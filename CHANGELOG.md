# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com).

## [Unreleased]

### Changed
- `nc_read_pdf` flags an extraction that came out suspiciously thin. A timetable has a text layer,
  so nothing failed — it yields a few hundred words in reading order, which looks like a
  successful call and reads like nonsense, and the model has no way to tell. Under 600 characters
  per page the result now carries a note saying the words survived but the rows and columns did
  not, and that layout cannot be inferred from the order. Measured over the pages that produced
  text rather than the whole document, so a single cover page in front of thirty blank ones does
  not count as sparse, and skipped when the character cap was hit, where a low average only
  reports the cap.
- With vision enabled, `nc_read_pdf` describes itself as being for letters, contracts and
  articles, and points at `nc_read_pdf_page` for anything where position on the page carries
  meaning. Without vision the description stays as it was, minus its reference to
  `nc_read_pdf_page` — that function is not offered to such a profile, and naming it only sends
  the model somewhere it cannot go.

## 2.2.1 – 2026-09-04

### Changed
- `nc_read_pdf_page` renders at 1568 px on the page's *longer* edge instead of 1024 px on its
  width, and hands over a JPEG rather than a PNG. Scaling by width left a landscape page — a
  timetable, a spreadsheet export — at roughly two thirds of the resolution on the edge where
  the small print sits, which is exactly the kind of document that gets rendered instead of read.
  JPEG because the encode runs on the main thread, where deflating close to two megapixels is the
  most expensive step by far: it encodes several times faster and comes out around a tenth of the
  size, which counts twice over since base64 adds a third on the way out. On rasterised text q0.85
  is indistinguishable to a vision model, and the resolution bought with it is worth far more.
- `nc_read_pdf` also returns what the annotations carry. `getTextContent()` only sees the content
  stream, so a filled-in form or a commented page came back empty or half — for an AcroForm that
  is the difference between nothing and everything. Values already present in the text layer are
  dropped rather than handed over twice.

### Fixed
- A PDF without a text layer told the model to fall back to `nc_read_pdf_page` even when the
  profile had no vision, where that function is not offered at all — so the only exit from the
  dead end was another dead end. Without vision the note now names the actual remedy: the
  per-profile "Model can see images" switch.
- File reads are capped by size, not just by characters. The character cap only ever applied after
  the download, so `nc_read_text` or `nc_read_pdf` pointed at an 800 MB scan had the browser fetch
  all of it and pdf.js parse it before a single character was truncated. `Content-Length` rejects
  the read before the transfer starts and a running total rejects it during, since that header is
  absent on a chunked response and is the server's claim rather than a measurement.
- Path traversal is refused instead of rewritten. Dropping `.` and `..` turned
  `Documents/../secret.txt` into `Documents/secret.txt` — a different file than the one asked for,
  handed over without a word.

## 2.2.0 – 2026-09-04

### Added
- `nc_read` reaches the file service, not just Collectives: `nc_list_files` browses a directory,
  `nc_read_text` reads markdown, plain text, csv, html or a log, and `nc_read_pdf` extracts a
  PDF's text layer. Paths are relative to the user's home, which is what the Files app shows and
  what a search hit hands back, so the model can go from finding a file to reading it without
  translating anything. No new checkbox and no new approval rule — they live under the existing
  `nc_read` id and inherit its confirmation prompt. Reads are capped at 50 MB, a text read at
  what its character cap could possibly need, and an image read at the image limit — the
  character caps only apply after the download, so without a byte ceiling a model pointing at an
  800 MB scan would have the browser fetch all of it first. `Content-Length` fails the read
  before the transfer starts, a running total during it, since that header is absent on a
  chunked response and is the server's claim rather than a measurement.
- A path containing `.` or `..` segments is refused rather than silently stripped: rewriting
  `Documents/../secret.txt` to `Documents/secret.txt` would hand the model a different file than
  it asked for without a word about it, and a confidently wrong answer is worse than an error.
  Escaping the home was never the risk — DAV resolves the path itself and stops at the user root.
- New per-profile flag **"Model can see images"**, off by default. With it on, `nc_read` also
  offers `nc_read_image` and `nc_read_pdf_page` (one page rendered as a PNG). Both are hidden
  entirely without the flag: handing base64 to a text-only model fills its context with data it
  cannot read, at full token price. Deliberately not inferred from the model name — that list
  changes weekly and a wrong guess fails in both directions. One image per answer and 10 MB per
  file, both hard; the image rides in a multimodal message and stays ephemeral like every other
  tool round.
- PDF handling uses `pdfjs-dist` in the browser, loaded lazily. Not the `files_pdfviewer` app,
  which exports no module and can be switched off by an admin, and not a PHP parser, because tool
  calls deliberately do not grow server-side dependencies.

### Changed
- The token estimate in the status bar understands multimodal messages instead of stringifying
  the content array.
- Emitted assets that are neither image, style nor font now land in `js/` rather than a `dist/`
  directory of their own — untracked by `.gitignore`, unswept by `make clean` and easy to miss
  when deploying. The pdf.js worker was the first such asset.

### Fixed
- `make build` and `make lint` repair `node_modules/` when its native packages belong to another
  platform. rollup and esbuild ship their native part per platform and npm installs only the
  matching one, but `node_modules/` is a bind mount shared with the container — so running npm on
  the host swaps the musl build the alpine image needs for the host's glibc one, and the next
  containerised build dies with a `Cannot find module @rollup/rollup-<platform>` that names a
  package nothing depends on by name. Timestamps could not catch it: the tree ends up newer than
  the lock file and looks up to date. The check now asks rollup whether it loads.

## 2.1.0 – 2026-09-03

