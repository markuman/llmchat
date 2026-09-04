# Container based build for the llmchat Nextcloud app.
#
# Nothing is built on the server and nothing needs to be installed locally
# except podman: node and php run in throwaway containers, the artefacts land
# in js/ and css/ inside the project directory (both are in .gitignore) so a
# plain rsync can deploy them afterwards.
#
# `make` on its own prints the target list — see the help target at the bottom,
# which reads the `##` comments off the target lines so it cannot go stale.

APP_ID      := llmchat
VERSION     := $(shell sed -n 's:.*<version>\(.*\)</version>.*:\1:p' appinfo/info.xml)

# node:24, not 22: the lock file was written by npm 11+, and npm 10 refuses it
# with "Missing: pinia@4.0.3 from lock file" because it resolves that peer
# dependency differently.
#
# No architecture is pinned anywhere in this file and none should be: both
# images are multi-arch manifests, so podman pulls the arm64 variant on a
# Raspberry Pi 5 by itself, and `npm ci` then picks the matching native
# packages out of the lock file — which lists every platform, arm64 included.
# A separate arm target would be a second thing to keep in sync for no gain.
# What does bite on a Pi is building in the container and then running npm on
# the host: see check-native.
NODE_IMAGE  := docker.io/library/node:24-alpine
PHP_IMAGE   := docker.io/library/php:8.4-cli-alpine
# psalm/phar 5.x refuses to start on 8.4, see the psalm target
PHP_PSALM_IMAGE := docker.io/library/php:8.3-cli-alpine

PODMAN      := podman
CACHE_DIR   := $(CURDIR)/.cache

# --userns=keep-id maps the calling user into the container, so everything
# written to the bind mount keeps our ownership instead of ending up root
# owned. HOME is redirected because the images default to /root, which that
# same mapping makes unwritable.
RUN = $(PODMAN) run --rm -t $(PODMAN_EXTRA) \
	--userns=keep-id \
	-v "$(CURDIR)":/app:z \
	-v "$(CACHE_DIR)":/cache:z \
	-w /app \
	-e HOME=/cache

RUN_NODE = $(RUN) -e npm_config_cache=/cache/npm $(NODE_IMAGE)
RUN_PHP  = $(RUN) -e COMPOSER_HOME=/cache/composer $(PHP_IMAGE)

# The one file that proves the frontend build ran.
MAIN_BUNDLE := js/$(APP_ID)-main.mjs

# rollup and esbuild ship their native part as per-platform optional packages,
# and npm installs exactly the one that matches. node_modules/ is a bind mount
# shared with the host, so an `npm install` run outside the container replaces
# the musl build the alpine image needs with the host's glibc one (or, on a
# Raspberry Pi, an arm64 one with an x86 one). The tree still looks complete —
# only the load fails, with a "Cannot find module @rollup/rollup-<platform>"
# that names a package nothing ever asked for by name.
#
# Timestamps cannot catch this: node_modules ends up *newer* than the lock
# file, so make would happily consider it up to date. So ask rollup instead of
# the mtime — importing it is what the build does two seconds later anyway.
#
# Deliberately not RUN_NODE: that passes -t, and podman wires a TTY straight
# through to the terminal, so the probe's own stack trace would show up even
# with stderr redirected and read exactly like a real build failure.
NATIVE_PROBE = $(PODMAN) run --rm --userns=keep-id \
	-v "$(CURDIR)":/app:z -w /app -e HOME=/cache \
	$(NODE_IMAGE) node -e 'import("rollup")'

.PHONY: help all build test lint psalm cs-fix deps php-deps check-native release deploy clean distclean shell shell-php version
.DEFAULT_GOAL := help

# ---------------------------------------------------------------- build ----

build: $(MAIN_BUNDLE) ## build js/ and css/ — all a deploy needs

all: build

$(MAIN_BUNDLE): node_modules $(shell find src -type f 2>/dev/null) vite.config.js
	@$(MAKE) --no-print-directory check-native
	$(RUN_NODE) npm run build
	@echo "==> assets ready: js/ $$(du -sh js | cut -f1), css/ $$(du -sh css | cut -f1)"

