'use strict';
// Every user action: optimistic local update → Gmail call → on failure revert.
// Targets are [{accountId, id}] and are grouped per account.
const { parsePayload, textToHtml, htmlToText, buildRaw, b64urlDecode } = require('./gmail/mime');
const { normaliseMessage } = require('./gmail/sync');
const { SNOOZE_LABEL_NAME } = require('./db');

const INLINE_MAX = 3 * 1024 * 1024;

class Actions {
  /** clients(accountId) → GmailClient; db → MailDb; onChange() → notify renderer */
  constructor({ db, clients, onChange = () => {}, log = () => {} }) {
    this.db = db; this.clients = clients; this.onChange = onChange; this.log = log;
  }

  groupByAccount(targets) {
    const g = new Map();
    for (const t of targets) { if (!g.has(t.accountId)) g.set(t.accountId, []); g.get(t.accountId).push(t.id); }
    return g;
  }

  /** Core label mutation with optimistic apply + revert. */
  async modify(targets, { add = [], remove = [] }) {
    const results = [];
    for (const [accountId, ids] of this.groupByAccount(targets)) {
      const before = ids.map(id => ({ id, labels: this.db.getMessage(accountId, id)?.labels || [] }));
      this.db.applyLabelChange(accountId, ids, { add, remove });
      this.onChange();
      try {
        const client = this.clients(accountId);
        for (let i = 0; i < ids.length; i += 1000) {
          await client.post('/messages/batchModify', { ids: ids.slice(i, i + 1000), addLabelIds: add, removeLabelIds: remove });
        }
        results.push({ accountId, ok: true, n: ids.length });
      } catch (e) {
        // revert
        for (const b of before) {
          const cur = this.db.getMessage(accountId, b.id);
          if (cur) this.db.applyLabelChange(accountId, [b.id], { add: b.labels.filter(l => !cur.labels.includes(l)), remove: cur.labels.filter(l => !b.labels.includes(l)) });
        }
        this.onChange();
        this.log(`modify failed: ${e.message}`);
        results.push({ accountId, ok: false, error: e.message });
      }
    }
    const failed = results.filter(r => !r.ok);
    if (failed.length) throw new Error(failed.map(f => f.error).join('; '));
    return results;
  }

  markRead(t, read = true) { return this.modify(t, read ? { remove: ['UNREAD'] } : { add: ['UNREAD'] }); }
  star(t, on = true) { return this.modify(t, on ? { add: ['STARRED'] } : { remove: ['STARRED'] }); }
  archive(t) { return this.modify(t, { remove: ['INBOX'] }); }
  trash(t) { return this.modify(t, { add: ['TRASH'], remove: ['INBOX', 'SPAM'] }); }
  untrash(t) { return this.modify(t, { remove: ['TRASH'], add: ['INBOX'] }); }
  spam(t, on = true) { return this.modify(t, on ? { add: ['SPAM'], remove: ['INBOX'] } : { remove: ['SPAM'], add: ['INBOX'] }); }
  /** Move = add destination label, drop the label of the folder it was viewed in (Gmail semantics). */
  move(t, toLabelId, fromLabelId) {
    const remove = fromLabelId && fromLabelId !== toLabelId ? [fromLabelId] : [];
    if (toLabelId !== 'INBOX' && !remove.includes('INBOX') && fromLabelId === 'INBOX') remove.push('INBOX');
    return this.modify(t, { add: [toLabelId], remove });
  }

  async ensureSnoozeLabel(accountId) {
    const acct = this.db.getAccount(accountId);
    if (acct.snooze_label_id) return acct.snooze_label_id;
    let l = this.db.findLabelByName(accountId, SNOOZE_LABEL_NAME);
    if (!l) {
      const created = await this.clients(accountId).post('/labels', { name: SNOOZE_LABEL_NAME, labelListVisibility: 'labelShow', messageListVisibility: 'show' });
      this.db.addLabel(accountId, created); l = created;
    }
    this.db.updateAccount(accountId, { snooze_label_id: l.id });
    return l.id;
  }
  /** Snooze: leave the inbox, wear the Snoozed label, come back at `until` (ms epoch). Local timer only. */
  async snooze(targets, until) {
    for (const [accountId, ids] of this.groupByAccount(targets)) {
      const snoozeLabel = await this.ensureSnoozeLabel(accountId);
      this.db.setSnooze(accountId, ids, until);
      await this.modify(ids.map(id => ({ accountId, id })), { add: [snoozeLabel], remove: ['INBOX'] });
    }
    this.onChange();
  }
  async unsnooze(targets) {
    for (const [accountId, ids] of this.groupByAccount(targets)) {
      const snoozeLabel = await this.ensureSnoozeLabel(accountId);
      this.db.setSnooze(accountId, ids, null);
      await this.modify(ids.map(id => ({ accountId, id })), { add: ['INBOX', 'UNREAD'], remove: [snoozeLabel] });
    }
    this.onChange();
  }
  async wakeDueSnoozes() {
    const due = this.db.dueSnoozes(Date.now());
    if (!due.length) return 0;
    await this.unsnooze(due.map(d => ({ accountId: d.account_id, id: d.id })));
    return due.length;
  }

