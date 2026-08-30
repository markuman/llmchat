<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\LlmChat\Controller;

use OCA\LlmChat\AppInfo\Application;
use OCA\LlmChat\Service\ConnectionService;
use OCA\LlmChat\Service\ProfileService;
use OCA\LlmChat\Service\SettingsService;
use OCA\LlmChat\Service\UrlHelper;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\ContentSecurityPolicy;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\AppFramework\Services\IInitialState;
use OCP\IRequest;
use OCP\Util;

class PageController extends Controller {
	public function __construct(
		IRequest $request,
		private IInitialState $initialState,
		private ConnectionService $connections,
		private ProfileService $profiles,
		private SettingsService $settings,
		private ?string $userId,
	) {
		parent::__construct(Application::APP_ID, $request);
	}

	/**
	 * @NoAdminRequired
	 * @NoCSRFRequired
	 */
	#[\OCP\AppFramework\Http\Attribute\NoAdminRequired]
	#[\OCP\AppFramework\Http\Attribute\NoCSRFRequired]
	public function index(): TemplateResponse {
		$userId = (string)$this->userId;

		$connections = $this->connections->findAll($userId);

		// Connections and profiles go into the initial state instead of being
		// fetched — otherwise the profile switcher flickers on load (spec §9).
		$this->initialState->provideInitialState(
			'connections',
			array_map(fn ($c) => $this->connections->toInitialState($c), $connections)
		);
		$this->initialState->provideInitialState(
			'profiles',
			array_map(static fn ($p) => $p->jsonSerialize(), $this->profiles->findAll($userId))
		);
		$this->initialState->provideInitialState('settings', $this->settings->get($userId));

		Util::addScript(Application::APP_ID, Application::APP_ID . '-main');
		Util::addStyle(Application::APP_ID, Application::APP_ID . '-style');

		$response = new TemplateResponse(Application::APP_ID, 'main');
		$response->setContentSecurityPolicy($this->buildCsp($connections));

		return $response;
	}

	/**
	 * Spec §7.1: Nextcloud's default CSP blocks every external fetch, so each
	 * user's base urls have to be whitelisted for connect-src — host *and*
	 * port, since `127.0.0.1` and `127.0.0.1:11434` are distinct sources.
	 *
	 * Note the consequence: this happens at page load. A connection created
	 * later in the modal is not in the running page's CSP, which is why the
	 * frontend reloads after a base_url change.
	 *
	 * @param \OCA\LlmChat\Db\Connection[] $connections
	 */
	private function buildCsp(array $connections): ContentSecurityPolicy {
		$csp = new ContentSecurityPolicy();

		$seen = [];
		foreach ($connections as $connection) {
			$source = UrlHelper::cspSource($connection->getBaseUrl());
			if ($source === null || isset($seen[$source])) {
				continue;
			}
			$seen[$source] = true;
			$csp->addAllowedConnectDomain($source);
		}

		return $csp;
	}
}
