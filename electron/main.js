'use strict';
const { app, BrowserWindow, ipcMain, shell, dialog, safeStorage, Menu, Notification, nativeImage, nativeTheme, protocol, net } = require('electron');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { MailDb } = require('./db');
const { Settings } = require('./settings');
const { AccountManager } = require('./accounts');
const { Actions } = require('./actions');
const { seedDemo, DemoProvider } = require('./demo');
const { autoconfig, ImapProvider } = require('./providers/imap');
const { buildDoc } = require('./printDoc');
const { runRules } = require('./rules');
const { createLogger } = require('./logger');
const { cleanUrl } = require('./links');
const { exportMbox } = require('./exportMbox');
const achievements = require('./achievements');
const appLock = require('./appLock');
const ai = require('./ai');
const aiJobs = new Map();

const DEMO = process.env.MAIL_DEMO === '1';
// stdout/stderr can be a pipe with no reader (desktop launcher, closed terminal): an EPIPE on a
// console write arrives asynchronously as a stream 'error' and, unhandled, crashes the main process.
for (const s of [process.stdout, process.stderr]) s?.on?.('error', () => {});
let log = (...a) => { try { console.log(new Date().toISOString().slice(11, 19), ...a); } catch {} };   // replaced by the file logger once userData is known

// The renderer is served from app://tomail/ rather than file:// so it has a real origin
// (sandboxed same-origin message frames can be measured; storage is stable).
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false } }]);
const DIST = path.join(__dirname, '..', 'dist');
function registerAppProtocol() {
  protocol.handle('app', (req) => {
    const u = new URL(req.url);
    let p = decodeURIComponent(u.pathname);
    if (p === '/' || p === '') p = '/index.html';
    const file = path.normalize(path.join(DIST, p));
    if (!file.startsWith(DIST + path.sep) && file !== DIST) return new Response('forbidden', { status: 403 });
    if (!fs.existsSync(file)) return new Response('not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
}
app.setName('Tomail');
app.setPath('userData', path.join(app.getPath('appData'), DEMO ? 'tomail-demo' : 'tomail'));
log = createLogger(path.join(app.getPath('userData'), 'logs', 'tomail.log'));
const ICON = path.join(__dirname, '..', 'build', 'icon.png');
if (process.platform === 'win32') app.setAppUserModelId('app.tomail.desktop');

let win, db, settings, accounts, actions;
const previewWins = new WeakSet();   // attachment viewers: the only windows allowed to show a file: URL
const PREVIEW_TYPES = /^(image\/(png|jpe?g|gif|webp|bmp|svg\+xml)|application\/pdf|text\/plain)$/i;
const composeWins = new Map();   // id → { win, payload }
let composeSeq = 0;
const syncStatus = {};
let lastCheckedAt = null;
let syncTimer, snoozeTimer, changeTimer, outboxTimer, housekeepTimer;
const pendingSends = new Map();  // id → { timer, payload, subject }
let sendSeq = 0;
const messageWins = new Map();
const syncing = new Set();
const lastSyncAt = new Map();   // accountId → ms
const pushTimers = new Map();

/** Every external link goes through here: tracking params stripped, redirectors unwrapped (Settings → General). */
function openLink(url) {
  if (!/^https?:|^mailto:/.test(url)) return;
  const p = settings.get().prefs;
  shell.openExternal(p.cleanLinks === false ? url : cleanUrl(url));
}
function send(channel, payload) { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, payload); }
/** Renderer refresh is expensive on a big mailbox (counts + list); during an initial download coalesce to one event per 10 s. */
function notifyChanged() {
  if (changeTimer) return;
  const initial = Object.values(syncStatus).some(s => s?.phase === 'initial');
  changeTimer = setTimeout(() => { changeTimer = null; send('mail:changed', {}); }, initial ? 10000 : 300);
}
function broadcastStatus() { send('sync:status', { accounts: syncStatus, lastCheckedAt }); }

async function syncOne(accountId) {
  if (syncing.has(accountId)) return;
  syncing.add(accountId);
  try {
    const p = accounts.provider(accountId);
    if (p.kind === 'imap' && !p.onPush) p.onPush = () => { clearTimeout(pushTimers.get(accountId)); pushTimers.set(accountId, setTimeout(() => syncOne(accountId).catch(() => {}), 800)); };
    let wasInitial = false;
    const r = await p.sync((st) => { if (st.phase === 'initial') wasInitial = true; syncStatus[accountId] = st; broadcastStatus(); if (st.phase !== 'error') notifyChanged(); });
    syncStatus[accountId] = { phase: 'idle' };
    if (wasInitial) { try { db.analyze(); log('database statistics refreshed after initial sync'); } catch (e) { log('analyze:', e.message); } }
    lastSyncAt.set(accountId, Date.now());
    notifyChanged();
    if (r?.newIds?.length) { try { const res = await runRules({ db, actions, accountId, ids: r.newIds, log }); if (res.applied) log(`rules: ${res.applied} message(s) filed`); } catch (e) { log('rules:', e.message); } }
    if (r?.newInbox?.length) notifyNewMail(accountId, r.newInbox.filter(id => db.getMessage(accountId, id)?.labels.includes('INBOX')));
  } catch (e) {
    syncStatus[accountId] = { phase: 'error', error: e.message, code: e.code };
    log(`sync ${accountId}: ${e.message}`);
  } finally { syncing.delete(accountId); broadcastStatus(); }
}
async function syncAll(onlyAccountId = null) {
  if (DEMO) { lastCheckedAt = Date.now(); broadcastStatus(); return; }
  const list = db.listAccounts().filter(a => !onlyAccountId || a.id === onlyAccountId);
  await Promise.allSettled(list.map(a => syncOne(a.id)));
  lastCheckedAt = Date.now();
  broadcastStatus();
}
/** Adaptive polling: every `fastPollSec` while Tomail is the active window, `syncIntervalSec` otherwise.
 *  IMAP accounts also get pushed to by IDLE, so they mostly sync ahead of the timer. */
function scheduleSync() {
  clearInterval(syncTimer);
  syncTimer = setInterval(() => {
    if (DEMO) return;
    const prefs = settings.get().prefs;
    const focused = win && !win.isDestroyed() && win.isFocused();
    const due = (focused ? Math.max(10, prefs.fastPollSec || 20) : Math.max(15, prefs.syncIntervalSec || 60)) * 1000;
    for (const a of db.listAccounts()) { if (Date.now() - (lastSyncAt.get(a.id) || 0) >= due) syncOne(a.id).catch(() => {}); }
    lastCheckedAt = Math.max(lastCheckedAt || 0, ...[...lastSyncAt.values()]);
    broadcastStatus();
  }, 5000);
}
function notifyNewMail(accountId, ids) {
  if (settings.get().prefs.notifications === false || !Notification.isSupported()) return;
  const msgs = ids.map(id => db.getMessage(accountId, id)).filter(Boolean).filter(m => m.unread).slice(0, 3);
  if (!msgs.length) return;
  const focused = win && !win.isDestroyed() && win.isFocused();
  if (focused && settings.get().prefs.notifyWhenFocused === false) return;
  const extra = ids.length - msgs.length;
  for (const m of msgs) {
    const n = new Notification({ title: (m.fromName || m.fromEmail || 'New mail') + (extra > 0 && m === msgs[msgs.length - 1] ? ` (+${extra} more)` : ''), body: (m.subject || '(no subject)') + (m.snippet ? '\n' + m.snippet : ''), silent: false, hasReply: process.platform === 'darwin', replyPlaceholder: 'Reply…' });
    n.on('click', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); send('app:open-message', { accountId, id: m.id, quickReply: true }); } });
    n.on('reply', (_e, text) => { if (text?.trim()) ipcMain.emit('quick-reply', null, accountId, m.id, text); });
    n.show();
  }
}

