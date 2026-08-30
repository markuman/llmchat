---
titel: nextcloud llm app — spezifikation
version: 0.1 (entwurf)
stand: 2026-08-29
status: pre-implementation
---

# nextcloud llm app — spezifikation

## 1. ziel

eine nextcloud-app, die ein llm-chatinterface bereitstellt, bei dem **der browser des users direkt mit dem llm-backend spricht**. der nextcloud-server ist kein proxy und sieht weder prompts noch antworten.

kernidee: `localhost` wird aus sicht des browsers aufgelöst. nextcloud kann in einem rechenzentrum stehen und trotzdem gegen ein ollama auf dem laptop des users sprechen. keine serverseitige llm-app kann das.

### 1.1 abgrenzung (non-goals für v1)

diese punkte sind bewusst ausgeschlossen, nicht vergessen:

| ausgeschlossen | begründung |
|---|---|
| datei-upload / attach | scope |
| rag, embeddings, vektorstore | scope |
| mcp / tool-calling | macht aus der app eine agent-runtime; separates release |
| admin-verwaltung, gruppenrichtlinien, geteilte keys | jeder user konfiguriert sich selbst |
| serverseitiger proxy zum llm | widerspricht dem architekturprinzip |
| collectives als archivziel | harte abhängigkeit auf eine app, die viele nicht installiert haben |
| bildgenerierung, tts, stt | scope |

---

## 2. architektur

```
┌──────────────────────────────────────────────┐
│ browser (vue 3)                              │
│                                              │
│  chat-ui ──── fetch/SSE ──────────────────────────►  llm-backend
│     │                                        │       (127.0.0.1:11434
│     │                                        │        oder openrouter.ai)
│     ├── indexeddb (aktive chatverläufe)      │
│     │                                        │
│     └── axios ──┐                            │
└─────────────────┼────────────────────────────┘
                  │ same origin, session-cookie
                  ▼
        ┌─────────────────────────┐
        │ nextcloud (php)         │
        │  - settings-crud        │
        │  - archiv schreiben     │
        │  - csp generieren       │
        │  - initial state        │
        └─────────────────────────┘
```

der php-anteil ist klein und enthält **keine** llm-logik. streaming, tokenzählung, retry und fehlerbehandlung leben komplett im frontend.

### 2.1 stack

- php 8.2+, nextcloud 30+
- vue 3 + `@nextcloud/vue`, `@nextcloud/axios`, `@nextcloud/dialogs`, `@nextcloud/router`
- keine llm-sdks — reines `fetch` gegen openai-kompatible endpunkte

---

## 3. datenmodell

credentials sind von profilen getrennt. das ist die grundlage für duplizierbarkeit und key-rotation.

### 3.1 `llm_connections`

| spalte | typ | anmerkung |
|---|---|---|
| `id` | bigint, pk | |
| `user_id` | varchar(64) | index |
| `name` | varchar(128) | z.b. "ollama laptop" |
| `base_url` | varchar(512) | z.b. `http://127.0.0.1:11434/v1` |
| `api_key` | text, nullable | verschlüsselt via `ICrypto`, bei ollama leer |
| `provider_hint` | varchar(32) | `ollama` \| `openai_compatible` \| `openrouter` |
| `created_at` / `updated_at` | datetime | |

### 3.2 `llm_profiles`

| spalte | typ | anmerkung |
|---|---|---|
| `id` | bigint, pk | |
| `user_id` | varchar(64) | index |
| `connection_id` | bigint, fk | |
| `name` | varchar(128) | |
| `model` | varchar(255) | |
| `system_prompt` | text, nullable | |
| `temperature` | float, nullable | null = default des backends |
| `max_tokens` | int, nullable | |
| `is_default` | boolean | genau eins pro user |
| `sort_order` | int | manuelle reihenfolge im switcher |

### 3.3 duplizieren

kopiert **eine** zeile aus `llm_profiles`, `connection_id` wird referenziert, nicht kopiert. secrets werden nie dupliziert.

- name wird `{name} (kopie)`
- `is_default` wird auf false gesetzt
- `sort_order` = original + 1
- der dialog öffnet direkt danach mit vorselektiertem namensfeld

### 3.4 export / import

profile als json exportierbar, **ohne** `api_key` und ohne `base_url`-credentials-anteil. beim import wählt der user, welche vorhandene connection zugeordnet wird. das ersetzt die verworfene admin-verwaltung: user können sich profile untereinander schicken, ohne dass der server etwas verwalten muss.

---

## 4. settings-ui

**nicht** im nextcloud-settings-framework. kein `ISettings` wird registriert.

### 4.1 navigation-footer

zahnrad unten links in der app-navigation, analog zur mail-app: `NcAppNavigationSettings` im `#footer`-slot von `NcAppNavigation`. klappt nach oben auf, ist ~300px schmal.

inhalt der schublade — nur toggles und ein knopf:

- default-profil (dropdown)
- archiv-ziel (dropdown) + zielordner (pfad-picker)
- kompaktmodus (toggle)
- markdown-rendering an/aus (toggle)
- `verbindungen & profile verwalten →` (öffnet modal)

