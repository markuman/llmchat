<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\LlmChat\Exception;

/**
 * An MCP server wants credentials the proxy does not have (issue #11).
 *
 * Not a BadRequestException on purpose: this is a normal state the browser
 * has to act on — point the user at the settings — rather than an error to
 * hand the model, which would only try the same call again.
 */
class McpAuthRequiredException extends \RuntimeException {
}
