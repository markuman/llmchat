<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\LlmChat\Controller;

use OCA\LlmChat\AppInfo\Application;
use OCA\LlmChat\Service\McpService;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\Attribute\UserRateLimit;
use OCP\AppFramework\Http\ContentSecurityPolicy;
use OCP\AppFramework\Http\DataResponse;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\IRequest;
use OCP\Util;
use Psr\Log\LoggerInterface;

/**
 * External MCP servers (issue #11) — CRUD, OAuth sign-in and the JSON-RPC
 * proxy. See McpService for why the proxy exists at all.
 */
class McpController extends ApiController {
	public function __construct(
		IRequest $request,
		LoggerInterface $logger,
		?string $userId,
		private McpService $service,
	) {
		parent::__construct($request, $logger, $userId);
	}

	#[NoAdminRequired]
	public function index(): DataResponse {
		return $this->handle(fn () => array_map(
			static fn ($s) => $s->jsonSerialize(),
			$this->service->findAll($this->uid())
		));
	}

	#[NoAdminRequired]
	public function create(
		string $name,
		string $url,
		string $auth_type = 'none',
		bool $enabled = true,
		?string $token = null,
		?string $client_id = null,
		?string $client_secret = null,
	): DataResponse {
		return $this->handle(fn () => $this->service->create($this->uid(), [
			'name' => $name,
			'url' => $url,
			'auth_type' => $auth_type,
			'enabled' => $enabled,
			'token' => $token,
			'client_id' => $client_id,
			'client_secret' => $client_secret,
		])->jsonSerialize());
	}

	/**
	 * `client_id` is the one field where an explicit empty string matters —
	 * it switches back to dynamic registration — so it is taken off the raw
	 * parameters instead of through a nullable argument that cannot tell
	 * "absent" from "cleared".
	 */
	#[NoAdminRequired]
	public function update(
		int $id,
		?string $name = null,
		?string $url = null,
		?string $auth_type = null,
		?bool $enabled = null,
		?string $token = null,
		?string $client_secret = null,
	): DataResponse {
		$data = array_filter([
			'name' => $name,
			'url' => $url,
			'auth_type' => $auth_type,
			'enabled' => $enabled,
			'token' => $token,
			'client_secret' => $client_secret,
		], static fn ($v) => $v !== null);

		$params = $this->request->getParams();
		if (array_key_exists('client_id', $params)) {
			$data['client_id'] = $params['client_id'];
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

	/**
	 * Returns the authorization url for the popup. Rate limited: every call
	 * runs discovery against a foreign host, and may register a client there.
	 */
	#[NoAdminRequired]
	#[UserRateLimit(limit: 20, period: 60)]
	public function connect(int $id): DataResponse {
		return $this->handle(fn () => $this->service->connect($id, $this->uid()));
	}

	#[NoAdminRequired]
	public function disconnect(int $id): DataResponse {
		return $this->handle(fn () => $this->service->disconnect($id, $this->uid())->jsonSerialize());
	}

	/**
	 * The proxy. `payload` is the JSON-RPC message as a string on purpose —
	 * see McpService::rpc() for what decoding it here would break.
	 *
	 * The limit is generous because one chat turn is several messages
	 * (initialize, initialized, tools/list per server, then the calls), but
	 * it still bounds what one account can relay through this server.
	 */
	#[NoAdminRequired]
	#[UserRateLimit(limit: 120, period: 60)]
	public function rpc(int $id, string $payload = '', ?string $session_id = null): DataResponse {
		return $this->handle(fn () => $this->service->rpc($id, $this->uid(), $payload, $session_id));
	}

	/**
	 * Where the authorization server sends the popup back to.
	 *
	 * NoCSRFRequired because it is a top-level navigation from a foreign
	 * site, which cannot carry our token; `state` does that job instead —
	 * random, bound to one server of the signed-in user, and single use.
	 * Still session authenticated: a callback for somebody else's sign-in
	 * finds no matching state.
	 */
	#[NoAdminRequired]
	#[NoCSRFRequired]
	public function oauthCallback(string $state = '', string $code = '', string $error = '', string $iss = ''): TemplateResponse {
		try {
			$result = $this->service->handleCallback($this->uid(), $state, $code, $error, $iss);
		} catch (\Throwable $e) {
			$this->logger->error('llmchat mcp oauth callback failed', ['exception' => $e]);
			$result = ['ok' => false, 'server_id' => null, 'name' => null, 'message' => 'internal server error'];
		}

		Util::addScript(Application::APP_ID, Application::APP_ID . '-oauthcallback');

		$response = new TemplateResponse(Application::APP_ID, 'oauth-callback', [
			'ok' => $result['ok'],
			'server_id' => $result['server_id'],
			'name' => $result['name'],
			'message' => $result['message'],
		], TemplateResponse::RENDER_AS_GUEST);
		$response->setContentSecurityPolicy(new ContentSecurityPolicy());

		return $response;
	}
}
