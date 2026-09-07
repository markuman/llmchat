<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Stub for static analysis only — never loaded at runtime.
 *
 * `OCA\Files\Event\LoadAdditionalScriptsEvent` is a public extension point
 * that apps are expected to listen on, but it lives in the Files *app*, not
 * in OCP, so `nextcloud/ocp` does not ship it. Without this, psalm reports the
 * listener's own type as undefined.
 *
 * A stub rather than a suppression in psalm.xml: the listener stays
 * type-checked against a real signature, and if the event ever moves or
 * changes shape, that shows up here instead of being silently ignored.
 */

namespace OCA\Files\Event;

use OCP\EventDispatcher\Event;

class LoadAdditionalScriptsEvent extends Event {
}
