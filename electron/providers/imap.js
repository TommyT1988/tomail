'use strict';
// Generic IMAP/SMTP provider. Folders become labels (special-use folders map onto the
// same INBOX/SENT/TRASH/SPAM/DRAFT ids the Gmail provider uses, plus ARCHIVE), flags map
// onto UNREAD/STARRED, and a "move" is what a label change means. Message ids are
// `<folder path>::<uid>`; a move re-keys the local row so cached bodies survive.
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');
const { htmlToText } = require('../gmail/mime');
const { parseAuthResults } = require('../authResults');

const SPECIAL = { '\\Inbox': 'INBOX', '\\Sent': 'SENT', '\\Trash': 'TRASH', '\\Junk': 'SPAM', '\\Drafts': 'DRAFT', '\\Archive': 'ARCHIVE', '\\All': 'ALLMAIL' };
const NAME_GUESS = [[/^inbox$/i, 'INBOX'], [/^(sent|sent items|sent mail|sent messages)$/i, 'SENT'], [/^(trash|deleted|deleted items|deleted messages|bin)$/i, 'TRASH'],
  [/^(junk|spam|junk e-?mail|bulk mail)$/i, 'SPAM'], [/^drafts?$/i, 'DRAFT'], [/^(archive|archives|all mail)$/i, 'ARCHIVE']];
const FOLDER_LABELS = new Set(['INBOX', 'SENT', 'TRASH', 'SPAM', 'DRAFT', 'ARCHIVE', 'ALLMAIL']);
const FLAG_LABELS = new Set(['UNREAD', 'STARRED']);
const CHUNK = 250;
const SNOOZE_KW = /^\$TomailUntil(\d{10,13})$/;
const FLAG_SWEEP_MS = 10 * 60 * 1000;

const mkId = (path, uid) => `${path}::${uid}`;
const splitId = (id) => { const i = id.lastIndexOf('::'); return { path: id.slice(0, i), uid: Number(id.slice(i + 2)) }; };

class ImapProvider {
  /** cfg: { host, port, secure, user, pass, smtpHost, smtpPort, smtpSecure, smtpUser?, smtpPass? } */
  constructor({ db, accountId, cfg, log = () => {} }) {
    this.kind = 'imap'; this.db = db; this.accountId = accountId; this.cfg = cfg; this.log = log;
    this.client = null; this.connecting = null; this.cancelled = false; this.running = false;
    this.folders = [];          // [{ path, labelId, type, delimiter, specialUse, name }]
    this.lastFlagSweep = 0;
  }
  cancel() { this.cancelled = true; }

