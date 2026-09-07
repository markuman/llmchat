<?php

declare(strict_types=1);

/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\LlmChat\Service;

use OCA\LlmChat\Exception\BadRequestException;
use OCA\LlmChat\Exception\NotFoundException;
use OCP\Files\File;
use OCP\Files\Folder;
use OCP\Files\IRootFolder;
use OCP\Files\NotFoundException as FilesNotFoundException;
use OCP\IL10N;
use Psr\Log\LoggerInterface;

/**
 * Skills (issue #17): user-written instructions that replace a web search with
 * a known-good procedure.
 *
 * A skill is a Markdown file with YAML front matter, living in a `Skills`
 * subdirectory of the archive folder. Same place, same ownership, same sync as
 * the archived chats — nothing new to back up and nothing hidden in a database
 * row the user cannot edit.
 *
 * Two halves, deliberately:
 *
 * - the *front matter* (name + description) is cheap and goes into every
 *   system prompt, so the model knows a skill exists;
 * - the *body* is only read when the model asks for it by name.
 *
 * Loading every body into the system prompt would work for three skills and
 * quietly cost a few thousand tokens per request at thirty.
 *
 * Reading happens on the server rather than in the browser, unlike the file
 * tools: the front matter has to be in the initial state before the first
 * request, and a WebDAV round trip per skill on every page load is a worse
 * trade than one folder listing in PHP.
 */
class SkillService {
	/** Subdirectory of the archive folder. Not configurable — one place to look. */
	public const FOLDER_NAME = 'Skills';

	/** A skill is Markdown. Anything else in the folder is ignored. */
	private const EXTENSION = '.md';

	/**
	 * Nothing here is a security boundary — the user owns these files and can
	 * write whatever they like. These caps only stop one runaway file from
	 * turning into a system prompt nobody asked for.
	 */
	private const MAX_SKILLS = 50;
	private const MAX_NAME_CHARS = 60;
	private const MAX_DESCRIPTION_CHARS = 400;
	private const MAX_BODY_CHARS = 20000;
	private const MAX_FILE_BYTES = 256 * 1024;

	/** Per skill; a skill needing more hosts than this is a program, not a skill. */
	private const MAX_DOMAINS = 5;

	public function __construct(
		private IRootFolder $rootFolder,
		private SettingsService $settings,
		private IL10N $l10n,
		private LoggerInterface $logger,
	) {
	}

	/**
	 * Every skill's metadata, without bodies. Safe to call on every page load.
	 *
	 * Never throws: a missing folder is the normal state before the feature is
	 * switched on, and a broken one must not take the whole app's initial
	 * state with it.
	 *
	 * @return list<array{id: string, name: string, description: string, domains: list<string>, path: string}>
	 */
	public function index(string $userId): array {
		if (!$this->settings->get($userId)['skills_enabled']) {
			return [];
		}

		try {
			$folder = $this->folder($userId);
		} catch (\Throwable) {
			return [];
		}

		$skills = [];
		$seen = [];

		foreach ($folder->getDirectoryListing() as $node) {
			if (count($skills) >= self::MAX_SKILLS) {
				break;
			}
			if (!$node instanceof File || !str_ends_with(strtolower($node->getName()), self::EXTENSION)) {
				continue;
			}

			// Before getContent(), which reads the whole file into memory.
			// This runs on every page load, so a 500 MB notes.md that someone
			// parked in the folder would otherwise be loaded in full just to
			// have its first few lines looked at.
			if ($node->getSize() > self::MAX_FILE_BYTES) {
				$this->logger->info('llmchat: skipping oversized skill', [
					'name' => $node->getName(),
					'size' => $node->getSize(),
				]);
				continue;
			}

			// Ids are compared case-insensitively, so Weather.md and
			// weather.md are the same skill as far as the model is concerned
			// — and read() answers with whichever the listing yields first.
			// Offering both would be offering a coin flip.
			$id = $this->idOf($node->getName());
			if (isset($seen[$id])) {
				$this->logger->info('llmchat: skipping duplicate skill id', [
					'name' => $node->getName(),
					'id' => $id,
				]);
				continue;
			}

			try {
				$parsed = $this->parse($node->getName(), $node->getContent());
			} catch (\Throwable $e) {
				// one unreadable file must not hide the other skills
				$this->logger->info('llmchat: skipping unreadable skill', ['exception' => $e]);
				continue;
			}

			$seen[$id] = true;

			// The body is deliberately dropped here. It is fetched by id when
			// the model actually asks for the skill.
			unset($parsed['body']);
			$skills[] = $parsed;
		}

		usort($skills, static fn ($a, $b) => strnatcasecmp($a['name'], $b['name']));

		return $skills;
	}

