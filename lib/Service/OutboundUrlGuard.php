<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\LlmChat\Service;

use OCA\LlmChat\Exception\BadRequestException;
use OCP\IConfig;
use OCP\IURLGenerator;
use OCP\Security\IRemoteHostValidator;

/**
 * The first gate for every request this server makes on a user's behalf —
 * `web_fetch` and the MCP proxy (issue #11) share it, so the two cannot drift
 * apart on what counts as "somewhere we will not go".
 *
 * First gate, not the only one: Nextcloud's HTTP client re-validates the host
 * after DNS resolution (DnsPinMiddleware) and on every redirect hop. This
 * exists to fail fast with a readable message, and to keep this very
 * instance off limits, which the SSRF guard does not cover.
 */
class OutboundUrlGuard {
	public function __construct(
		private IRemoteHostValidator $hostValidator,
		private IConfig $config,
		private IURLGenerator $urlGenerator,
	) {
	}

	/**
	 * @param bool $standardPortsOnly true for urls a model picked: an open
	 *                                "fetch any port" endpoint doubles as a port scanner. false for urls the
	 *                                user registered themselves, where :8000 is simply where the thing runs.
	 * @param string $ownInstanceMessage what to tell the caller when the url
	 *                                   points back at this Nextcloud
	 * @throws BadRequestException
	 */
	public function validate(
		string $url,
		bool $standardPortsOnly = true,
		string $ownInstanceMessage = 'this Nextcloud instance cannot be reached from here',
	): string {
		$url = trim($url);
		if ($url === '' || strlen($url) > 2048) {
			throw new BadRequestException('invalid url');
		}

		$parts = parse_url($url);
		if ($parts === false || !isset($parts['scheme'], $parts['host'])) {
			throw new BadRequestException('invalid url');
		}

		$scheme = strtolower($parts['scheme']);
		if ($scheme !== 'http' && $scheme !== 'https') {
			throw new BadRequestException('only http and https are allowed');
		}

		// no credentials in the url — they are a classic parser-confusion vector
		if (isset($parts['user']) || isset($parts['pass'])) {
			throw new BadRequestException('urls with credentials are not allowed');
		}

		$port = $parts['port'] ?? null;
		if ($standardPortsOnly && $port !== null && $port !== 80 && $port !== 443) {
			throw new BadRequestException('only standard ports are allowed');
		}

		if (!$this->hostValidator->isValid($parts['host'])) {
			throw new BadRequestException('this address is not allowed');
		}

		// This Nextcloud is off limits. The SSRF guard does not catch it —
		// the instance usually resolves to a perfectly public address — but
		// requesting it server-side is still wrong: the request carries no
		// session, so it either 401s or, worse, silently reads whatever is
		// public (share links, previews) under the server's own identity.
		if ($this->isOwnInstance($parts['host'])) {
			throw new BadRequestException($ownInstanceMessage);
		}

		return $url;
	}

	/**
	 * Every name this instance is known by: the current base url, the
	 * configured trusted domains and the CLI overwrite. Ports are ignored on
	 * purpose — a different port on the same host is still this instance.
	 */
	public function isOwnInstance(string $host): bool {
		$host = strtolower(rtrim($host, '.'));
		if ($host === '') {
			return false;
		}

		$candidates = [
			parse_url($this->urlGenerator->getBaseUrl(), PHP_URL_HOST),
			parse_url((string)$this->config->getSystemValue('overwrite.cli.url', ''), PHP_URL_HOST),
		];

		foreach ((array)$this->config->getSystemValue('trusted_domains', []) as $domain) {
			// trusted domains may carry a port and may be a wildcard
			$candidates[] = strtok((string)$domain, ':');
		}

		foreach ($candidates as $candidate) {
			if (!is_string($candidate) || $candidate === '') {
				continue;
			}

			$candidate = strtolower(rtrim($candidate, '.'));
			if ($candidate === $host) {
				return true;
			}

			// trusted_domains supports a leading wildcard (*.example.com)
			if (str_starts_with($candidate, '*.')
				&& str_ends_with($host, substr($candidate, 1))) {
				return true;
			}
		}

		return false;
	}
}
