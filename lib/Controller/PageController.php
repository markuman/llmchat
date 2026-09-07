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
use OCA\LlmChat\Service\SkillService;
use OCA\LlmChat\Service\UrlHelper;
use OCP\App\IAppManager;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\ContentSecurityPolicy;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\AppFramework\Services\IInitialState;
use OCP\IRequest;
use OCP\Util;

class PageController extends Controller {
	public function __construct(
		IRequest $request,
		private IInitialState $initialState,
		private IAppManager $appManager,
		private ConnectionService $connections,
		private ProfileService $profiles,
		private SettingsService $settings,
		private SkillService $skills,
		private ?string $userId,
	) {
		parent::__construct(Application::APP_ID, $request);
	}

	#[NoAdminRequired]
	#[NoCSRFRequired]
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
		$settings = $this->settings->get($userId);
		$this->initialState->provideInitialState('settings', $settings);

		// Issue #17: metadata only, never the bodies. This is what goes into
		// every system prompt, so it has to be here rather than fetched — and
		// it has to stay small.
		$skills = $this->skills->index($userId);
		$this->initialState->provideInitialState('skills', $skills);

		// Issue #19: the installed version, read from the app manager rather
		// than hardcoded — a constant next to info.xml is a second place to
		// forget on release day, and it would report the version the bundle
		// was built from instead of the one actually installed.
		$this->initialState->provideInitialState(
			'version',
			$this->appManager->getAppVersion(Application::APP_ID)
		);

		Util::addScript(Application::APP_ID, Application::APP_ID . '-main');
		Util::addStyle(Application::APP_ID, Application::APP_ID . '-style');

		// Taken from the same listing that went into the initial state, rather
		// than asked for separately: the policy and what the browser believes
		// it may reach then cannot disagree.
		$skillDomains = [];
		foreach ($skills as $skill) {
			foreach ($skill['domains'] as $domain) {
				$skillDomains[$domain] = true;
			}
		}

		$response = new TemplateResponse(Application::APP_ID, 'main');
		$response->setContentSecurityPolicy(
			$this->buildCsp(
				$connections,
				(string)$settings['searxng_url'],
				array_keys($skillDomains)
			)
		);

		return $response;
	}

	/**
	 * Spec §7.1: Nextcloud's default CSP blocks every external fetch, so each
	 * user's base urls have to be whitelisted for connect-src — host *and*
	 * port, since `127.0.0.1` and `127.0.0.1:11434` are distinct sources.
	 *
	 * The SearXNG instance is in here for the same reason: the browser queries
	 * it directly, so the server never sees the search terms.
	 *
	 * So are the hosts a skill declares (issue #17), on the same principle and
	 * with one extra restriction: https only. A connection may be plain http
	 * because it is usually `localhost`, where TLS buys nothing; a skill talks
	 * to a public API over the internet, and there is no reason to let a line
	 * in a Markdown file open an http source in the page's policy.
	 *
	 * Note the consequence: this happens at page load. A connection created
	 * later in the modal is not in the running page's CSP, which is why the
	 * frontend reloads after a base_url change.
	 *
	 * @param \OCA\LlmChat\Db\Connection[] $connections
	 * @param list<string> $skillDomains bare hostnames declared by the skills
	 */
	private function buildCsp(
		array $connections,
		string $searxngUrl,
		array $skillDomains = [],
	): ContentSecurityPolicy {
		$csp = new ContentSecurityPolicy();

		$urls = array_map(static fn ($c) => $c->getBaseUrl(), $connections);
		if ($searxngUrl !== '') {
			$urls[] = $searxngUrl;
		}
		foreach ($skillDomains as $domain) {
			$urls[] = 'https://' . $domain;
		}

		$seen = [];
		foreach ($urls as $url) {
			$source = UrlHelper::cspSource($url);
			if ($source === null || isset($seen[$source])) {
				continue;
			}
			$seen[$source] = true;
			$csp->addAllowedConnectDomain($source);
		}

		return $csp;
	}
}
