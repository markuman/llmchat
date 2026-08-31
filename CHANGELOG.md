# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com).

## [Unreleased]

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