### 4.2 verwaltungs-modal

`NcModal` mit zwei tabs:

**tab „verbindungen"**
liste + formular: name, base-url, api-key (passwortfeld, wird nach dem speichern nie zurückgeliefert — nur `has_key: true`), provider-hint.
button **„verbindung testen"** (siehe 7.3).

**tab „profile"**
liste mit drag-handle für sortierung, pro eintrag: bearbeiten, duplizieren, löschen, als default setzen.
duplizieren ist eine **hauptaktion mit eigenem button**, nicht im überlaufmenü versteckt.
formular: name, connection (dropdown), modell (dropdown, siehe 7.4), systemprompt (textarea, monospace, autogrow), temperature, max_tokens.

### 4.3 profil-umschaltung

gehört **nicht** in die settings, sondern als dropdown in den chat-header. das ist eine aktion pro nachricht, keine konfiguration.

---

## 5. chat-ui

- linke spalte: chatliste (aus indexeddb), gruppiert nach heute / diese woche / älter
- header: profil-dropdown, chattitel (inline editierbar), archivieren-button, löschen-button
- nachrichtenliste: markdown-rendering, codeblöcke mit syntax-highlighting und copy-button, „antwort neu generieren", „nachricht bearbeiten & ab hier neu"
- eingabe: textarea mit autogrow, enter = senden, shift+enter = zeilenumbruch, esc = generierung abbrechen (`AbortController`)
- statusleiste: geschätzte tokenzahl des kontexts, aktives modell, bei openrouter grobe kostenschätzung

### 5.1 chattitel