  // ── connection ──
  async conn() {
    if (this.client?.usable) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const c = new ImapFlow({ host: this.cfg.host, port: this.cfg.port || (this.cfg.secure === false ? 143 : 993), secure: this.cfg.secure !== false,
        auth: { user: this.cfg.user, pass: this.cfg.pass }, logger: false, clientInfo: { name: 'Tomail' }, socketTimeout: 120000 });
      c.on('error', (e) => this.log(`imap error (${this.accountId}): ${e.message}`));
      c.on('close', () => { if (this.client === c) this.client = null; });
      c.on('exists', () => { if (this.onPush && !this.running) this.onPush(); });
      c.on('flags', () => { if (this.onPush && !this.running) this.onPush(); });
      await c.connect();
      this.client = c;
      return c;
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  async close() { try { await this.client?.logout(); } catch {} this.client = null; }
  static async test(cfg) {
    const c = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure !== false, auth: { user: cfg.user, pass: cfg.pass }, logger: false, connectionTimeout: 15000 });
    await c.connect(); const caps = [...(c.capabilities?.keys?.() || [])]; await c.logout();
    if (cfg.smtpHost) { const t = ImapProvider.transport(cfg); await t.verify(); }
    return { ok: true, capabilities: caps };
  }
  static transport(cfg) {
    const port = cfg.smtpPort || 587;
    return nodemailer.createTransport({ host: cfg.smtpHost, port, secure: cfg.smtpSecure ?? port === 465, auth: { user: cfg.smtpUser || cfg.user, pass: cfg.smtpPass || cfg.pass }, connectionTimeout: 20000 });
  }

  // ── folders ──
  async syncLabels() {
    const c = await this.conn();
    const list = await c.list({ statusQuery: undefined });
    const used = new Set();
    this.folders = [];
    for (const f of list) {
      if ((f.flags && f.flags.has('\\Noselect')) || f.listed === false) continue;
      let labelId = SPECIAL[f.specialUse] || null;
      if (!labelId) for (const [re, id] of NAME_GUESS) if (re.test(f.name) && !used.has(id) && !f.parentPath) { labelId = id; break; }
      if (f.path.toUpperCase() === 'INBOX') labelId = 'INBOX';
      if (labelId && used.has(labelId)) labelId = null;
      if (labelId) used.add(labelId); else labelId = f.path;
      const name = labelId === f.path ? f.path.split(f.delimiter || '/').join('/') : labelId;
      this.folders.push({ path: f.path, labelId, type: FOLDER_LABELS.has(labelId) ? 'system' : 'user', delimiter: f.delimiter || '/', name, specialUse: f.specialUse });
    }
    this.db.replaceLabels(this.accountId, this.folders.map(f => ({ id: f.labelId, name: f.name, type: f.type, imapPath: f.path })));
    return this.folders;
  }
  folderFor(labelId) { return this.folders.find(f => f.labelId === labelId) || null; }
  async ensureFolder(labelId, createName) {
    if (!this.folders.length) await this.syncLabels();
    let f = this.folderFor(labelId);
    if (f) return f;
    const c = await this.conn();
    const r = await c.mailboxCreate(createName || labelId);
    await this.syncLabels();
    f = this.folders.find(x => x.path === r.path) || this.folderFor(labelId);
    if (!f) throw new Error(`Could not create folder ${createName || labelId}`);
    if (f.labelId !== labelId) { f.labelId = labelId; f.type = 'system'; this.db.replaceLabels(this.accountId, this.folders.map(x => ({ id: x.labelId, name: x.name, type: x.type, imapPath: x.path }))); }
    return f;
  }

  // ── sync ──
  async sync(onProgress = () => {}) {
    if (this.running) return { newInbox: [] };
    this.running = true; this.cancelled = false;
    const newInbox = [], newAll = [];
    try {
      await this.syncLabels();
      const acct = this.db.getAccount(this.accountId);
      const order = [...this.folders].sort((a, b) => (a.labelId === 'INBOX' ? -1 : b.labelId === 'INBOX' ? 1 : 0));
      const initial = !acct.initial_done;
      let synced = acct.synced_count || 0;
      const doFlagSweep = Date.now() - this.lastFlagSweep > FLAG_SWEEP_MS;
      for (const f of order) {
        if (this.cancelled) break;
        onProgress({ phase: initial ? 'initial' : 'incremental', synced, folder: f.name });
        const r = await this.syncFolder(f, { onProgress: (n) => { synced += n; onProgress({ phase: initial ? 'initial' : 'incremental', synced, folder: f.name }); }, flagSweep: doFlagSweep });
        if (f.labelId === 'INBOX') newInbox.push(...r.newIds.filter(id => this.db.getMessage(this.accountId, id)?.unread));
        if (!['SENT', 'DRAFT', 'TRASH', 'SPAM'].includes(f.labelId)) newAll.push(...r.newIds);
      }
      if (doFlagSweep) this.lastFlagSweep = Date.now();
      // Leave INBOX selected so the connection idles there and the server pushes new-mail events to us.
      try { const inbox = this.folderFor('INBOX'); if (inbox) { const c = await this.conn(); if (c.mailbox?.path !== inbox.path) await c.mailboxOpen(inbox.path); } } catch {}
      const allDone = this.folders.every(f => this.db.imapFolder(this.accountId, f.path)?.initial_done);
      this.db.updateAccount(this.accountId, { synced_count: synced, initial_done: allDone ? 1 : 0, last_sync_at: Date.now(), last_error: null });
      onProgress({ phase: 'idle' });
      return { newInbox, newIds: newAll };
    } catch (e) {
      this.db.updateAccount(this.accountId, { last_error: e.message });
      onProgress({ phase: 'error', error: e.message, code: /auth|login|credentials/i.test(e.message) ? 'REAUTH' : undefined });
      await this.close();
      throw e;
    } finally { this.running = false; }
  }

  async syncFolder(f, { onProgress, flagSweep }) {
    const c = await this.conn();
    const lock = await c.getMailboxLock(f.path);
    const newIds = [];
    try {
      const mb = c.mailbox;
      const st0 = this.db.imapFolder(this.accountId, f.path);
      const firstVisit = !st0;
      let st = st0 || { uid_validity: null, last_uid: 0, min_uid: null, modseq: null, initial_done: 0 };
      if (st.uid_validity != null && st.uid_validity !== mb.uidValidity) {
        this.log(`UIDVALIDITY changed for ${f.path} — refetching`);
        this.db.deleteFolderMessages(this.accountId, f.path);
        st = { uid_validity: mb.uidValidity, last_uid: 0, min_uid: null, modseq: null, initial_done: 0 };
      }
      st.uid_validity = mb.uidValidity;
      const top = (mb.uidNext || 1) - 1;
      if (st.last_uid === 0 && st.min_uid == null) {
        // first visit: mark the top and backfill downwards in chunks (newest first, resumable)
        st.last_uid = top; st.min_uid = top + 1; st.initial_done = mb.exists === 0 ? 1 : 0;
      } else if (top > st.last_uid) {
        // new mail since last visit
        const ids = await this.fetchRange(c, f, `${st.last_uid + 1}:*`, { onlyAbove: st.last_uid });
        if (!firstVisit) newIds.push(...ids); onProgress(ids.length);
        st.last_uid = top;
      }
      // backfill older mail (initial sync), bounded per pass so other folders/accounts get a turn
      let passes = 0;
      while (!st.initial_done && st.min_uid > 1 && passes < 8 && !this.cancelled) {
        const lo = Math.max(1, st.min_uid - CHUNK), hi = st.min_uid - 1;
        const ids = await this.fetchRange(c, f, `${lo}:${hi}`);
        onProgress(ids.length);
        st.min_uid = lo;
        if (lo === 1) st.initial_done = 1;
        this.db.setImapFolder(this.accountId, f.path, st);
        passes++;
      }
      if (!st.initial_done && st.min_uid <= 1) st.initial_done = 1;
      // flag changes + deletions
      if (st.initial_done || flagSweep) {
        const local = this.db.messagesByFolder(this.accountId, f.path);
        if (local.length) {
          const useCondstore = mb.highestModseq && st.modseq && c.capabilities?.has?.('CONDSTORE');
          const seen = new Set();
          const flagsOf = new Map();
          if (useCondstore && !flagSweep) {
            for await (const m of c.fetch('1:*', { uid: true, flags: true }, { uid: true, changedSince: BigInt(st.modseq) })) flagsOf.set(m.uid, m.flags);
            for await (const m of c.fetch('1:*', { uid: true }, { uid: true })) seen.add(m.uid);
          } else {
            for await (const m of c.fetch('1:*', { uid: true, flags: true }, { uid: true })) { seen.add(m.uid); flagsOf.set(m.uid, m.flags); }
          }
          const gone = local.filter(r => r.uid <= st.last_uid && !seen.has(r.uid) && r.uid >= (st.min_uid || 1)).map(r => r.id);
          if (gone.length) this.db.deleteMessages(this.accountId, gone);
          for (const r of local) {
            const fl = flagsOf.get(r.uid); if (!fl) continue;
            const want = flagsToLabels(fl, f.labelId);
            const add = want.filter(l => !r.labels.includes(l)), remove = r.labels.filter(l => !want.includes(l));
            if (add.length || remove.length) this.db.applyLabelChange(this.accountId, [r.id], { add, remove });
            const sn = snoozeFromFlags(fl); if (sn) this.db.adoptSnooze(this.accountId, r.id, sn);
            const answered = fl.has('\\Answered') ? 1 : 0;
            if (answered !== r.answered) this.db.prep('UPDATE messages SET answered = ? WHERE account_id = ? AND id = ?').run(answered, this.accountId, r.id);
          }
        }
        if (mb.highestModseq) st.modseq = String(mb.highestModseq);
      }
      this.db.setImapFolder(this.accountId, f.path, st);
    } finally { lock.release(); }
    return { newIds };
  }

  /** FETCH metadata for a UID range into the DB; returns new ids. Newest first within the range. */
  async fetchRange(c, f, range, { onlyAbove = 0 } = {}) {
    const rows = [];
    for await (const m of c.fetch(range, { uid: true, flags: true, envelope: true, bodyStructure: true, size: true, internalDate: true, headers: ['references', 'reply-to', 'content-type', 'list-unsubscribe', 'authentication-results'] }, { uid: true })) {
      if (m.uid <= onlyAbove) continue;
      rows.push(normaliseImap(m, f));
    }
    if (rows.length) { this.db.upsertMessages(this.accountId, rows); this.db.assignThreads(this.accountId, rows.map(r => r.id)); }
    return rows.map(r => r.id);
  }

  // ── actions ──
  /** Translate label semantics into flag + move operations. */
  async modify(ids, { add = [], remove = [] }) {
    if (!this.folders.length) await this.syncLabels();
    const rekeyed = new Map();
    const c = await this.conn();
    const byFolder = new Map();
    for (const id of ids) { const { path, uid } = splitId(id); if (!byFolder.has(path)) byFolder.set(path, []); byFolder.get(path).push({ id, uid }); }
    const flagAdd = [], flagDel = [];
    if (add.includes('STARRED')) flagAdd.push('\\Flagged'); if (remove.includes('STARRED')) flagDel.push('\\Flagged');
    if (add.includes('UNREAD')) flagDel.push('\\Seen'); if (remove.includes('UNREAD')) flagAdd.push('\\Seen');
    if (add.includes('ANSWERED')) flagAdd.push('\\Answered');
    for (const l of add) if (/^\$TomailUntil/.test(l)) flagAdd.push(l);
    for (const l of remove) if (/^\$TomailUntil/.test(l)) flagDel.push(l);
    const isFlagish = (l) => FLAG_LABELS.has(l) || l === 'ANSWERED' || /^\$TomailUntil/.test(l);
    let target = add.find(l => !isFlagish(l)) || null;
    if (!target && remove.some(l => l === 'INBOX' || (!isFlagish(l) && !FOLDER_LABELS.has(l)))) target = 'ARCHIVE';
    for (const [path, items] of byFolder) {
      const lock = await c.getMailboxLock(path);
      try {
        const uids = items.map(i => i.uid);
        if (flagAdd.length) await c.messageFlagsAdd(uids, flagAdd, { uid: true });
        if (flagDel.length) await c.messageFlagsRemove(uids, flagDel, { uid: true });
        if (target) {
          const tf = target === 'ARCHIVE' ? await this.ensureFolder('ARCHIVE', 'Archive') : target === 'SNOOZED' ? await this.ensureFolder('SNOOZED', 'Snoozed') : await this.ensureFolder(target, target);
          if (tf.path !== path) {
            const r = await c.messageMove(uids, tf.path, { uid: true });
            const map = r?.uidMap || new Map();
            for (const it of items) {
              const nu = map.get(it.uid);
              if (nu) { this.db.rekeyMessage(this.accountId, it.id, mkId(tf.path, nu), { folder: tf.path, uid: nu }); rekeyed.set(it.id, mkId(tf.path, nu)); }
              else this.db.deleteMessages(this.accountId, [it.id]); // server didn't tell us the new UID; next sync re-adds it
              const cur = this.db.getMessage(this.accountId, nu ? mkId(tf.path, nu) : it.id);
              if (cur) {
                const folderLabel = this.folders.find(x => x.path === path)?.labelId;
                this.db.applyLabelChange(this.accountId, [cur.id], { add: [tf.labelId], remove: [folderLabel].filter(l => l && l !== tf.labelId) });
              }
            }
            // bump destination folder's watermark so the sync doesn't re-fetch what we just moved
            const st = this.db.imapFolder(this.accountId, tf.path);
            if (st && map.size) { st.last_uid = Math.max(st.last_uid, ...map.values()); this.db.setImapFolder(this.accountId, tf.path, st); }
          }
        }
      } finally { lock.release(); }
    }
    return { rekeyed };
  }
  async fetchFull(id) {
    const { path, uid } = splitId(id);
    const c = await this.conn();
    const lock = await c.getMailboxLock(path);
    let src;
    try { const r = await c.download(uid, undefined, { uid: true }); src = await streamToBuffer(r.content); }
    finally { lock.release(); }
    const parsed = await simpleParser(src, { skipImageLinks: false });
    const attachments = (parsed.attachments || []).map((a, i) => ({ partId: String(i), attachmentId: String(i), filename: a.filename || `attachment-${i + 1}`, mimeType: a.contentType,
      size: a.size, contentId: a.contentId ? a.contentId.replace(/^<|>$/g, '') : null, inline: a.contentDisposition === 'inline' && !!a.contentId, _content: a.content }));
    return { meta: null, text: parsed.text || '', html: parsed.html || (parsed.textAsHtml || ''), attachments, inlineData: async (a) => a._content,
      calendar: (parsed.attachments || []).find(a => /text\/calendar/i.test(a.contentType))?.content?.toString('utf8') || null };
  }
  async getAttachment(id, attachmentId) {
    const full = await this.fetchFull(id);
    const a = full.attachments[Number(attachmentId)];
    if (!a) throw new Error('Attachment not found');
    return a._content;
  }
  async send({ raw }) {
    const buf = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const t = ImapProvider.transport(this.cfg);
    const info = await t.sendMail({ raw: buf });
    // Most non-Gmail servers don't keep a copy: append to Sent (Gmail/Outlook IMAP do it themselves).
    if (!/gmail\.com|googlemail\.com|office365\.com|outlook\.com/i.test(this.cfg.host)) {
      try { const sf = await this.ensureFolder('SENT', 'Sent'); const c = await this.conn(); await c.append(sf.path, buf, ['\\Seen']); } catch (e) { this.log('append to Sent failed: ' + e.message); }
    }
    return { id: info.messageId };
  }
  async search(q, limit = 100) {
    if (!this.folders.length) await this.syncLabels();
    const c = await this.conn();
    const out = [];
    const order = [...this.folders].sort((a, b) => (a.labelId === 'INBOX' ? -1 : b.labelId === 'INBOX' ? 1 : 0)).filter(f => !['TRASH', 'SPAM'].includes(f.labelId)).slice(0, 12);
    for (const f of order) {
      if (out.length >= limit) break;
      const lock = await c.getMailboxLock(f.path);
      try {
        const uids = await c.search({ or: [{ subject: q }, { from: q }, { to: q }, { body: q }] }, { uid: true });
        const top = (uids || []).sort((a, b) => b - a).slice(0, limit - out.length);
        const ids = top.map(u => mkId(f.path, u));
        const known = this.db.existingIds(this.accountId, ids);
        const missing = top.filter(u => !known.has(mkId(f.path, u)));
        if (missing.length) await this.fetchRange(c, f, missing.join(','));
        out.push(...ids);
      } finally { lock.release(); }
    }
    return out;
  }
  async createLabel(name) {
    const c = await this.conn();
    const r = await c.mailboxCreate(name.split('/'));
    await this.syncLabels();
    return this.folders.find(f => f.path === r.path) || { id: name, name };
  }
  async renameLabel(id, name) {
    const f = this.folderFor(id); if (!f) throw new Error('Folder not found');
    const c = await this.conn();
    const parent = f.path.includes(f.delimiter) ? f.path.slice(0, f.path.lastIndexOf(f.delimiter) + 1) : '';
    await c.mailboxRename(f.path, parent + name.replace(/\//g, f.delimiter));
    this.db.deleteFolderMessages(this.accountId, f.path);
    this.db.prep('DELETE FROM imap_folders WHERE account_id = ? AND path = ?').run(this.accountId, f.path);
    await this.syncLabels();
  }
  async deleteLabel(id) {
    const f = this.folderFor(id); if (!f) throw new Error('Folder not found');
    const c = await this.conn();
    await c.mailboxDelete(f.path);
    this.db.deleteFolderMessages(this.accountId, f.path);
    this.db.prep('DELETE FROM imap_folders WHERE account_id = ? AND path = ?').run(this.accountId, f.path);
    await this.syncLabels();
  }
  async setLabelColor(id, bg, fg) { this.db.updateLabel(this.accountId, id, { color_bg: bg || null, color_fg: fg || null }); }
  async saveDraft({ raw, remoteId }) {
    const df = await this.ensureFolder('DRAFT', 'Drafts');
    const c = await this.conn();
    const buf = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const r = await c.append(df.path, buf, ['\\Draft', '\\Seen']);
    if (remoteId) await this.deleteDraft(remoteId).catch(() => {});
    const id = mkId(df.path, r.uid);
    return { id, messageId: id };
  }
  async deleteDraft(remoteId) {
    const { path, uid } = splitId(remoteId);
    const c = await this.conn();
    const lock = await c.getMailboxLock(path);
    try { await c.messageDelete([uid], { uid: true }); } finally { lock.release(); }
    this.db.deleteMessages(this.accountId, [remoteId]);
  }
  get canDeleteForever() { return true; }
  async deleteForever(ids) {
    const c = await this.conn();
    const byFolder = new Map();
    for (const id of ids) { const { path, uid } = splitId(id); (byFolder.get(path) || byFolder.set(path, []).get(path)).push(uid); }
    for (const [path, uids] of byFolder) { const lock = await c.getMailboxLock(path); try { await c.messageDelete(uids, { uid: true }); } finally { lock.release(); } }
    this.db.deleteMessages(this.accountId, ids);
  }
  async emptyFolder(labelId) {
    const f = this.folderFor(labelId); if (!f) return 0;
    const c = await this.conn();
    const lock = await c.getMailboxLock(f.path);
    try { if (c.mailbox.exists > 0) await c.messageDelete('1:*'); } finally { lock.release(); }
    return this.db.deleteFolderMessages(this.accountId, f.path);
  }
}

function snoozeFromFlags(flags) { for (const f of flags || []) { const m = SNOOZE_KW.exec(f); if (m) return Number(m[1]) * (m[1].length <= 10 ? 1000 : 1); } return null; }
function flagsToLabels(flags, folderLabel) {
  const l = [folderLabel];
  if (!flags.has('\\Seen')) l.push('UNREAD');
  if (flags.has('\\Flagged')) l.push('STARRED');
  return l;
}
function addr(list) { return (list || []).filter(a => a.address).map(a => ({ name: a.name || '', email: String(a.address).toLowerCase() })); }
function hasAttachmentPart(bs) {
  if (!bs) return false;
  if (bs.disposition === 'attachment' || (bs.dispositionParameters?.filename && bs.disposition !== 'inline') || (bs.parameters?.name && !/^text\//.test(bs.type || ''))) return true;
  return (bs.childNodes || []).some(hasAttachmentPart);
}
function parseHeaderBlock(buf) {
  const o = {};
  if (!buf) return o;
  for (const line of buf.toString('utf8').replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) { const i = line.indexOf(':'); if (i > 0) o[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim(); }
  return o;
}
function normaliseImap(m, f) {
  const env = m.envelope || {};
  const h = parseHeaderBlock(m.headers);
  const from = addr(env.from)[0] || { name: '', email: '' };
  return {
    id: mkId(f.path, m.uid), threadId: null, historyId: null, internalDate: (m.internalDate || env.date || new Date()).getTime?.() || Date.parse(m.internalDate || env.date) || 0,
    size: m.size || 0, snippet: '', subject: env.subject || '', fromName: from.name, fromEmail: from.email,
    to: addr(env.to), cc: addr(env.cc), replyTo: h['reply-to'] || (addr(env.replyTo)[0]?.email) || null,
    messageIdHdr: env.messageId || null, inReplyTo: env.inReplyTo || null, references: h.references || null,
    hasAttachment: hasAttachmentPart(m.bodyStructure), labels: flagsToLabels(m.flags || new Set(), f.labelId), answered: (m.flags || new Set()).has('\\Answered'),
    imapFolder: f.path, imapUid: m.uid, snoozeUntil: snoozeFromFlags(m.flags), auth: parseAuthResults(h['authentication-results']),
  };
}
async function streamToBuffer(stream) { const chunks = []; for await (const c of stream) chunks.push(c); return Buffer.concat(chunks); }

/** Guess IMAP/SMTP settings for an address: Mozilla autoconfig DB → presets → DNS-style guesses. */
async function autoconfig(email) {
  const domain = String(email).split('@')[1]?.toLowerCase();
  if (!domain) throw new Error('Enter a full email address');
  const presets = {
    'gmail.com': { host: 'imap.gmail.com', smtpHost: 'smtp.gmail.com', note: 'Use an App Password (Google Account → Security → 2-Step Verification → App passwords). Or add it as a Google account instead.' },
    'googlemail.com': { host: 'imap.gmail.com', smtpHost: 'smtp.gmail.com', note: 'Use an App Password.' },
    'outlook.com': { host: 'outlook.office365.com', smtpHost: 'smtp.office365.com', note: 'Microsoft has retired password sign-in for IMAP on most accounts; if login fails, an app password or OAuth is required.' },
    'hotmail.com': { host: 'outlook.office365.com', smtpHost: 'smtp.office365.com', note: 'Microsoft has retired password sign-in for IMAP on most accounts.' },
    'live.com': { host: 'outlook.office365.com', smtpHost: 'smtp.office365.com' }, 'msn.com': { host: 'outlook.office365.com', smtpHost: 'smtp.office365.com' },
    'yahoo.com': { host: 'imap.mail.yahoo.com', smtpHost: 'smtp.mail.yahoo.com', note: 'Generate an app password in Yahoo Account Security.' },
    'yahoo.co.uk': { host: 'imap.mail.yahoo.com', smtpHost: 'smtp.mail.yahoo.com', note: 'Generate an app password in Yahoo Account Security.' },
    'icloud.com': { host: 'imap.mail.me.com', smtpHost: 'smtp.mail.me.com', note: 'Use an app-specific password from appleid.apple.com.' },
    'me.com': { host: 'imap.mail.me.com', smtpHost: 'smtp.mail.me.com' }, 'mac.com': { host: 'imap.mail.me.com', smtpHost: 'smtp.mail.me.com' },
    'aol.com': { host: 'imap.aol.com', smtpHost: 'smtp.aol.com', note: 'Generate an app password in AOL Account Security.' },
    'fastmail.com': { host: 'imap.fastmail.com', smtpHost: 'smtp.fastmail.com', note: 'Use an app password from Fastmail settings.' },
    'zoho.com': { host: 'imap.zoho.com', smtpHost: 'smtp.zoho.com' }, 'gmx.com': { host: 'imap.gmx.com', smtpHost: 'mail.gmx.com' }, 'gmx.de': { host: 'imap.gmx.net', smtpHost: 'mail.gmx.net' },
    'yandex.com': { host: 'imap.yandex.com', smtpHost: 'smtp.yandex.com' }, 'protonmail.com': { note: 'Proton requires the Proton Mail Bridge app (IMAP on 127.0.0.1:1143).', host: '127.0.0.1', port: 1143, secure: false, smtpHost: '127.0.0.1', smtpPort: 1025, smtpSecure: false },
  };
  const base = { user: email, port: 993, secure: true, smtpPort: 587, smtpSecure: false, source: 'preset' };
  if (presets[domain]) return { ...base, ...presets[domain] };
  try {
    const r = await fetch(`https://autoconfig.thunderbird.net/v1.1/${encodeURIComponent(domain)}`, { signal: AbortSignal.timeout(6000) });
    if (r.ok) {
      const xml = await r.text();
      const inc = /<incomingServer type="imap">([\s\S]*?)<\/incomingServer>/.exec(xml)?.[1];
      const out = /<outgoingServer type="smtp">([\s\S]*?)<\/outgoingServer>/.exec(xml)?.[1];
      const tag = (s, t) => /<t>([^<]*)<\/t>/.exec(s || '')?.[1]?.trim() || null;
      const pick = (block, t) => new RegExp(`<${t}>([^<]*)</${t}>`).exec(block || '')?.[1]?.trim() || null;
      const userOf = (block) => { const u = pick(block, 'username'); return u === '%EMAILLOCALPART%' ? email.split('@')[0] : email; };
      if (inc) {
        return { ...base, host: pick(inc, 'hostname'), port: Number(pick(inc, 'port')) || 993, secure: pick(inc, 'socketType') !== 'STARTTLS', user: userOf(inc),
          smtpHost: pick(out, 'hostname') || `smtp.${domain}`, smtpPort: Number(pick(out, 'port')) || 587, smtpSecure: pick(out, 'socketType') === 'SSL', smtpUser: userOf(out), source: 'autoconfig', displayName: tag(xml) };
      }
    }
  } catch {}
  return { ...base, host: `imap.${domain}`, smtpHost: `smtp.${domain}`, source: 'guess', note: 'Guessed from the domain — check with your provider if sign-in fails.' };
}

module.exports = { ImapProvider, autoconfig, mkId, splitId, normaliseImap, flagsToLabels, FOLDER_LABELS };
