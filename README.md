# LLM Chat for Nextcloud

A chat interface for large language models where **the browser talks directly to the LLM backend**.
Nextcloud stores configuration and archived chats — it is never a proxy for the LLM traffic and
never sees prompts or responses.

One deliberate exception: the optional **`web_fetch` tool** (see below). Arbitrary web pages send
no CORS headers, so fetching one has to go through the Nextcloud server, which therefore sees the
URL. Prompts, responses and search queries do not touch it.

The point: because the request originates in the browser, `localhost` resolves from the *user's*
machine. Your Nextcloud can sit in a datacenter and still talk to an Ollama running on your laptop.
No server-side LLM app can do that.

## Requirements

* Nextcloud 34
* PHP 8.2+
* Node 20+ and npm 10+ **on the build machine** — nothing is compiled on the server

## Install

Build locally:

```bash
npm ci
npm run build
```

Copy to the server. `.deployignore` keeps `node_modules`, sources and sourcemaps
out, which is the difference between 2.5 MB and 314 MB:

```bash
rsync -avz --delete --exclude-from=.deployignore \
  ./ user@server:/var/www/nextcloud/apps/llmchat/
```

Then, on the server:

```bash
chown -R www-data:www-data /var/www/nextcloud/apps/llmchat
sudo -u www-data php occ app:enable llmchat
```

`app:enable` also runs the database migration. `occ upgrade` is *not* the right
command here — that one is for core upgrades.

Do not copy a `composer/` directory into the app. Its presence turns off
Nextcloud's generic PSR-4 autoloader, and without a matching `vendor/` the app
dies with a fatal error. The app has no runtime PHP dependencies, so it does not
need one.

## Setup

1. Open the app, click **Set up connection & profile**.
2. Add a connection — the base URL of your backend, for example:
   * Ollama: `http://127.0.0.1:11434/v1`
   * OpenRouter: `https://openrouter.ai/api/v1`
   * anything OpenAI-compatible: `https://.../v1`
3. **Reload the page.** See "Content Security Policy" below for why.
4. Create a profile: pick the connection, a model from the dropdown, and optionally a system prompt.

### Ollama

Ollama refuses cross-origin requests by default. Set the origin of your Nextcloud:

```bash
# systemd
systemctl edit ollama
# [Service]
# Environment="OLLAMA_ORIGINS=https://cloud.example.com"

# or ad hoc
OLLAMA_ORIGINS=https://cloud.example.com ollama serve
```

This is by far the most common reason a connection does not work.

### Browser caveats

* **Mixed content:** Chrome and Firefox treat `http://127.0.0.1` as potentially trustworthy, so the
  plain-HTTP request from an HTTPS page goes through. **Safari is stricter** — if you use Safari
  against a local backend, expect trouble.
* **Private Network Access:** Chrome sends a preflight with `Access-Control-Request-Private-Network`
  when an HTTPS page reaches into the local network. If the backend does not answer it correctly,
  Chrome blocks the request even though the CORS headers are fine.
* Models from Anthropic and Google block browser requests outright. Use OpenRouter for those.

### Content Security Policy

Nextcloud's default CSP blocks every outbound fetch. The app generates a `connect-src` allowlist from
your connections **when the page loads**. A connection created afterwards is therefore not in the
running page's CSP, and the first request against it fails with an error that looks like CORS but
is not.

The app tells you when this happens and offers a reload button. Reloading is only needed after
adding a connection or changing its base URL — renaming does nothing.

## How data is stored

| what | where | why |
|---|---|---|
| connections, profiles, preferences | Nextcloud database | needs to follow the user across devices |
| API keys | Nextcloud database, encrypted with `ICrypto` | see the security note below |
| active chats | browser IndexedDB | the server is not supposed to see them |
| archived chats | your Nextcloud files, as Markdown | search, versioning, sharing, sync all work for free |

**Chat histories are per browser and per device.** A different machine means a different history.
This is deliberate — it is the reason the archive function exists. Archive anything you want to keep.

Archived chats land in `{folder}/{YYYY}/{YYYY-MM-DD}-{slug}.md` with YAML front matter, default
folder `/LLM Chats`.