nach dem ersten antwortpaar wird ein titel generiert: separater, nonstreaming-call gegen dasselbe profil mit fixem prompt („fasse in maximal 5 wörtern zusammen, nur der titel"). ergebnis wird lokal gecacht und nie erneut generiert. bei fehler: erste 40 zeichen der ersten user-nachricht.

---

## 6. persistenz

### 6.1 aktive chats — browser

**indexeddb**, nicht localstorage (5 mb cap, synchrone api, blockiert den main-thread).

```
db: nc_llm
  store: chats     { id, title, profile_id, created_at, updated_at }
  store: messages  { id, chat_id, role, content, ts }   index: chat_id
```

konsequenz, die dokumentiert werden muss: **verläufe sind pro browser und gerät**. anderer rechner = anderer verlauf. das ist gewollt (duck.ai-modell) und der grund, warum es die archivfunktion gibt.

### 6.2 archivierung — nextcloud

beim klick auf „archivieren" wird der chat als `.md` über die eigene api ins dateisystem geschrieben. der server schreibt die datei via `IRootFolder`, nicht der browser via webdav — so bleibt die pfadlogik an einer stelle.

pfad: `{konfigurierter ordner}/{YYYY}/{YYYY-MM-DD}-{slug(titel)}.md`, default `/LLM Chats/`.

format:

```markdown
---
title: kaputte nginx timeouts
date: 2026-08-29T14:22:00+02:00
profile: ollama laptop / qwen3.6:35b-a3b
model: qwen3.6:35b-a3b
system_prompt: |
  du bist knapp und sarkastisch.
---

## user

...

## assistant

...
```

warum dateisystem statt eigener db-tabelle:

- fulltextsearch findet die inhalte ohne zusatzarbeit
- versionierung, papierkorb, sync und der normale share-dialog funktionieren gratis
- export ist ein no-op
- eine eigene tabelle würde bedeuten, suche, pagination und export selbst nachzubauen

optional (v1.1): archivziel „datenbank" als alternative für user, die keine dateien wollen. das schema ist dann bewusst dumm: `id, user_id, title, markdown, created_at`.

nach dem archivieren bleibt der chat im browser bestehen und wird als archiviert markiert (link zur datei im header).

---

## 7. die vier fallstricke

### 7.1 content security policy

nextclouds default-csp blockt jeden fetch nach extern. jede `base_url` eines users muss per `addAllowedConnectDomain()` in die `ContentSecurityPolicy` des pagecontrollers — **dynamisch generiert aus den connections des eingeloggten users**.

```php
$csp = new ContentSecurityPolicy();
foreach ($this->connections->findAllForUser($uid) as $c) {
    $csp->addAllowedConnectDomain($this->host($c->getBaseUrl()));
}
$response->setContentSecurityPolicy($csp);
```

`127.0.0.1:11434` ist dabei ein eigener eintrag inklusive port.

**wichtige folge aus entscheidung 4.1**: die csp wird beim seitenaufruf gesetzt. legt der user im modal eine neue connection an, steht deren domain nicht in der csp der laufenden seite — der erste request dagegen scheitert mit einer meldung, die nach cors aussieht, aber keine ist.

→ nach dem anlegen oder ändern einer `base_url` ein `window.location.reload()`. im dialog angekündigt („verbindung wird nach dem speichern aktiviert"). bei rein kosmetischen änderungen nicht reloaden.

### 7.2 cors und private network access

- **ollama**: der user muss `OLLAMA_ORIGINS=https://cloud.example.de` setzen. das ist der mit abstand häufigste support-fall.
- **private network access**: chrome schickt bei einem request von https ins lokale netz einen preflight mit `Access-Control-Request-Private-Network`. antwortet das backend nicht passend, blockt chrome trotz korrekter cors-header.
- **mixed content**: chrome und firefox behandeln `http://127.0.0.1` als potentially trustworthy, der http-request von einer https-seite geht also durch. **safari ist strenger — vor dem release explizit testen.**
- **openrouter**: gilt als browser-tauglich und ist der übliche weg, anthropic- und google-modelle client-seitig zu nutzen, weil diese direkt per cors blocken. es gibt vereinzelte fehlerberichte, meist bei falsch gesetzter base-url. **vor implementierungsbeginn mit einem devtools-fetch verifizieren** — daran hängt das gesamte konzept.
- optional bei openrouter: `HTTP-Referer` und `X-OpenRouter-Title` setzen, dann taucht die app in deren leaderboard auf.

### 7.3 verbindungstest

button im connection-formular, der die drei fehlerklassen auseinanderhält und im klartext sagt, was zu tun ist:

| symptom | meldung |
|---|---|
| `TypeError: Failed to fetch`, csp-verstoß in der console | „diese domain ist noch nicht freigegeben — seite neu laden" |
| cors-preflight fehlgeschlagen | „das backend erlaubt keine anfragen von dieser adresse. bei ollama: `OLLAMA_ORIGINS` setzen." |
| http 401 / 403 | „api-key wird abgelehnt" |
| http 200, aber leere modellliste | „verbindung ok, aber keine modelle gefunden" |

das spart praktisch alle issues.

### 7.4 modellliste

nicht tippen lassen. nach eingabe von url + key einmal ziehen und das dropdown befüllen:

- ollama: `GET /api/tags`
- openai-kompatibel / openrouter: `GET /v1/models` bzw. `GET /api/v1/models`

ergebnis in indexeddb cachen, manueller refresh-button daneben. erspart tickets der art „qwen3.6:35b-a3b geht nicht" (tippfehler im tag).

---

## 8. streaming

`fetch` + `ReadableStream`, sse-frames manuell parsen. `AbortController` für den abbrechen-button.

hinweis aus der praxis: streaming ist bei ollama-adaptern in kombination mit bestimmten features zickig. wenn sich das zeigt, ist der pragmatische ausweg `stream: false` als per-profil-toggle statt tagelanger fehlersuche.

---

## 9. backend-api

alle routen nur für den eingeloggten user, kein `NoCSRFRequired`, kein `PublicPage`.

```
GET    /apps/{app}/api/v1/connections
POST   /apps/{app}/api/v1/connections
PUT    /apps/{app}/api/v1/connections/{id}
DELETE /apps/{app}/api/v1/connections/{id}

GET    /apps/{app}/api/v1/profiles
POST   /apps/{app}/api/v1/profiles
PUT    /apps/{app}/api/v1/profiles/{id}
DELETE /apps/{app}/api/v1/profiles/{id}
POST   /apps/{app}/api/v1/profiles/{id}/duplicate

POST   /apps/{app}/api/v1/archive          { title, markdown, created_at }
GET    /apps/{app}/api/v1/settings
PUT    /apps/{app}/api/v1/settings
```

connections und profile werden per `IInitialState` in die seite injiziert, nicht per fetch nachgeladen — sonst flackert der profil-switcher beim start.

---

## 10. sicherheit

- api-keys werden mit `\OCP\Security\ICrypto` verschlüsselt gespeichert. der schlüssel liegt trotzdem auf dem server; bei self-hosting ist das akzeptabel, muss aber in der readme stehen.
- keys werden **nie** in einer api-antwort zurückgegeben, nur `has_key: true`.
- der key landet zwangsläufig im browser, weil dort der request rausgeht. jeder user sieht seinen eigenen key in den devtools — unkritisch, da es sein eigener ist. genau das ist auch der grund, warum es keine geteilten admin-keys gibt.
- keine llm-daten in den nextcloud-logs, weil der server sie nie sieht. das ist ein verkaufsargument, kein zufall.

---

## 11. offene punkte

- verhalten beim löschen einer connection, die von profilen benutzt wird: blockieren oder kaskadieren?
- soll `system_prompt` mehrzeilige templates mit platzhaltern (`{{date}}`, `{{user}}`) unterstützen? tendenz: nein für v1.
- reasoning-token-anzeige bei modellen, die `<think>`-blöcke liefern — ausklappbar oder wegwerfen?
- indexeddb-quota: was passiert bei sehr langen verläufen? mindestens eine warnung.

## 12. danach

reihenfolge nach nutzen pro aufwand:

1. **mcp-tooling** — remote-server (streamable http) only; stdio ist aus dem browser nicht erreichbar. der agent-loop läuft dann im frontend, die app wird dadurch spürbar größer. tool-allowlist und approval-mode pro profil sind dabei pflicht, nicht kür.
2. datei-attach über den nextcloud-filepicker (webdav, same origin) — bewusst „attach", nicht rag
3. archivziel datenbank als alternative
4. files-app-action „mit llm besprechen"