	/**
	 * One skill including its body.
	 *
	 * @return array{id: string, name: string, description: string, domains: list<string>, path: string, body: string}
	 * @throws NotFoundException
	 * @throws BadRequestException
	 */
	public function read(string $userId, string $id): array {
		if (!$this->settings->get($userId)['skills_enabled']) {
			throw new NotFoundException('skills are switched off');
		}

		// `$id` comes from the model, so it is an arbitrary string: resolve it
		// against the listing rather than building a path out of it. No
		// traversal is possible because no path is ever constructed.
		$name = $this->normalizeId($id);
		if ($name === '') {
			throw new BadRequestException('skill id must not be empty');
		}

		$folder = $this->folder($userId);

		foreach ($folder->getDirectoryListing() as $node) {
			if (!$node instanceof File || !str_ends_with(strtolower($node->getName()), self::EXTENSION)) {
				continue;
			}
			if ($this->idOf($node->getName()) !== $name) {
				continue;
			}
			// Skipped rather than refused, so this walk makes the same
			// decisions as index(): a file the catalogue passed over must not
			// be the one that answers for that id. With `Weather.md` too
			// large and `weather.md` fine, the model was offered the second
			// and has to get the second.
			if ($node->getSize() > self::MAX_FILE_BYTES) {
				continue;
			}

			return $this->parse($node->getName(), $node->getContent());
		}

		// Also the answer when every candidate was too large: the model was
		// never offered such a skill, so "no skill named X" is what actually
		// happened from where it is standing.
		throw new NotFoundException('no skill named "' . $name . '"');
	}

	/**
	 * Creates the folder and, if it is not there yet, the example skill.
	 *
	 * Called when the setting is switched on. Existing files are never
	 * touched: someone who edited the weather skill did so on purpose, and
	 * toggling a switch twice is not consent to overwrite it.
	 *
	 * @return array{path: string, created: bool, example_created: bool}
	 */
	public function provision(string $userId): array {
		$userFolder = $this->rootFolder->getUserFolder($userId);
		$relative = trim($this->settings->get($userId)['archive_folder'], '/')
			. '/' . self::FOLDER_NAME;

		$existed = $userFolder->nodeExists($relative);
		$folder = $this->ensureFolder($userFolder, $relative);

		$exampleName = 'weather' . self::EXTENSION;
		$exampleCreated = false;
		if (!$folder->nodeExists($exampleName)) {
			$folder->newFile($exampleName, $this->exampleSkill());
			$exampleCreated = true;
		}

		return [
			'path' => $userFolder->getRelativePath($folder->getPath()) ?? $folder->getPath(),
			'created' => !$existed,
			'example_created' => $exampleCreated,
		];
	}

