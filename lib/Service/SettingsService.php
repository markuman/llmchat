<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\LlmChat\Service;

use OCA\LlmChat\AppInfo\Application;
use OCP\IConfig;

class SettingsService {
	private const DEFAULTS = [
		'archive_folder' => '/LLM Chats',
		'archive_target' => 'files',
		'compact_mode' => false,
		'markdown_rendering' => true,
		'show_reasoning' => true,
		'default_profile_id' => null,
	];

	public function __construct(
		private IConfig $config,
	) {
	}

	public function get(string $userId): array {
		$settings = [];

		foreach (self::DEFAULTS as $key => $default) {
			$raw = $this->config->getUserValue($userId, Application::APP_ID, $key, '');
			$settings[$key] = $raw === '' ? $default : $this->cast($key, $raw);
		}

		return $settings;
	}

	public function update(string $userId, array $data): array {
		foreach (self::DEFAULTS as $key => $default) {
			if (!array_key_exists($key, $data)) {
				continue;
			}

			$value = $data[$key];
			if ($value === null) {
				$this->config->deleteUserValue($userId, Application::APP_ID, $key);
				continue;
			}

			$this->config->setUserValue(
				$userId,
				Application::APP_ID,
				$key,
				$this->serialize($key, $value)
			);
		}

		return $this->get($userId);
	}

	private function cast(string $key, string $raw): mixed {
		return match ($key) {
			'compact_mode', 'markdown_rendering', 'show_reasoning' => $raw === '1',
			'default_profile_id' => (int)$raw,
			default => $raw,
		};
	}

	private function serialize(string $key, mixed $value): string {
		return match ($key) {
			'compact_mode', 'markdown_rendering', 'show_reasoning' => $value ? '1' : '0',
			'archive_folder' => $this->normalizeFolder((string)$value),
			'archive_target' => in_array($value, ['files'], true) ? (string)$value : 'files',
			default => (string)$value,
		};
	}

	private function normalizeFolder(string $folder): string {
		$folder = '/' . trim(str_replace('\\', '/', $folder), '/');

		return $folder === '/' ? '/LLM Chats' : $folder;
	}
}
