<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\LlmChat\Controller;

use OCA\LlmChat\Service\ConnectionService;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\DataResponse;
use OCP\IRequest;
use Psr\Log\LoggerInterface;

class ConnectionsController extends ApiController {
	public function __construct(
		IRequest $request,
		LoggerInterface $logger,
		?string $userId,
		private ConnectionService $service,
	) {
		parent::__construct($request, $logger, $userId);
	}

	/**
	 * Returns connections *with* the decrypted api key — the browser is where
	 * the LLM request happens, so it needs it. Each user only ever sees their
	 * own (spec §10).
	 *
	 * @NoAdminRequired
	 */
	#[NoAdminRequired]
	public function index(): DataResponse {
		return $this->handle(fn () => array_map(
			fn ($c) => $this->service->toInitialState($c),
			$this->service->findAll($this->uid())
		));
	}

	/**
	 * @NoAdminRequired
	 */
	#[NoAdminRequired]
	public function create(
		string $name,
		string $base_url,
		?string $api_key = null,
		string $provider_hint = 'openai_compatible',
	): DataResponse {
		return $this->handle(fn () => $this->service->create($this->uid(), [
			'name' => $name,
			'base_url' => $base_url,
			'api_key' => $api_key,
			'provider_hint' => $provider_hint,
		])->jsonSerialize());
	}

	/**
	 * @NoAdminRequired
	 */
	#[NoAdminRequired]
	public function update(
		int $id,
		?string $name = null,
		?string $base_url = null,
		?string $api_key = null,
		?string $provider_hint = null,
	): DataResponse {
		$data = array_filter([
			'name' => $name,
			'base_url' => $base_url,
			'api_key' => $api_key,
			'provider_hint' => $provider_hint,
		], static fn ($v) => $v !== null);

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
}