## Tools (optional, per profile)

Each profile picks its tools individually — they differ in what they cost you:

| tool | who executes it | does the Nextcloud server see it? |
|---|---|---|
| `get_current_datetime` | the browser | no |
| `web_search` | the browser → your SearXNG | no |
| `web_fetch` | the Nextcloud server | yes, the URL |

With at least one enabled, the model runs a small agent loop (at most 3 tool rounds, then a final
answer without tools). Requires a model trained for tool calling — small or older models will
either ignore the tools or produce garbage.

How it works, and what it changes:

* **`web_search` goes straight from the browser to your SearXNG instance.** That works because
  SearXNG can be told to send CORS headers, so the search terms never reach this server. Put the
  instance URL in the app settings; without it the tool reports itself as unconfigured and the
  other two keep working.

  Your `settings.yml` needs two things:

  ```yaml
  server:
    default_http_headers:
      Access-Control-Allow-Origin: https://your-nextcloud.example
  search:
    formats: [html, json]
  ```

  Beware `use_default_settings: engines: keep_only:` — it *keeps* engines but does not enable
  them. Several defaults ship `disabled: true`, so a `keep_only` list can leave you with an
  instance that answers every query with zero results. Enable them explicitly in an `engines:`
  block.

  There is no hosted default. A DuckDuckGo fallback was tried and removed: its Instant Answer API
  serves encyclopedic entities, not web results. `berlin` returned 10 hits while
  `weather in berlin tomorrow`, `latest news` and `python asyncio tutorial` each returned zero,
  and the model responded to the empty list by inventing URLs to fetch. A tool that silently
  fails at its actual job is worse than one that is absent.
* **`web_fetch` has to use the server.** Arbitrary sites send no CORS headers, so the browser
  cannot read their responses — there is no way around a server-side fetch, and the URL is
  therefore visible to Nextcloud. This is the one remaining exception to "the server sees
  nothing", and it is why tools are opt-in per profile.
* The fetch endpoint is intentionally locked down: http/https only, standard ports only, no
  credentials in URLs, SSRF protection via Nextcloud's HTTP client (DNS pinning, local address
  blocking, re-validation on every redirect), 2 MB response cap, text extraction only — the
  fetched document is parsed as data and never executed or rendered. Rate limited per user, and
  refused unless the tool is enabled in at least one of your profiles. The browser additionally
  rejects tool calls a profile does not allow, because models do invent function names.
* **Tool rounds are ephemeral.** Fetched page content is fed to the model but never stored in the
  chat history — the next message does not re-send kilobytes of scraped text. A collapsed
  "tool calls" log on the answer shows what happened.
* Server-side fetches rotate the User-Agent (Safari/macOS, Edge/Windows, Firefox/Linux) —
  a UA of "Nextcloud-Server-Crawler" hits bot walls instantly.

**Privacy note:** the search query is written by the *model*, derived from your prompt. It can
contain things you did not intend to send to a search engine. Your SearXNG instance sees it, and
so do the upstream engines it queries. That is inherent to the feature, not fixable by this app.

## Security

* API keys are encrypted at rest with `\OCP\Security\ICrypto`. **The encryption key still lives on
  the server**, so a server admin can decrypt them. For self-hosting this is an acceptable trade-off,
  but you should know about it.
* Keys are never returned by the CRUD API — only `has_key: true`. They *are* delivered to the browser
  of the owning user, because that is where the request is made. Every user only ever sees their own
  key, which is exactly why the app has no shared admin keys.
* No LLM prompts, responses or search queries ever reach the Nextcloud logs, because the server
  never sees them. With `web_fetch` enabled, failed fetch attempts are logged at info level
  (URL and error, never page content).

## What this app does not do (v1)

File uploads, RAG, MCP, admin-managed shared keys, a server-side proxy for LLM traffic, image
generation, TTS/STT. These are out of scope on purpose, not forgotten.

## Development

```bash
npm run watch    # rebuild on change
npm run build    # production bundle
```

The PHP side is deliberately small: settings CRUD, archive writing, CSP generation, initial state.
Streaming, token counting, retries and error handling all live in the frontend.

## License

AGPL-3.0-or-later
