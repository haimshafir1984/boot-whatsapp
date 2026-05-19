# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Commands

```bash
npm run dev        # Run with ts-node (development, no build step)
npm run build      # Compile TypeScript → dist/
npm start          # Run compiled JS from dist/
```

No tests or linting scripts.

## What this project does

A WhatsApp bot that:
1. Listens for trigger phrases (defined in campaigns)
2. Optionally asks the sender for their preferred name
3. Saves the sender as a contact (Google / iCloud / manual CSV)
4. Replies with a text message + the owner's vCard contact

A web admin dashboard (Express + vanilla JS) manages campaigns and settings at runtime without restarting the process.

## Deployment

**Production**: Railway (Docker). GitHub repo: `haimshafir1984/boot-whatsapp`.
Every push to `master` triggers an automatic deploy.

**Local dev**: `npm run dev` → dashboard at `http://localhost:3001`

### Railway configuration
- One **Volume** mounted at `/app/data` — persists contacts.json, google-token.json, and the WhatsApp session (at `./data/session`)
- **Environment variables**:
  - `PORT=3001`
  - `GOOGLE_CREDENTIALS_BASE64` — base64 of `credentials.json` (Google OAuth client)
- **Dockerfile** uses `node:20-slim` + system Chromium (`PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`)

### Google Cloud Console
Authorized redirect URIs must include:
- `https://boot-whatsapp-production-e6d7.up.railway.app/oauth2callback`
- `http://localhost:3001/oauth2callback` (for local dev)

## Architecture

### Boot sequence (`src/index.ts`)
1. Removes stale Chromium `Singleton*` lock files from the session dir (prevents crash-on-restart)
2. Creates a `Storage` instance (loads/creates `data/contacts.json`)
3. Calls `startAdminServer(storage)` — Express on `PORT` (default 3001)
4. Calls `createWhatsAppClient(storage)` — starts Puppeteer/WhatsApp session

### Message flow (`src/whatsapp.ts`)

Every incoming **private** message (groups filtered by `@g.us`):

1. **Pending name reply?** — If `conversationState` has an entry for this JID, treat the message as the chosen name. Cancel the auto-save timeout, call `saveAndReply`.
2. **Trigger match?** — Call `detectTrigger` (normalized exact match against active campaigns).
   - `askNameEnabled` ON — send ask-name message, register `PendingConversation` with `setTimeout` fallback
   - `askNameEnabled` OFF — call `saveAndReply` immediately
3. **No match** — silently ignored

`saveAndReply` sequence:
1. Skip if phone already saved (`storage.isContactSaved`)
2. Save to Google Contacts / iCloud CardDAV / log locally (based on `contactsProvider` setting)
3. Send `config.REPLY_TEXT`
4. Send owner's vCard (`client.getContactById`)

### Trigger detection (`src/triggerDetector.ts`)

`normalize()` strips invisible Unicode chars (RTL markers, zero-width spaces) and collapses whitespace before comparing — needed because WhatsApp injects these into Hebrew text.

Match is **exact** after normalization. Case-sensitive.

### Campaign model (`src/storage.ts`)

- **Type 1 (Bot):** `triggerPhrase` entered freely; suffix = ` - (Bot)`
- **Type 2 (Referral):** trigger auto-built as `${basePhrase} הגעתי דרך ${referrerName}`; suffix = ` - (referrerName)`

`Storage` reads/writes a single JSON file synchronously on every mutation. All runtime changes are reflected immediately because `whatsapp.ts` calls `storage.getActiveCampaigns()` and `storage.getAdminSettings()` on every message — no restart needed.

### Admin dashboard (`src/adminServer.ts` + `public/index.html`)

REST API:
- `GET /api/qr` — QR data URL + authenticated status
- `POST /api/pair` — request WhatsApp pairing code (phone number alternative to QR)
- `GET/POST /api/settings` — `AdminSettings`
- `GET/POST/PUT/DELETE /api/campaigns/:id` — campaign CRUD
- `PATCH /api/campaigns/:id/toggle` — toggle active
- `GET /api/config` — owner phone for wa.me link generation
- `GET /api/google/status` — is Google token present
- `GET /api/google/auth-url` — generates OAuth URL (dynamic baseUrl from request)
- `DELETE /api/google/disconnect` — deletes token file
- `GET /oauth2callback` — Google OAuth redirect handler
- `POST /api/icloud/test` — verify iCloud credentials
- `GET /api/contacts/export` — CSV download

`public/index.html` is a single self-contained HTML file (vanilla JS, no build). Dashboard sections (top to bottom): WhatsApp connection → Contacts provider → Campaigns → Settings → Share links.

### Google Contacts (`src/googleContacts.ts`)

OAuth 2.0 with offline access. Credentials loaded from:
1. `GOOGLE_CREDENTIALS_BASE64` env var (base64 JSON) — used on Railway
2. `credentials.json` file — used locally

Token saved to `data/google-token.json`. Refreshed automatically on expiry.

### iCloud Contacts (`src/icloudContacts.ts`)

CardDAV via native `https` module:
- `testICloudConnection` — PROPFIND to verify App Password
- `saveContactToICloud` — discovers principal → addressbook URL → PUT vCard

Requires an Apple ID **App Password** (not the main password).

## Configuration (`src/config.ts`)

Edit before deploying for a new client:
- `MY_CONTACT` — owner name, phone (E.164), optional email/organization
- `REPLY_TEXT` — message sent to every user who triggers the bot
- `ASK_NAME_TEXT` — message asking for preferred name (`{timeout}` replaced at runtime)
- `BOT_SUFFIX` / `TRIGGER_REFERRAL_PREFIX` — contact name formatting

`ADMIN_PORT` reads `process.env.PORT` first (for Railway).
`SESSION_PATH` is `./data/session` — inside the volume on Railway.

## Runtime data (gitignored)

| Path | Contents |
|------|----------|
| `credentials.json` | Google OAuth client credentials (use env var on Railway) |
| `data/contacts.json` | Saved phones, campaigns, admin settings |
| `data/google-token.json` | Google OAuth token (auto-created after first auth) |
| `data/session/` | WhatsApp Puppeteer session |

## Known issues / gotchas

- **Chromium SingletonLock**: Railway kills the process but the lock file stays on the volume. Fixed by `removeSingletonLocks()` in `index.ts`.
- **Invisible Unicode in Hebrew messages**: WhatsApp adds RTL/LTR markers. `normalize()` in `triggerDetector.ts` strips them before matching.
- **"Active campaigns: 0" in startup log**: Normal if campaigns were created after the last restart. `storage.getActiveCampaigns()` is called on every message, so new campaigns work immediately without restart.
- **Volume not mounted at `/app/data`**: All data is ephemeral — campaigns, contacts, Google token, and WA session are lost on every restart. Verify by checking the startup log line `Storage : /app/data/contacts.json`.
