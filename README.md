# Mail — TAB Retail desktop email client

Electron desktop client for Google Workspace / Gmail accounts, modelled on the
three-pane layout in the design screenshot: folder tree (favourites, per-account
system folders, nested labels), message list with Primary/Promotions/Social tabs
and day grouping, reading pane below, compose in a modal.

Every account's mailbox is mirrored into a local SQLite database (bundled with
Electron's Node — no native modules), so folder views, counts and search are
instant even for a 60k-message inbox. Gmail stays the source of truth: read /
flag / archive / delete / move / snooze are Gmail label changes, applied
optimistically and reverted if Google rejects them.

## Stack
- Electron 44 (Node 24) · React 19 + Vite 8 · `node:sqlite` with FTS5 · nodemailer (MIME building only)
- No UI component libraries. All icons are inline SVG.

## Layout
```
electron/main.js        app lifecycle, window, IPC, sync scheduler, snooze timer
electron/preload.cjs    contextBridge → window.mail.*  (renderer never touches network/db)
electron/db.js          SQLite schema + queries + FTS (accounts, labels, messages, message_labels)
electron/accounts.js    token storage (safeStorage-encrypted) + GmailClient factory
electron/actions.js     every user action (mark/star/archive/trash/move/snooze/send/deep search/body fetch)
electron/gmail/oauth.js PKCE loopback OAuth for a Google "Desktop app" client
electron/gmail/api.js   Gmail REST client: refresh on 401, backoff on 429/5xx, multipart batch GETs
electron/gmail/sync.js  resumable initial sync (newest first, metadata only) + history.list increments
electron/gmail/mime.js  payload → text/html/attachments; outgoing → RFC 2822 raw
electron/demo.js        MAIL_DEMO=1 sample mailbox (no Google needed)
src/                    React renderer (App, Sidebar, MessageList, ReadingPane, Compose, SettingsModal, Menus, Icons)
test/                   node:test unit tests (db, mime, batch parser, sync, actions) — `npm test`
```

## First run — Google API credentials (one-time, ~5 minutes)
Mail talks to Gmail directly, so it needs its own OAuth client:
1. https://console.cloud.google.com → create a project (e.g. "TAB Mail") → **APIs & Services → Library → Gmail API → Enable**.
2. **OAuth consent screen**: User type **Internal** (Workspace only, no Google verification needed). App name "Mail", your address as contact.
3. **Credentials → Create credentials → OAuth client ID → Desktop app**. Copy the client ID + secret.
4. In the app: **Settings → Google API** → paste both → Save. Then **Settings → Accounts → Add Google account** (a browser tab opens for sign-in; repeat per mailbox).
5. If the Workspace admin has locked down third-party apps: Admin console → Security → API controls → allow this client ID.

Scope requested: `gmail.modify` only (read, label, archive, trash, send). Permanent delete is never requested.
Tokens are stored encrypted with the OS keychain (Electron `safeStorage`) under the app's data folder.

## Run
```
npm install            # first time (downloads Electron)
npm run dev            # Vite dev server + Electron with live reload
npm start              # build renderer, then run Electron against dist/
MAIL_DEMO=1 npm start  # sample mailbox, no Google connection
npm test               # unit tests
npm run dist           # package with electron-builder (release/)
```
On a headless Linux box the demo can be exercised under Xvfb:
`env -u ELECTRON_RUN_AS_NODE MAIL_DEMO=1 MAIL_SCREENSHOT=/tmp/shots xvfb-run -a ./node_modules/electron/dist/electron . --no-sandbox`
(VS Code terminals export `ELECTRON_RUN_AS_NODE=1`, which turns the Electron binary into plain Node — unset it.)

## Behaviour notes
- **Initial sync** pins the history cursor first, then walks `messages.list` newest-first in batches of 50
  (metadata only, ~50 msgs/s under the default quota). It is resumable (`next_page_token` persisted),
  so closing the app mid-sync is fine. Bodies download on first open and are cached.
- **Incremental sync** every 60 s (Settings) via `history.list`; a 404 (expired history) triggers a clean resync.
- **Search**: Enter = local FTS over subject/from/to/snippet/cached bodies (prefix matching).
  **Deep search** = Gmail's own `q` search (bodies + attachment contents, full Gmail syntax); results are pulled into the local cache.
- **Snooze** removes INBOX, adds a `Snoozed` label (created on demand) and stores the wake time locally;
  a 30 s timer puts it back in the inbox unread. The wake timer is per PC (only the PC that snoozed it wakes it).
- **Categories**: Primary = inbox messages carrying no `CATEGORY_*` label; Promotions/Social tabs filter on Gmail's labels.
- **Remote images** are blocked by default (per-message "Load images" button; global toggle in Settings).
  HTML is rendered in a sandboxed iframe; links open in the system browser.
- **Move to folder** follows Gmail semantics: adds the target label, removes the label of the folder you were viewing.
- Keyboard in the list: ↑/↓ move · Delete = trash · e = archive · u = read/unread · s = flag · r/a/f = reply/reply all/forward · n = new · Esc = clear selection.

## Not in v1 (candidates for next)
Drafts (Gmail DRAFT folder is read-only here), threaded conversation view, rich-text compose, empty trash / permanent delete,
Google push notifications (Pub/Sub) instead of polling, rules/filters, calendar invites, per-account signatures, printing.
