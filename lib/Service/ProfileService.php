<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\LlmChat\Service;

use OCA\LlmChat\Db\Profile;
use OCA\LlmChat\Db\ProfileMapper;
use OCA\LlmChat\Exception\BadRequestException;
use OCA\LlmChat\Exception\NotFoundException;
use OCP\AppFramework\Db\DoesNotExistException;
use OCP\AppFramework\Db\MultipleObjectsReturnedException;
use OCP\IL10N;

class ProfileService {
	/**
	 * Valid tool ids. Kept in sync with TOOL_IDS in src/services/tools.js —
	 * the frontend decides which definitions to send, this list makes sure
	 * nothing unknown ever reaches the database.
	 */
	public const TOOL_IDS = ['datetime', 'web_search', 'web_fetch', 'nc_read'];

	public function __construct(
		private ProfileMapper $mapper,
		private ConnectionService $connections,
		private IL10N $l10n,
	) {
	}

	/**
	 * @return Profile[]
	 */
	public function findAll(string $userId): array {
		return $this->mapper->findAllForUser($userId);
	}

	public function find(int $id, string $userId): Profile {
		try {
			return $this->mapper->findForUser($id, $userId);
		} catch (DoesNotExistException|MultipleObjectsReturnedException) {
			throw new NotFoundException('profile not found');
		}
	}

	public function create(string $userId, array $data): Profile {
		$profile = new Profile();
		$profile->setUserId($userId);
		$profile->setName($this->requireName($data['name'] ?? ''));
		$profile->setModel($this->requireModel($data['model'] ?? ''));
		$profile->setConnectionId($this->requireConnection((int)($data['connection_id'] ?? 0), $userId));
		$profile->setSystemPrompt($this->nullableString($data['system_prompt'] ?? null));
		$profile->setTemperature($this->nullableFloat($data['temperature'] ?? null));
		$profile->setMaxTokens($this->nullableInt($data['max_tokens'] ?? null));
		$profile->setStreaming((bool)($data['streaming'] ?? true));
		$profile->setReasoning((bool)($data['reasoning'] ?? true));
		$profile->setEnabledTools($this->normalizeTools($data['enabled_tools'] ?? []));
		$profile->setToolApproval((bool)($data['tool_approval'] ?? true));
		$profile->setToolRounds($this->nullableToolRounds($data['tool_rounds'] ?? null));
		$profile->setVision((bool)($data['vision'] ?? false));
		$profile->setSortOrder($this->mapper->maxSortOrder($userId) + 1);

		// the very first profile is the default, no matter what the client says
		$isFirst = count($this->mapper->findAllForUser($userId)) === 0;
		$makeDefault = $isFirst || (bool)($data['is_default'] ?? false);
		$profile->setIsDefault($makeDefault);

		$profile = $this->mapper->insert($profile);

		if ($makeDefault) {
			$this->mapper->clearDefault($userId, $profile->getId());
		}

		return $profile;
	}

	public function update(int $id, string $userId, array $data): Profile {
		$profile = $this->find($id, $userId);

		if (array_key_exists('name', $data)) {
			$profile->setName($this->requireName((string)$data['name']));
		}
		if (array_key_exists('model', $data)) {
			$profile->setModel($this->requireModel((string)$data['model']));
		}
		if (array_key_exists('connection_id', $data)) {
			$profile->setConnectionId($this->requireConnection((int)$data['connection_id'], $userId));
		}
		if (array_key_exists('system_prompt', $data)) {
			$profile->setSystemPrompt($this->nullableString($data['system_prompt']));
		}
		if (array_key_exists('temperature', $data)) {
			$profile->setTemperature($this->nullableFloat($data['temperature']));
		}
		if (array_key_exists('max_tokens', $data)) {
			$profile->setMaxTokens($this->nullableInt($data['max_tokens']));
		}
		if (array_key_exists('streaming', $data)) {
			$profile->setStreaming((bool)$data['streaming']);
		}
		if (array_key_exists('reasoning', $data)) {
			$profile->setReasoning((bool)$data['reasoning']);
		}
		if (array_key_exists('enabled_tools', $data)) {
			$profile->setEnabledTools($this->normalizeTools($data['enabled_tools']));
		}
		if (array_key_exists('tool_approval', $data)) {
			$profile->setToolApproval((bool)$data['tool_approval']);
		}
		if (array_key_exists('tool_rounds', $data)) {
			$profile->setToolRounds($this->nullableToolRounds($data['tool_rounds']));
		}
		if (array_key_exists('vision', $data)) {
			$profile->setVision((bool)$data['vision']);
		}

		$makeDefault = array_key_exists('is_default', $data) && (bool)$data['is_default'];
		if ($makeDefault) {
			$profile->setIsDefault(true);
		}

		$profile = $this->mapper->update($profile);

		if ($makeDefault) {
			$this->mapper->clearDefault($userId, $profile->getId());
		}

		return $profile;
	}

