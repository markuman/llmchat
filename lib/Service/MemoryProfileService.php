<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\LlmChat\Service;

use OCA\LlmChat\Db\MemoryProfile;
use OCA\LlmChat\Db\MemoryProfileMapper;
use OCA\LlmChat\Db\ProfileMapper;
use OCA\LlmChat\Exception\BadRequestException;
use OCA\LlmChat\Exception\ConflictException;
use OCA\LlmChat\Exception\NotFoundException;
use OCP\AppFramework\Db\DoesNotExistException;
use OCP\AppFramework\Db\MultipleObjectsReturnedException;
use OCP\Files\File;
use OCP\Files\Folder;
use OCP\Files\InvalidPathException;
use OCP\Files\IRootFolder;
use OCP\Files\NotFoundException as FilesNotFoundException;
use OCP\Files\NotPermittedException;

/**
 * CRUD for memory profiles (3.0.0).
 *
 * The memory itself is one Markdown file in the user's home. The browser
 * reads and writes it over WebDAV with ETags; this service only stores where
 * it is and creates it once, empty, so the very first write has a folder to
 * land in. Creating it is the one and only time PHP touches that file.
 */
class MemoryProfileService {
	public const DEFAULT_FOLDER = 'LLM Memory';
	public const DEFAULT_MAX_CHARS = 12000;
	public const MIN_MAX_CHARS = 1000;
	public const MAX_MAX_CHARS = 100000;
	public const DEFAULT_THRESHOLD = 80;

	public function __construct(
		private MemoryProfileMapper $mapper,
		private ProfileMapper $profileMapper,
		private IRootFolder $rootFolder,
	) {
	}

	/**
	 * @return MemoryProfile[]
	 */
	public function findAll(string $userId): array {
		return $this->mapper->findAllForUser($userId);
	}

	public function find(int $id, string $userId): MemoryProfile {
		try {
			return $this->mapper->findForUser($id, $userId);
		} catch (DoesNotExistException|MultipleObjectsReturnedException) {
			throw new NotFoundException('memory profile not found');
		}
	}

	public function create(string $userId, array $data): MemoryProfile {
		$now = (new \DateTimeImmutable())->format(\DateTimeInterface::ATOM);
		$name = $this->requireName((string)($data['name'] ?? ''));

		$profile = new MemoryProfile();
		$profile->setUserId($userId);
		$profile->setName($name);
		$profile->setPath($this->normalizePath((string)($data['path'] ?? ''), $name));
		$profile->setMaxChars($this->clampMaxChars($data['max_chars'] ?? null));
		$profile->setRecapEnabled((bool)($data['recap_enabled'] ?? true));
		$profile->setRecapProfileId($this->recapProfile($data['recap_profile_id'] ?? null, $userId));
		$profile->setAutoCompact((bool)($data['auto_compact'] ?? false));
		$profile->setCompactThreshold($this->clampThreshold($data['compact_threshold'] ?? null));
		$profile->setCreatedAt($now);
		$profile->setUpdatedAt($now);

		// before the insert: a path that cannot be created should not leave
		// a row behind that points nowhere
		$this->ensureFile($userId, $profile->getPath(), $name);

		return $this->mapper->insert($profile);
	}

	public function update(int $id, string $userId, array $data): MemoryProfile {
		$profile = $this->find($id, $userId);

		if (array_key_exists('name', $data)) {
			$profile->setName($this->requireName((string)$data['name']));
		}
		if (array_key_exists('max_chars', $data)) {
			$profile->setMaxChars($this->clampMaxChars($data['max_chars']));
		}
		if (array_key_exists('recap_enabled', $data)) {
			$profile->setRecapEnabled((bool)$data['recap_enabled']);
		}
		if (array_key_exists('recap_profile_id', $data)) {
			$profile->setRecapProfileId($this->recapProfile($data['recap_profile_id'], $userId));
		}
		if (array_key_exists('auto_compact', $data)) {
			$profile->setAutoCompact((bool)$data['auto_compact']);
		}
		if (array_key_exists('compact_threshold', $data)) {
			$profile->setCompactThreshold($this->clampThreshold($data['compact_threshold']));
		}

		// Ensured on every save, not only when the path changed: saving is
		// the documented way to get a folder back that someone deleted, and
		// an existing file is left alone anyway.
		if (array_key_exists('path', $data)) {
			$profile->setPath($this->normalizePath((string)$data['path'], $profile->getName()));
		}
		$this->ensureFile($userId, $profile->getPath(), $profile->getName());

		$profile->setUpdatedAt((new \DateTimeImmutable())->format(\DateTimeInterface::ATOM));

		return $this->mapper->update($profile);
	}

