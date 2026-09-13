'use strict';
// Local mirror of every account's mailbox. SQLite (node:sqlite, bundled with
// Electron's Node) + FTS5 for instant local search. Gmail is always the source
// of truth for labels/read/starred — this DB is a cache that the sync engine
// keeps current, plus a few local-only columns (snooze_until, body cache).
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const SYSTEM_LABELS = ['INBOX', 'SENT', 'DRAFT', 'TRASH', 'SPAM', 'STARRED', 'UNREAD', 'IMPORTANT',
  'CATEGORY_PERSONAL', 'CATEGORY_SOCIAL', 'CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS', 'CHAT'];
const CATEGORY_LABELS = ['CATEGORY_SOCIAL', 'CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS'];
const SNOOZE_LABEL_NAME = 'Snoozed';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  token_enc BLOB,
  history_id TEXT,
  initial_done INTEGER NOT NULL DEFAULT 0,
  next_page_token TEXT,
  synced_count INTEGER NOT NULL DEFAULT 0,
  total_estimate INTEGER,
  last_sync_at INTEGER,
  last_error TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  snooze_label_id TEXT
);
CREATE TABLE IF NOT EXISTS labels (
  account_id INTEGER NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  color_bg TEXT, color_fg TEXT,
  visible INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (account_id, id)
);
CREATE TABLE IF NOT EXISTS messages (
  rid INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  id TEXT NOT NULL,
  thread_id TEXT,
  history_id TEXT,
  internal_date INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  snippet TEXT,
  subject TEXT,
  from_name TEXT, from_email TEXT,
  to_json TEXT, cc_json TEXT, reply_to TEXT,
  message_id_hdr TEXT, in_reply_to TEXT, references_hdr TEXT,
  has_attachment INTEGER NOT NULL DEFAULT 0,
  unread INTEGER NOT NULL DEFAULT 0,
  starred INTEGER NOT NULL DEFAULT 0,
  labels_json TEXT NOT NULL DEFAULT '[]',
  body_fetched INTEGER NOT NULL DEFAULT 0,
  body_text TEXT, body_html TEXT,
  attachments_json TEXT,
  snooze_until INTEGER,
  UNIQUE (account_id, id)
);
CREATE INDEX IF NOT EXISTS messages_date ON messages(internal_date DESC);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(account_id, thread_id);
CREATE INDEX IF NOT EXISTS messages_snooze ON messages(snooze_until) WHERE snooze_until IS NOT NULL;
CREATE TABLE IF NOT EXISTS message_labels (
  account_id INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  label_id TEXT NOT NULL,
  PRIMARY KEY (account_id, message_id, label_id)
);
CREATE INDEX IF NOT EXISTS message_labels_label ON message_labels(account_id, label_id);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  subject, from_text, to_text, snippet, body,
  content='messages', content_rowid='rid', tokenize='unicode61'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, subject, from_text, to_text, snippet, body)
  VALUES (new.rid, new.subject, coalesce(new.from_name,'')||' '||coalesce(new.from_email,''),
          coalesce(new.to_json,'')||' '||coalesce(new.cc_json,''), new.snippet, new.body_text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, from_text, to_text, snippet, body)
  VALUES ('delete', old.rid, old.subject, coalesce(old.from_name,'')||' '||coalesce(old.from_email,''),
          coalesce(old.to_json,'')||' '||coalesce(old.cc_json,''), old.snippet, old.body_text);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF subject, from_name, from_email, to_json, cc_json, snippet, body_text ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, from_text, to_text, snippet, body)
  VALUES ('delete', old.rid, old.subject, coalesce(old.from_name,'')||' '||coalesce(old.from_email,''),
          coalesce(old.to_json,'')||' '||coalesce(old.cc_json,''), old.snippet, old.body_text);
  INSERT INTO messages_fts(rowid, subject, from_text, to_text, snippet, body)
  VALUES (new.rid, new.subject, coalesce(new.from_name,'')||' '||coalesce(new.from_email,''),
          coalesce(new.to_json,'')||' '||coalesce(new.cc_json,''), new.snippet, new.body_text);
