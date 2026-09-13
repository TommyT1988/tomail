# Tomail

A fast, keyboard-friendly desktop email client for **Gmail, Google Workspace and any IMAP mailbox** (Outlook, Yahoo, iCloud, Fastmail, your own domain…), for Windows, macOS and Linux.

Three-pane layout: folders and labels on the left (favourites, per-account system folders, nested labels),
a message list with Primary / Promotions / Social tabs grouped by day, and a reading pane below.
Every account is mirrored into a local database, so folder views, unread counts and search are
instant even for a 60,000-message inbox — and it still works when you're offline.

## Features
- Google accounts (sign in with your browser) and IMAP/SMTP accounts (server settings looked up automatically), any mix, with a merged **All Inboxes** view
- **Conversation view** (toggle in the list header): one row per thread, messages stacked in the reading pane
- **Drafts** auto-save as you type and are mirrored to the server's Drafts folder, so you can finish them elsewhere
- **Compose opens in its own window** (move, minimise, resize; several at once); closing it saves the draft
- **Rich-text compose**: bold/italic/underline, lists, quotes, links, pasted or inserted images; per-account signatures
- **Calendar invites** show as a card with Accept / Maybe / Decline (sends the reply to the organiser)
- **Notifications** for new inbox mail (click to open) and an unread badge on the dock / taskbar icon
- **Dark mode** (system, light or dark), printing, search filters (from, to, dates, account, folder, unread, flagged, attachments)
- Trash and Junk views offer Restore, Delete forever and Empty folder (Gmail needs "Grant full access" for permanent delete)
- **Rules**: file, label, archive, flag, read, junk or trash new mail by sender, recipient, subject, body or attachment (Settings → Rules, or "Create rule from sender" in Quick Actions)
- **Address autocomplete** in To/Cc/Bcc from the people you've written to and heard from
- **Snooze follows you**: the wake time is stored on the server (a hidden Gmail label or an IMAP keyword), so every device running Tomail wakes the message
- **Undo** after archive, delete, move and junk, and an undo-send delay (default 5 s) after pressing Send
- **Outbox**: with no connection, sent mail waits and goes out automatically when you're back online
- **Open a message in its own window** (o), attachment previews for images and PDFs inline
- **Folder management** from the sidebar's right-click menu: rename, delete, colour, new subfolder
- **Search operators** in the search box: `from:` `to:` `in:` `is:unread` `is:flagged` `has:attachment` `after:` `before:`; press `?` for the shortcut list
- **Report a problem** (Settings → General) opens a GitHub issue with the version and recent log attached, addresses redacted; the log file lives in the data folder
- **Housekeeping**: optional "keep downloaded bodies for N days" and weekly database compaction
- **Instant new mail** on IMAP accounts via IMAP IDLE; Gmail polls every 20 s while Tomail is the active window (60 s in the background). True Gmail push needs a Pub/Sub relay server, which a standalone app can't ship.
- Instant local search (subject, sender, recipients, cached bodies) plus **Deep search** that runs Gmail's own
  search — full Gmail syntax, including inside attachments
- Read / unread, flag, archive, delete, move to folder, junk / not junk — all applied instantly and synced to Gmail
- **Snooze** (later today, tomorrow, weekend, next week, or pick a time)
- Compose, reply, reply all, forward (with the original attachments), file attachments, signature
- Remote images blocked by default (per-message "Load images"), HTML rendered in a sandbox, links open in your browser
- Keyboard: ↑/↓ move · Delete = trash · e = archive · u = read/unread · s = flag · r / a / f = reply / reply all / forward · n = new
- Automatic updates from GitHub Releases

IMAP accounts get the same features. Folders appear as labels, flags map to read/flagged, and moving between folders is what archive, junk, snooze and "move to" do underneath. Message ids are `folder::uid`, and a move re-keys the local row so cached bodies survive.

Tomail asks Google for the `gmail.modify` scope only: read, label, archive, trash and send.
It never requests permanent-delete access, and your Google password never passes through the app.
Sign-in tokens are stored encrypted with your operating system's keychain.

