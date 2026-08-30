# LLM Chat for Nextcloud

A chat interface for large language models where **the browser talks directly to the LLM backend**.
Nextcloud stores configuration and archived chats — it is never a proxy and never sees prompts or
responses.

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

## Security

* API keys are encrypted at rest with `\OCP\Security\ICrypto`. **The encryption key still lives on
  the server**, so a server admin can decrypt them. For self-hosting this is an acceptable trade-off,
  but you should know about it.
* Keys are never returned by the CRUD API — only `has_key: true`. They *are* delivered to the browser
  of the owning user, because that is where the request is made. Every user only ever sees their own
  key, which is exactly why the app has no shared admin keys.
* No LLM data ever reaches the Nextcloud logs, because the server never sees it.

## What this app does not do (v1)

File uploads, RAG, MCP/tool calling, admin-managed shared keys, a server-side proxy, image
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
