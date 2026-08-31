<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\LlmChat\Controller;

use OCA\LlmChat\Service\ProfileService;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\DataResponse;
use OCP\IRequest;
use Psr\Log\LoggerInterface;

class ProfilesController extends ApiController {
	public function __construct(
		IRequest $request,
		LoggerInterface $logger,
		?string $userId,
		private ProfileService $service,
	) {
		parent::__construct($request, $logger, $userId);
	}

	/**
	 * @NoAdminRequired
	 */
	#[NoAdminRequired]
	public function index(): DataResponse {
		return $this->handle(fn () => array_map(
			static fn ($p) => $p->jsonSerialize(),
			$this->service->findAll($this->uid())
		));
	}

	/**
	 * @NoAdminRequired
	 */
	#[NoAdminRequired]
	public function create(
		string $name,
		int $connection_id,
		string $model,
		?string $system_prompt = null,
		?float $temperature = null,
		?int $max_tokens = null,
		bool $streaming = true,
		bool $reasoning = true,
		array $enabled_tools = [],
		bool $tool_approval = true,
		bool $is_default = false,
	): DataResponse {
		return $this->handle(fn () => $this->service->create($this->uid(), [
			'name' => $name,
			'connection_id' => $connection_id,
			'model' => $model,
			'system_prompt' => $system_prompt,
			'temperature' => $temperature,
			'max_tokens' => $max_tokens,
			'streaming' => $streaming,
			'reasoning' => $reasoning,
			'enabled_tools' => $enabled_tools,
			'tool_approval' => $tool_approval,
			'is_default' => $is_default,
		])->jsonSerialize());
	}

	/**
	 * @NoAdminRequired
	 */
	#[NoAdminRequired]
	public function update(
		int $id,
		?string $name = null,
		?int $connection_id = null,
		?string $model = null,
		?bool $streaming = null,
		?bool $reasoning = null,
		?bool $tool_approval = null,
		?bool $is_default = null,
	): DataResponse {
		$data = [];
		foreach (['name' => $name, 'connection_id' => $connection_id, 'model' => $model,
			'streaming' => $streaming, 'reasoning' => $reasoning,
			'tool_approval' => $tool_approval, 'is_default' => $is_default] as $key => $value) {
			if ($value !== null) {
				$data[$key] = $value;
			}
		}

		// system_prompt, temperature and max_tokens are nullable *values*, and
		// enabled_tools has an empty array as a meaningful value, so "not sent"
		// has to stay distinguishable from "explicitly empty" — which typed
		// parameters cannot express. Read those straight off the request.
		$sentinel = "\0absent";
		foreach (['system_prompt', 'temperature', 'max_tokens', 'enabled_tools'] as $key) {
			$value = $this->request->getParam($key, $sentinel);
			if ($value !== $sentinel) {
				$data[$key] = $value;
			}
		}

		return $this->handle(fn () => $this->service->update($id, $this->uid(), $data)->jsonSerialize());
	}

	/**
	 * @NoAdminRequired
	 */
	#[NoAdminRequired]
	public function destroy(int $id): DataResponse {
		return $this->handle(function () use ($id) {
			$this->service->delete($id, $this->uid());
			return ['status' => 'deleted'];
		});
	}

	/**
	 * @NoAdminRequired
	 */
	#[NoAdminRequired]
	public function duplicate(int $id): DataResponse {
		return $this->handle(fn () => $this->service->duplicate($id, $this->uid())->jsonSerialize());
	}

	/**
	 * @NoAdminRequired
	 */
	#[NoAdminRequired]
	public function reorder(array $ids): DataResponse {
		return $this->handle(fn () => array_map(
			static fn ($p) => $p->jsonSerialize(),
			$this->service->reorder($this->uid(), $ids)
		));
	}

	/**
	 * @NoAdminRequired
	 */
	#[NoAdminRequired]
	public function import(array $profiles, int $connection_id): DataResponse {
		return $this->handle(fn () => array_map(
			static fn ($p) => $p->jsonSerialize(),
			$this->service->import($this->uid(), $profiles, $connection_id)
		));
	}
}