	/**
	 * Spec §3.3: copies one row, references the connection instead of
	 * copying it, never touches secrets.
	 */
	public function duplicate(int $id, string $userId): Profile {
		$source = $this->find($id, $userId);

		$copy = new Profile();
		$copy->setUserId($userId);
		$copy->setConnectionId($source->getConnectionId());
		$copy->setName($this->l10n->t('%s (copy)', [$source->getName()]));
		$copy->setModel($source->getModel());
		$copy->setSystemPrompt($source->getSystemPrompt());
		$copy->setTemperature($source->getTemperature());
		$copy->setMaxTokens($source->getMaxTokens());
		$copy->setStreaming($source->getStreaming());
		$copy->setReasoning($source->getReasoning());
		$copy->setEnabledTools($source->getEnabledTools());
		$copy->setToolApproval($source->getToolApproval());
		$copy->setToolRounds($source->getToolRounds());
		$copy->setVision($source->getVision());
		$copy->setIsDefault(false);
		$copy->setSortOrder($source->getSortOrder() + 1);

		$copy = $this->mapper->insert($copy);
		$this->shiftSortOrderAfter($userId, $source->getSortOrder(), $copy->getId());

		return $copy;
	}

	public function delete(int $id, string $userId): void {
		$profile = $this->find($id, $userId);
		$wasDefault = $profile->getIsDefault();

		$this->mapper->delete($profile);

		if ($wasDefault) {
			$remaining = $this->mapper->findAllForUser($userId);
			if (count($remaining) > 0) {
				$next = $remaining[0];
				$next->setIsDefault(true);
				$this->mapper->update($next);
			}
		}
	}

	/**
	 * @param array<mixed> $orderedIds straight from the request, hence the cast
	 * @return Profile[]
	 */
	public function reorder(string $userId, array $orderedIds): array {
		$position = 0;
		foreach ($orderedIds as $id) {
			try {
				$profile = $this->find((int)$id, $userId);
			} catch (NotFoundException) {
				continue;
			}
			$profile->setSortOrder($position++);
			$this->mapper->update($profile);
		}

		return $this->findAll($userId);
	}

	/**
	 * Spec §3.4: import assigns every incoming profile to a connection the
	 * user picked; nothing about credentials travels in the file.
	 *
	 * @return Profile[]
	 */
	public function import(string $userId, array $profiles, int $connectionId): array {
		$this->requireConnection($connectionId, $userId);

		$created = [];
		foreach ($profiles as $raw) {
			if (!is_array($raw)) {
				continue;
			}
			$created[] = $this->create($userId, [
				'name' => $raw['name'] ?? $this->l10n->t('Imported profile'),
				'model' => $raw['model'] ?? '',
				'connection_id' => $connectionId,
				'system_prompt' => $raw['system_prompt'] ?? null,
				'temperature' => $raw['temperature'] ?? null,
				'max_tokens' => $raw['max_tokens'] ?? null,
				'streaming' => $raw['streaming'] ?? true,
				'reasoning' => $raw['reasoning'] ?? true,
				'enabled_tools' => $raw['enabled_tools'] ?? [],
				'tool_approval' => $raw['tool_approval'] ?? true,
				'tool_rounds' => $raw['tool_rounds'] ?? null,
				'vision' => $raw['vision'] ?? false,
				'is_default' => false,
			]);
		}

		return $created;
	}

	private function shiftSortOrderAfter(string $userId, int $afterOrder, int $exceptId): void {
		foreach ($this->mapper->findAllForUser($userId) as $profile) {
			if ($profile->getId() === $exceptId) {
				continue;
			}
			if ($profile->getSortOrder() > $afterOrder) {
				$profile->setSortOrder($profile->getSortOrder() + 1);
				$this->mapper->update($profile);
			}
		}
	}

	private function requireConnection(int $connectionId, string $userId): int {
		// throws NotFoundException if it is not the user's connection
		$this->connections->find($connectionId, $userId);

		return $connectionId;
	}

	private function requireName(string $name): string {
		$name = trim($name);
		if ($name === '') {
			throw new BadRequestException('name must not be empty');
		}

		return mb_substr($name, 0, 128);
	}

	private function requireModel(string $model): string {
		$model = trim($model);
		if ($model === '') {
			throw new BadRequestException('model must not be empty');
		}

		return mb_substr($model, 0, 255);
	}

	/**
	 * Accepts an array or a comma separated string, keeps only known ids and
	 * drops duplicates. Unknown ids are silently discarded rather than
	 * rejected: an import from a newer version should lose the tool it does
	 * not know, not fail outright.
	 */
	private function normalizeTools(mixed $value): string {
		if (is_string($value)) {
			$value = explode(',', $value);
		}
		if (!is_array($value)) {
			return '';
		}

		$ids = array_map(static fn ($v) => trim((string)$v), $value);
		$ids = array_values(array_unique(array_filter(
			$ids,
			static fn ($v) => in_array($v, self::TOOL_IDS, true)
		)));

		return implode(',', $ids);
	}

	private function nullableString(mixed $value): ?string {
		if ($value === null) {
			return null;
		}
		$value = (string)$value;

		return $value === '' ? null : $value;
	}

	private function nullableFloat(mixed $value): ?float {
		if ($value === null || $value === '') {
			return null;
		}

		return max(0.0, min(2.0, (float)$value));
	}

	private function nullableInt(mixed $value): ?int {
		if ($value === null || $value === '') {
			return null;
		}
		$int = (int)$value;

		return $int > 0 ? $int : null;
	}

	/**
	 * Per-profile override of the agent loop's tool budget.
	 *
	 * null stays null — that is "follow the general setting", not "zero
	 * rounds". Anything else is clamped into the same range as the general
	 * setting, so a profile cannot be edited or imported into an unbounded
	 * loop.
	 */
	private function nullableToolRounds(mixed $value): ?int {
		if ($value === null || $value === '') {
			return null;
		}

		return SettingsService::clampToolRounds((int)$value);
	}
}