END;
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
`;

class MailDb {
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    this._stmts = new Map();
  }
  close() { this.db.close(); }
  prep(sql) {
    let s = this._stmts.get(sql);
    if (!s) { s = this.db.prepare(sql); this._stmts.set(sql, s); }
    return s;
  }
  tx(fn) {
    this.db.exec('BEGIN');
    try { const r = fn(); this.db.exec('COMMIT'); return r; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  // ── accounts ──────────────────────────────────────────────────────────
  listAccounts() {
    return this.prep('SELECT * FROM accounts ORDER BY position, id').all().map(a => ({ ...a, token_enc: undefined }));
  }
  getAccount(id) { return this.prep('SELECT * FROM accounts WHERE id = ?').get(id) || null; }
  getAccountByEmail(email) { return this.prep('SELECT * FROM accounts WHERE email = ?').get(email) || null; }
  addAccount({ email, displayName, tokenEnc }) {
    const pos = this.prep('SELECT coalesce(max(position),0)+1 AS p FROM accounts').get().p;
    this.prep('INSERT INTO accounts (email, display_name, token_enc, position) VALUES (?,?,?,?)')
      .run(email, displayName || null, tokenEnc, pos);
    return this.getAccountByEmail(email);
  }
  updateAccount(id, fields) {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    const sets = keys.map(k => `${k} = ?`).join(', ');
    this.prep(`UPDATE accounts SET ${sets} WHERE id = ?`).run(...keys.map(k => fields[k]), id);
  }
  removeAccount(id) {
    this.tx(() => {
      this.prep('DELETE FROM message_labels WHERE account_id = ?').run(id);
      this.prep('DELETE FROM messages WHERE account_id = ?').run(id);
      this.prep('DELETE FROM labels WHERE account_id = ?').run(id);
      this.prep('DELETE FROM accounts WHERE id = ?').run(id);
    });
  }
  resetAccountSync(id) {
    this.tx(() => {
      this.prep('DELETE FROM message_labels WHERE account_id = ?').run(id);
      this.prep('DELETE FROM messages WHERE account_id = ?').run(id);
      this.updateAccount(id, { history_id: null, initial_done: 0, next_page_token: null, synced_count: 0, last_error: null });
    });
  }

  // ── labels ────────────────────────────────────────────────────────────
  replaceLabels(accountId, labels) {
    this.tx(() => {
      this.prep('DELETE FROM labels WHERE account_id = ?').run(accountId);
      const ins = this.prep('INSERT INTO labels (account_id, id, name, type, color_bg, color_fg, visible) VALUES (?,?,?,?,?,?,?)');
      for (const l of labels) {
        ins.run(accountId, l.id, l.name, l.type, l.color?.backgroundColor || null, l.color?.textColor || null,
          l.labelListVisibility === 'labelHide' ? 0 : 1);
      }
    });
  }
  listLabels(accountId) {
    return this.prep('SELECT * FROM labels WHERE account_id = ? ORDER BY type DESC, name').all(accountId);
  }
  findLabelByName(accountId, name) {
    return this.prep('SELECT * FROM labels WHERE account_id = ? AND name = ? COLLATE NOCASE').get(accountId, name) || null;
  }
  addLabel(accountId, l) {
    this.prep('INSERT OR REPLACE INTO labels (account_id, id, name, type, color_bg, color_fg, visible) VALUES (?,?,?,?,?,?,1)')
      .run(accountId, l.id, l.name, l.type || 'user', l.color?.backgroundColor || null, l.color?.textColor || null);
  }

  // ── messages: writes ──────────────────────────────────────────────────
  /** rows: normalised message rows (see sync.normaliseMessage). Existing rows keep their body cache. */
  upsertMessages(accountId, rows) {
    const ins = this.prep(`INSERT INTO messages (account_id, id, thread_id, history_id, internal_date, size, snippet, subject,
        from_name, from_email, to_json, cc_json, reply_to, message_id_hdr, in_reply_to, references_hdr, has_attachment,
        unread, starred, labels_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(account_id, id) DO UPDATE SET
        thread_id=excluded.thread_id, history_id=excluded.history_id, internal_date=excluded.internal_date,
        size=excluded.size, snippet=excluded.snippet, subject=excluded.subject, from_name=excluded.from_name,
        from_email=excluded.from_email, to_json=excluded.to_json, cc_json=excluded.cc_json, reply_to=excluded.reply_to,
        message_id_hdr=excluded.message_id_hdr, in_reply_to=excluded.in_reply_to, references_hdr=excluded.references_hdr,
        has_attachment=max(messages.has_attachment, excluded.has_attachment),
        unread=excluded.unread, starred=excluded.starred, labels_json=excluded.labels_json`);
    const delL = this.prep('DELETE FROM message_labels WHERE account_id = ? AND message_id = ?');
    const insL = this.prep('INSERT OR IGNORE INTO message_labels (account_id, message_id, label_id) VALUES (?,?,?)');
    this.tx(() => {
      for (const m of rows) {
        ins.run(accountId, m.id, m.threadId || null, m.historyId || null, m.internalDate || 0, m.size || 0,
          m.snippet || '', m.subject || '', m.fromName || null, m.fromEmail || null,
          JSON.stringify(m.to || []), JSON.stringify(m.cc || []), m.replyTo || null,
          m.messageIdHdr || null, m.inReplyTo || null, m.references || null, m.hasAttachment ? 1 : 0,
          m.labels.includes('UNREAD') ? 1 : 0, m.labels.includes('STARRED') ? 1 : 0, JSON.stringify(m.labels));
        delL.run(accountId, m.id);
        for (const l of m.labels) insL.run(accountId, m.id, l);
      }
    });
  }
  deleteMessages(accountId, ids) {
    const d1 = this.prep('DELETE FROM message_labels WHERE account_id = ? AND message_id = ?');
    const d2 = this.prep('DELETE FROM messages WHERE account_id = ? AND id = ?');
    this.tx(() => { for (const id of ids) { d1.run(accountId, id); d2.run(accountId, id); } });
  }
  /** Apply label add/remove to local rows (used by both sync and optimistic UI actions). */
  applyLabelChange(accountId, ids, { add = [], remove = [] }) {
    const get = this.prep('SELECT labels_json FROM messages WHERE account_id = ? AND id = ?');
    const upd = this.prep('UPDATE messages SET labels_json = ?, unread = ?, starred = ? WHERE account_id = ? AND id = ?');
    const insL = this.prep('INSERT OR IGNORE INTO message_labels (account_id, message_id, label_id) VALUES (?,?,?)');
    const delL = this.prep('DELETE FROM message_labels WHERE account_id = ? AND message_id = ? AND label_id = ?');
    this.tx(() => {
      for (const id of ids) {
        const row = get.get(accountId, id);
        if (!row) continue;
        const set = new Set(JSON.parse(row.labels_json));
        for (const l of remove) { set.delete(l); delL.run(accountId, id, l); }
        for (const l of add) { set.add(l); insL.run(accountId, id, l); }
        const labels = [...set];
        upd.run(JSON.stringify(labels), set.has('UNREAD') ? 1 : 0, set.has('STARRED') ? 1 : 0, accountId, id);
      }
    });
  }
  setBody(accountId, id, { text, html, attachments }) {
    this.prep('UPDATE messages SET body_fetched = 1, body_text = ?, body_html = ?, attachments_json = ?, has_attachment = ? WHERE account_id = ? AND id = ?')
      .run(text || '', html || null, JSON.stringify(attachments || []), attachments?.some(a => !a.inline) ? 1 : 0, accountId, id);
  }
  setSnooze(accountId, ids, until) {
    const s = this.prep('UPDATE messages SET snooze_until = ? WHERE account_id = ? AND id = ?');
    this.tx(() => { for (const id of ids) s.run(until, accountId, id); });
  }
  dueSnoozes(now) {
    return this.prep('SELECT account_id, id FROM messages WHERE snooze_until IS NOT NULL AND snooze_until <= ?').all(now);
  }

  // ── messages: reads ───────────────────────────────────────────────────
  getMessage(accountId, id) {
    const r = this.prep('SELECT * FROM messages WHERE account_id = ? AND id = ?').get(accountId, id);
    return r ? rowToMessage(r) : null;
  }
  getThread(accountId, threadId) {
    return this.prep('SELECT * FROM messages WHERE account_id = ? AND thread_id = ? ORDER BY internal_date').all(accountId, threadId).map(rowToMessage);
  }
  existingIds(accountId, ids) {
    const s = this.prep('SELECT id FROM messages WHERE account_id = ? AND id = ?');
    return new Set(ids.filter(id => s.get(accountId, id)));
  }
  /**
   * view: { kind: 'label'|'all-inboxes'|'unread'|'starred'|'snoozed'|'search'|'all',
   *         accountId?, labelId?, category?: 'primary'|'CATEGORY_x', q? }
   */
  listMessages(view, { offset = 0, limit = 100 } = {}) {
    const { where, params, join } = this._viewSql(view);
    const sql = `SELECT m.rid, m.account_id, m.id, m.thread_id, m.internal_date, m.size, m.snippet, m.subject, m.from_name,
        m.from_email, m.to_json, m.has_attachment, m.unread, m.starred, m.labels_json, m.snooze_until
      FROM messages m ${join} WHERE ${where} ORDER BY m.internal_date DESC LIMIT ? OFFSET ?`;
    return this.prep(sql).all(...params, limit, offset).map(rowToListItem);
  }
  countMessages(view) {
    const { where, params, join } = this._viewSql(view);
    return this.prep(`SELECT count(*) AS n FROM messages m ${join} WHERE ${where}`).get(...params).n;
  }
  _viewSql(view) {
    const params = [];
    const w = [];
    let join = '';
    const notTrashSpam = `NOT EXISTS (SELECT 1 FROM message_labels x WHERE x.account_id = m.account_id AND x.message_id = m.id AND x.label_id IN ('TRASH','SPAM'))`;
    const hasLabel = (l) => `EXISTS (SELECT 1 FROM message_labels x WHERE x.account_id = m.account_id AND x.message_id = m.id AND x.label_id = '${l.replace(/'/g, "''")}')`;
    if (view.accountId != null && view.kind !== 'label') { w.push('m.account_id = ?'); params.push(view.accountId); }
    switch (view.kind) {
      case 'label': {
        w.push('m.account_id = ?'); params.push(view.accountId);
        join = 'JOIN message_labels ml ON ml.account_id = m.account_id AND ml.message_id = m.id AND ml.label_id = ?';
        params.unshift(view.labelId);
        if (!['TRASH', 'SPAM'].includes(view.labelId)) w.push(notTrashSpam);
        if (view.labelId === 'INBOX' && view.category) w.push(categorySql(view.category, hasLabel));
        w.push('m.snooze_until IS NULL');
        break;
      }
      case 'all-inboxes':
        w.push(hasLabel('INBOX'), notTrashSpam, 'm.snooze_until IS NULL');
        if (view.category) w.push(categorySql(view.category, hasLabel));
        break;
      case 'unread': w.push('m.unread = 1', notTrashSpam, 'm.snooze_until IS NULL'); break;
      case 'starred': w.push('m.starred = 1', notTrashSpam); break;
      case 'snoozed': w.push('m.snooze_until IS NOT NULL'); break;
      case 'all': w.push(notTrashSpam); break;
      case 'search': {
        join = 'JOIN messages_fts f ON f.rowid = m.rid';
        w.push('messages_fts MATCH ?'); params.push(toFtsQuery(view.q));
        w.push(notTrashSpam);
        break;
      }
      case 'ids': {
        // explicit (account, id) pairs, e.g. deep-search results
        const pairs = view.ids || [];
        if (!pairs.length) { w.push('0'); break; }
        w.push('(' + pairs.map(() => '(m.account_id = ? AND m.id = ?)').join(' OR ') + ')');
        for (const p of pairs) params.push(p.accountId, p.id);
        break;
      }
      default: w.push('0');
    }
    return { where: w.join(' AND ') || '1', params, join };
  }
  /** Unread counts per (account,label) + favourites, computed locally. */
  counts() {
    const perLabel = this.prep(`SELECT ml.account_id, ml.label_id, count(*) AS total, sum(m.unread) AS unread
      FROM message_labels ml JOIN messages m ON m.account_id = ml.account_id AND m.id = ml.message_id
      WHERE m.snooze_until IS NULL GROUP BY ml.account_id, ml.label_id`).all();
    const labels = {};
    for (const r of perLabel) (labels[r.account_id] ||= {})[r.label_id] = { total: r.total, unread: r.unread };
    const fav = this.prep(`SELECT
      (SELECT count(*) FROM messages m WHERE m.unread = 1 AND m.snooze_until IS NULL AND NOT EXISTS (SELECT 1 FROM message_labels x WHERE x.account_id=m.account_id AND x.message_id=m.id AND x.label_id IN ('TRASH','SPAM'))) AS unread,
      (SELECT count(*) FROM messages m WHERE m.starred = 1 AND NOT EXISTS (SELECT 1 FROM message_labels x WHERE x.account_id=m.account_id AND x.message_id=m.id AND x.label_id IN ('TRASH','SPAM'))) AS starred,
      (SELECT count(*) FROM messages m WHERE m.snooze_until IS NOT NULL) AS snoozed,
      (SELECT count(*) FROM messages m WHERE m.snooze_until IS NULL AND EXISTS (SELECT 1 FROM message_labels x WHERE x.account_id=m.account_id AND x.message_id=m.id AND x.label_id='INBOX') AND NOT EXISTS (SELECT 1 FROM message_labels x WHERE x.account_id=m.account_id AND x.message_id=m.id AND x.label_id IN ('TRASH','SPAM'))) AS inboxTotal,
      (SELECT count(*) FROM messages m WHERE m.unread=1 AND m.snooze_until IS NULL AND EXISTS (SELECT 1 FROM message_labels x WHERE x.account_id=m.account_id AND x.message_id=m.id AND x.label_id='INBOX') AND NOT EXISTS (SELECT 1 FROM message_labels x WHERE x.account_id=m.account_id AND x.message_id=m.id AND x.label_id IN ('TRASH','SPAM'))) AS inboxUnread
    `).get();
    return { labels, favourites: fav };
  }
  kvGet(k) { const r = this.prep('SELECT v FROM kv WHERE k = ?').get(k); return r ? JSON.parse(r.v) : null; }
  kvSet(k, v) { this.prep('INSERT OR REPLACE INTO kv (k, v) VALUES (?,?)').run(k, JSON.stringify(v)); }
}

