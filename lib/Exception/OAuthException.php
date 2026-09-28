<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\LlmChat\Exception;

/**
 * A token endpoint said no. Carries the RFC 6749 `error` code, because
 * `invalid_grant` (the grant is dead, sign in again) has to be told apart
 * from everything else (try again later).
 */
class OAuthException extends \RuntimeException {
	public function __construct(
		string $message,
		private string $errorCode = '',
	) {
		parent::__construct($message);
	}

	public function getErrorCode(): string {
		return $this->errorCode;
	}
}
