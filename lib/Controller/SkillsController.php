<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\LlmChat\Controller;

use OCA\LlmChat\Service\SkillService;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\DataResponse;
use OCP\IRequest;
use Psr\Log\LoggerInterface;

/**
 * Skills (issue #17).
 *
 * Reading goes through the server rather than WebDAV because the front matter
 * has to be in the initial state, and having two ways to read the same files
 * would mean two places to keep the parser.
 */
class SkillsController extends ApiController {
	public function __construct(
		IRequest $request,
		LoggerInterface $logger,
		?string $userId,
		private SkillService $service,
	) {
		parent::__construct($request, $logger, $userId);
	}

	#[NoAdminRequired]
	public function index(): DataResponse {
		return $this->handle(fn () => $this->service->index($this->uid()));
	}

	/**
	 * Creates the skills folder and the example skill. Called when the
	 * setting is switched on.
	 */
	#[NoAdminRequired]
	public function provision(): DataResponse {
		return $this->handle(fn () => $this->service->provision($this->uid()));
	}

	/**
	 * One skill including its body — what `skill_read` calls.
	 */
	#[NoAdminRequired]
	public function show(string $id): DataResponse {
		return $this->handle(fn () => $this->service->read($this->uid(), $id));
	}
}