  /** Full message with body; fetches + caches on first open, resolves inline cid: images. */
  async getMessage(accountId, id) {
    let m = this.db.getMessage(accountId, id);
    if (!m) return null;
    if (m.bodyFetched) return m;
    const client = this.clients(accountId);
    const full = await client.get(`/messages/${id}`, { format: 'full' });
    const parsed = parsePayload(full.payload);
    let html = parsed.html;
    // Inline images referenced by cid: → data URLs (bounded size)
    for (const a of parsed.attachments) {
      if (!a.contentId || !html.includes('cid:' + a.contentId) || a.size > INLINE_MAX) continue;
      try {
        const data = a.data ? b64urlDecode(a.data) : b64urlDecode((await client.get(`/messages/${id}/attachments/${a.attachmentId}`)).data);
        html = html.split('cid:' + a.contentId).join(`data:${a.mimeType};base64,${data.toString('base64')}`);
        a.inline = true;
      } catch (e) { this.log(`inline image ${a.contentId}: ${e.message}`); }
    }
    const text = parsed.text || htmlToText(html);
    const attachments = parsed.attachments.filter(a => !a.inline).map(({ data, ...rest }) => rest);
    // Keep metadata from the full fetch too (labels may have moved on)
    this.db.upsertMessages(accountId, [normaliseMessage(full)]);
    this.db.setBody(accountId, id, { text, html, attachments });
    m = this.db.getMessage(accountId, id);
    this.onChange();
    return m;
  }

  async getAttachment(accountId, messageId, attachmentId) {
    const r = await this.clients(accountId).get(`/messages/${messageId}/attachments/${attachmentId}`);
    return b64urlDecode(r.data);
  }

  /** Gmail-side search ("deep": bodies + attachment contents). Returns [{accountId,id}], caching unknown rows locally. */
  async deepSearch(q, accountId = null, limit = 100) {
    const accounts = accountId ? [this.db.getAccount(accountId)] : this.db.listAccounts();
    const out = [];
    for (const acct of accounts) {
      if (!acct) continue;
      const client = this.clients(acct.id);
      const j = await client.get('/messages', { q, maxResults: limit });
      const ids = (j.messages || []).map(m => m.id);
      const known = this.db.existingIds(acct.id, ids);
      const missing = ids.filter(id => !known.has(id));
      if (missing.length) {
        const { AccountSync } = require('./gmail/sync');
        const s = new AccountSync({ db: this.db, client, account: acct, log: this.log });
        for (let i = 0; i < missing.length; i += 50) await s.fetchAndStore(missing.slice(i, i + 50));
      }
      for (const id of ids) out.push({ accountId: acct.id, id });
    }
    return out;
  }

  /**
   * Send. opts: { accountId, to, cc, bcc, subject, text, quotedHtml?, attachments:[{filename,path}], replyTo:{accountId,id}?, mode:'reply'|'forward'? }
   */
  async send(opts) {
    const acct = this.db.getAccount(opts.accountId);
    if (!acct) throw new Error('Unknown account');
    const fromName = acct.display_name && acct.display_name !== acct.email ? acct.display_name : '';
    const from = fromName ? `"${fromName.replace(/"/g, '')}" <${acct.email}>` : acct.email;
    let inReplyTo, references, threadId;
    if (opts.replyTo) {
      const orig = this.db.getMessage(opts.replyTo.accountId, opts.replyTo.id);
      if (orig && opts.mode !== 'forward') {
        inReplyTo = orig.messageIdHdr || undefined;
        references = [orig.references, orig.messageIdHdr].filter(Boolean).join(' ') || undefined;
        threadId = orig.threadId;
      }
    }
    const html = textToHtml(opts.text || '') + (opts.quotedHtml ? `<br><div class="gmail_quote">${opts.quotedHtml}</div>` : '');
    const text = (opts.text || '') + (opts.quotedText ? `\n\n${opts.quotedText}` : '');
    const attachments = (opts.attachments || []).map(a => ({ filename: a.filename, path: a.path, content: a.content, contentType: a.contentType }));
    if (opts.forwardAttachments && opts.replyTo) {
      // Forward: carry the original's real attachments across (downloaded from Gmail, never from the renderer)
      const orig = this.db.getMessage(opts.replyTo.accountId, opts.replyTo.id);
      for (const a of orig?.attachments || []) {
        if (!a.attachmentId) continue;
        attachments.push({ filename: a.filename, contentType: a.mimeType, content: await this.getAttachment(opts.replyTo.accountId, opts.replyTo.id, a.attachmentId) });
      }
    }
    const raw = await buildRaw({ from, to: opts.to, cc: opts.cc, bcc: opts.bcc, subject: opts.subject, text, html, attachments, inReplyTo, references });
    const sent = await this.clients(opts.accountId).post('/messages/send', { raw, ...(threadId ? { threadId } : {}) });
    // Pull the sent message straight in so Sent shows it immediately
    try {
      const full = await this.clients(opts.accountId).get(`/messages/${sent.id}`, { format: 'metadata' });
      this.db.upsertMessages(opts.accountId, [normaliseMessage(full)]);
      this.onChange();
    } catch {}
    return sent;
  }

  async createLabel(accountId, name) {
    const created = await this.clients(accountId).post('/labels', { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' });
    this.db.addLabel(accountId, created);
    this.onChange();
    return created;
  }
}

module.exports = { Actions };
