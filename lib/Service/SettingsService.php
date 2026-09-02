<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\LlmChat\Service;

use OCA\LlmChat\AppInfo\Application;
use OCP\IConfig;

class SettingsService {
	/** Tool rounds the agent loop may spend before it has to answer. */
	public const MIN_TOOL_ROUNDS = 3;
	public const MAX_TOOL_ROUNDS = 7;

	private const DEFAULTS = [
		'archive_folder' => '/LLM Chats',
		'archive_target' => 'files',
		'compact_mode' => false,
		'markdown_rendering' => true,
		'show_reasoning' => true,
		'default_profile_id' => null,
		'searxng_url' => '',
		'max_tool_rounds' => self::MIN_TOOL_ROUNDS,
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
			'max_tool_rounds' => $this->clampToolRounds((int)$raw),
			default => $raw,
		};
	}

	private function serialize(string $key, mixed $value): string {
		return match ($key) {
			'compact_mode', 'markdown_rendering', 'show_reasoning' => $value ? '1' : '0',
			'archive_folder' => $this->normalizeFolder((string)$value),
			'archive_target' => in_array($value, ['files'], true) ? (string)$value : 'files',
			'searxng_url' => $this->normalizeSearxngUrl((string)$value),
			'max_tool_rounds' => (string)$this->clampToolRounds((int)$value),
			default => (string)$value,
		};
	}

	/**
	 * The browser runs the agent loop, so this bound is advisory — but storing
	 * a sane value keeps a hand-edited config from turning into an endless
	 * tool loop, and the front end reads the same range.
	 */
	private function clampToolRounds(int $rounds): int {
		return max(self::MIN_TOOL_ROUNDS, min(self::MAX_TOOL_ROUNDS, $rounds));
	}

	private function normalizeSearxngUrl(string $url): string {
		$url = trim($url);
		if ($url === '') {
			return '';
		}

		// A schemeless "127.0.0.1:8888" parses as path+port with no host, so it
		// used to be discarded silently — the field looked saved but was not.
		// Assume https, except for the loopback host, which rarely has TLS.
		if (!preg_match('#^[a-z][a-z0-9+.-]*://#i', $url)) {
			$isLoopback = (bool)preg_match('#^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)(:|/|$)#i', $url);
			$url = ($isLoopback ? 'http://' : 'https://') . $url;
		}

		$parts = parse_url($url);
		$scheme = strtolower((string)($parts['scheme'] ?? ''));
		if ($parts === false || !isset($parts['host']) || ($scheme !== 'http' && $scheme !== 'https')) {
			return '';
		}

		return rtrim($url, '/');
	}

	private function normalizeFolder(string $folder): string {
		$folder = '/' . trim(str_replace('\\', '/', $folder), '/');

		return $folder === '/' ? '/LLM Chats' : $folder;
	}
}
