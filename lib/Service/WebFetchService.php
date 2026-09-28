<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\LlmChat\Service;

use OCA\LlmChat\Exception\BadRequestException;
use OCP\Http\Client\IClientService;
use OCP\Http\Client\LocalServerException;
use Psr\Log\LoggerInterface;

/**
 * Fetches a web page on behalf of the browser and reduces it to plain text
 * for the model.
 *
 * Threat model — this endpoint must never become:
 *
 * 1. An open proxy. Countered by: session auth + rate limit (controller),
 *    http(s)-only, standard ports only, response size cap, text-only content
 *    types, plain-text output (never the raw document).
 *
 * 2. An SSRF vector into the local network. Countered by Nextcloud's own
 *    HTTP client, which we deliberately use instead of curl: it validates
 *    the host via IRemoteHostValidator, pins DNS to prevent rebinding
 *    (DnsPinMiddleware) and re-checks every redirect hop. We additionally
 *    pre-validate the host to fail fast with a clean message (OutboundUrlGuard,
 *    shared with the MCP proxy).
 *
 * 3. A code-execution surface. The fetched document is *data*, never
 *    interpreted: parsed with DOMDocument (libxml entity loading disabled by
 *    default since PHP 8), scripts/styles dropped, output is plain text that
 *    goes through the frontend's usual sanitised rendering path.
 */
class WebFetchService {
	/** hard cap on the response body */
	private const MAX_BODY_BYTES = 2 * 1024 * 1024;
	/** what the model gets at most, roughly 6k tokens */
	private const MAX_TEXT_CHARS = 24000;
	private const REQUEST_TIMEOUT = 15;

	/**
	 * Rotated per request. Ordinary desktop browsers; a server that
	 * identifies as "Nextcloud-Server-Crawler" gets bot-walled instantly.
	 */
	private const USER_AGENTS = [
		// Mac Safari
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
		// Windows Edge
		'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36 Edg/139.0.0.0',
		// Linux Firefox
		'Mozilla/5.0 (X11; Linux x86_64; rv:142.0) Gecko/20100101 Firefox/142.0',
	];

	public function __construct(
		private IClientService $clientService,
		private OutboundUrlGuard $guard,
		private UserAgentRotator $userAgents,
		private LoggerInterface $logger,
	) {
	}

	/**
	 * @return array{url: string, final_url: string, title: string|null, content: string, truncated: bool}
	 * @throws BadRequestException
	 */
	public function fetch(string $url): array {
		// the url comes from the model, so standard ports only — see the guard
		$url = $this->guard->validate(
			$url,
			true,
			'this Nextcloud instance cannot be fetched — use the nextcloud tools instead',
		);

		$client = $this->clientService->newClient();

		try {
			$response = $client->get($url, [
				'timeout' => self::REQUEST_TIMEOUT,
				'headers' => [
					'User-Agent' => $this->userAgents->next(self::USER_AGENTS),
					'Accept' => 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1',
					'Accept-Language' => 'en, *;q=0.5',
				],
				// stream so the size cap can be enforced while reading,
				// instead of after the whole body is already in memory
				'stream' => true,
				// deliberately NOT setting allow_redirects here: Nextcloud's
				// client installs an on_redirect callback that re-validates
				// every hop against the local-address rules, and array_merge
				// in buildRequestOptions() would replace it wholesale — a
				// redirect to an internal host would then go through
			]);
		} catch (LocalServerException $e) {
			// no detail on purpose: do not leak which internal hosts exist
			throw new BadRequestException('this address is not allowed');
		} catch (\Exception $e) {
			$this->logger->info('llmchat webfetch failed', ['exception' => $e]);
			throw new BadRequestException('the page could not be fetched: ' . $this->safeMessage($e));
		}

		$status = $response->getStatusCode();
		if ($status >= 400) {
			throw new BadRequestException('the page answered with HTTP ' . $status);
		}

		$contentType = strtolower($response->getHeader('Content-Type'));
		if (!$this->isTextual($contentType)) {
			throw new BadRequestException('unsupported content type: ' . substr($contentType, 0, 100));
		}

		$body = $this->readCapped($response->getBody());

		$isHtml = str_contains($contentType, 'html') || $contentType === '';
		[$title, $text] = $isHtml
			? $this->extractFromHtml($body)
			: [null, $body];

		$text = $this->normalizeWhitespace($text);
		$truncated = mb_strlen($text) > self::MAX_TEXT_CHARS;
		if ($truncated) {
			$text = mb_substr($text, 0, self::MAX_TEXT_CHARS);
		}

		return [
			'url' => $url,
			'final_url' => $url,
			'title' => $title,
			'content' => $text,
			'truncated' => $truncated,
		];
	}