# Repairs node_modules when its native packages are for the wrong platform.
# Silent when everything is fine, which is the normal case.
check-native: node_modules ## verify the native rollup/esbuild binaries match the container
	@$(NATIVE_PROBE) 2>/dev/null || { \
		echo "==> native modules do not match $(NODE_IMAGE) — reinstalling"; \
		echo "    (an npm run outside the container swapped them for the host's)"; \
		rm -rf node_modules; \
		$(MAKE) --no-print-directory node_modules; \
		$(NATIVE_PROBE) >/dev/null 2>&1 || { \
			echo "still broken after npm ci — that is not the platform mismatch" >&2; \
			exit 1; \
		}; \
	}

# ----------------------------------------------------------------- test ----

test: lint ## eslint + php -l + php-cs-fixer

lint: node_modules vendor
	@$(MAKE) --no-print-directory check-native
	@echo "==> eslint"
	$(RUN_NODE) npm run lint
	@echo "==> php -l"
	$(RUN_PHP) sh -c 'find lib -name "*.php" -print0 | xargs -0 -n1 php -l > /dev/null'
	@echo "==> php-cs-fixer"
	$(RUN_PHP) php /cache/composer.phar run cs:check

# Deliberately not part of `test`: psalm/phar ^5.26 caps out at PHP 8.3 and its
# bundled requirement checker aborts on the 8.4 image. Run it in a matching
# interpreter instead of downgrading the whole toolchain.
psalm: vendor ## static analysis (own PHP 8.3 image)
	$(RUN) -e COMPOSER_HOME=/cache/composer $(PHP_PSALM_IMAGE) \
		php /cache/composer.phar run psalm

cs-fix: vendor ## rewrite lib/ with php-cs-fixer
	$(RUN_PHP) php /cache/composer.phar run cs:fix

# -------------------------------------------------------------- shipping ----

release: build ## signed app store tarball in build/
	./build-release.sh

# Same exclusion list as the tarball, so the two cannot drift apart.
deploy: build ## rsync to DEPLOY_TARGET=user@host:/…/apps/llmchat/
	@test -n "$(DEPLOY_TARGET)" || { echo "set DEPLOY_TARGET=user@host:/path/to/apps/$(APP_ID)/" >&2; exit 1; }
	rsync -a --delete --exclude-from=.deployignore ./ "$(DEPLOY_TARGET)"

# ----------------------------------------------------------------- deps ----

deps: node_modules ## npm ci in a container

node_modules: package-lock.json | $(CACHE_DIR)
	$(RUN_NODE) npm ci --no-audit --no-fund
	@touch node_modules

php-deps: vendor ## composer install in a container

vendor: composer.json $(CACHE_DIR)/composer.phar
	$(RUN_PHP) php /cache/composer.phar install --no-interaction --no-progress
	@touch vendor

# composer is not in the php image, so fetch the phar once into the cache
$(CACHE_DIR)/composer.phar: | $(CACHE_DIR)
	$(RUN_PHP) sh -c 'php -r "copy(\"https://getcomposer.org/installer\", \"/cache/composer-setup.php\");" \
		&& php /cache/composer-setup.php --install-dir=/cache --filename=composer.phar \
		&& rm -f /cache/composer-setup.php'

$(CACHE_DIR):
	mkdir -p "$(CACHE_DIR)"

# ---------------------------------------------------------------- sundry ----

shell: PODMAN_EXTRA = -i
shell: | $(CACHE_DIR) ## interactive shell in the node container
	$(RUN_NODE) sh

shell-php: PODMAN_EXTRA = -i
shell-php: | $(CACHE_DIR) ## interactive shell in the php container
	$(RUN_PHP) sh

version: ## print app id and version from appinfo/info.xml
	@echo "$(APP_ID) $(VERSION)"

clean: ## remove js/, css/ and build/
	rm -rf js css build

distclean: clean ## also drop node_modules, vendor and the container caches
	rm -rf node_modules vendor "$(CACHE_DIR)"

# The target list is generated from the `##` comments above, in the order they
# appear in this file, so adding a target documents it automatically.
help: ## show this help
	@echo "$(APP_ID) $(VERSION) — everything runs in podman containers"
	@echo
	@echo "targets:"
	@awk 'BEGIN { FS = ":.*## " } \
		/^[a-zA-Z0-9_.-]+:.*## / { printf "  %-12s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)
	@echo
	@echo "images: $(NODE_IMAGE)"
	@echo "        $(PHP_IMAGE)"
