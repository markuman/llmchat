<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\LlmChat\Service;

use OCA\LlmChat\Exception\BadRequestException;
use OCP\Files\Folder;
use OCP\Files\IRootFolder;
use OCP\Files\NotFoundException as FilesNotFoundException;
use OCP\Files\NotPermittedException;
use OCP\IL10N;

/**
 * Writes archived chats into the user's files (spec §6.2).
 *
 * The server does the writing — not the browser via WebDAV — so that the
 * path logic lives in exactly one place.
 */
class ArchiveService {
	public function __construct(
		private IRootFolder $rootFolder,
		private SettingsService $settings,
		private IL10N $l10n,
	) {
	}

	/**
	 * @return array{path: string, name: string, file_id: int}
	 */
	public function store(string $userId, array $data): array {
		$title = trim((string)($data['title'] ?? ''));
		if ($title === '') {
			$title = $this->l10n->t('Untitled chat');
		}

		$body = (string)($data['markdown'] ?? '');
		if (trim($body) === '') {
			throw new BadRequestException('markdown must not be empty');
		}

		$created = $this->parseDate((string)($data['created_at'] ?? ''));
		$settings = $this->settings->get($userId);

		$userFolder = $this->rootFolder->getUserFolder($userId);
		$targetDir = $this->ensureFolder(
			$userFolder,
			trim($settings['archive_folder'], '/') . '/' . $created->format('Y')
		);

		$content = $this->frontMatter($title, $created, $data) . "\n" . rtrim($body) . "\n";
		$filename = $this->uniqueName(
			$targetDir,
			$created->format('Y-m-d') . '-' . $this->slug($title)
		);

		$file = $targetDir->newFile($filename, $content);

		return [
			'path' => $userFolder->getRelativePath($file->getPath()) ?? $file->getPath(),
			'name' => $file->getName(),
			'file_id' => $file->getId(),
		];
	}

	private function frontMatter(string $title, \DateTimeImmutable $created, array $data): string {
		$lines = ['---'];
		$lines[] = 'title: ' . $this->yamlScalar($title);
		$lines[] = 'date: ' . $created->format(\DateTimeInterface::ATOM);

		$profile = trim((string)($data['profile'] ?? ''));
		if ($profile !== '') {
			$lines[] = 'profile: ' . $this->yamlScalar($profile);
		}

		$model = trim((string)($data['model'] ?? ''));
		if ($model !== '') {
			$lines[] = 'model: ' . $this->yamlScalar($model);
		}

		$systemPrompt = (string)($data['system_prompt'] ?? '');
		if (trim($systemPrompt) !== '') {
			$lines[] = 'system_prompt: |';
			foreach (preg_split('/\r\n|\r|\n/', rtrim($systemPrompt)) as $line) {
				$lines[] = '  ' . $line;
			}
		}

		$lines[] = '---';

		return implode("\n", $lines) . "\n";
	}

	/**
	 * Quotes only when the value could be misread as YAML structure.
	 */
	private function yamlScalar(string $value): string {
		$value = str_replace(["\r", "\n"], ' ', $value);

		if (preg_match('/^[^\s\-?:,\[\]{}#&*!|>\'"%@`][^:#]*$/u', $value) === 1) {
			return $value;
		}

		return '"' . str_replace(['\\', '"'], ['\\\\', '\"'], $value) . '"';
	}

	private function parseDate(string $raw): \DateTimeImmutable {
		if ($raw === '') {
			return new \DateTimeImmutable();
		}

		try {
			return new \DateTimeImmutable($raw);
		} catch (\Exception) {
			return new \DateTimeImmutable();
		}
	}

	/**
	 * @throws NotPermittedException
	 */
	private function ensureFolder(Folder $root, string $relativePath): Folder {
		$current = $root;

		foreach (explode('/', $relativePath) as $segment) {
			$segment = $this->sanitizeSegment($segment);
			if ($segment === '') {
				continue;
			}

			try {
				$node = $current->get($segment);
				if (!$node instanceof Folder) {
					throw new BadRequestException('archive path is blocked by a file: ' . $segment);
				}
				$current = $node;
			} catch (FilesNotFoundException) {
				$current = $current->newFolder($segment);
			}
		}

		return $current;
	}

	private function uniqueName(Folder $folder, string $base): string {
		$name = $base . '.md';
		$counter = 2;

		while ($folder->nodeExists($name)) {
			$name = $base . '-' . $counter . '.md';
			$counter++;
		}

		return $name;
	}

	private function sanitizeSegment(string $segment): string {
		$segment = str_replace(['/', '\\', "\0"], '', trim($segment));

		return $segment === '.' || $segment === '..' ? '' : $segment;
	}

	private function slug(string $title): string {
		$slug = mb_strtolower($title, 'UTF-8');
		$slug = strtr($slug, [
			'ä' => 'ae', 'ö' => 'oe', 'ü' => 'ue', 'ß' => 'ss',
			'à' => 'a', 'á' => 'a', 'â' => 'a', 'ã' => 'a', 'å' => 'a',
			'è' => 'e', 'é' => 'e', 'ê' => 'e', 'ë' => 'e',
			'ì' => 'i', 'í' => 'i', 'î' => 'i', 'ï' => 'i',
			'ò' => 'o', 'ó' => 'o', 'ô' => 'o', 'õ' => 'o',
			'ù' => 'u', 'ú' => 'u', 'û' => 'u',
			'ñ' => 'n', 'ç' => 'c',
		]);
		$slug = preg_replace('/[^a-z0-9]+/u', '-', $slug) ?? '';
		$slug = trim($slug, '-');
		$slug = mb_substr($slug, 0, 60);

		return $slug === '' ? 'chat' : $slug;
	}
}
