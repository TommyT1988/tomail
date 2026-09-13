'use strict';
const { app, BrowserWindow, ipcMain, shell, dialog, safeStorage, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { MailDb } = require('./db');
const { Settings } = require('./settings');
const { AccountManager } = require('./accounts');
const { AccountSync } = require('./gmail/sync');
const { Actions } = require('./actions');
const { seedDemo, DemoClient } = require('./demo');

const DEMO = process.env.MAIL_DEMO === '1';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

app.setName('Mail');
app.setPath('userData', path.join(app.getPath('appData'), DEMO ? 'tab-mail-demo' : 'tab-mail'));

let win, db, settings, accounts, actions;
const syncers = new Map();      // accountId → AccountSync
const syncStatus = {};          // accountId → { phase, synced, total, error }
let lastCheckedAt = null;
let syncTimer, snoozeTimer, changeTimer;

function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }
function notifyChanged() { clearTimeout(changeTimer); changeTimer = setTimeout(() => send('mail:changed', {}), 300); }
function broadcastStatus() { send('sync:status', { accounts: syncStatus, lastCheckedAt }); }

function syncerFor(accountId) {
  let s = syncers.get(accountId);
  if (!s) {
    s = new AccountSync({ db, client: accounts.client(accountId), account: { id: accountId }, log,
      onProgress: (st) => { syncStatus[accountId] = st; broadcastStatus(); if (st.phase !== 'error') notifyChanged(); } });
    syncers.set(accountId, s);
  }
  return s;
}
async function syncAll(onlyAccountId = null) {
  if (DEMO) { lastCheckedAt = Date.now(); broadcastStatus(); return; }
  const list = db.listAccounts().filter(a => !onlyAccountId || a.id === onlyAccountId);
  await Promise.allSettled(list.map(a => syncerFor(a.id).run().then(() => notifyChanged())));
  lastCheckedAt = Date.now();
  broadcastStatus();
}
function scheduleSync() {
  clearInterval(syncTimer);
  const sec = Math.max(15, settings.get().prefs.syncIntervalSec || 60);
  syncTimer = setInterval(() => syncAll().catch(() => {}), sec * 1000);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 1015, minWidth: 900, minHeight: 600, title: 'Mail', autoHideMenuBar: true, show: false,
    backgroundColor: '#f6f6f6',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:|^mailto:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('http://localhost') && !url.startsWith('file:')) { e.preventDefault(); shell.openExternal(url); } });
  const dev = process.env.VITE_DEV_SERVER_URL;
  if (dev) win.loadURL(dev); else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  win.on('closed', () => { win = null; });
  // Dev/CI hook: MAIL_SCREENSHOT=/dir → capture the window (and a second shot with a message open), then quit.
  if (process.env.MAIL_SCREENSHOT) {
    win.webContents.on('console-message', (e) => { const d = e.message !== undefined ? e : e; log('[renderer]', d.level ?? '', d.message ?? d.text ?? ''); });
    win.webContents.once('did-finish-load', async () => {
      const dir = process.env.MAIL_SCREENSHOT;
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const shot = async (name) => fs.writeFileSync(path.join(dir, name), (await win.webContents.capturePage()).toPNG());
      try {
        await wait(1500); await shot('1-inbox.png');
        await win.webContents.executeJavaScript(`(() => { const r = document.querySelectorAll('.row')[5]; if (r) r.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); })()`);
        await wait(1200); await shot('2-reading.png');
        await win.webContents.executeJavaScript(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true })); const b = [...document.querySelectorAll('.toolbar button')].find(b => b.textContent.includes('Reply') && !b.textContent.includes('All')); b && b.click(); })()`);
        await wait(800); await shot('3-compose.png');
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

function registerIpc() {
  handle('app:info', () => ({ version: app.getVersion(), demo: DEMO, userData: app.getPath('userData'), encrypted: safeStorage.isEncryptionAvailable() }));
  handle('settings:get', () => settings.get());
  handle('settings:set', (patch) => { const s = settings.set(patch); scheduleSync(); return s; });

  handle('accounts:list', () => db.listAccounts().map(a => ({ ...a, status: syncStatus[a.id] || null })));
  handle('accounts:add', async () => {
    if (DEMO) throw new Error('Demo mode: accounts cannot be added');
    const { account, existed } = await accounts.add({ openUrl: (u) => shell.openExternal(u) });
    syncers.delete(account.id);
    syncAll(account.id).catch(() => {});
    notifyChanged();
    return { account: { ...account, token_enc: undefined }, existed };
  });
  handle('accounts:remove', (id) => { syncers.get(id)?.cancel(); syncers.delete(id); delete syncStatus[id]; accounts.remove(id); notifyChanged(); return true; });
  handle('accounts:rename', (id, name) => { db.updateAccount(id, { display_name: name }); notifyChanged(); return true; });
  handle('accounts:resync', (id) => { syncers.get(id)?.cancel(); syncers.delete(id); db.resetAccountSync(id); notifyChanged(); syncAll(id).catch(() => {}); return true; });

  handle('labels:list', (accountId) => db.listLabels(accountId));
  handle('labels:create', (accountId, name) => actions.createLabel(accountId, name));

  handle('messages:list', (view, page) => db.listMessages(view, page));
  handle('messages:count', (view) => db.countMessages(view));
  handle('messages:counts', () => db.counts());
  handle('messages:get', (accountId, id) => actions.getMessage(accountId, id));
  handle('messages:thread', (accountId, threadId) => db.getThread(accountId, threadId));
  handle('messages:deepSearch', (q, accountId) => actions.deepSearch(q, accountId));

  handle('actions:markRead', (t, read) => actions.markRead(t, read));
  handle('actions:star', (t, on) => actions.star(t, on));
  handle('actions:archive', (t) => actions.archive(t));
  handle('actions:trash', (t) => actions.trash(t));
  handle('actions:untrash', (t) => actions.untrash(t));
  handle('actions:spam', (t, on) => actions.spam(t, on));
  handle('actions:move', (t, to, from) => actions.move(t, to, from));
  handle('actions:snooze', (t, until) => actions.snooze(t, until));
  handle('actions:unsnooze', (t) => actions.unsnooze(t));
  handle('actions:send', (opts) => actions.send(opts));

  handle('attachments:save', async (accountId, messageId, att) => {
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), att.filename || 'attachment') });
    if (r.canceled) return null;
    const data = await actions.getAttachment(accountId, messageId, att.attachmentId);
    fs.writeFileSync(r.filePath, data);
    return r.filePath;
  });
  handle('attachments:open', async (accountId, messageId, att) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-mail-'));
    const file = path.join(dir, (att.filename || 'attachment').replace(/[\\/:*?"<>|]/g, '_'));
    fs.writeFileSync(file, await actions.getAttachment(accountId, messageId, att.attachmentId));
    const err = await shell.openPath(file);
    if (err) throw new Error(err);
    return file;
  });
  handle('compose:pickFiles', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
    if (r.canceled) return [];
    return r.filePaths.map(p => ({ path: p, filename: path.basename(p), size: fs.statSync(p).size }));
  });
  handle('sync:now', (accountId) => { syncAll(accountId || null).catch(() => {}); return true; });
  handle('sync:status', () => ({ accounts: syncStatus, lastCheckedAt }));
  handle('shell:openExternal', (url) => { if (/^https?:|^mailto:/.test(url)) shell.openExternal(url); return true; });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  const userData = app.getPath('userData');
  settings = new Settings(path.join(userData, 'settings.json'));
  db = new MailDb(DEMO ? ':memory:' : path.join(userData, 'mail.sqlite'));
  accounts = new AccountManager({ db, settings, safeStorage, log });
  if (DEMO) { seedDemo(db); const dc = new DemoClient(); accounts.client = () => dc; }
  actions = new Actions({ db, clients: (id) => accounts.client(id), onChange: notifyChanged, log });
  registerIpc();
  createWindow();
  syncAll().catch(() => {});
  scheduleSync();
  snoozeTimer = setInterval(() => actions.wakeDueSnoozes().then(n => { if (n) notifyChanged(); }).catch(e => log('snooze wake:', e.message)), 30000);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { clearInterval(syncTimer); clearInterval(snoozeTimer); for (const s of syncers.values()) s.cancel(); try { db?.close(); } catch {} });