### Added
- Per-profile override of the tool round budget. Empty follows the general setting, so nothing
  changes for existing profiles; a value between 3 and 7 applies to that profile alone. A profile
  that chains a search into several page fetches needs a larger budget than a plain chat profile,
  and raising it globally would make every answer slower and more expensive. Clamped to the same
  range as the general setting, on import as well.

### Fixed
- Clearing `system_prompt`, `temperature` or `max_tokens` on an existing profile silently did
  nothing. `IRequest::getParam()` is `isset()` based, so an explicit `null` was indistinguishable
  from an omitted key and the field kept its old value.
- The "new chat" button rendered without its icon: the component was imported but never registered.
- `UserAgentRotator` called the atomic `add()`/`inc()`, which are `IMemcache` rather than plain
  `ICache` — a cache backend without them would have raised a fatal error instead of falling back
  to the random pick.
- `web_fetch` could dereference null while extracting the page title or stripping nodes from
  malformed HTML.
- A `searxng_url` that `parse_url()` rejects outright is now discarded before the result is read
  instead of after.

### Changed
- Settings moved from the deprecated `IConfig` user-value API to `IUserConfig`. Same keys, same
  storage, no migration needed.
- Added the missing linter configuration: `eslint.config.js`, `.php-cs-fixer.dist.php` and
  `psalm.xml`. `npm run lint`, `composer cs:check` and `composer psalm` previously all failed on a
  fresh checkout because the configs the scripts referenced did not exist. Formatting across
  `src/` was normalised in the process, and `nextcloud/ocp` now matches the targeted server
  version instead of pinning 30.

## 2.0.0 – 2026-09-02

### Added
- Full-text search over the local chat history (#6). Searches titles and message bodies, groups
  hits per chat, and jumps to the matching message. IndexedDB has no text index, so this is a
  cursor scan inside one read transaction, stopping at 60 hits and debounced by 180 ms — an
  inverted index would cost storage on every write plus a migration for everything written before
  it, and the scan is single-digit milliseconds at realistic history sizes.
- Regenerate an answer with a different profile (#10). The menu next to the regenerate button lists
  the other usable profiles; picking one switches the chat over for good, because a hidden mode
  where the composer shows one profile and the next message goes to another is worse than an
  explicit switch.
- General settings tab in the modal (#2), with the settings that used to live in the navigation
  drawer plus the new tool round slider.
- Configurable tool budget for the agent loop (#3): a slider from 3 to 7 rounds, default 3. The
  last round always runs without tools, so an answer is guaranteed. The value is clamped on both
  sides — a hand-edited config cannot unbound the loop.

### Changed
- **Breaking (UI):** the navigation footer no longer contains settings, only a cog that opens the
  modal (#2). A 300 px drawer was the wrong place for a path picker, a URL field and a slider, and
  it covered the chat list exactly while it was needed.

## 1.6.0 – 2026-08-31

### Added
- Read-only Nextcloud tools (`nc_read`): unified search across files, calendar, contacts, notes,
  Deck and Talk, plus listing and reading Collectives pages. Runs in the browser on the existing
  session, so the user's own permissions apply and no app password or MCP server is involved.
- Approval dialog before any tool call that leaves the browser. On by default, switchable per
  profile. Shows the tool and its arguments; declining hands the model an error and it carries on.

### Changed
- Rewrote the README and the app store description.

### Security
- `web_fetch` now refuses to fetch the Nextcloud instance it runs on. Such a request carries no
  session and would read whatever happens to be public under the server's identity instead of the
  user's. Blocked against the base URL, all trusted domains including wildcards, and
  `overwrite.cli.url`.
- Restored Nextcloud's redirect validation on `web_fetch`. Passing `allow_redirects` replaced the
  HTTP client's own value wholesale, dropping the callback that re-checks every hop against the
  local-address rules.

## 1.5.0 – 2026-08-31

### Changed
- `web_search` moved from the server into the browser. SearXNG can be configured to send CORS
  headers, so search terms no longer pass through the Nextcloud server at all. `web_fetch` still
  needs the server, since arbitrary sites send no such headers.

### Fixed
- A SearXNG URL entered without a scheme (`127.0.0.1:8888`) was silently discarded — the field
  looked saved but was not. The scheme is now inferred.

## 1.4.0 – 2026-08-31

### Removed
- The DuckDuckGo search provider. Its Instant Answer API serves encyclopedic entities, not web
  results: `berlin` returned hits while `weather in berlin tomorrow` returned nothing, and the
  model reacted to the empty list by inventing URLs to fetch. SearXNG is now the only backend.

## 1.3.1 – 2026-08-30

### Fixed
- Writing a message whose tool log had been appended to during streaming threw "Proxy object could
  not be cloned" and the answer was never persisted. IndexedDB uses structured clone, which
  rejects Vue's reactive proxies.

## 1.3.0 – 2026-08-30

### Changed
- The single tools toggle became a per-tool allowlist. The tools differ in what they cost:
  date/time is answered in the browser, the web tools are not.

## 1.2.0 – 2026-08-30

### Added
- Web tools: `web_search`, `web_fetch` and `get_current_datetime`, with a bounded agent loop of at
  most three tool rounds. Tool rounds are ephemeral and never enter the chat history.

## 1.1.0 – 2026-08-30

### Added
- Per-profile reasoning switch. Off actually disables thinking on backends that support it rather
  than only hiding it, which saves tokens.

## 1.0.0 – 2026-08-29

### Added
- Initial release. Browser-to-backend chat with multiple connections and profiles, streaming with
  abort, Markdown rendering, chat history in IndexedDB, and archiving to Nextcloud files as
  Markdown.
