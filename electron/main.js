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

const DEMO = process.env.MAIL_DEMO === '1';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

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
if (process.platform === 'win32') app.setAppUserModelId('app.tomail.desktop');

let win, db, settings, accounts, actions;
const syncStatus = {};
let lastCheckedAt = null;
let syncTimer, snoozeTimer, changeTimer;
const syncing = new Set();
const lastSyncAt = new Map();   // accountId → ms
const pushTimers = new Map();

function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }
function notifyChanged() { clearTimeout(changeTimer); changeTimer = setTimeout(() => send('mail:changed', {}), 300); }
function broadcastStatus() { send('sync:status', { accounts: syncStatus, lastCheckedAt }); }

async function syncOne(accountId) {
  if (syncing.has(accountId)) return;
  syncing.add(accountId);
  try {
    const p = accounts.provider(accountId);
    if (p.kind === 'imap' && !p.onPush) p.onPush = () => { clearTimeout(pushTimers.get(accountId)); pushTimers.set(accountId, setTimeout(() => syncOne(accountId).catch(() => {}), 800)); };
    const r = await p.sync((st) => { syncStatus[accountId] = st; broadcastStatus(); if (st.phase !== 'error') notifyChanged(); });
    syncStatus[accountId] = { phase: 'idle' };
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
    const n = new Notification({ title: (m.fromName || m.fromEmail || 'New mail') + (extra > 0 && m === msgs[msgs.length - 1] ? ` (+${extra} more)` : ''), body: (m.subject || '(no subject)') + (m.snippet ? '\n' + m.snippet : ''), silent: false });
    n.on('click', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); send('app:open-message', { accountId, id: m.id }); } });
    n.show();
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 1015, minWidth: 900, minHeight: 600, title: 'Tomail', autoHideMenuBar: true, show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1f22' : '#f6f6f6',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:|^mailto:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('http://localhost') && !url.startsWith('app://')) { e.preventDefault(); if (/^https?:|^mailto:/.test(url)) shell.openExternal(url); } });
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
        await wait(800); await shot('3-compose.png');
        await js(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); })()`);
        await wait(300);
        await js(`(() => { const r = [...document.querySelectorAll('.row')].find(r => r.textContent.includes('Invitation')); if (r) r.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); })()`);
        await wait(1000); await shot('4-invite.png');
        await js(`(() => { const b = [...document.querySelectorAll('.tabs button')].find(b => /Conversations: off/.test(b.textContent)); b && b.click(); })()`);
        await wait(800);
        await js(`(() => { const r = [...document.querySelectorAll('.row')].find(r => r.textContent.includes('Quote for 20')); if (r) r.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); })()`);
        await wait(1000); await shot('5-thread.png');
        await js(`(() => { const b = [...document.querySelectorAll('.status button')].find(b => /Settings/.test(b.textContent)); b && b.click(); })()`);
        await wait(600); await shot('6-settings.png');
        await js(`(() => { const b = [...document.querySelectorAll('.settings .tabs button')].find(b => /Rules/.test(b.textContent)); b && b.click(); })()`);
        await wait(500); await shot('8-rules.png');
        await js(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return window.mail.settings.set({ prefs: { theme: 'dark' } }).then(() => { document.documentElement.dataset.theme = 'dark'; }); })()`);
        await js(`(() => { document.documentElement.classList.add('dark'); const r = [...document.querySelectorAll('.row')].find(r => r.textContent.includes('Amazon Europe')); if (r) r.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); })()`);
        await wait(900); await shot('7-dark.png');
        await js(`window.mail.settings.set({ prefs: { theme: 'system' } })`);
      } catch (e) { log('screenshot failed:', e.message); }
      app.quit();
    });
  }
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try { return await fn(...args); }
    catch (e) { log(`ipc ${channel} failed:`, e.message); return { __err: { message: e.message, code: e.code } }; }
  });
}
function applyTheme() { nativeTheme.themeSource = settings.get().prefs.theme || 'system'; }

function registerIpc() {
  handle('app:info', () => ({ version: app.getVersion(), demo: DEMO, userData: app.getPath('userData'), encrypted: safeStorage.isEncryptionAvailable(), hasGoogleClient: accounts.hasClient(), packaged: app.isPackaged, platform: process.platform }));
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
  handle('compose:pickFiles', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths.map(p => ({ path: p, filename: path.basename(p), size: fs.statSync(p).size }));
  });
  handle('sync:now', (accountId) => { syncAll(accountId || null).catch(() => {}); return true; });
  handle('sync:status', () => ({ accounts: syncStatus, lastCheckedAt }));
  handle('shell:openExternal', (url) => { if (/^https?:|^mailto:/.test(url)) shell.openExternal(url); return true; });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  registerAppProtocol();
  const userData = app.getPath('userData');
  settings = new Settings(path.join(userData, 'settings.json'));
  applyTheme();
  db = new MailDb(DEMO ? ':memory:' : path.join(userData, 'mail.sqlite'));
  accounts = new AccountManager({ db, settings, safeStorage, log });
  if (DEMO) { seedDemo(db); const dp = new DemoProvider(); accounts.provider = () => dp; }
  actions = new Actions({ db, providers: (id) => accounts.provider(id), onChange: notifyChanged, log });
  registerIpc();
  createWindow();
  syncAll().catch(() => {});
  scheduleSync();
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
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { clearInterval(syncTimer); clearInterval(snoozeTimer); for (const a of db?.listAccounts?.() || []) { try { accounts.providers.get(a.id)?.cancel(); } catch {} } try { db?.close(); } catch {} });