/** Navigation policy for EVERY window Tomail creates (main, compose, message, preview): stay on the
 *  app's own origin (or the Vite dev server), hand http(s)/mailto to the browser, refuse everything else. */
function allowedNavigation(wc, url) {
  let u; try { u = new URL(url); } catch { return false; }
  if (u.protocol === 'app:') return true;
  const dev = process.env.VITE_DEV_SERVER_URL;
  if (dev) { try { if (u.origin === new URL(dev).origin) return true; } catch {} }
  if (u.protocol === 'file:' && previewWins.has(wc)) return true;
  return false;
}
app.on('web-contents-created', (_e, wc) => {
  wc.on('will-navigate', (ev, url) => { if (!allowedNavigation(wc, url)) { ev.preventDefault(); openLink(url); } });
  wc.on('will-redirect', (ev, url) => { if (!allowedNavigation(wc, url)) ev.preventDefault(); });
  wc.on('will-attach-webview', (ev) => ev.preventDefault());
  wc.setWindowOpenHandler(({ url }) => { openLink(url); return { action: 'deny' }; });
});
function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 1015, minWidth: 900, minHeight: 600, title: `Tomail ${app.getVersion()}`, autoHideMenuBar: true, show: false, icon: ICON,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1f22' : '#f6f6f6',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.on('context-menu', (_e, params) => {
    if (!params.isEditable) return;
    const items = params.dictionarySuggestions.map(s => ({ label: s, click: () => win.webContents.replaceMisspelling(s) }));
    if (params.misspelledWord) items.push({ label: 'Add to dictionary', click: () => win.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord) }, { type: 'separator' });
    items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
    Menu.buildFromTemplate(items).popup();
  });
  const dev = process.env.VITE_DEV_SERVER_URL;
  if (dev) win.loadURL(dev); else win.loadURL('app://tomail/index.html');
  win.on('closed', () => { win = null; });
  // Dev/CI hook: MAIL_SCREENSHOT=/dir → capture the window through a few states, then quit.
  if (process.env.MAIL_SCREENSHOT) {
    win.webContents.on('console-message', (e) => log('[renderer]', e.level ?? '', e.message ?? ''));
    win.webContents.once('did-finish-load', async () => {
      const dir = process.env.MAIL_SCREENSHOT;
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const shot = async (name) => fs.writeFileSync(path.join(dir, name), (await win.webContents.capturePage()).toPNG());
      const js = (code) => win.webContents.executeJavaScript(code).catch(e => log('js:', e.message));
      try {
        await wait(1500); await shot('1-inbox.png');
        await js(`(() => { const r = document.querySelectorAll('.row')[5]; if (r) r.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); })()`);
        await wait(1200); await shot('2-reading.png');
        await js(`(() => { const b = [...document.querySelectorAll('.toolbar button')].find(b => b.textContent.includes('Reply') && !b.textContent.includes('All')); b && b.click(); })()`);
        await wait(1800);
        { const cw = [...composeWins.values()][0]?.win; if (cw && !cw.isDestroyed()) { fs.writeFileSync(path.join(dir, '3-compose.png'), (await cw.webContents.capturePage()).toPNG()); const rec = [...composeWins.values()][0]; rec.allowClose = true; cw.close(); } }
        await wait(300);
        await js(`(() => { const r = [...document.querySelectorAll('.row')].find(r => r.textContent.includes('Invitation')); if (r) r.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); })()`);
        await wait(1000); await shot('4-invite.png');
        await js(`(() => { const b = [...document.querySelectorAll('.tabs button')].find(b => /Conversations: off/.test(b.textContent)); b && b.click(); })()`);
        await wait(800);
        await js(`(() => { const r = [...document.querySelectorAll('.row')].find(r => r.textContent.includes('Quote for 20')); if (r) r.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); })()`);
        await wait(1000); await shot('5-thread.png');
        await js(`(() => { const b = [...document.querySelectorAll('.topbar button')].find(b => /Settings/.test(b.textContent)); b && b.click(); })()`);
        await js(`window.mail.messages.openWindow(1, 'demo9')`);
        await wait(1500);
        { const mw = [...messageWins.values()][0]; if (mw && !mw.isDestroyed()) { fs.writeFileSync(path.join(dir, '9-message-window.png'), (await mw.webContents.capturePage()).toPNG()); mw.close(); } }
        await wait(600); await shot('6-settings.png');
        await js(`(() => { const b = [...document.querySelectorAll('.settings .tabs button')].find(b => /Rules/.test(b.textContent)); b && b.click(); })()`);
        await wait(500); await shot('8-rules.png');
        await js(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return window.mail.settings.set({ prefs: { theme: 'dark' } }).then(() => { document.documentElement.dataset.theme = 'dark'; }); })()`);
        await js(`(() => { document.documentElement.classList.add('dark'); const r = [...document.querySelectorAll('.row')].find(r => r.textContent.includes('Amazon Europe')); if (r) r.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); })()`);
        await wait(900); await shot('7-dark.png');
        await js(`window.mail.settings.set({ prefs: { theme: 'system' } })`);
        // Oldest-first: clicking Received twice flips the sort — the list must land on TODAY at the bottom.
        await js(`(() => { document.documentElement.classList.remove('dark'); const th = [...document.querySelectorAll('.cols .th')].find(t => /Received/.test(t.textContent)); if (th) { th.click(); setTimeout(() => th.click(), 400); } })()`);
        await wait(2000); await shot('10-oldest-first.png');
        log('oldest-first scroll:', await js(`(() => { const el = document.querySelector('.rows'); const g = [...el.querySelectorAll('.grp')].pop(); return JSON.stringify({ atBottom: el.scrollHeight - el.scrollTop - el.clientHeight, lastGroup: g && g.textContent }); })()`));
      } catch (e) { log('screenshot failed:', e.message); }
      app.quit();
    });
  }
}

/** A compose window: independent (not a child), so it can be moved/minimised/resized on its own. */
function openComposeWindow(payload) {
  const id = ++composeSeq;
  const prefs = settings.get().prefs;
  const b = prefs.composeBounds || {};
  const cw = new BrowserWindow({
    width: b.width || 900, height: b.height || 720, x: b.x, y: b.y, minWidth: 620, minHeight: 460, title: 'New message', autoHideMenuBar: true, show: false, icon: ICON,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1f22' : '#f6f6f6',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true },
  });
  composeWins.set(id, { win: cw, payload });
  cw.once('ready-to-show', () => cw.show());
  cw.webContents.on('context-menu', (_e, params) => {
    if (!params.isEditable) return;
    const items = params.dictionarySuggestions.map(s => ({ label: s, click: () => cw.webContents.replaceMisspelling(s) }));
    if (params.misspelledWord) items.push({ label: 'Add to dictionary', click: () => cw.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord) }, { type: 'separator' });
    items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
    Menu.buildFromTemplate(items).popup();
  });
  // Closing via the OS button: let the renderer save the draft first, then it calls compose:closeNow.
  cw.on('close', (e) => { const rec = composeWins.get(id); if (rec && !rec.allowClose) { e.preventDefault(); rec.allowClose = true; cw.webContents.send('compose:request-close'); setTimeout(() => { if (!cw.isDestroyed()) cw.close(); }, 4000); } });
  cw.on('closed', () => { composeWins.delete(id); });
  const remember = () => { if (cw.isDestroyed() || cw.isMinimized() || cw.isMaximized()) return; settings.set({ prefs: { composeBounds: cw.getBounds() } }); };
  cw.on('resize', remember); cw.on('move', remember);
  const dev = process.env.VITE_DEV_SERVER_URL;
  cw.loadURL((dev || 'app://tomail/index.html') + '#compose/' + id);
  return id;
}
/** A message in its own window (#message/<accountId>/<id>). */
function openMessageWindow(accountId, id) {
  const key = `${accountId}:${id}`;
  const existing = messageWins.get(key);
  if (existing && !existing.isDestroyed()) { existing.focus(); return true; }
  const b = settings.get().prefs.messageBounds || {};
  const mw = new BrowserWindow({ width: b.width || 900, height: b.height || 700, minWidth: 520, minHeight: 360, title: 'Message', autoHideMenuBar: true, show: false, icon: ICON,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1f22' : '#f6f6f6',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  messageWins.set(key, mw);
  mw.once('ready-to-show', () => mw.show());
  mw.on('closed', () => messageWins.delete(key));
  const remember = () => { if (!mw.isDestroyed() && !mw.isMinimized() && !mw.isMaximized()) settings.set({ prefs: { messageBounds: mw.getBounds() } }); };
  mw.on('resize', remember); mw.on('move', remember);
  const dev = process.env.VITE_DEV_SERVER_URL;
  mw.loadURL((dev || 'app://tomail/index.html') + `#message/${accountId}/${encodeURIComponent(id)}`);
  return true;
}
/** Send with an undo window: the draft is kept until the timer fires. */
function queueSend(payload) {
  const id = ++sendSeq;
  const delay = Math.max(0, settings.get().prefs.sendDelaySec ?? 5) * 1000;
  const fire = async () => {
    pendingSends.delete(id);
    send('send:state', { id, state: 'sending', subject: payload.subject });
    try { await actions.send(payload); send('send:state', { id, state: 'sent', subject: payload.subject }); }
    catch (e) { send('send:state', { id, state: e.code === 'OUTBOX' ? 'outbox' : 'failed', subject: payload.subject, error: e.message, draftId: payload.draftId, accountId: payload.accountId }); }
  };
  if (!delay) { fire(); return id; }
  pendingSends.set(id, { timer: setTimeout(fire, delay), payload });
  send('send:state', { id, state: 'pending', subject: payload.subject, until: Date.now() + delay, draftId: payload.draftId, accountId: payload.accountId });
  return id;
}
function checkAchievements() {
  if (settings.get().prefs.achievements === false) return [];
  try {
    const unlocked = db.kvGet('achievements') || {};
    const fresh = achievements.evaluate(db.activity(), unlocked);
    for (const a of fresh) unlocked[a.id] = Date.now();
    if (fresh.length) { db.kvSet('achievements', unlocked); send('achievements:unlocked', fresh.map(({ id, title, body }) => ({ id, title, body }))); }
    return fresh;
  } catch (e) { log('achievements:', e.message); return []; }
}
function housekeeping() {
  for (const a of db.listAccounts()) {
    if (a.kind !== 'gmail' || !/auth\/contacts\.readonly/.test(a.scopes || '')) continue;
    if (Date.now() - (db.kvGet('contactsImportedAt:' + a.id) || 0) < 20 * 3600000) continue;
    accounts.provider(a.id).importContacts().then(r => log(`contacts: refreshed ${r.imported} from ${a.email}`)).catch(e => log('contacts refresh:', e.message));
  }
  try {
    const days = settings.get().prefs.bodyRetentionDays || 0;
    if (days) { const n = db.pruneBodies(days); if (n) log(`housekeeping: cleared ${n} cached bodies older than ${days} days`); }
    const last = db.kvGet('lastVacuum') || 0;
    if (Date.now() - last > 7 * 86400000) { db.vacuum(); log('housekeeping: database compacted'); }
    if (Date.now() - (db.kvGet('lastAnalyze') || 0) > 7 * 86400000) { db.analyze(); log('housekeeping: statistics refreshed'); }
  } catch (e) { log('housekeeping:', e.message); }
}
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try { return await fn(...args); }
    catch (e) { log(`ipc ${channel} failed:`, e.message); return { __err: { message: e.message, code: e.code } }; }
  });
}
function applyTheme() { nativeTheme.themeSource = settings.get().prefs.theme || 'system'; }

