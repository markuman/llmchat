<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\LlmChat\Controller;

use OCA\LlmChat\Exception\BadRequestException;
use OCA\LlmChat\Service\ProfileService;
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
		private ProfileService $profiles,
	) {
		parent::__construct($request, $logger, $userId);
	}

	/**
	 * @NoAdminRequired
	 */
	#[NoAdminRequired]
	#[UserRateLimit(limit: 30, period: 60)]
	public function search(string $query): DataResponse {
		return $this->handle(function () use ($query) {
			$this->requireTool('web_search');

			return $this->webSearch->search($this->uid(), $query);
		});
	}

	/**
	 * @NoAdminRequired
	 */
	#[NoAdminRequired]
	#[UserRateLimit(limit: 30, period: 60)]
	public function fetch(string $url): DataResponse {
		return $this->handle(function () use ($url) {
			$this->requireTool('web_fetch');

			return $this->webFetch->fetch($url);
		});
	}

	/**
	 * The frontend only offers tools a profile allows, but the endpoint must
	 * not depend on that: a user who has the tool enabled nowhere should not
	 * be able to reach the network through this server at all.
	 *
	 * Checked against all of the user's profiles rather than one specific
	 * profile — the request carries no trustworthy profile reference, and
	 * "may use this tool somewhere" is the honest granularity here.
	 *
	 * @throws BadRequestException
	 */
	private function requireTool(string $tool): void {
		foreach ($this->profiles->findAll($this->uid()) as $profile) {
			if (in_array($tool, $profile->getEnabledToolsArray(), true)) {
				return;
			}
		}

		throw new BadRequestException('this tool is not enabled in any of your profiles');
	}
}
