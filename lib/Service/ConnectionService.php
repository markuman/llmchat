<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\LlmChat\Service;

use OCA\LlmChat\Db\Connection;
use OCA\LlmChat\Db\ConnectionMapper;
use OCA\LlmChat\Db\ProfileMapper;
use OCA\LlmChat\Exception\BadRequestException;
use OCA\LlmChat\Exception\ConflictException;
use OCA\LlmChat\Exception\NotFoundException;
use OCP\AppFramework\Db\DoesNotExistException;
use OCP\AppFramework\Db\MultipleObjectsReturnedException;
use OCP\Security\ICrypto;
use Psr\Log\LoggerInterface;

class ConnectionService {
	private const PROVIDER_HINTS = ['ollama', 'openai_compatible', 'openrouter'];

	public function __construct(
		private ConnectionMapper $mapper,
		private ProfileMapper $profileMapper,
		private ICrypto $crypto,
		private LoggerInterface $logger,
	) {
	}

	/**
	 * @return Connection[]
	 */
	public function findAll(string $userId): array {
		return $this->mapper->findAllForUser($userId);
	}

	public function find(int $id, string $userId): Connection {
		try {
			return $this->mapper->findForUser($id, $userId);
		} catch (DoesNotExistException|MultipleObjectsReturnedException) {
			throw new NotFoundException('connection not found');
		}
	}

	public function create(string $userId, array $data): Connection {
		$now = (new \DateTimeImmutable())->format(\DateTimeInterface::ATOM);

		$connection = new Connection();
		$connection->setUserId($userId);
		$connection->setName($this->requireName($data['name'] ?? ''));
		$connection->setBaseUrl(UrlHelper::normalizeBaseUrl((string)($data['base_url'] ?? '')));
		$connection->setProviderHint($this->normalizeHint($data['provider_hint'] ?? 'openai_compatible'));
		$connection->setApiKey($this->encrypt((string)($data['api_key'] ?? '')));
		$connection->setCreatedAt($now);
		$connection->setUpdatedAt($now);

		return $this->mapper->insert($connection);
	}

	/**
	 * An absent `api_key` key leaves the stored key untouched — the client
	 * never receives it back, so it cannot echo it either. An explicit empty
	 * string clears it.
	 */
	public function update(int $id, string $userId, array $data): Connection {
		$connection = $this->find($id, $userId);

		if (array_key_exists('name', $data)) {
			$connection->setName($this->requireName((string)$data['name']));
		}
		if (array_key_exists('base_url', $data)) {
			$connection->setBaseUrl(UrlHelper::normalizeBaseUrl((string)$data['base_url']));
		}
		if (array_key_exists('provider_hint', $data)) {
			$connection->setProviderHint($this->normalizeHint((string)$data['provider_hint']));
		}
		if (array_key_exists('api_key', $data) && $data['api_key'] !== null) {
			$connection->setApiKey($this->encrypt((string)$data['api_key']));
		}

		$connection->setUpdatedAt((new \DateTimeImmutable())->format(\DateTimeInterface::ATOM));

		return $this->mapper->update($connection);
	}

	/**
	 * Decision on spec §11: deleting a connection that is still referenced
	 * by profiles is blocked rather than cascaded. Losing a profile because
	 * you rotated a key is a worse outcome than an error message.
	 */
	public function delete(int $id, string $userId): void {
		$connection = $this->find($id, $userId);

		$profiles = $this->profileMapper->findByConnection($id, $userId);
		if (count($profiles) > 0) {
			$names = array_map(static fn ($p) => $p->getName(), $profiles);
			throw new ConflictException(
				'connection is still used by: ' . implode(', ', $names)
			);
		}

		$this->mapper->delete($connection);
	}

	/**
	 * Serialises for the initial state. This is the *only* place where the
	 * decrypted key leaves the server, and it goes to the browser of the very
	 * user it belongs to — which is where the request has to be made from.
	 */
	public function toInitialState(Connection $connection): array {
		$data = $connection->jsonSerialize();
		$data['api_key'] = $this->decrypt($connection->getApiKey());

		return $data;
	}

	private function encrypt(string $plain): ?string {
		if ($plain === '') {
			return null;
		}

		return $this->crypto->encrypt($plain);
	}

	private function decrypt(?string $encrypted): string {
		if ($encrypted === null || $encrypted === '') {
			return '';
		}

		try {
			return $this->crypto->decrypt($encrypted);
		} catch (\Throwable $e) {
			$this->logger->warning('could not decrypt llm api key', ['exception' => $e]);
			return '';
		}
	}

	private function requireName(string $name): string {
		$name = trim($name);
		if ($name === '') {
			throw new BadRequestException('name must not be empty');
		}

		return mb_substr($name, 0, 128);
	}

	private function normalizeHint(string $hint): string {
		return in_array($hint, self::PROVIDER_HINTS, true) ? $hint : 'openai_compatible';
	}
}