function registerIpc() {
  handle('app:info', () => ({ version: app.getVersion(), demo: DEMO, userData: app.getPath('userData'), encrypted: safeStorage.isEncryptionAvailable(), hasGoogleClient: accounts.hasClient(), packaged: app.isPackaged, platform: process.platform, logFile: log.file }));
  handle('app:openLogs', () => { shell.showItemInFolder(log.file); return true; });
  handle('app:reportProblem', (description) => {
    const redact = (s) => String(s).replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>');
    const body = `**What happened**\n${description || ''}\n\n**Environment**\nTomail ${app.getVersion()} · ${process.platform} ${process.arch} · Electron ${process.versions.electron}\nAccounts: ${db.listAccounts().map(a => a.kind).join(', ') || 'none'}\n\n**Recent log** (addresses redacted)\n\`\`\`\n${redact(log.tail(60))}\n\`\`\``;
    const url = 'https://github.com/TommyT1988/tomail/issues/new?' + new URLSearchParams({ title: `Problem: ${(description || '').slice(0, 60) || 'describe it here'}`, body: body.slice(0, 7000) }).toString();
    shell.openExternal(url); return true;
  });
  handle('app:dbInfo', () => { let size = 0; try { size = fs.statSync(path.join(app.getPath('userData'), 'mail.sqlite')).size; } catch {} return { size, ...db.stats() }; });
  handle('app:compactDb', () => { const days = settings.get().prefs.bodyRetentionDays || 0; const pruned = days ? db.pruneBodies(days) : 0; db.vacuum(); notifyChanged(); return { pruned }; });
  handle('messages:openWindow', (accountId, id) => openMessageWindow(accountId, id));
  handle('send:queue', (payload) => queueSend(payload));
  handle('send:cancel', (id) => { const p = pendingSends.get(id); if (!p) return false; clearTimeout(p.timer); pendingSends.delete(id); send('send:state', { id, state: 'cancelled', subject: p.payload.subject, draftId: p.payload.draftId, accountId: p.payload.accountId }); return true; });
  handle('outbox:list', () => db.listOutbox());
  handle('followups:list', () => { actions.checkFollowups(); return db.listFollowups(); });
  handle('followups:add', (accountId, messageId, dueAt) => actions.addFollowup(accountId, messageId, dueAt));
  handle('followups:update', (id, fields) => { const allowed = {}; if (fields.dueAt) { allowed.due_at = Number(fields.dueAt); allowed.status = 'waiting'; allowed.notified = 0; } if (fields.status) allowed.status = fields.status; db.updateFollowup(id, allowed); notifyChanged(); return db.getFollowup(id); });
  handle('followups:remove', (id) => { db.deleteFollowup(id); notifyChanged(); return true; });
  handle('messages:senderInfo', (email) => db.senderInfo(email, db.listAccounts().map(a => a.email)));
  handle('outbox:sendNow', (id) => actions.sendOutboxItem(id));
  handle('outbox:remove', (id) => { db.removeOutbox(id); notifyChanged(); return true; });
  handle('labels:rename', (accountId, id, name) => actions.renameLabel(accountId, id, name));
  handle('labels:remove', (accountId, id) => actions.deleteLabel(accountId, id));
  handle('labels:color', (accountId, id, bg, fg) => actions.setLabelColor(accountId, id, bg, fg));
  handle('attachments:data', async (accountId, messageId, att) => {
    if ((att.size || 0) > 12 * 1024 * 1024) throw new Error('Attachment too large to preview');
    const data = await actions.getAttachment(accountId, messageId, att.attachmentId);
    return `data:${att.mimeType || 'application/octet-stream'};base64,${Buffer.from(data).toString('base64')}`;
  });
  handle('attachments:preview', async (accountId, messageId, att) => {
    const mime = String(att.mimeType || '').toLowerCase().split(';')[0].trim();
    const byExt = /\.(png|jpe?g|gif|webp|bmp|pdf|txt)$/i.test(att.filename || '');
    if (!PREVIEW_TYPES.test(mime) && !byExt) throw new Error('Preview is only available for images, PDFs and plain text — use Open or Save instead');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tomail-'));
    const file = path.join(dir, (att.filename || 'attachment').replace(/[\\/:*?"<>|]/g, '_'));
    fs.writeFileSync(file, await actions.getAttachment(accountId, messageId, att.attachmentId));
    const pw = new BrowserWindow({ width: 1000, height: 800, title: att.filename, autoHideMenuBar: true, icon: ICON, webPreferences: { sandbox: true, plugins: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
    previewWins.add(pw.webContents);
    pw.loadFile(file);
    return true;
  });
  handle('app:setBadge', (count, dataUrl) => {
    if (process.platform === 'win32') { if (win && !win.isDestroyed()) win.setOverlayIcon(count > 0 && dataUrl ? nativeImage.createFromDataURL(dataUrl) : null, count > 0 ? `${count} unread` : ''); }
    else app.setBadgeCount(count || 0);
    return true;
  });
  handle('settings:get', () => settings.get());
  handle('settings:set', (patch) => { const s = settings.set(patch); scheduleSync(); applyTheme(); return s; });

  handle('accounts:list', () => db.listAccounts().map(a => ({ ...a, status: syncStatus[a.id] || null, canDeleteForever: (() => { try { return accounts.provider(a.id).canDeleteForever; } catch { return false; } })() })));
  handle('accounts:add', async (opts = {}) => {
    if (DEMO) throw new Error('Demo mode: accounts cannot be added');
    const { account, existed } = await accounts.add({ openUrl: (u) => shell.openExternal(u), fullAccess: !!opts.fullAccess });
    syncStatus[account.id] = { phase: 'initial', synced: 0 };
    syncAll(account.id).catch(() => {}); notifyChanged();
    return { account: { ...account, token_enc: undefined }, existed };
  });
  handle('accounts:autoconfig', (email) => autoconfig(email));
  handle('accounts:testImap', (cfg) => ImapProvider.test(cfg));
  handle('accounts:addImap', async (cfg) => {
    if (DEMO) throw new Error('Demo mode: accounts cannot be added');
    const { account, existed } = await accounts.addImap(cfg);
    syncStatus[account.id] = { phase: 'initial', synced: 0 };
    syncAll(account.id).catch(() => {}); notifyChanged();
    return { account: { ...account, token_enc: undefined, imap_json: undefined }, existed };
  });
  handle('accounts:remove', async (id) => { await accounts.remove(id); delete syncStatus[id]; notifyChanged(); return true; });
  handle('accounts:reorder', (ids) => { db.reorderAccounts(ids); notifyChanged(); return true; });
  handle('accounts:rename', (id, name) => { db.updateAccount(id, { display_name: name }); notifyChanged(); return true; });
  handle('accounts:setSignature', (id, sig) => { db.updateAccount(id, { signature: sig }); notifyChanged(); return true; });
  handle('accounts:resync', (id) => { accounts.forget(id); db.resetAccountSync(id); notifyChanged(); syncAll(id).catch(() => {}); return true; });

  handle('labels:list', (accountId) => db.listLabels(accountId));
  handle('labels:create', (accountId, name) => actions.providers(accountId).createLabel(name).then(l => { notifyChanged(); return l; }));

  handle('messages:list', (view, page) => view.threaded ? db.listThreads(view, page) : db.listMessages(view, page));
  handle('messages:count', (view) => view.threaded ? db.countThreads(view) : db.countMessages(view));
  handle('messages:counts', () => db.counts());
  handle('messages:get', (accountId, id) => actions.getMessage(accountId, id));
  handle('messages:thread', (accountId, threadId, opts) => db.threadMessages(accountId, threadId, opts || {}));
  handle('messages:deepSearch', (q, accountId) => actions.deepSearch(q, accountId));
  handle('messages:print', async (accountId, id) => {
    const m = await actions.getMessage(accountId, id);
    if (!m) throw new Error('Message not found');
    const pw = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    await pw.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(buildDoc(m)));
    await new Promise(r => setTimeout(r, 300));
    pw.webContents.print({ silent: false, printBackground: true }, () => pw.close());
    return true;
  });

  for (const a of ['markRead', 'star', 'archive', 'trash', 'untrash', 'spam', 'move', 'snooze', 'unsnooze', 'send', 'deleteForever', 'emptyFolder', 'respondInvite'])
    handle('actions:' + a, (...args) => actions[a](...args));
  handle('actions:undo', (ids, inverse) => actions.modify(ids, inverse));
  handle('drafts:list', () => ({ local: actions.listDrafts(), remote: actions.remoteDraftMessages() }));
  handle('rules:list', () => db.listRules());
  handle('rules:save', (r) => { const s = db.saveRule(r); notifyChanged(); return s; });
  handle('rules:remove', (id) => { db.deleteRule(id); notifyChanged(); return true; });
  handle('rules:run', async (accountId, labelId = 'INBOX') => {
    // apply the rule set to what's already in a folder (cap 2000, newest first)
    const ids = db.listMessages({ kind: 'label', accountId, labelId }, { limit: 2000 }).map(m => m.id);
    const res = await runRules({ db, actions, accountId, ids, log });
    return { scanned: ids.length, applied: res.applied };
  });
  handle('contacts:search', (q) => db.searchContacts(q));
  handle('contacts:stats', () => ({ ...db.contactStats(), accounts: Object.fromEntries(db.listAccounts().filter(a => a.kind === 'gmail').map(a => [a.id, { granted: /auth\/contacts\.readonly/.test(a.scopes || ''), importedAt: db.kvGet('contactsImportedAt:' + a.id) }])) }));
  handle('contacts:importGoogle', async (accountId) => {
    if (DEMO) throw new Error('Demo mode');
    const a = db.getAccount(accountId); if (!a || a.kind !== 'gmail') throw new Error('Not a Google account');
    let p = accounts.provider(accountId);
    if (!p.hasContactsScope) {
      // one-time re-consent adding the People API scopes (include_granted_scopes keeps Gmail access)
      await accounts.add({ openUrl: (u) => shell.openExternal(u), contacts: true, fullAccess: /mail\.google\.com/.test(a.scopes || ''), loginHint: a.email });
      accounts.forget(accountId); p = accounts.provider(accountId);
      if (!p.hasContactsScope) throw new Error('Google did not grant contacts access — make sure the contacts permission is ticked on the consent screen.');
    }
    const r = await p.importContacts(); notifyChanged(); return r;
  });
  handle('drafts:get', (id) => actions.getDraft(id));
  handle('drafts:save', (d) => actions.saveDraft(d));
  handle('drafts:remove', (id) => actions.deleteDraft(id));
  handle('drafts:openRemote', (accountId, messageId) => actions.openRemoteDraft(accountId, messageId));

  handle('attachments:save', async (accountId, messageId, att) => {
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), att.filename || 'attachment') });
    if (r.canceled) return null;
    fs.writeFileSync(r.filePath, await actions.getAttachment(accountId, messageId, att.attachmentId));
    return r.filePath;
  });
  handle('attachments:open', async (accountId, messageId, att) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tomail-'));
    const file = path.join(dir, (att.filename || 'attachment').replace(/[\\/:*?"<>|]/g, '_'));
    fs.writeFileSync(file, await actions.getAttachment(accountId, messageId, att.attachmentId));
    const err = await shell.openPath(file);
    if (err) throw new Error(err);
    return file;
  });
  handle('compose:open', (payload) => openComposeWindow(payload));
  handle('compose:payload', (id) => composeWins.get(Number(id))?.payload || null);
  handle('compose:closeNow', (id) => { const rec = composeWins.get(Number(id)); if (rec) { rec.allowClose = true; if (!rec.win.isDestroyed()) rec.win.close(); } return true; });
  handle('compose:pickFiles', async (_id) => {
    const r = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow() || win, { properties: ['openFile', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths.map(p => ({ path: p, filename: path.basename(p), size: fs.statSync(p).size }));
  });
  handle('sync:now', (accountId) => { syncAll(accountId || null).catch(() => {}); return true; });
  handle('sync:status', () => ({ accounts: syncStatus, lastCheckedAt }));
  handle('shell:openExternal', (url) => { openLink(url); return true; });
  handle('links:preview', (url) => cleanUrl(url));
  // scheduled sends
  handle('scheduled:add', (payload, sendAt) => { const id = db.addScheduled(payload.accountId, payload, Number(sendAt)); notifyChanged(); return id; });
  handle('scheduled:list', () => db.listScheduled());
  handle('scheduled:sendNow', async (id) => { const it = db.getScheduled(id); if (!it) throw new Error('Not scheduled'); await actions.send({ ...it.payload, draftId: undefined }); db.removeScheduled(id); notifyChanged(); return true; });
  handle('scheduled:reschedule', (id, sendAt) => { db.updateScheduled(id, Number(sendAt)); notifyChanged(); return true; });
  handle('scheduled:cancel', async (id) => { const it = db.getScheduled(id); if (!it) return false; db.removeScheduled(id); notifyChanged(); const d = actions.db.saveDraft({ accountId: it.account_id, mode: it.payload.mode || 'new', replyTo: it.payload.replyTo || null, to: it.payload.to, cc: it.payload.cc, bcc: it.payload.bcc, subject: it.payload.subject, bodyHtml: it.payload.html, bodyText: it.payload.text, attachments: it.payload.attachments || [], quotedHtml: it.payload.quotedHtml, quotedText: it.payload.quotedText }); return d.id; });
  // snippets
  handle('snippets:list', () => db.listSnippets());
  handle('snippets:save', (s) => { const id = db.saveSnippet(s); send('snippets:changed', {}); return id; });
  handle('snippets:remove', (id) => { db.deleteSnippet(id); send('snippets:changed', {}); return true; });
  // quick reply (from the reading pane or a notification)
  handle('messages:quickReply', async (accountId, id, text, all) => {
    const m = await actions.getMessage(accountId, id); if (!m) throw new Error('Message not found');
    const me = new Set(db.listAccounts().map(a => a.email.toLowerCase()));
    const to = m.replyTo || (m.fromName ? `"${m.fromName.replace(/"/g, '')}" <${m.fromEmail}>` : m.fromEmail);
    const others = all ? [...(m.to || []), ...(m.cc || [])].filter(a => !me.has(a.email)).map(a => a.name ? `"${a.name}" <${a.email}>` : a.email).join(', ') : '';
    const subj = /^re:/i.test(m.subject || '') ? m.subject : `Re: ${m.subject || ''}`;
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const quotedHtml = `<div>On ${new Date(m.date).toLocaleString('en-GB')}, ${esc(m.fromName || m.fromEmail)} wrote:</div><blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${m.bodyHtml || `<div style="white-space:pre-wrap">${esc(m.bodyText || '')}</div>`}</blockquote>`;
    return actions.send({ accountId, to, cc: others, subject: subj, text, quotedHtml, quotedText: (m.bodyText || '').split('\n').map(l => '> ' + l).join('\n'), replyTo: { accountId, id }, mode: all ? 'replyAll' : 'reply' });
  });
  // export
  handle('export:mbox', async (accountId) => {
    const a = db.getAccount(accountId); if (!a) throw new Error('Unknown account');
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('documents'), `${a.email.replace(/[^\w.-]/g, '_')}.mbox`), filters: [{ name: 'mbox', extensions: ['mbox'] }] });
    if (r.canceled) return null;
    const res = await exportMbox(db, accountId, r.filePath, (n) => send('export:progress', { n }));
    return { file: r.filePath, ...res };
  });
  // app lock
  handle('lock:status', () => ({ enabled: appLock.enabled(settings), idleMinutes: settings.get().prefs.lockIdleMinutes ?? 10 }));
  handle('lock:set', (pass, current) => { if (appLock.enabled(settings) && !appLock.verify(settings, current || '')) throw new Error('Current passphrase is wrong'); if (pass) appLock.setPass(settings, pass); else appLock.clearPass(settings); return true; });
  handle('lock:verify', (pass) => appLock.verify(settings, pass));
  // achievements
  // ── local AI (Ollama / OpenAI-compatible on localhost) ──
  const aiRun = async (reqId, messages, opts = {}) => {
    const ac = new AbortController(); aiJobs.set(reqId, ac);
    try { return await ai.chat(settings, messages, { ...opts, signal: ac.signal, onToken: opts.stream ? (t) => send('ai:token', { reqId, text: t }) : undefined }); }
    finally { aiJobs.delete(reqId); send('ai:done', { reqId }); }
  };
  const meName = (accountId) => { const a = db.getAccount(accountId); return a?.display_name && a.display_name !== a.email ? a.display_name : (a?.email || 'me'); };
  handle('ai:status', () => ai.status(settings));
  handle('ai:recommended', () => ai.RECOMMENDED);
  handle('ai:pull', async (model) => { const ac = new AbortController(); aiJobs.set('pull', ac); try { await ai.pull(settings, model, (p) => send('ai:pull-progress', p), ac.signal); return true; } finally { aiJobs.delete('pull'); } });
  handle('ai:cancel', (reqId) => { aiJobs.get(reqId)?.abort(); return true; });
  handle('ai:summarise', async (reqId, accountId, id, threadId) => {
    const msgs = threadId ? db.threadMessages(accountId, threadId) : [await actions.getMessage(accountId, id)].filter(Boolean);
    for (const m of msgs) if (!m.bodyFetched) { const full = await actions.getMessage(m.accountId, m.id); Object.assign(m, full); }
    if (!msgs.length) throw new Error('Message not found');
    const text = await aiRun(reqId, ai.summarisePrompt(msgs, meName(accountId)), { stream: true, maxTokens: 500 });
    if (!threadId && text.trim()) db.setSummary(accountId, id, text.trim());
    return text;
  });
  handle('ai:suggest', async (reqId, accountId, id) => {
    const m = await actions.getMessage(accountId, id); if (!m) throw new Error('Message not found');
    const raw = await aiRun(reqId, ai.suggestPrompt(m, meName(accountId)), { json: true, maxTokens: 300, temperature: 0.7 });
    try { const j = JSON.parse(raw); return (j.replies || []).slice(0, 3).map(String); } catch { return raw.split('\n').filter(Boolean).slice(0, 3); }
  });
  handle('ai:draft', async (reqId, { accountId, originalId, instruction, mode }) => {
    const original = originalId ? await actions.getMessage(accountId, originalId) : null;
    const cfg = { ...ai.DEFAULTS, ...(settings.get().prefs.ai || {}) };
    const styleSamples = cfg.styleLearning ? db.styleSamples(accountId) : [];
    return aiRun(reqId, ai.draftPrompt({ original, instruction, styleSamples, me: meName(accountId), mode: mode || (original ? 'reply' : 'new') }), { stream: true, maxTokens: 600, temperature: 0.5 });
  });
  handle('ai:rewrite', (reqId, text, mode) => aiRun(reqId, ai.rewritePrompt(text, mode), { stream: true, maxTokens: 900, temperature: 0.2 }));
  handle('ai:rule', async (reqId, text, accountId) => {
    const labels = (accountId ? db.listLabels(accountId) : db.listAccounts().flatMap(a => db.listLabels(a.id))).filter(l => l.type === 'user' || l.id === 'ARCHIVE');
    const raw = await aiRun(reqId, ai.rulePrompt(text, labels), { json: true, maxTokens: 400, temperature: 0 });
    const j = JSON.parse(raw);
    return { name: j.name || text.slice(0, 40), match: j.match === 'any' ? 'any' : 'all', conditions: (j.conditions || []).filter(c => c.field), actions: (j.actions || []).filter(a => a.type) };
  });
  handle('achievements:list', () => ({ all: achievements.LIST.map(({ id, title, body }) => ({ id, title, body })), unlocked: db.kvGet('achievements') || {} }));
  handle('achievements:check', () => checkAchievements());
  handle('achievements:reset', () => { db.kvSet('achievements', {}); return true; });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  registerAppProtocol();
  const userData = app.getPath('userData');
  settings = new Settings(path.join(userData, 'settings.json'));
  applyTheme();
  db = new MailDb(DEMO ? ':memory:' : path.join(userData, 'mail.sqlite'));
  accounts = new AccountManager({ db, settings, safeStorage, log });
  if (DEMO) { seedDemo(db); const dp = new DemoProvider(db); accounts.provider = () => dp; }
  actions = new Actions({ db, providers: (id) => accounts.provider(id), onChange: notifyChanged, log });
  registerIpc();
  createWindow();
  syncAll().catch(() => {});
  scheduleSync();
  setInterval(() => { try { for (const f of actions.checkFollowups()) { if (!f.notified && Notification.isSupported() && settings.get().prefs.notifications !== false) { const n = new Notification({ title: 'No reply yet: ' + (f.subject || '(no subject)'), body: `Sent to ${f.to} on ${new Date(f.createdAt).toLocaleDateString('en-GB')} — follow up?` }); n.on('click', () => { if (win) { win.show(); win.focus(); send('app:open-followups', {}); } }); n.show(); actions.markFollowupNotified(f.id); } } } catch (e) { log('followups:', e.message); } }, 5 * 60000);
  setInterval(() => actions.processScheduled().then(n => { if (n) log(`scheduled: sent ${n}`); }).catch(e => log('scheduled:', e.message)), 30000);
  setInterval(checkAchievements, 60000); setTimeout(checkAchievements, 20000);
  outboxTimer = setInterval(() => actions.processOutbox().then(n => { if (n) log(`outbox: sent ${n}`); }).catch(e => log('outbox:', e.message)), 60000);
  housekeepTimer = setTimeout(housekeeping, 90000); setInterval(housekeeping, 24 * 3600000);
  snoozeTimer = setInterval(() => actions.wakeDueSnoozes().then(n => { if (n) notifyChanged(); }).catch(e => log('snooze wake:', e.message)), 30000);
  if (app.isPackaged && !DEMO) {
    try {
      const { autoUpdater } = require('electron-updater');
      autoUpdater.logger = { info: log, warn: log, error: log, debug: () => {} };
      autoUpdater.on('update-downloaded', (info) => send('app:update-ready', { version: info.version }));
      autoUpdater.checkForUpdatesAndNotify().catch(e => log('update check:', e.message));
      setInterval(() => autoUpdater.checkForUpdatesAndNotify().catch(() => {}), 6 * 3600 * 1000);
      ipcMain.handle('app:installUpdate', () => { autoUpdater.quitAndInstall(); return true; });
    } catch (e) { log('updater unavailable:', e.message); }
  }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
ipcMain.on('quick-reply', (_e, accountId, id, text) => { actions.getMessage(accountId, id).then(async (m) => { if (!m) return; const to = m.replyTo || m.fromEmail; const subj = /^re:/i.test(m.subject || '') ? m.subject : `Re: ${m.subject || ''}`; await actions.send({ accountId, to, subject: subj, text, replyTo: { accountId, id }, mode: 'reply' }); }).catch(e => log('notification reply:', e.message)); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { clearInterval(syncTimer); clearInterval(snoozeTimer); clearInterval(outboxTimer); clearTimeout(housekeepTimer); for (const a of db?.listAccounts?.() || []) { try { accounts.providers.get(a.id)?.cancel(); } catch {} } try { db?.close(); } catch {} });
