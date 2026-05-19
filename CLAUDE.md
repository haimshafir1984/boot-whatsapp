# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # Run with ts-node (development, no build step)
npm run build      # Compile TypeScript → dist/
npm start          # Run compiled JS from dist/
```

There are no tests or linting scripts.

## Architecture

A WhatsApp bot that listens for trigger messages, saves senders as Google Contacts, and replies with a text message + the owner's contact card. A web admin dashboard manages campaigns and settings at runtime without restarting the process.

### Boot sequence (`src/index.ts`)

1. Creates a `Storage` instance (loads/creates `data/contacts.json`)
2. Calls `startAdminServer(storage)` → Express on port 3001
3. Calls `createWhatsAppClient(storage)` → starts Puppeteer/WhatsApp session; prints QR code on first run

### Message flow (`src/whatsapp.ts`)

For every incoming private message (groups are ignored):

1. **Pending name reply?** – If `conversationState` has an entry for this JID, treat the message as the user's chosen name. Cancel the auto-save timeout, then call `saveAndReply`.
2. **Trigger match?** – Call `detectTrigger` (exact string match against active campaigns). If matched and `askNameEnabled`, send the name-question message and register a `PendingConversation` with a `setTimeout` fallback. If not asking for names, call `saveAndReply` immediately.
3. **No match** – silently ignored.

`saveAndReply` does three things in sequence: save to Google Contacts (skip if already saved), send `config.REPLY_TEXT`, send the owner's contact card via `client.getContactById`.

### Campaign model (`src/storage.ts`)

- **Type 1 (Bot):** `triggerPhrase` is entered freely; suffix is always ` - (Bot)`.
- **Type 2 (Referral):** trigger is auto-built as `${basePhrase} הגעתי דרך ${referrerName}`; suffix is ` - (referrerName)`.

`Storage` reads/writes a single JSON file synchronously on every mutation. All runtime changes (campaigns, settings) are reflected immediately because `whatsapp.ts` calls `storage.getActiveCampaigns()` and `storage.getAdminSettings()` on every message.

### Admin dashboard (`src/adminServer.ts` + `public/index.html`)

REST API:
- `GET/POST /api/settings` – `AdminSettings` (askName toggle, timeout)
- `GET/POST/PUT/DELETE /api/campaigns/:id` – campaign CRUD
- `PATCH /api/campaigns/:id/toggle` – toggle active
- `GET /api/config` – returns the owner phone number for wa.me link generation

`public/index.html` is a single self-contained HTML file (no build, vanilla JS). The WhatsApp share links section displays human-readable URLs but copies properly encoded URLs to the clipboard.

### Google Contacts (`src/googleContacts.ts`)

OAuth 2.0 with offline access. On first run it opens a browser for user consent and saves the token to `data/google-token.json`. Subsequent runs reuse the token silently. The redirect URI `http://localhost:3000/oauth2callback` must be registered in Google Cloud Console.

## Configuration

All static values are in `src/config.ts` — **edit this file before first run:**
- `MY_CONTACT` – owner name, phone (E.164), optional email/organization
- `REPLY_TEXT` / `ASK_NAME_TEXT` – messages sent to users
- `BOT_SUFFIX` / `TRIGGER_REFERRAL_PREFIX` – contact name formatting

## First-run setup

1. Edit `MY_CONTACT` in `src/config.ts`
2. Copy `credentials.example.json` → `credentials.json` and fill in Google OAuth 2.0 client credentials (downloaded from Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client ID)
3. `npm run dev` – scan the QR code in WhatsApp, then authorize Google in the browser that opens

## Runtime data (gitignored)

| Path | Contents |
|------|----------|
| `credentials.json` | Google OAuth client credentials |
| `data/contacts.json` | Saved phones, campaigns, admin settings |
| `data/google-token.json` | Google OAuth token (auto-created) |
| `session/` | WhatsApp Puppeteer session |
