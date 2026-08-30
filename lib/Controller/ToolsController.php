<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\LlmChat\Controller;

use OCA\LlmChat\Service\WebFetchService;
use OCA\LlmChat\Service\WebSearchService;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\UserRateLimit;
use OCP\AppFramework\Http\DataResponse;
use OCP\IRequest;
use Psr\Log\LoggerInterface;

/**
 * Server-side halves of the browser's agent tools.
 *
 * Session-authenticated and CSRF-protected like every other route (spec §9) —
 * that alone rules out drive-by use as an anonymous proxy. The rate limits
 * bound what a single authenticated user can relay through the server.
 */
class ToolsController extends ApiController {
	public function __construct(
		IRequest $request,
		LoggerInterface $logger,
		?string $userId,
		private WebFetchService $webFetch,
		private WebSearchService $webSearch,
	) {
		parent::__construct($request, $logger, $userId);
	}

	/**
	 * @NoAdminRequired
	 */
	#[NoAdminRequired]
	#[UserRateLimit(limit: 30, period: 60)]
	public function search(string $query): DataResponse {
		return $this->handle(fn () => $this->webSearch->search($this->uid(), $query));
	}

	/**
	 * @NoAdminRequired
	 */
	#[NoAdminRequired]
	#[UserRateLimit(limit: 30, period: 60)]
	public function fetch(string $url): DataResponse {
		return $this->handle(fn () => $this->webFetch->fetch($url));
	}
}
