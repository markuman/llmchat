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
 * Web search executed by the server on behalf of the browser.
 *
 * SearXNG only. There used to be a DuckDuckGo fallback via the Instant Answer
 * API, on the assumption that a zero-setup provider beats none — it does not.
 * That API returns encyclopedic entities, so "berlin" worked while "weather in
 * berlin tomorrow" returned nothing at all. An empty result set made the model
 * conclude nothing existed and start inventing URLs to fetch. A tool that
 * silently fails at the actual job is worse than an absent one.
 *
 * The instance needs `formats: [html, json]` in its settings.yml. Requests go
 * through Nextcloud's SSRF-guarded HTTP client like every other fetch — unless
 * the admin has allowed local servers, the instance must be reachable via a
 * public address.
 */
class WebSearchService {
	private const REQUEST_TIMEOUT = 15;
	private const MAX_RESULTS = 8;
	private const MAX_QUERY_LENGTH = 400;

	public function __construct(
		private IClientService $clientService,
		private SettingsService $settings,
		private UserAgentRotator $userAgents,
		private LoggerInterface $logger,
	) {
	}

	/**
	 * @return array{provider: string, query: string, results: array<int, array{title: string, url: string, snippet: string}>}
	 * @throws BadRequestException
	 */
	public function search(string $userId, string $query): array {
		$query = trim($query);
		if ($query === '') {
			throw new BadRequestException('query must not be empty');
		}
		$query = mb_substr($query, 0, self::MAX_QUERY_LENGTH);

		$settings = $this->settings->get($userId);
		$results = $this->searxng($query, (string)$settings['searxng_url']);

		$payload = [
			'provider' => 'searxng',
			'query' => $query,
			'results' => array_slice($results, 0, self::MAX_RESULTS),
		];

		// Say it explicitly, otherwise the model treats an empty list as
		// "this does not exist" and starts guessing URLs for web_fetch.
		if ($payload['results'] === []) {
			$payload['note'] = 'No results for this query. Try rephrasing it, or tell the user '
				. 'that the search returned nothing. Do not guess URLs.';
		}

		return $payload;
	}

	/**
	 * @return array<int, array{title: string, url: string, snippet: string}>
	 */
	private function searxng(string $query, string $baseUrl): array {
		if ($baseUrl === '') {
			throw new BadRequestException(
				'no SearXNG instance configured — set one in the app settings to enable web search'
			);
		}

		$url = rtrim($baseUrl, '/') . '/search?' . http_build_query([
			'q' => $query,
			'format' => 'json',
		]);

		$payload = $this->getJson($url);

		$results = [];
		foreach (($payload['results'] ?? []) as $entry) {
			if (!is_array($entry) || empty($entry['url'])) {
				continue;
			}
			$results[] = [
				'title' => $this->clip((string)($entry['title'] ?? ''), 200),
				'url' => $this->clip((string)$entry['url'], 1024),
				'snippet' => $this->clip((string)($entry['content'] ?? ''), 500),
			];
		}

		return $results;
	}

	private function getJson(string $url): array {
		$client = $this->clientService->newClient();

		try {
			$response = $client->get($url, [
				'timeout' => self::REQUEST_TIMEOUT,
				'headers' => [
					'User-Agent' => $this->userAgents->next(WebFetchService::USER_AGENTS),
					'Accept' => 'application/json',
				],
			]);
		} catch (LocalServerException) {
			throw new BadRequestException(
				'the search instance is not reachable: local addresses are blocked unless the admin sets allow_local_remote_servers'
			);
		} catch (\Exception $e) {
			$this->logger->info('llmchat websearch failed', ['exception' => $e]);
			throw new BadRequestException('search failed: ' . mb_substr(strtok($e->getMessage(), "\n") ?: 'unknown error', 0, 200));
		}

		if ($response->getStatusCode() === 403) {
			throw new BadRequestException(
				'the search instance rejected the request (HTTP 403) — is the json format enabled in its settings?'
			);
		}
		if ($response->getStatusCode() >= 400) {
			throw new BadRequestException('the search instance answered with HTTP ' . $response->getStatusCode());
		}

		$body = $response->getBody();
		$decoded = json_decode(is_string($body) ? $body : '', true);
		if (!is_array($decoded)) {
			throw new BadRequestException('the search instance did not return valid JSON');
		}

		return $decoded;
	}

	private function clip(string $value, int $max): string {
		return mb_substr(trim($value), 0, $max);
	}
}
