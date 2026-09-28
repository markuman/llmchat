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
	 * Title and date only name the file — the archive itself is the bare
	 * conversation. Profile, model and system prompt are no longer part of
	 * it; an older frontend that still sends them is not rejected, the
	 * fields are simply not read.
	 */
	#[NoAdminRequired]
	public function store(
		string $title,
		string $markdown,
		?string $created_at = null,
	): DataResponse {
		return $this->handle(fn () => $this->service->store($this->uid(), [
			'title' => $title,
			'markdown' => $markdown,
			'created_at' => $created_at,
		]));
	}
}
