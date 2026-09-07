<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\LlmChat\AppInfo;

use OCA\Files\Event\LoadAdditionalScriptsEvent;
use OCA\LlmChat\Listener\LoadFilesPluginListener;
use OCP\AppFramework\App;
use OCP\AppFramework\Bootstrap\IBootContext;
use OCP\AppFramework\Bootstrap\IBootstrap;
use OCP\AppFramework\Bootstrap\IRegistrationContext;

class Application extends App implements IBootstrap {
	public const APP_ID = 'llmchat';

	public function __construct(array $urlParams = []) {
		parent::__construct(self::APP_ID, $urlParams);
	}

	public function register(IRegistrationContext $context): void {
		// Issue #20: the "LLM Chat" entry in the Files menu.
		//
		// Registering by class name costs nothing when the Files app is
		// disabled — the event simply never fires, and neither the listener
		// nor the event class is ever loaded.
		$context->registerEventListener(
			LoadAdditionalScriptsEvent::class,
			LoadFilesPluginListener::class
		);
	}

	public function boot(IBootContext $context): void {
	}
}