	/**
	 * Splits `--- yaml --- body`.
	 *
	 * A hand-rolled reader for the four scalar keys that matter, rather than a
	 * YAML dependency: these files are written by users in a text editor, and
	 * failing a skill because its front matter is not spec-perfect YAML would
	 * be the wrong kind of strict. Anything unparseable simply falls back to
	 * the filename.
	 *
	 * @return array{id: string, name: string, description: string, domains: list<string>, path: string, body: string}
	 */
	private function parse(string $filename, string $content): array {
		$content = str_replace(["\r\n", "\r"], "\n", $content);
		$meta = [];
		$body = $content;

		// The closing marker is a line of its own: three or more dashes and
		// then nothing but whitespace. Searching for the string "\n---" alone
		// would also stop at "----" and at "--- something", and hand whatever
		// followed on that line to the body as a stray "-" or " something".
		// Extra dashes and trailing spaces are tolerated because a text editor
		// produces them by accident; a marker with words after it is not an
		// accident and is left to be body text.
		if (preg_match('/^---\n(.*?)\n-{3,}[ \t]*(?:\n|$)/s', $content, $matches) === 1) {
			$meta = $this->parseFrontMatter($matches[1]);
			$body = ltrim(substr($content, strlen($matches[0])), "\n");
		}

		$id = $this->idOf($filename);
		$name = $this->clamp($meta['name'] ?? '', self::MAX_NAME_CHARS);

		return [
			'id' => $id,
			// a skill without a name is still usable — the filename is one
			'name' => $name === '' ? $id : $name,
			'description' => $this->clamp($meta['description'] ?? '', self::MAX_DESCRIPTION_CHARS),
			'domains' => $this->parseDomains($meta['allowed-domains'] ?? ''),
			'path' => $filename,
			'body' => $this->clamp($body, self::MAX_BODY_CHARS),
		];
	}

	/**
	 * @return array<string, string>
	 */
	private function parseFrontMatter(string $yaml): array {
		$meta = [];

		foreach (explode("\n", $yaml) as $line) {
			// only top-level scalars; an indented line belongs to a structure
			// this reader does not pretend to understand
			if ($line === '' || $line[0] === '#' || $line[0] === ' ' || $line[0] === "\t") {
				continue;
			}

			$colon = strpos($line, ':');
			if ($colon === false) {
				continue;
			}

			$key = strtolower(trim(substr($line, 0, $colon)));
			$value = trim(substr($line, $colon + 1));

			// strip one layer of matching quotes, the usual YAML habit
			if (strlen($value) >= 2
				&& ($value[0] === '"' || $value[0] === "'")
				&& $value[strlen($value) - 1] === $value[0]) {
				$value = substr($value, 1, -1);
			}

			if ($key !== '') {
				$meta[$key] = $value;
			}
		}

		return $meta;
	}

	/**
	 * Accepts `[a.example, b.example]` or `a.example, b.example`.
	 *
	 * Only hostnames survive: no scheme, no path, no port. Whatever comes out
	 * ends up in a CSP `connect-src` entry as `https://<host>`, so a wildcard
	 * or a stray `*` would widen the page's policy on the say-so of a file —
	 * and while that file is the user's own, a CSP is not the place to be
	 * generous.
	 *
	 * @return list<string>
	 */
	private function parseDomains(string $raw): array {
		$raw = trim($raw, " \t[]");
		if ($raw === '') {
			return [];
		}

		$domains = [];
		foreach (explode(',', $raw) as $entry) {
			$entry = trim($entry, " \t\"'");
			if ($entry === '') {
				continue;
			}

			// tolerate a pasted URL, keep only the host
			if (str_contains($entry, '://')) {
				$entry = (string)parse_url($entry, PHP_URL_HOST);
			}
			$entry = strtolower(strtok($entry, '/:') ?: '');

			// hostname characters only — this becomes a CSP source
			if ($entry === '' || preg_match('/^[a-z0-9.-]+$/', $entry) !== 1) {
				continue;
			}
			if (!str_contains($entry, '.')) {
				continue;
			}

			$domains[$entry] = true;
			if (count($domains) >= self::MAX_DOMAINS) {
				break;
			}
		}

		return array_keys($domains);
	}

	/** Filename without the extension: what the model calls the skill. */
	private function idOf(string $filename): string {
		return $this->normalizeId(substr($filename, 0, -strlen(self::EXTENSION)));
	}

	/**
	 * Ids are compared case-insensitively and without the extension, because
	 * a model that read "weather" in the system prompt may well ask for
	 * "Weather" or "weather.md".
	 */
	private function normalizeId(string $id): string {
		$id = strtolower(trim($id));
		if (str_ends_with($id, self::EXTENSION)) {
			$id = substr($id, 0, -strlen(self::EXTENSION));
		}

		return trim($id);
	}

	private function clamp(string $value, int $max): string {
		$value = trim($value);

		return mb_strlen($value) > $max ? mb_substr($value, 0, $max) : $value;
	}

