<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\LlmChat\Controller;

use OCA\LlmChat\Service\SettingsService;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\DataResponse;
use OCP\IRequest;
use Psr\Log\LoggerInterface;

class SettingsController extends ApiController {
	public function __construct(
		IRequest $request,
		LoggerInterface $logger,
		?string $userId,
		private SettingsService $service,
	) {
		parent::__construct($request, $logger, $userId);
	}

	/**
	 * @NoAdminRequired
	 */
	#[NoAdminRequired]
	public function show(): DataResponse {
		return $this->handle(fn () => $this->service->get($this->uid()));
	}

	/**
	 * @NoAdminRequired
	 */
	#[NoAdminRequired]
	public function update(
		?string $archive_folder = null,
		?string $archive_target = null,
		?bool $compact_mode = null,
		?bool $markdown_rendering = null,
		?bool $show_reasoning = null,
		?int $default_profile_id = null,
		?string $search_provider = null,
		?string $searxng_url = null,
	): DataResponse {
		$data = array_filter([
			'archive_folder' => $archive_folder,
			'archive_target' => $archive_target,
			'compact_mode' => $compact_mode,
			'markdown_rendering' => $markdown_rendering,
			'show_reasoning' => $show_reasoning,
			'default_profile_id' => $default_profile_id,
			'search_provider' => $search_provider,
			'searxng_url' => $searxng_url,
		], static fn ($v) => $v !== null);

		return $this->handle(fn () => $this->service->update($this->uid(), $data));
	}
}