	/**
	 * Blocked while chat profiles still point here, same as connections.
	 * The file stays: it is the user's data, and a memory profile is only
	 * a pointer to it.
	 */
	public function delete(int $id, string $userId): void {
		$profile = $this->find($id, $userId);

		$users = $this->profileMapper->findByMemoryProfile($id, $userId);
		if (count($users) > 0) {
			$names = array_map(static fn ($p) => $p->getName(), $users);
			throw new ConflictException('memory profile is still used by: ' . implode(', ', $names));
		}

		$this->mapper->delete($profile);
	}

	/**
	 * Relative to the home, no leading slash, always `.md`.
	 *
	 * `.` and `..` are refused rather than stripped — the same stance as
	 * davUrl() in the frontend: quietly turning `a/../b.md` into `a/b.md`
	 * would point the memory at a file the user did not name.
	 */
	public function normalizePath(string $path, string $name): string {
		$path = trim(str_replace('\\', '/', $path));
		if (str_contains($path, "\0")) {
			throw new BadRequestException('path contains a null byte');
		}

		$segments = array_values(array_filter(
			array_map('trim', explode('/', $path)),
			static fn ($s) => $s !== ''
		));

		foreach ($segments as $segment) {
			if ($segment === '.' || $segment === '..') {
				throw new BadRequestException('the path must not contain "." or ".." segments');
			}
		}

		if (count($segments) === 0) {
			$segments = [self::DEFAULT_FOLDER, $this->slug($name)];
		}

		$last = count($segments) - 1;
		if (!str_ends_with(strtolower($segments[$last]), '.md')) {
			$segments[$last] .= '.md';
		}

		$normalized = implode('/', $segments);
		if (mb_strlen($normalized) > 1024) {
			throw new BadRequestException('path is too long');
		}

		return $normalized;
	}

	/**
	 * Creates folder and file if missing. An existing file is not touched,
	 * which is what lets a memory profile point at a file that is already
	 * there — or several profiles at the same one.
	 */
	private function ensureFile(string $userId, string $path, string $name): void {
		$userFolder = $this->rootFolder->getUserFolder($userId);
		$segments = explode('/', $path);
		$filename = array_pop($segments);

		// a name Nextcloud refuses, a read-only share in the way: that is
		// the user's input being wrong, not a server error
		try {
			$folder = $this->ensureFolder($userFolder, $segments);

			try {
				$node = $folder->get($filename);
				if (!$node instanceof File) {
					throw new BadRequestException('the memory path is a folder: ' . $path);
				}

				return;
			} catch (FilesNotFoundException) {
				// create it below
			}

			$folder->newFile($filename, '# memory: ' . $name . "\n\n");
		} catch (InvalidPathException|NotPermittedException $e) {
			throw new BadRequestException('cannot create the memory file ' . $path . ': ' . $e->getMessage());
		}
	}

	/**
	 * Same walk as ArchiveService::ensureFolder and SkillService::ensureFolder,
	 * and not shared for the same reason SkillService gives.
	 *
	 * @param list<string> $segments
	 */
	private function ensureFolder(Folder $root, array $segments): Folder {
		$current = $root;

		foreach ($segments as $segment) {
			try {
				$node = $current->get($segment);
				if (!$node instanceof Folder) {
					throw new BadRequestException('the memory path is blocked by a file: ' . $segment);
				}
				$current = $node;
			} catch (FilesNotFoundException) {
				$current = $current->newFolder($segment);
			}
		}

		return $current;
	}

	/**
	 * Has to be one of the user's own profiles. A profile deleted later is
	 * not cascaded here: the browser falls back to the chat profile.
	 */
	private function recapProfile(mixed $value, string $userId): ?int {
		if ($value === null || $value === '' || (int)$value <= 0) {
			return null;
		}

		try {
			$this->profileMapper->findForUser((int)$value, $userId);
		} catch (DoesNotExistException|MultipleObjectsReturnedException) {
			throw new BadRequestException('unknown recap profile');
		}

		return (int)$value;
	}

	private function clampMaxChars(mixed $value): int {
		if ($value === null || $value === '') {
			return self::DEFAULT_MAX_CHARS;
		}

		return max(self::MIN_MAX_CHARS, min(self::MAX_MAX_CHARS, (int)$value));
	}

	private function clampThreshold(mixed $value): int {
		if ($value === null || $value === '') {
			return self::DEFAULT_THRESHOLD;
		}

		return max(50, min(100, (int)$value));
	}

	private function requireName(string $name): string {
		$name = trim($name);
		if ($name === '') {
			throw new BadRequestException('name must not be empty');
		}

		return mb_substr($name, 0, 128);
	}

	private function slug(string $name): string {
		$slug = strtr(mb_strtolower($name, 'UTF-8'), ['ä' => 'ae', 'ö' => 'oe', 'ü' => 'ue', 'ß' => 'ss']);
		$slug = trim(preg_replace('/[^a-z0-9]+/u', '-', $slug) ?? '', '-');
		$slug = mb_substr($slug, 0, 60);

		return $slug === '' ? 'memory' : $slug;
	}
}
