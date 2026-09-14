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
  snooze_label_id TEXT,
  kind TEXT NOT NULL DEFAULT 'gmail',
  imap_json TEXT,
  signature TEXT,
  scopes TEXT
);
CREATE TABLE IF NOT EXISTS labels (
  account_id INTEGER NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  color_bg TEXT, color_fg TEXT,
  visible INTEGER NOT NULL DEFAULT 1,
  imap_path TEXT,
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
  answered INTEGER NOT NULL DEFAULT 0,
  imap_folder TEXT,
  imap_uid INTEGER,
  calendar_json TEXT,
  auth_json TEXT,
  ai_summary TEXT,
  UNIQUE (account_id, id)
);
CREATE INDEX IF NOT EXISTS messages_msgid ON messages(account_id, message_id_hdr);
CREATE TABLE IF NOT EXISTS imap_folders (
  account_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  uid_validity INTEGER,
  last_uid INTEGER NOT NULL DEFAULT 0,
  min_uid INTEGER,
  modseq TEXT,
  initial_done INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, path)
);
CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  mode TEXT NOT NULL DEFAULT 'new',
  reply_account_id INTEGER, reply_message_id TEXT,
  to_text TEXT, cc_text TEXT, bcc_text TEXT, subject TEXT,
  body_html TEXT, body_text TEXT,
  attachments_json TEXT,
  quoted_html TEXT, quoted_text TEXT, include_orig_atts INTEGER NOT NULL DEFAULT 0,
  remote_id TEXT, remote_message_id TEXT, remote_synced_at INTEGER,
  updated_at INTEGER NOT NULL
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
CREATE TABLE IF NOT EXISTS contacts (
  email TEXT PRIMARY KEY,
  name TEXT,
  sent_count INTEGER NOT NULL DEFAULT 0,
  recv_count INTEGER NOT NULL DEFAULT 0,
  last_used INTEGER NOT NULL DEFAULT 0,
  source TEXT
);
CREATE TABLE IF NOT EXISTS followups (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  message_id TEXT, thread_id TEXT, message_id_hdr TEXT,
  subject TEXT, to_text TEXT,
  due_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting',
  replied_by TEXT, replied_at INTEGER, notified INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS scheduled (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  subject TEXT, to_text TEXT,
  send_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS snippets (
  id INTEGER PRIMARY KEY,
  trigger TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  body_html TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  subject TEXT, to_text TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_try INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  account_id INTEGER,
  position INTEGER NOT NULL DEFAULT 0,
  match TEXT NOT NULL DEFAULT 'all',
  conditions_json TEXT NOT NULL DEFAULT '[]',
  actions_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
`;

class MailDb {
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
    this.db.function('regexp_strip', { deterministic: true }, (s) => String(s || '').replace(/^\s*((re|fwd?|aw|wg)\s*:\s*)+/i, ''));
    this.db.exec(SCHEMA);
    this._migrate();
    this._stmts = new Map();
  }
  close() { this.db.close(); }
  _migrate() {
    const cols = (t) => new Set(this.db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name));
    const add = (t, col, def) => { if (!cols(t).has(col)) this.db.exec(`ALTER TABLE ${t} ADD COLUMN ${col} ${def}`); };
    add('accounts', 'kind', "TEXT NOT NULL DEFAULT 'gmail'"); add('accounts', 'imap_json', 'TEXT'); add('accounts', 'signature', 'TEXT'); add('accounts', 'scopes', 'TEXT');
    add('labels', 'imap_path', 'TEXT');
    add('messages', 'answered', 'INTEGER NOT NULL DEFAULT 0'); add('messages', 'calendar_json', 'TEXT');
    add('drafts', 'remote_message_id', 'TEXT'); add('contacts', 'source', 'TEXT'); add('messages', 'auth_json', 'TEXT'); add('messages', 'ai_summary', 'TEXT'); add('messages', 'imap_folder', 'TEXT'); add('messages', 'imap_uid', 'INTEGER');
  }
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
    return this.prep('SELECT * FROM accounts ORDER BY position, id').all().map(a => ({ ...a, token_enc: undefined, imap_json: undefined, imap: publicImap(a.imap_json) }));
  }
  getAccount(id) { return this.prep('SELECT * FROM accounts WHERE id = ?').get(id) || null; }
  getAccountByEmail(email) { return this.prep('SELECT * FROM accounts WHERE email = ?').get(email) || null; }
  addAccount({ email, displayName, tokenEnc, kind = 'gmail', imapJson = null }) {
    const pos = this.prep('SELECT coalesce(max(position),0)+1 AS p FROM accounts').get().p;
    this.prep('INSERT INTO accounts (email, display_name, token_enc, position, kind, imap_json) VALUES (?,?,?,?,?,?)')
      .run(email, displayName || null, tokenEnc, pos, kind, imapJson);
    return this.getAccountByEmail(email);
  }
  reorderAccounts(ids) { this.tx(() => ids.forEach((id, i) => this.prep('UPDATE accounts SET position = ? WHERE id = ?').run(i + 1, id))); }
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
      this.prep('DELETE FROM imap_folders WHERE account_id = ?').run(id);
      this.prep('DELETE FROM drafts WHERE account_id = ?').run(id);
      this.prep('DELETE FROM accounts WHERE id = ?').run(id);
    });
  }
  resetAccountSync(id) {
    this.tx(() => {
      this.prep('DELETE FROM message_labels WHERE account_id = ?').run(id);
      this.prep('DELETE FROM messages WHERE account_id = ?').run(id);
      this.prep('DELETE FROM imap_folders WHERE account_id = ?').run(id);
      this.updateAccount(id, { history_id: null, initial_done: 0, next_page_token: null, synced_count: 0, last_error: null });
    });
  }

  // ── labels ────────────────────────────────────────────────────────────
  replaceLabels(accountId, labels) {
    this.tx(() => {
      this.prep('DELETE FROM labels WHERE account_id = ?').run(accountId);
      const ins = this.prep('INSERT INTO labels (account_id, id, name, type, color_bg, color_fg, visible, imap_path) VALUES (?,?,?,?,?,?,?,?)');
      for (const l of labels) {
        ins.run(accountId, l.id, l.name, l.type, l.color?.backgroundColor || null, l.color?.textColor || null,
          l.labelListVisibility === 'labelHide' ? 0 : 1, l.imapPath || null);
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
  // ── contacts (harvested from mail: people you write to count most) ──
  harvestContacts(rows) {
    const up = this.prep(`INSERT INTO contacts (email, name, sent_count, recv_count, last_used) VALUES (?,?,?,?,?)
      ON CONFLICT(email) DO UPDATE SET name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE contacts.name END,
        sent_count = contacts.sent_count + excluded.sent_count, recv_count = contacts.recv_count + excluded.recv_count, last_used = max(contacts.last_used, excluded.last_used)`);
    for (const m of rows) {
      const sent = m.labels.includes('SENT');
      const people = sent ? [...(m.to || []), ...(m.cc || [])] : (m.fromEmail ? [{ name: m.fromName, email: m.fromEmail }] : []);
      for (const p of people) { if (!p.email || !p.email.includes('@') || /no-?reply|donotreply|mailer-daemon|notification/i.test(p.email)) continue; up.run(p.email.toLowerCase(), p.name || '', sent ? 1 : 0, sent ? 0 : 1, m.internalDate || 0); }
    }
  }
  searchContacts(q, limit = 8) {
    const like = '%' + String(q || '').toLowerCase() + '%';
    return this.prep(`SELECT email, name, sent_count, recv_count, last_used, source FROM contacts WHERE email LIKE ? OR lower(name) LIKE ?
      ORDER BY (sent_count * 5 + recv_count + CASE WHEN source = 'google' THEN 4 ELSE 0 END) DESC, last_used DESC LIMIT ?`).all(like, like, limit);
  }
  /** Google address book: names win over harvested ones; rows are marked source='google'. */
  upsertGoogleContacts(rows) {
    const up = this.prep(`INSERT INTO contacts (email, name, sent_count, recv_count, last_used, source) VALUES (?,?,0,0,0,'google')
      ON CONFLICT(email) DO UPDATE SET name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE contacts.name END, source = 'google'`);
    let n = 0;
    this.tx(() => { for (const r of rows) { if (!r.email) continue; up.run(r.email.toLowerCase(), r.name || ''); n++; } });
    return n;
  }
  contactStats() { const r = this.prep(`SELECT count(*) AS total, sum(CASE WHEN source = 'google' THEN 1 ELSE 0 END) AS google FROM contacts`).get(); return { total: r.total, google: r.google || 0 }; }
  // ── rules ──
  listRules() { return this.prep('SELECT * FROM rules ORDER BY position, id').all().map(rowToRule); }
  saveRule(r) {
    if (r.id) { this.prep('UPDATE rules SET name=?, enabled=?, account_id=?, match=?, conditions_json=?, actions_json=?, position=? WHERE id=?').run(r.name, r.enabled ? 1 : 0, r.accountId ?? null, r.match || 'all', JSON.stringify(r.conditions || []), JSON.stringify(r.actions || []), r.position ?? 0, r.id); return this.listRules().find(x => x.id === r.id); }
    const pos = this.prep('SELECT coalesce(max(position),0)+1 AS p FROM rules').get().p;
    const res = this.prep('INSERT INTO rules (name, enabled, account_id, match, conditions_json, actions_json, position, created_at) VALUES (?,?,?,?,?,?,?,?)').run(r.name, r.enabled === false ? 0 : 1, r.accountId ?? null, r.match || 'all', JSON.stringify(r.conditions || []), JSON.stringify(r.actions || []), pos, Date.now());
    return this.listRules().find(x => x.id === Number(res.lastInsertRowid));
  }
  deleteRule(id) { this.prep('DELETE FROM rules WHERE id = ?').run(id); }
  // ── follow-ups (remind me if no reply) ──
  addFollowup(f) {
    const r = this.prep('INSERT INTO followups (account_id, message_id, thread_id, message_id_hdr, subject, to_text, due_at, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(f.accountId, f.messageId || null, f.threadId || null, f.messageIdHdr || null, f.subject || '', f.to || '', f.dueAt, Date.now());
    return Number(r.lastInsertRowid);
  }
  listFollowups() { return this.prep("SELECT * FROM followups WHERE status IN ('waiting','due') ORDER BY due_at").all().map(rowToFollowup); }
  getFollowup(id) { const r = this.prep('SELECT * FROM followups WHERE id = ?').get(id); return r ? rowToFollowup(r) : null; }
  updateFollowup(id, fields) { const k = Object.keys(fields); if (!k.length) return; this.prep(`UPDATE followups SET ${k.map(x => `${x} = ?`).join(', ')} WHERE id = ?`).run(...k.map(x => fields[x]), id); }
  deleteFollowup(id) { this.prep('DELETE FROM followups WHERE id = ?').run(id); }
  /** Has anyone other than `ownEmails` written in this thread since `since`? Returns the reply row or null. */
  replyInThread(accountId, { threadId, messageIdHdr }, since, ownEmails) {
    const rows = threadId ? this.prep('SELECT * FROM messages WHERE account_id = ? AND thread_id = ? AND internal_date > ? ORDER BY internal_date').all(accountId, threadId, since) : [];
    const more = messageIdHdr ? this.prep("SELECT * FROM messages WHERE account_id = ? AND internal_date > ? AND (in_reply_to = ? OR instr(coalesce(references_hdr,''), ?) > 0)").all(accountId, since, messageIdHdr, messageIdHdr) : [];
    const own = new Set(ownEmails.map(e => e.toLowerCase()));
    for (const r of [...rows, ...more]) { const m = rowToMessage(r); if (m.fromEmail && !own.has(m.fromEmail.toLowerCase()) && !m.labels.includes('SENT') && !m.labels.includes('DRAFT')) return m; }
    return null;
  }
  // ── sender intelligence ──
  senderInfo(email, ownEmails = []) {
    const e = String(email || '').toLowerCase();
    if (!e) return null;
    const own = new Set(ownEmails.map(x => x.toLowerCase()));
    const recv = this.prep(`SELECT count(*) AS n, min(internal_date) AS first, max(internal_date) AS last, sum(has_attachment) AS atts, sum(unread) AS unread
      FROM messages WHERE lower(from_email) = ? AND NOT EXISTS (SELECT 1 FROM message_labels x WHERE x.account_id = messages.account_id AND x.message_id = messages.id AND x.label_id IN ('SENT','DRAFT'))`).get(e);
    const sent = this.prep(`SELECT count(*) AS n, max(internal_date) AS last FROM messages m JOIN message_labels ml ON ml.account_id = m.account_id AND ml.message_id = m.id AND ml.label_id = 'SENT'
      WHERE lower(m.to_json) LIKE ? OR lower(m.cc_json) LIKE ?`).get('%"' + e + '"%', '%"' + e + '"%');
    const recent = this.prep(`SELECT account_id, id, thread_id, subject, internal_date, unread FROM messages WHERE lower(from_email) = ? ORDER BY internal_date DESC LIMIT 6`).all(e)
      .map(r => ({ accountId: r.account_id, id: r.id, threadId: r.thread_id, subject: r.subject, date: r.internal_date, unread: !!r.unread }));
    // response time: for each of their messages, our next SENT message in the same thread
    const pairs = this.prep(`SELECT m.internal_date AS theirs, (SELECT min(s.internal_date) FROM messages s JOIN message_labels sl ON sl.account_id = s.account_id AND sl.message_id = s.id AND sl.label_id = 'SENT'
        WHERE s.account_id = m.account_id AND s.thread_id = m.thread_id AND s.internal_date > m.internal_date) AS ours
      FROM messages m WHERE lower(m.from_email) = ? AND m.thread_id IS NOT NULL ORDER BY m.internal_date DESC LIMIT 50`).all(e).filter(p => p.ours);
    const avgReplyMs = pairs.length ? pairs.reduce((a, p) => a + (p.ours - p.theirs), 0) / pairs.length : null;
    const labels = this.prep(`SELECT ml.label_id AS l, count(*) AS n FROM messages m JOIN message_labels ml ON ml.account_id = m.account_id AND ml.message_id = m.id
      WHERE lower(m.from_email) = ? AND ml.label_id NOT IN ('INBOX','UNREAD','STARRED','IMPORTANT','SENT','DRAFT','TRASH','SPAM','ARCHIVE') AND ml.label_id NOT LIKE 'CATEGORY_%' GROUP BY ml.label_id ORDER BY n DESC LIMIT 3`).all(e);
    const spam = this.prep(`SELECT count(*) AS n FROM messages m JOIN message_labels ml ON ml.account_id = m.account_id AND ml.message_id = m.id AND ml.label_id = 'SPAM' WHERE lower(m.from_email) = ?`).get(e).n;
    const contact = this.prep('SELECT name, source FROM contacts WHERE email = ?').get(e);
    return { email: e, received: recv.n, firstSeen: recv.first, lastSeen: recv.last, attachments: recv.atts || 0, unread: recv.unread || 0, sentTo: sent.n, lastSentAt: sent.last,
      repliedCount: pairs.length, avgReplyMs, labels: labels.map(x => x.l), spam, inContacts: !!contact, contactSource: contact?.source || null, isOwn: own.has(e), recent };
  }
  // ── scheduled sends ──
  addScheduled(accountId, payload, sendAt) { const r = this.prep('INSERT INTO scheduled (account_id, payload_json, subject, to_text, send_at, created_at) VALUES (?,?,?,?,?,?)').run(accountId, JSON.stringify(payload), payload.subject || '', payload.to || '', sendAt, Date.now()); return Number(r.lastInsertRowid); }
  listScheduled() { return this.prep('SELECT id, account_id, subject, to_text, send_at, created_at FROM scheduled ORDER BY send_at').all().map(r => ({ id: r.id, accountId: r.account_id, subject: r.subject, to: r.to_text, sendAt: r.send_at, createdAt: r.created_at })); }
  getScheduled(id) { const r = this.prep('SELECT * FROM scheduled WHERE id = ?').get(id); return r ? { ...r, payload: JSON.parse(r.payload_json) } : null; }
  dueScheduled(now) { return this.prep('SELECT * FROM scheduled WHERE send_at <= ? ORDER BY send_at').all(now).map(r => ({ ...r, payload: JSON.parse(r.payload_json) })); }
  updateScheduled(id, sendAt) { this.prep('UPDATE scheduled SET send_at = ? WHERE id = ?').run(sendAt, id); }
  removeScheduled(id) { this.prep('DELETE FROM scheduled WHERE id = ?').run(id); }
  // ── snippets ──
  listSnippets() { return this.prep('SELECT * FROM snippets ORDER BY trigger').all().map(r => ({ id: r.id, trigger: r.trigger, name: r.name, bodyHtml: r.body_html })); }
  saveSnippet(s) {
    const trig = String(s.trigger || '').trim().replace(/^;/, '');
    if (!trig) throw new Error('A trigger is required');
    if (s.id) { this.prep('UPDATE snippets SET trigger = ?, name = ?, body_html = ? WHERE id = ?').run(trig, s.name || trig, s.bodyHtml || '', s.id); return s.id; }
    return Number(this.prep('INSERT INTO snippets (trigger, name, body_html, created_at) VALUES (?,?,?,?)').run(trig, s.name || trig, s.bodyHtml || '', Date.now()).lastInsertRowid);
  }
  deleteSnippet(id) { this.prep('DELETE FROM snippets WHERE id = ?').run(id); }
  // ── stats for achievements ──
  activity() {
    const now = Date.now(), week = now - 7 * 86400000, day = new Date(); day.setHours(0, 0, 0, 0);
    const sentWeek = this.prep(`SELECT count(*) AS n FROM messages m JOIN message_labels ml ON ml.account_id = m.account_id AND ml.message_id = m.id AND ml.label_id = 'SENT' WHERE m.internal_date > ?`).get(week).n;
    const sentTotal = this.prep(`SELECT count(*) AS n FROM message_labels WHERE label_id = 'SENT'`).get().n;
    const inboxUnread = this.prep(`SELECT count(*) AS n FROM messages m JOIN message_labels ml ON ml.account_id = m.account_id AND ml.message_id = m.id AND ml.label_id = 'INBOX' WHERE m.unread = 1 AND m.snooze_until IS NULL`).get().n;
    const inboxTotal = this.prep(`SELECT count(*) AS n FROM messages m JOIN message_labels ml ON ml.account_id = m.account_id AND ml.message_id = m.id AND ml.label_id = 'INBOX' WHERE m.snooze_until IS NULL`).get().n;
    const rules = this.prep('SELECT count(*) AS n FROM rules WHERE enabled = 1').get().n;
    const earliest = this.prep(`SELECT min(strftime('%H', internal_date/1000, 'unixepoch', 'localtime')) AS h FROM messages m JOIN message_labels ml ON ml.account_id = m.account_id AND ml.message_id = m.id AND ml.label_id = 'SENT' WHERE m.internal_date > ?`).get(week).h;
    const latest = this.prep(`SELECT max(strftime('%H', internal_date/1000, 'unixepoch', 'localtime')) AS h FROM messages m JOIN message_labels ml ON ml.account_id = m.account_id AND ml.message_id = m.id AND ml.label_id = 'SENT' WHERE m.internal_date > ?`).get(week).h;
    return { sentWeek, sentTotal, inboxUnread, inboxTotal, rules, earliestSentHour: earliest == null ? null : Number(earliest), latestSentHour: latest == null ? null : Number(latest), archivedTotal: this.kvGet('stat:archived') || 0, snoozedTotal: this.kvGet('stat:snoozed') || 0, followupsDone: this.kvGet('stat:followups') || 0 };
  }
  bump(key, n = 1) { this.kvSet('stat:' + key, (this.kvGet('stat:' + key) || 0) + n); }
  /** Iterate messages (with bodies where cached) for export. */
  *iterateForExport(accountId) {
    const st = this.prep('SELECT * FROM messages WHERE account_id = ? ORDER BY internal_date');
    for (const r of st.iterate(accountId)) yield rowToMessage(r);
  }
  // ── outbox (messages waiting for a connection) ──
  enqueueOutbox(accountId, payload, err) {
    const r = this.prep('INSERT INTO outbox (account_id, payload_json, subject, to_text, attempts, last_error, next_try, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(accountId, JSON.stringify(payload), payload.subject || '', payload.to || '', 1, err || null, Date.now() + 60000, Date.now());
    return Number(r.lastInsertRowid);
  }
  listOutbox() { return this.prep('SELECT id, account_id, subject, to_text, attempts, last_error, next_try, created_at FROM outbox ORDER BY created_at').all().map(r => ({ id: r.id, accountId: r.account_id, subject: r.subject, to: r.to_text, attempts: r.attempts, lastError: r.last_error, nextTry: r.next_try, createdAt: r.created_at })); }
  dueOutbox(now) { return this.prep('SELECT * FROM outbox WHERE next_try <= ? ORDER BY created_at').all(now).map(r => ({ ...r, payload: JSON.parse(r.payload_json) })); }
  getOutbox(id) { const r = this.prep('SELECT * FROM outbox WHERE id = ?').get(id); return r ? { ...r, payload: JSON.parse(r.payload_json) } : null; }
  outboxFailed(id, err) { this.prep('UPDATE outbox SET attempts = attempts + 1, last_error = ?, next_try = ? WHERE id = ?').run(err, Date.now() + Math.min(30, 2 ** 1) * 60000, id); }
  removeOutbox(id) { this.prep('DELETE FROM outbox WHERE id = ?').run(id); }
  // ── labels ──
  updateLabel(accountId, id, fields) {
    const keys = Object.keys(fields); if (!keys.length) return;
    this.prep(`UPDATE labels SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE account_id = ? AND id = ?`).run(...keys.map(k => fields[k]), accountId, id);
  }
  deleteLabel(accountId, id) {
    this.tx(() => {
      this.prep('DELETE FROM labels WHERE account_id = ? AND id = ?').run(accountId, id);
      const ids = this.labelIds(accountId, id);
      if (ids.length) this.applyLabelChange(accountId, ids, { remove: [id] });
    });
  }
  // ── housekeeping ──
  /** Drop cached bodies older than N days (kept for flagged/snoozed/unfetched). Returns rows cleared. */
  pruneBodies(days) {
    if (!days) return 0;
    const cutoff = Date.now() - days * 86400000;
    return Number(this.prep(`UPDATE messages SET body_fetched = 0, body_text = NULL, body_html = NULL, attachments_json = NULL
      WHERE body_fetched = 1 AND internal_date < ? AND starred = 0 AND snooze_until IS NULL`).run(cutoff).changes);
  }
  vacuum() { this.db.exec('VACUUM'); this.kvSet('lastVacuum', Date.now()); }
  stats() {
    const n = this.prep('SELECT count(*) AS n, sum(body_fetched) AS b FROM messages').get();
    return { messages: n.n, bodies: n.b || 0, lastVacuum: this.kvGet('lastVacuum') };
  }
  /** Adopt a snooze wake time learned from the server (another device snoozed it) without clobbering a local one. */
  adoptSnooze(accountId, id, until) { this.prep('UPDATE messages SET snooze_until = ? WHERE account_id = ? AND id = ? AND snooze_until IS NULL').run(until, accountId, id); }

  /** rows: normalised message rows (see sync.normaliseMessage). Existing rows keep their body cache. */
  upsertMessages(accountId, rows) {
    const ins = this.prep(`INSERT INTO messages (account_id, id, thread_id, history_id, internal_date, size, snippet, subject,
        from_name, from_email, to_json, cc_json, reply_to, message_id_hdr, in_reply_to, references_hdr, has_attachment,
        unread, starred, labels_json, answered, imap_folder, imap_uid, auth_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(account_id, id) DO UPDATE SET
        thread_id=excluded.thread_id, history_id=excluded.history_id, internal_date=excluded.internal_date,
        size=excluded.size, snippet=excluded.snippet, subject=excluded.subject, from_name=excluded.from_name,
        from_email=excluded.from_email, to_json=excluded.to_json, cc_json=excluded.cc_json, reply_to=excluded.reply_to,
        message_id_hdr=excluded.message_id_hdr, in_reply_to=excluded.in_reply_to, references_hdr=excluded.references_hdr,
        has_attachment=max(messages.has_attachment, excluded.has_attachment),
        unread=excluded.unread, starred=excluded.starred, labels_json=excluded.labels_json, answered=excluded.answered,
        imap_folder=excluded.imap_folder, imap_uid=excluded.imap_uid, auth_json=coalesce(excluded.auth_json, messages.auth_json)`);
    const delL = this.prep('DELETE FROM message_labels WHERE account_id = ? AND message_id = ?');
    const insL = this.prep('INSERT OR IGNORE INTO message_labels (account_id, message_id, label_id) VALUES (?,?,?)');
    this.tx(() => {
      for (const m of rows) {
        ins.run(accountId, m.id, m.threadId || null, m.historyId || null, m.internalDate || 0, m.size || 0,
          m.snippet || '', m.subject || '', m.fromName || null, m.fromEmail || null,
          JSON.stringify(m.to || []), JSON.stringify(m.cc || []), m.replyTo || null,
          m.messageIdHdr || null, m.inReplyTo || null, m.references || null, m.hasAttachment ? 1 : 0,
          m.labels.includes('UNREAD') ? 1 : 0, m.labels.includes('STARRED') ? 1 : 0, JSON.stringify(m.labels), m.answered ? 1 : 0,
          m.imapFolder || null, m.imapUid ?? null, m.auth ? JSON.stringify(m.auth) : null);
        delL.run(accountId, m.id);
        for (const l of m.labels) insL.run(accountId, m.id, l);
        if (m.snoozeUntil) this.adoptSnooze(accountId, m.id, m.snoozeUntil);
      }
      this.harvestContacts(rows);
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
  setSummary(accountId, id, text) { this.prep('UPDATE messages SET ai_summary = ? WHERE account_id = ? AND id = ?').run(text, accountId, id); }
  /** Recent short messages the user wrote (style samples for drafting). */
  styleSamples(accountId, n = 4) {
    return this.prep(`SELECT body_text FROM messages m JOIN message_labels ml ON ml.account_id = m.account_id AND ml.message_id = m.id AND ml.label_id = 'SENT'
      WHERE m.account_id = ? AND body_fetched = 1 AND length(body_text) BETWEEN 80 AND 1500 ORDER BY internal_date DESC LIMIT ?`).all(accountId, n).map(r => r.body_text.split(/\n(?:On .* wrote:|>)/)[0].trim());
  }
  setCalendar(accountId, id, ev) { this.prep('UPDATE messages SET calendar_json = ? WHERE account_id = ? AND id = ?').run(ev ? JSON.stringify(ev) : null, accountId, id); }
  setBody(accountId, id, { text, html, attachments }) {
    const snippet = (text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    this.prep(`UPDATE messages SET body_fetched = 1, body_text = ?, body_html = ?, attachments_json = ?, has_attachment = ?,
      snippet = CASE WHEN coalesce(snippet,'') = '' THEN ? ELSE snippet END WHERE account_id = ? AND id = ?`)
      .run(text || '', html || null, JSON.stringify(attachments || []), attachments?.some(a => !a.inline) ? 1 : 0, snippet, accountId, id);
  }
  deleteFolderMessages(accountId, folder) {
    const ids = this.prep('SELECT id FROM messages WHERE account_id = ? AND imap_folder = ?').all(accountId, folder).map(r => r.id);
    this.deleteMessages(accountId, ids);
    return ids.length;
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
        m.from_email, m.to_json, m.has_attachment, m.unread, m.starred, m.labels_json, m.snooze_until, m.answered, m.imap_folder, m.imap_uid
      FROM messages m ${join} WHERE ${where} ORDER BY ${orderSql(view, 'm')} LIMIT ? OFFSET ?`;
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
    const f = view.filters || {};
    if (f.unread) w.push('m.unread = 1');
    if (f.starred) w.push('m.starred = 1');
    if (f.hasAttachment) w.push('m.has_attachment = 1');
    if (f.from) { w.push("(m.from_email LIKE ? OR m.from_name LIKE ?)"); params.push('%' + f.from + '%', '%' + f.from + '%'); }
    if (f.to) { w.push("(m.to_json LIKE ? OR m.cc_json LIKE ?)"); params.push('%' + f.to + '%', '%' + f.to + '%'); }
    if (f.after) { w.push('m.internal_date >= ?'); params.push(Number(f.after)); }
    if (f.before) { w.push('m.internal_date < ?'); params.push(Number(f.before)); }
    if (f.labelId) w.push(hasLabel(f.labelId));
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
  /** One row per conversation (latest message), with count + unread for the members that match the view. */
  listThreads(view, { offset = 0, limit = 100 } = {}) {
    const { where, params, join } = this._viewSql(view);
    const sql = `WITH t AS (SELECT m.account_id, m.thread_id, max(m.internal_date) AS d, count(*) AS n, sum(m.unread) AS u
        FROM messages m ${join} WHERE ${where} AND m.thread_id IS NOT NULL GROUP BY m.account_id, m.thread_id)
      SELECT m.rid, m.account_id, m.id, m.thread_id, m.internal_date, m.size, m.snippet, m.subject, m.from_name, m.from_email, m.to_json,
        m.has_attachment, m.unread, m.starred, m.labels_json, m.snooze_until, m.answered, m.imap_folder, m.imap_uid,
        t.n AS thread_count, t.u AS thread_unread
      FROM t JOIN messages m ON m.account_id = t.account_id AND m.thread_id = t.thread_id AND m.internal_date = t.d
      GROUP BY m.account_id, m.thread_id ORDER BY ${orderSql(view, 'm', 't.d')} LIMIT ? OFFSET ?`;
    return this.prep(sql).all(...params, limit, offset).map(rowToListItem);
  }
  countThreads(view) {
    const { where, params, join } = this._viewSql(view);
    return this.prep(`SELECT count(*) AS n FROM (SELECT 1 FROM messages m ${join} WHERE ${where} AND m.thread_id IS NOT NULL GROUP BY m.account_id, m.thread_id)`).get(...params).n;
  }
  /** Members of a thread that are visible in the given view context (TRASH/SPAM hidden unless viewing them). */
  threadMessages(accountId, threadId, { includeTrash = false } = {}) {
    const rows = this.prep('SELECT * FROM messages WHERE account_id = ? AND thread_id = ? ORDER BY internal_date').all(accountId, threadId).map(rowToMessage);
    return includeTrash ? rows : rows.filter(m => !m.labels.includes('TRASH') && !m.labels.includes('SPAM'));
  }
  /** Assign thread ids by Message-ID / References for rows that have none (IMAP). Union with existing threads both ways. */
  assignThreads(accountId, ids) {
    const get = this.prep('SELECT id, thread_id, message_id_hdr, in_reply_to, references_hdr FROM messages WHERE account_id = ? AND id = ?');
    const byMsgId = this.prep('SELECT thread_id FROM messages WHERE account_id = ? AND message_id_hdr = ? AND thread_id IS NOT NULL LIMIT 1');
    const refsMe = this.prep(`SELECT thread_id FROM messages WHERE account_id = ? AND thread_id IS NOT NULL AND (in_reply_to = ? OR instr(coalesce(references_hdr,''), ?) > 0) LIMIT 1`);
    const set = this.prep('UPDATE messages SET thread_id = ? WHERE account_id = ? AND id = ?');
    const merge = this.prep('UPDATE messages SET thread_id = ? WHERE account_id = ? AND thread_id = ?');
    this.tx(() => {
      for (const id of ids) {
        const r = get.get(accountId, id);
        if (!r) continue;
        const refs = [r.in_reply_to, ...String(r.references_hdr || '').split(/\s+/)].filter(Boolean);
        let tid = null;
        for (const ref of refs) { const x = byMsgId.get(accountId, ref); if (x) { tid = x.thread_id; break; } }
        const child = r.message_id_hdr ? refsMe.get(accountId, r.message_id_hdr, r.message_id_hdr) : null;
        if (!tid) tid = child?.thread_id || r.thread_id || ('t:' + (r.message_id_hdr || r.id));
        else if (child && child.thread_id !== tid) merge.run(tid, accountId, child.thread_id);
        if (r.thread_id !== tid) { if (r.thread_id) merge.run(tid, accountId, r.thread_id); set.run(tid, accountId, r.id); }
      }
    });
  }
  /** IMAP move changes a message's UID (and folder) → keep the row (body cache, snooze) under its new key. */
  rekeyMessage(accountId, oldId, newId, { folder, uid }) {
    this.tx(() => {
      this.prep('UPDATE messages SET id = ?, imap_folder = ?, imap_uid = ? WHERE account_id = ? AND id = ?').run(newId, folder, uid, accountId, oldId);
      this.prep('UPDATE message_labels SET message_id = ? WHERE account_id = ? AND message_id = ?').run(newId, accountId, oldId);
    });
  }
  messagesByFolder(accountId, folder) {
    return this.prep('SELECT id, imap_uid AS uid, unread, starred, answered, labels_json FROM messages WHERE account_id = ? AND imap_folder = ?').all(accountId, folder)
      .map(r => ({ ...r, labels: safeJson(r.labels_json, []) }));
  }
  labelIds(accountId, labelId) { return this.prep('SELECT message_id AS id FROM message_labels WHERE account_id = ? AND label_id = ?').all(accountId, labelId).map(r => r.id); }
  // ── imap folder state ──
  imapFolder(accountId, path) { return this.prep('SELECT * FROM imap_folders WHERE account_id = ? AND path = ?').get(accountId, path) || null; }
  setImapFolder(accountId, path, f) {
    this.prep(`INSERT INTO imap_folders (account_id, path, uid_validity, last_uid, min_uid, modseq, initial_done) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(account_id, path) DO UPDATE SET uid_validity=excluded.uid_validity, last_uid=excluded.last_uid, min_uid=excluded.min_uid, modseq=excluded.modseq, initial_done=excluded.initial_done`)
      .run(accountId, path, f.uid_validity ?? null, f.last_uid ?? 0, f.min_uid ?? null, f.modseq ?? null, f.initial_done ? 1 : 0);
  }
  // ── drafts ──
  listDrafts(accountId = null) {
    return (accountId ? this.prep('SELECT * FROM drafts WHERE account_id = ? ORDER BY updated_at DESC').all(accountId)
      : this.prep('SELECT * FROM drafts ORDER BY updated_at DESC').all()).map(rowToDraft);
  }
  getDraft(id) { const r = this.prep('SELECT * FROM drafts WHERE id = ?').get(id); return r ? rowToDraft(r) : null; }
  getDraftByRemote(accountId, remoteId) { const r = this.prep('SELECT * FROM drafts WHERE account_id = ? AND remote_id = ?').get(accountId, remoteId); return r ? rowToDraft(r) : null; }
  saveDraft(d) {
    const now = Date.now();
    if (d.id) {
      this.prep(`UPDATE drafts SET account_id=?, mode=?, reply_account_id=?, reply_message_id=?, to_text=?, cc_text=?, bcc_text=?, subject=?, body_html=?, body_text=?,
        attachments_json=?, quoted_html=?, quoted_text=?, include_orig_atts=?, updated_at=? WHERE id = ?`)
        .run(d.accountId, d.mode || 'new', d.replyTo?.accountId ?? null, d.replyTo?.id ?? null, d.to || '', d.cc || '', d.bcc || '', d.subject || '', d.bodyHtml || '', d.bodyText || '',
          JSON.stringify(d.attachments || []), d.quotedHtml || null, d.quotedText || null, d.includeOrigAtts ? 1 : 0, now, d.id);
      return this.getDraft(d.id);
    }
    const r = this.prep(`INSERT INTO drafts (account_id, mode, reply_account_id, reply_message_id, to_text, cc_text, bcc_text, subject, body_html, body_text, attachments_json, quoted_html, quoted_text, include_orig_atts, remote_id, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(d.accountId, d.mode || 'new', d.replyTo?.accountId ?? null, d.replyTo?.id ?? null, d.to || '', d.cc || '', d.bcc || '', d.subject || '', d.bodyHtml || '', d.bodyText || '',
        JSON.stringify(d.attachments || []), d.quotedHtml || null, d.quotedText || null, d.includeOrigAtts ? 1 : 0, d.remoteId || null, now);
    return this.getDraft(Number(r.lastInsertRowid));
  }
  setDraftRemote(id, remoteId, remoteMessageId) { this.prep('UPDATE drafts SET remote_id = ?, remote_message_id = ?, remote_synced_at = ? WHERE id = ?').run(remoteId, remoteMessageId || null, Date.now(), id); }
  draftRemoteMessageIds(accountId) { return new Set(this.prep('SELECT remote_message_id AS m FROM drafts WHERE account_id = ? AND remote_message_id IS NOT NULL').all(accountId).map(r => r.m)); }
  deleteDraft(id) { this.prep('DELETE FROM drafts WHERE id = ?').run(id); }

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

/** ORDER BY for a view: { col: 'date'|'size'|'from'|'subject', dir: 'asc'|'desc' } (default date desc). */
function orderSql(view, m, dateExpr) {
  const s = view.sort || {};
  const dir = s.dir === 'asc' ? 'ASC' : 'DESC';
  const date = dateExpr || `${m}.internal_date`;
  switch (s.col) {
    case 'size': return `${m}.size ${dir}, ${date} DESC`;
    case 'from': return `lower(coalesce(nullif(${m}.from_name,''), ${m}.from_email)) ${dir}, ${date} DESC`;
    case 'subject': return `lower(regexp_strip(${m}.subject)) ${dir}, ${date} DESC`;
    default: return `${date} ${dir}`;
  }
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
    labels: safeJson(r.labels_json, []), snoozeUntil: r.snooze_until, answered: !!r.answered,
    imapFolder: r.imap_folder, imapUid: r.imap_uid, threadCount: r.thread_count || undefined, threadUnread: r.thread_unread || undefined,
  };
}
function rowToRule(r) { return { id: r.id, name: r.name, enabled: !!r.enabled, accountId: r.account_id, position: r.position, match: r.match, conditions: safeJson(r.conditions_json, []), actions: safeJson(r.actions_json, []) }; }
function rowToFollowup(r) { return { id: r.id, accountId: r.account_id, messageId: r.message_id, threadId: r.thread_id, messageIdHdr: r.message_id_hdr, subject: r.subject, to: r.to_text, dueAt: r.due_at, createdAt: r.created_at, status: r.status, repliedBy: r.replied_by, repliedAt: r.replied_at, notified: !!r.notified }; }
function rowToDraft(r) {
  return { id: r.id, accountId: r.account_id, mode: r.mode, replyTo: r.reply_message_id ? { accountId: r.reply_account_id, id: r.reply_message_id } : null,
    to: r.to_text || '', cc: r.cc_text || '', bcc: r.bcc_text || '', subject: r.subject || '', bodyHtml: r.body_html || '', bodyText: r.body_text || '',
    attachments: safeJson(r.attachments_json, []), quotedHtml: r.quoted_html, quotedText: r.quoted_text, includeOrigAtts: !!r.include_orig_atts,
    remoteId: r.remote_id, remoteMessageId: r.remote_message_id, updatedAt: r.updated_at };
}
function publicImap(json) {
  if (!json) return null;
  try { const j = JSON.parse(json); return { host: j.host, port: j.port, secure: j.secure, user: j.user, smtpHost: j.smtpHost, smtpPort: j.smtpPort, smtpSecure: j.smtpSecure }; } catch { return null; }
}
function rowToMessage(r) {
  return {
    ...rowToListItem(r), cc: safeJson(r.cc_json, []), replyTo: r.reply_to, messageIdHdr: r.message_id_hdr,
    inReplyTo: r.in_reply_to, references: r.references_hdr, bodyFetched: !!r.body_fetched, calendar: safeJson(r.calendar_json, null), auth: safeJson(r.auth_json, null), aiSummary: r.ai_summary || null,
    bodyText: r.body_text, bodyHtml: r.body_html, attachments: safeJson(r.attachments_json, []),
  };
}
function safeJson(s, d) { try { return s ? JSON.parse(s) : d; } catch { return d; } }

module.exports = { MailDb, SYSTEM_LABELS, CATEGORY_LABELS, SNOOZE_LABEL_NAME, toFtsQuery };
