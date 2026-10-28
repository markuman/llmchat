<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\LlmChat\Controller;

use OCA\LlmChat\Service\MemoryProfileService;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\DataResponse;
use OCP\IRequest;
use Psr\Log\LoggerInterface;

class MemoryProfilesController extends ApiController {
	public function __construct(
		IRequest $request,
		LoggerInterface $logger,
		?string $userId,
		private MemoryProfileService $service,
	) {
		parent::__construct($request, $logger, $userId);
	}

	#[NoAdminRequired]
	public function index(): DataResponse {
		return $this->handle(fn () => array_map(
			static fn ($m) => $m->jsonSerialize(),
			$this->service->findAll($this->uid())
		));
	}

	#[NoAdminRequired]
	public function create(
		string $name,
		string $path = '',
		?int $max_chars = null,
		bool $recap_enabled = true,
		?int $recap_profile_id = null,
		bool $auto_compact = false,
		?int $compact_threshold = null,
	): DataResponse {
		return $this->handle(fn () => $this->service->create($this->uid(), [
			'name' => $name,
			'path' => $path,
			'max_chars' => $max_chars,
			'recap_enabled' => $recap_enabled,
			'recap_profile_id' => $recap_profile_id,
			'auto_compact' => $auto_compact,
			'compact_threshold' => $compact_threshold,
		])->jsonSerialize());
	}

	#[NoAdminRequired]
	public function update(
		int $id,
		?string $name = null,
		?string $path = null,
		?int $max_chars = null,
		?bool $recap_enabled = null,
		?bool $auto_compact = null,
		?int $compact_threshold = null,
	): DataResponse {
		$data = array_filter([
			'name' => $name,
			'path' => $path,
			'max_chars' => $max_chars,
			'recap_enabled' => $recap_enabled,
			'auto_compact' => $auto_compact,
			'compact_threshold' => $compact_threshold,
		], static fn ($v) => $v !== null);

		// null is a meaningful value here ("same as the chat profile"), so
		// "not sent" has to be told apart from it — same reasoning as in
		// ProfilesController::update()
		$params = $this->request->getParams();
		if (array_key_exists('recap_profile_id', $params)) {
			$data['recap_profile_id'] = $params['recap_profile_id'];
		}

		return $this->handle(fn () => $this->service->update($id, $this->uid(), $data)->jsonSerialize());
	}

	#[NoAdminRequired]
	public function destroy(int $id): DataResponse {
		return $this->handle(function () use ($id) {
			$this->service->delete($id, $this->uid());
			return ['status' => 'deleted'];
		});
	}
}
