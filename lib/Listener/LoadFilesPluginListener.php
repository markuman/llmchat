<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\LlmChat\Listener;

use OCA\Files\Event\LoadAdditionalScriptsEvent;
use OCA\LlmChat\AppInfo\Application;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use OCP\Util;

/**
 * Adds the "LLM Chat" entry to the Files app menu (issue #20).
 *
 * @template-implements IEventListener<LoadAdditionalScriptsEvent>
 */
class LoadFilesPluginListener implements IEventListener {
	public function handle(Event $event): void {
		if (!$event instanceof LoadAdditionalScriptsEvent) {
			return;
		}

		// Its own bundle, not the app's: this runs on every Files page view,
		// and the main bundle is a chat client. No style goes with it — the
		// action is a menu entry rendered by the Files app itself.
		Util::addScript(Application::APP_ID, Application::APP_ID . '-filesplugin');
	}
}