	private function isTextual(string $contentType): bool {
		if ($contentType === '') {
			// some sites omit it; the HTML parser treats the body as data
			// either way, so this is acceptable
			return true;
		}

		foreach (['text/html', 'application/xhtml+xml', 'text/plain', 'text/markdown', 'application/xml', 'text/xml'] as $allowed) {
			if (str_starts_with($contentType, $allowed)) {
				return true;
			}
		}

		return false;
	}

	/**
	 * Reads at most MAX_BODY_BYTES from the response stream, then stops —
	 * a 5 GB response must not exhaust PHP's memory.
	 *
	 * @param resource|string|null $body
	 */
	private function readCapped($body): string {
		if (is_string($body)) {
			return substr($body, 0, self::MAX_BODY_BYTES);
		}

		if (!is_resource($body)) {
			return '';
		}

		$data = '';
		while (!feof($body) && strlen($data) < self::MAX_BODY_BYTES) {
			$chunk = fread($body, 64 * 1024);
			if ($chunk === false) {
				break;
			}
			$data .= $chunk;
		}
		fclose($body);

		return $data;
	}

	/**
	 * HTML → title + visible text. The document is never executed or
	 * rendered: DOMDocument builds a tree, scripts/styles/navigation are
	 * removed, the rest is flattened to text.
	 *
	 * @return array{0: string|null, 1: string}
	 */
	private function extractFromHtml(string $html): array {
		$doc = new \DOMDocument();

		// suppress warnings from real-world markup; no network access happens
		// here (libxml entity loading is disabled by default since PHP 8)
		$previous = libxml_use_internal_errors(true);
		$loaded = $doc->loadHTML(
			// force utf-8 interpretation
			'<?xml encoding="utf-8"?>' . $html,
			LIBXML_NONET | LIBXML_NOWARNING | LIBXML_NOERROR
		);
		libxml_clear_errors();
		libxml_use_internal_errors($previous);

		if (!$loaded) {
			return [null, strip_tags($html)];
		}

		$title = null;
		$titleNode = $doc->getElementsByTagName('title')->item(0);
		if ($titleNode !== null) {
			$title = trim($titleNode->textContent);
			$title = $title === '' ? null : mb_substr($title, 0, 300);
		}

		// strip everything that is code or chrome, keep the content
		$xpath = new \DOMXPath($doc);
		$junk = $xpath->query(
			'//script | //style | //noscript | //template | //svg | //iframe | //nav | //header | //footer | //form'
		);
		if ($junk !== false) {
			// iterate backwards: removing nodes invalidates forward iteration
			for ($i = $junk->length - 1; $i >= 0; $i--) {
				$node = $junk->item($i);
				if ($node !== null) {
					$node->parentNode?->removeChild($node);
				}
			}
		}

		$main = $xpath->query('//main | //article');
		$root = ($main !== false && $main->length > 0) ? $main->item(0) : $doc->documentElement;

		return [$title, $root === null ? '' : $root->textContent];
	}

	private function normalizeWhitespace(string $text): string {
		$text = preg_replace('/[ \t\x{00A0}]+/u', ' ', $text) ?? $text;
		$text = preg_replace('/\s*\n\s*(\n\s*)+/u', "\n\n", $text) ?? $text;

		return trim($text);
	}

	/**
	 * Guzzle exception messages can contain the full URL and internal paths;
	 * keep only the first line, capped.
	 */
	private function safeMessage(\Exception $e): string {
		$message = strtok($e->getMessage(), "\n");

		return $message === false ? 'unknown error' : mb_substr($message, 0, 200);
	}
}