	/**
	 * @throws NotFoundException
	 */
	private function folder(string $userId): Folder {
		$userFolder = $this->rootFolder->getUserFolder($userId);
		$relative = trim($this->settings->get($userId)['archive_folder'], '/')
			. '/' . self::FOLDER_NAME;

		try {
			$node = $userFolder->get($relative);
		} catch (FilesNotFoundException) {
			throw new NotFoundException('the skills folder does not exist yet');
		}

		if (!$node instanceof Folder) {
			throw new NotFoundException('the skills path is a file, not a folder');
		}

		return $node;
	}

	/**
	 * Same walk as ArchiveService::ensureFolder. Not shared with it on
	 * purpose: three lines of duplication are cheaper than a base class whose
	 * only job is to hold three lines.
	 *
	 * @throws BadRequestException
	 */
	private function ensureFolder(Folder $root, string $relativePath): Folder {
		$current = $root;

		foreach (explode('/', $relativePath) as $segment) {
			$segment = str_replace(['/', '\\', "\0"], '', trim($segment));
			if ($segment === '' || $segment === '.' || $segment === '..') {
				continue;
			}

			try {
				$node = $current->get($segment);
				if (!$node instanceof Folder) {
					throw new BadRequestException('the skills path is blocked by a file: ' . $segment);
				}
				$current = $node;
			} catch (FilesNotFoundException) {
				$current = $current->newFolder($segment);
			}
		}

		return $current;
	}