function categorySql(category, hasLabel) {
  if (category === 'primary') return `NOT (${CATEGORY_LABELS.map(hasLabel).join(' OR ')})`;
  return hasLabel(category);
}

/** Turn free text into a safe FTS5 query: each word becomes a prefix term, phrases in quotes kept. */
function toFtsQuery(q) {
  const terms = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(q || ''))) {
    if (m[1]) terms.push('"' + m[1].replace(/"/g, '') + '"');
    else {
      const w = m[2].replace(/[^\p{L}\p{N}@._-]/gu, '');
      if (w) terms.push('"' + w + '"*');
    }
  }
  return terms.length ? terms.join(' AND ') : '""';
}

function rowToListItem(r) {
  return {
    accountId: r.account_id, id: r.id, threadId: r.thread_id, date: r.internal_date, size: r.size,
    snippet: r.snippet, subject: r.subject, fromName: r.from_name, fromEmail: r.from_email,
    to: safeJson(r.to_json, []), hasAttachment: !!r.has_attachment, unread: !!r.unread, starred: !!r.starred,
    labels: safeJson(r.labels_json, []), snoozeUntil: r.snooze_until,
  };
}
function rowToMessage(r) {
  return {
    ...rowToListItem(r), cc: safeJson(r.cc_json, []), replyTo: r.reply_to, messageIdHdr: r.message_id_hdr,
    inReplyTo: r.in_reply_to, references: r.references_hdr, bodyFetched: !!r.body_fetched,
    bodyText: r.body_text, bodyHtml: r.body_html, attachments: safeJson(r.attachments_json, []),
  };
}
function safeJson(s, d) { try { return s ? JSON.parse(s) : d; } catch { return d; } }

module.exports = { MailDb, SYSTEM_LABELS, CATEGORY_LABELS, SNOOZE_LABEL_NAME, toFtsQuery };
