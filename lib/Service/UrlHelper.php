<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\LlmChat\Service;

use OCA\LlmChat\Exception\BadRequestException;

class UrlHelper {
	/**
	 * Normalises a base url: trims whitespace and trailing slashes,
	 * rejects everything that is not http(s).
	 *
	 * @throws BadRequestException
	 */
	public static function normalizeBaseUrl(string $url): string {
		$url = trim($url);
		if ($url === '') {
			throw new BadRequestException('base_url must not be empty');
		}

		$parts = parse_url($url);
		if ($parts === false || !isset($parts['scheme'], $parts['host'])) {
			throw new BadRequestException('base_url is not a valid absolute URL');
		}

		$scheme = strtolower($parts['scheme']);
		if ($scheme !== 'http' && $scheme !== 'https') {
			throw new BadRequestException('base_url must use http or https');
		}

		return rtrim($url, '/');
	}

	/**
	 * Returns `scheme://host[:port]` for the CSP connect-src entry.
	 * The port matters — `127.0.0.1` and `127.0.0.1:11434` are different
	 * sources as far as the CSP is concerned (spec §7.1).
	 */
	public static function cspSource(string $url): ?string {
		$parts = parse_url(trim($url));
		if ($parts === false || !isset($parts['scheme'], $parts['host'])) {
			return null;
		}

		$source = strtolower($parts['scheme']) . '://' . $parts['host'];
		if (isset($parts['port'])) {
			$source .= ':' . $parts['port'];
		}

		return $source;
	}
}
