# Container based build for the llmchat Nextcloud app.
#
# Nothing is built on the server and nothing needs to be installed locally
# except podman: node and php run in throwaway containers, the artefacts land
# in js/ and css/ inside the project directory (both are in .gitignore) so a
# plain rsync can deploy them afterwards.
#
#   make build     js/ + css/ (this is what a deploy needs)
#   make test      eslint + php -l + php-cs-fixer
#   make psalm     static analysis (separate, needs an older PHP)
#   make cs-fix    apply php-cs-fixer to lib/
#   make release   signed app store tarball in build/
#   make deploy    rsync to DEPLOY_TARGET
#   make clean     remove build artefacts

APP_ID      := llmchat
VERSION     := $(shell sed -n 's:.*<version>\(.*\)</version>.*:\1:p' appinfo/info.xml)

# node:24, not 22: the lock file was written by npm 11+, and npm 10 refuses it
# with "Missing: pinia@4.0.3 from lock file" because it resolves that peer
# dependency differently.
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

.PHONY: all build test lint psalm cs-fix deps php-deps release deploy clean distclean shell shell-php version

all: build

$(CACHE_DIR):
	mkdir -p "$(CACHE_DIR)"

## deps — npm ci in a container, node_modules stays in the project directory
deps: node_modules

node_modules: package-lock.json | $(CACHE_DIR)
	$(RUN_NODE) npm ci --no-audit --no-fund
	@touch node_modules

## build — the only target a deploy depends on
build: $(MAIN_BUNDLE)

$(MAIN_BUNDLE): node_modules $(shell find src -type f 2>/dev/null) vite.config.js
	$(RUN_NODE) npm run build
	@echo "==> assets ready: js/ $$(du -sh js | cut -f1), css/ $$(du -sh css | cut -f1)"

## php-deps — composer install; composer is not in the php image, so fetch the
## phar once into the cache
$(CACHE_DIR)/composer.phar: | $(CACHE_DIR)
	$(RUN_PHP) sh -c 'php -r "copy(\"https://getcomposer.org/installer\", \"/cache/composer-setup.php\");" \
		&& php /cache/composer-setup.php --install-dir=/cache --filename=composer.phar \
		&& rm -f /cache/composer-setup.php'

php-deps: vendor

vendor: composer.json $(CACHE_DIR)/composer.phar
	$(RUN_PHP) php /cache/composer.phar install --no-interaction --no-progress
	@touch vendor

## test — everything a CI would run
test: lint

lint: node_modules vendor
	@echo "==> eslint"
	$(RUN_NODE) npm run lint
	@echo "==> php -l"
	$(RUN_PHP) sh -c 'find lib -name "*.php" -print0 | xargs -0 -n1 php -l > /dev/null'
	@echo "==> php-cs-fixer"
	$(RUN_PHP) php /cache/composer.phar run cs:check

## psalm — deliberately not part of `test`: psalm/phar ^5.26 caps out at PHP
## 8.3 and its bundled requirement checker aborts on the 8.4 image. Run it in
## a matching interpreter instead of downgrading the whole toolchain.
psalm: vendor
	$(RUN) -e COMPOSER_HOME=/cache/composer $(PHP_PSALM_IMAGE) \
		php /cache/composer.phar run psalm

## cs:fix — rewrite the sources in place
cs-fix: vendor
	$(RUN_PHP) php /cache/composer.phar run cs:fix

## release — app store tarball; delegates to the existing script, which needs
## the assets to be there already
release: build
	./build-release.sh

## deploy — rsync the app to a server, using the same exclusion list as the
## tarball so the two cannot drift apart
##   make deploy DEPLOY_TARGET=user@host:/var/www/nextcloud/apps/llmchat/
deploy: build
	@test -n "$(DEPLOY_TARGET)" || { echo "set DEPLOY_TARGET=user@host:/path/to/apps/$(APP_ID)/" >&2; exit 1; }
	rsync -a --delete --exclude-from=.deployignore ./ "$(DEPLOY_TARGET)"

## shells for poking around
shell: PODMAN_EXTRA = -i
shell: | $(CACHE_DIR)
	$(RUN_NODE) sh

shell-php: PODMAN_EXTRA = -i
shell-php: | $(CACHE_DIR)
	$(RUN_PHP) sh

version:
	@echo "$(APP_ID) $(VERSION)"

clean:
	rm -rf js css build

distclean: clean
	rm -rf node_modules vendor "$(CACHE_DIR)"
