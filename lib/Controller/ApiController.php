<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\LlmChat\Controller;

use OCA\LlmChat\AppInfo\Application;
use OCA\LlmChat\Exception\BadRequestException;
use OCA\LlmChat\Exception\ConflictException;
use OCA\LlmChat\Exception\NotFoundException;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\DataResponse;
use OCP\IRequest;
use Psr\Log\LoggerInterface;

/**
 * Shared error handling for the JSON endpoints.
 *
 * All routes are session authenticated: no NoCSRFRequired, no PublicPage
 * (spec §9).
 */
abstract class ApiController extends Controller {
	public function __construct(
		IRequest $request,
		protected LoggerInterface $logger,
		protected ?string $userId,
	) {
		parent::__construct(Application::APP_ID, $request);
	}

	protected function uid(): string {
		return (string)$this->userId;
	}

	protected function handle(callable $callback): DataResponse {
		try {
			return new DataResponse($callback());
		} catch (BadRequestException $e) {
			return new DataResponse(['message' => $e->getMessage()], Http::STATUS_BAD_REQUEST);
		} catch (NotFoundException $e) {
			return new DataResponse(['message' => $e->getMessage()], Http::STATUS_NOT_FOUND);
		} catch (ConflictException $e) {
			return new DataResponse(['message' => $e->getMessage()], Http::STATUS_CONFLICT);
		} catch (\Throwable $e) {
			$this->logger->error('llmchat api error', ['exception' => $e]);
			return new DataResponse(
				['message' => 'internal server error'],
				Http::STATUS_INTERNAL_SERVER_ERROR
			);
		}
	}
}