	/**
	 * The shipped example (issue #17).
	 *
	 * Weather is the ideal demonstration because the alternative is visibly
	 * worse: asked for a forecast without this, a model runs a web search and
	 * summarises whatever a content farm wrote this morning. With it, the
	 * answer comes from one request to a JSON API — and the skill is about
	 * eighty lines the user can read and change.
	 *
	 * Written in English, and not run through the translator: the audience is
	 * the model, not the user. The model is told to answer in the language of
	 * the conversation instead, which is the part that actually matters.
	 */
	private function exampleSkill(): string {
		// heredoc, not a translated string: see above
		return <<<'MARKDOWN'
			---
			name: Weather forecast
			description: Current conditions and the multi-day forecast for any place, from wttr.in. Use for every weather question instead of searching the web.
			allowed-domains: [wttr.in]
			---

			# Weather forecast

			Weather questions are answered from `wttr.in`, never from a web search. A
			search returns yesterday's article about the weather; this returns the
			forecast.

			## Fetching

			Call `skill_fetch` with:

			```
			https://wttr.in/<location>?format=j1
			```

			`<location>` is URL-encoded — `Bad Salzuflen` becomes `Bad%20Salzuflen`. A
			city name, a postcode, an airport code (`~CDG`) or `Berlin,DE` all work. If
			the user did not name a place, ask with `ask_user` rather than guessing;
			omitting the location gives you the weather of whatever exit node the
			request came from, which is nowhere near them.

			The response is JSON, roughly 40 kB, and holds three days:

			- `current_condition[0]` — `temp_C`, `FeelsLikeC`, `weatherDesc[0].value`,
			  `weatherCode`, `windspeedKmph`, `winddir16Point`, `humidity`,
			  `precipMM`, `observation_time` (**UTC**, not local time)
			- `weather[]` — one entry per day: `date`, `maxtempC`, `mintempC`,
			  `avgtempC`, `uvIndex`, `sunHour`, `astronomy[0]` (`sunrise`, `sunset`,
			  `moon_phase`)
			- `weather[].hourly[]` — eight three-hourly slots. `time` is `"0"`, `"300"`,
			  … `"2100"`, so `"900"` means 09:00 — pad it, do not read it as a number.
			  Each slot has `tempC`, `FeelsLikeC`, `weatherCode`, `weatherDesc`,
			  `chanceofrain`, `precipMM`, `windspeedKmph`, `winddir16Point`.
			- `nearest_area[0].areaName[0].value` — the place actually matched. Name it
			  in the answer when it differs from what the user asked for.

			## Answering

			Always a **horizontal Markdown table**: time or date across the header row,
			measurements down the left. Weather reads as a progression, and a table
			with one row per hour makes the reader scan vertically for a trend that
			runs sideways.

			Pick the table from the question:

			- **Today / tomorrow / "right now"** → the day table: one column per
			  three-hourly slot, rows for condition emoji, temperature (`°C`), felt
			  temperature when it differs by 2° or more, chance of rain (`%`) and wind
			  (`km/h`, with the direction arrow). For "right now", lead with one
			  sentence from `current_condition` before the table.
			- **The week / "the next few days"** → the week table: one column per day
			  (`weather[]`), rows for condition emoji, max/min (`23° / 14°`), chance of
			  rain as the day's maximum across `hourly[]`, wind as the day's maximum
			  speed with the direction that goes with it, and sunrise/sunset. Say that
			  wttr.in provides three days when the user asked for seven — do not pad
			  the table with days you do not have.

			Then one or two sentences on what actually matters: rain arriving, a sharp
			drop overnight, wind worth a jacket. Skip that when the day is
			unremarkable — inventing significance is worse than a short answer.

			Answer in the language of the conversation. Metric units unless the user
			used imperial. Never invent a value that is not in the response.

			## Condition emoji

			From `weatherCode`, using wttr.in's own mapping:

			| Emoji | `weatherCode` |
			| --- | --- |
			| ☀️ | 113 |
			| ⛅ | 116 |
			| ☁️ | 119, 122 |
			| 🌫️ | 143, 248, 260 |
			| 🌦️ | 176, 263, 266, 293, 296, 353 |
			| 🌧️ | 179, 182, 185, 281, 284, 299, 302, 305, 308, 311, 314, 317, 350, 356, 359, 362, 365, 374, 377 |
			| 🌨️ | 227, 320, 323, 326, 368 |
			| ❄️ | 230, 329, 332, 338 |
			| ⛈️ | 200, 386, 392 |
			| 🌩️ | 389 |
			| 🌬️ | 335, 371, 395 |

			Anything else: ✨. Add 🌡️ to the temperature row, 💧 to the rain row and
			💨 to the wind row — one emoji per row label, not per cell.

			## Wind direction

			Every wind cell is an **arrow followed by the speed**: `↑ 12`. Look the
			arrow up from `winddir16Point`, which is a compass point and not a number:

			| `winddir16Point` | Arrow |
			| --- | --- |
			| `N`, `NNW` | ↓ |
			| `NNE`, `NE` | ↙ |
			| `ENE`, `E` | ← |
			| `ESE`, `SE` | ↖ |
			| `SSE`, `S` | ↑ |
			| `SSW`, `SW` | ↗ |
			| `WSW`, `W` | → |
			| `WNW`, `NW` | ↘ |

			**The arrow points where the wind is blowing to**, so a northerly — coming
			from the north, heading south — is ↓, and an easterly is ←. This is the
			same convention wttr.in uses in its own terminal output, and it reads like
			an arrow on a map.

			Mind the half-turn: `winddir16Point` names the direction the wind comes
			*from*, which is the opposite of what the arrow shows. `N` means a wind out
			of the north, so it gets ↓. Take the arrow from the table rather than
			reasoning it out each time, and never mix the two conventions inside one
			answer. When writing prose next to the table, keep saying "from the north"
			— that is what the data means, and it agrees with the arrow rather than
			contradicting it.

			If a `winddir16Point` is missing or is not one of the sixteen points above,
			write the speed with no arrow rather than guessing at a heading.

			## Example

			```markdown
			**Berlin** — 20 °C, overcast, wind 15 km/h from the south.

			| | 06:00 | 09:00 | 12:00 | 15:00 | 18:00 | 21:00 |
			| --- | --- | --- | --- | --- | --- | --- |
			| | ☁️ | ⛅ | ☀️ | ☀️ | ⛅ | 🌦️ |
			| 🌡️ °C | 14 | 17 | 20 | 23 | 21 | 18 |
			| 💧 % | 0 | 0 | 10 | 10 | 20 | 45 |
			| 💨 km/h | ↑ 9 | ↑ 12 | ↗ 15 | → 17 | → 14 | ↘ 11 |

			Dry until the late afternoon; showers become likely after 21:00. The wind
			veers from south to north-west during the day.
			```

			MARKDOWN;
	}
}