## Install
Download the installer for your platform from the [Releases](https://github.com/TommyT1988/tomail/releases) page:
Windows `-win-x64.exe` / `-win-arm64.exe`, macOS `-mac-x64.dmg` (Intel) / `-mac-arm64.dmg` (Apple Silicon), Linux `-linux-x86_64.AppImage` or `-linux-arm64.AppImage` (plus `.deb` for both).

> Builds are not code-signed yet. Windows SmartScreen and macOS Gatekeeper will warn on first launch
> ("More info → Run anyway" / right-click → Open).

Then click **Sign in with Google**. The newest mail appears within seconds; the rest of the mailbox
downloads in the background (roughly 50 messages per second) and resumes if you close the app.

## Build it yourself
```
git clone https://github.com/TommyT1988/tomail && cd tomail
npm install
npm run dev              # Vite dev server + Electron, live reload
npm start                # build the renderer and run Electron against it
MAIL_DEMO=1 npm start    # sample mailbox, no Google connection
npm test                 # unit tests (node:test)
npm run dist             # installers into release/
```

**Google sign-in for your own build.** Releases carry a built-in Google OAuth client. Your own build won't, so either:
- create a *Desktop app* OAuth client in [Google Cloud Console](https://console.cloud.google.com/apis/library/gmail.googleapis.com)
  (enable the Gmail API; consent screen **Internal** for Workspace, or External with yourself as a test user) and export
  `TOMAIL_GOOGLE_CLIENT_ID` / `TOMAIL_GOOGLE_CLIENT_SECRET` before `npm run oauth:client`, or
- paste the same values in the app under **Settings → Advanced**.

On a headless Linux box the demo can be exercised under Xvfb:
`env -u ELECTRON_RUN_AS_NODE MAIL_DEMO=1 MAIL_SCREENSHOT=/tmp/shots xvfb-run -a ./node_modules/electron/dist/electron . --no-sandbox`
(VS Code terminals export `ELECTRON_RUN_AS_NODE=1`, which turns the Electron binary into plain Node — unset it.)

## Releasing
1. Add repository secrets `TOMAIL_GOOGLE_CLIENT_ID` and `TOMAIL_GOOGLE_CLIENT_SECRET`.
2. Bump `version` in `package.json`, commit, tag `vX.Y.Z`, push the tag.
3. The **Release** workflow builds all three platforms and attaches installers to a GitHub Release; installed copies pick it up automatically.

### Google verification (read this before publishing widely)
`gmail.modify` is a **restricted** scope. While the OAuth consent screen is in *Testing* mode Google allows up to
100 test users and expires their sign-in every 7 days (Tomail shows a "Sign in again" button when that happens).
To remove those limits the app must pass Google's OAuth verification, which for restricted Gmail scopes includes an
annual third-party CASA security assessment. Plan for that before promoting Tomail beyond a test group.

## How it works
```
electron/main.js        app lifecycle, window, IPC, sync scheduler, snooze timer, auto-update
electron/preload.cjs    contextBridge → window.mail.*  (the renderer never touches the network or database)
electron/db.js          SQLite (node:sqlite, bundled with Electron) schema + queries + FTS5 search
electron/accounts.js    token storage (safeStorage-encrypted) + per-account Gmail client
electron/actions.js     every user action: optimistic local change → Gmail call → revert on failure
electron/gmail/oauth.js PKCE loopback OAuth for a Google "Desktop app" client
electron/gmail/api.js   Gmail REST client: refresh on 401, backoff on 429/5xx, multipart batch GETs
electron/gmail/sync.js  resumable newest-first initial sync (metadata only) + history.list increments
electron/gmail/mime.js  Gmail payload → text/html/attachments; outgoing → RFC 2822
src/                    React renderer (no UI libraries; icons are inline SVG)
test/                   unit tests for db, mime, batch parsing, sync and actions
```
- Initial sync pins the history cursor, then walks `messages.list` newest-first in batches of 50 (metadata only).
  Bodies download on first open and are cached. Incremental sync runs every 60 s via `history.list`; an expired
  history (404) triggers a clean resync.
- Snooze removes `INBOX`, adds a `Snoozed` label (created on demand) and stores the wake time locally; a timer
  puts the message back in the inbox, unread. The timer lives on the PC that snoozed it.
- Primary = inbox messages with no `CATEGORY_*` label; Promotions/Social follow Gmail's own categorisation.
- Move follows Gmail semantics: add the target label, drop the label of the folder you were viewing.

## Roadmap
Code signing, Microsoft OAuth for Outlook/365 IMAP, Google Contacts import.

Microsoft 365 / Outlook.com note: Microsoft has retired password sign-in for IMAP on most accounts, so those need an app password (where the tenant allows it) or OAuth support, which Tomail doesn't have yet.

## License
MIT — see [LICENSE](LICENSE).
