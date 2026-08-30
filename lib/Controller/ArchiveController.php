<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\LlmChat\Controller;

use OCA\LlmChat\Service\ArchiveService;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\DataResponse;
use OCP\IRequest;
use Psr\Log\LoggerInterface;

class ArchiveController extends ApiController {
	public function __construct(
		IRequest $request,
		LoggerInterface $logger,
		?string $userId,
		private ArchiveService $service,
	) {
		parent::__construct($request, $logger, $userId);
	}

	/**
	 * @NoAdminRequired
	 */
	#[NoAdminRequired]
	public function store(
		string $title,
		string $markdown,
		?string $created_at = null,
		?string $profile = null,
		?string $model = null,
		?string $system_prompt = null,
	): DataResponse {
		return $this->handle(fn () => $this->service->store($this->uid(), [
			'title' => $title,
			'markdown' => $markdown,
			'created_at' => $created_at,
			'profile' => $profile,
			'model' => $model,
			'system_prompt' => $system_prompt,
		]));
	}
}
