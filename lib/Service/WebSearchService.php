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
 * Two providers:
 *
 * - `searxng`: a SearXNG instance configured by the user. Full web results.
 *   The instance needs `formats: [html, json]` in its settings.yml. Requests
 *   go through Nextcloud's SSRF-guarded HTTP client like every other fetch —
 *   unless the admin has allowed local servers, the instance must be
 *   reachable via a public address.
 *
 * - `duckduckgo`: the Instant Answer API. No key, no configuration, but
 *   only abstracts/definitions, not full result lists. It is the zero-setup
 *   fallback, not a real search.
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
		$provider = $settings['search_provider'];

		$results = match ($provider) {
			'searxng' => $this->searxng($query, (string)$settings['searxng_url']),
			default => $this->duckduckgo($query),
		};

		$payload = [
			'provider' => $provider,
			'query' => $query,
			'results' => array_slice($results, 0, self::MAX_RESULTS),
		];

		// An empty result list is the normal case for DuckDuckGo: its Instant
		// Answer API only knows entities ("berlin"), not questions ("weather in
		// berlin tomorrow"). Without an explanation the model reads this as
		// "nothing exists" and starts guessing URLs to fetch, so tell it what
		// actually happened and what to do instead.
		if ($payload['results'] === []) {
			$payload['note'] = $provider === 'duckduckgo'
				? 'No results. This provider only covers encyclopedic entities, not questions, '
					. 'news or weather. Do not guess URLs — tell the user that the DuckDuckGo '
					. 'instant answer backend cannot answer this and that a SearXNG instance '
					. 'can be configured in the app settings for real web search.'
				: 'No results for this query. Consider rephrasing it.';
		}

		return $payload;
	}

	/**
	 * @return array<int, array{title: string, url: string, snippet: string}>
	 */
	private function searxng(string $query, string $baseUrl): array {
		if ($baseUrl === '') {
			throw new BadRequestException('no SearXNG instance configured — set one in the settings');
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

	/**
	 * Instant answers only. Kept deliberately: zero configuration beats no
	 * search at all, and the tool description tells the model how weak it is.
	 *
	 * @return array<int, array{title: string, url: string, snippet: string}>
	 */
	private function duckduckgo(string $query): array {
		$url = 'https://api.duckduckgo.com/?' . http_build_query([
			'q' => $query,
			'format' => 'json',
			'no_html' => '1',
			'skip_disambig' => '0',
		]);

		$payload = $this->getJson($url);
		$results = [];

		$abstract = (string)($payload['AbstractText'] ?? '');
		if ($abstract !== '') {
			$results[] = [
				'title' => $this->clip((string)($payload['Heading'] ?? $query), 200),
				'url' => $this->clip((string)($payload['AbstractURL'] ?? ''), 1024),
				'snippet' => $this->clip($abstract, 500),
			];
		}

		$answer = (string)($payload['Answer'] ?? '');
		if ($answer !== '') {
			$results[] = [
				'title' => 'Direct answer',
				'url' => '',
				'snippet' => $this->clip($answer, 500),
			];
		}

		foreach (($payload['RelatedTopics'] ?? []) as $topic) {
			if (!is_array($topic)) {
				continue;
			}
			// nested categories carry their entries under Topics
			$entries = isset($topic['Topics']) && is_array($topic['Topics']) ? $topic['Topics'] : [$topic];
			foreach ($entries as $entry) {
				if (!is_array($entry) || empty($entry['FirstURL']) || empty($entry['Text'])) {
					continue;
				}
				$results[] = [
					'title' => $this->clip(strtok((string)$entry['Text'], '-') ?: (string)$entry['Text'], 200),
					'url' => $this->clip((string)$entry['FirstURL'], 1024),
					'snippet' => $this->clip((string)$entry['Text'], 500),
				];
			}
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
