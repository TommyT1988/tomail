'use strict';
// Every user action, provider-agnostic: optimistic local update → provider call → revert on failure.
// Targets are [{accountId, id}] and are grouped per account.
const { textToHtml, htmlToText, buildRaw } = require('./gmail/mime');
const { SNOOZE_LABEL_NAME } = require('./db');
const { parseIcs, buildReply } = require('./calendar');

const INLINE_MAX = 3 * 1024 * 1024;

class Actions {
  /** providers(accountId) → provider; db → MailDb; onChange() → notify renderer */
  constructor({ db, providers, onChange = () => {}, log = () => {} }) {
    this.db = db; this.providers = providers; this.onChange = onChange; this.log = log;
  }
  groupByAccount(targets) {
    const g = new Map();
    for (const t of targets) { if (!g.has(t.accountId)) g.set(t.accountId, []); g.get(t.accountId).push(t.id); }
    return g;
  }

  /** Returns { ids } — the targets after the change (IMAP moves re-key messages), so callers can undo. */
  async modify(targets, { add = [], remove = [] }) {
    const failed = []; const result = [];
    for (const [accountId, ids] of this.groupByAccount(targets)) {
      const before = ids.map(id => ({ id, labels: this.db.getMessage(accountId, id)?.labels || [] }));
      this.db.applyLabelChange(accountId, ids, { add, remove });
      this.onChange();
      try { const r = await this.providers(accountId).modify(ids, { add, remove }); const rk = r?.rekeyed; for (const id of ids) result.push({ accountId, id: rk?.get(id) || id }); }
      catch (e) {
        for (const b of before) {
          const cur = this.db.getMessage(accountId, b.id);
          if (cur) this.db.applyLabelChange(accountId, [b.id], { add: b.labels.filter(l => !cur.labels.includes(l)), remove: cur.labels.filter(l => !b.labels.includes(l)) });
        }
        this.log(`modify failed: ${e.message}`); failed.push(e.message);
      }
      this.onChange();
    }
    if (failed.length) throw new Error(failed.join('; '));
    return { ids: result };
  }
  markRead(t, read = true) { return this.modify(t, read ? { remove: ['UNREAD'] } : { add: ['UNREAD'] }); }
  star(t, on = true) { return this.modify(t, on ? { add: ['STARRED'] } : { remove: ['STARRED'] }); }
  archive(t) { return this.modify(t, { remove: ['INBOX'] }); }
  trash(t) { return this.modify(t, { add: ['TRASH'], remove: ['INBOX', 'SPAM'] }); }
  untrash(t) { return this.modify(t, { remove: ['TRASH', 'SPAM'], add: ['INBOX'] }); }
  spam(t, on = true) { return this.modify(t, on ? { add: ['SPAM'], remove: ['INBOX'] } : { remove: ['SPAM'], add: ['INBOX'] }); }
  move(t, toLabelId, fromLabelId) {
    const remove = fromLabelId && fromLabelId !== toLabelId ? [fromLabelId] : [];
    if (toLabelId !== 'INBOX' && fromLabelId === 'INBOX' && !remove.includes('INBOX')) remove.push('INBOX');
    return this.modify(t, { add: [toLabelId], remove });
  }
  async deleteForever(targets) {
    for (const [accountId, ids] of this.groupByAccount(targets)) await this.providers(accountId).deleteForever(ids);
    this.onChange();
  }
  async emptyFolder(accountId, labelId) {
    const n = await this.providers(accountId).emptyFolder(labelId);
    this.onChange();
    return n;
  }

  // ── snooze ──
  async snoozeLabel(accountId) {
    const acct = this.db.getAccount(accountId);
    const p = this.providers(accountId);
    if (p.kind === 'imap') { const f = await p.ensureFolder('SNOOZED', SNOOZE_LABEL_NAME); return f.labelId; }
    if (acct.snooze_label_id) return acct.snooze_label_id;
    let l = this.db.findLabelByName(accountId, SNOOZE_LABEL_NAME);
    if (!l) l = await p.createLabel(SNOOZE_LABEL_NAME);
    this.db.updateAccount(accountId, { snooze_label_id: l.id });
    return l.id;
  }
  /** Server-side wake-time marker so every device running Tomail wakes the message: Gmail hidden label / IMAP keyword. */
  async untilMarker(accountId, until) {
    const p = this.providers(accountId);
    if (p.kind === 'imap') return '$TomailUntil' + Math.floor(until / 1000);
    if (p.untilLabel) return p.untilLabel(until);
    return null;
  }
  async snooze(targets, until) {
    for (const [accountId, ids] of this.groupByAccount(targets)) {
      const label = await this.snoozeLabel(accountId);
      const marker = await this.untilMarker(accountId, until).catch(() => null);
      this.db.setSnooze(accountId, ids, until);
      await this.modify(ids.map(id => ({ accountId, id })), { add: [label, ...(marker ? [marker] : [])], remove: ['INBOX'] });
      // IMAP moves re-key the rows; carry the snooze time onto the new keys
      for (const id of ids) if (!this.db.getMessage(accountId, id)) { /* rekeyed — find by label */ }
      const stillNull = this.db.prep('SELECT id FROM messages WHERE account_id = ? AND snooze_until IS NULL AND imap_folder = (SELECT imap_path FROM labels WHERE account_id = ? AND id = ?)').all(accountId, accountId, label).map(r => r.id);
      if (stillNull.length) this.db.setSnooze(accountId, stillNull, until);
    }
    this.onChange();
  }
  async unsnooze(targets) {
    for (const [accountId, ids] of this.groupByAccount(targets)) {
      const label = await this.snoozeLabel(accountId);
      const untilLabels = new Set(this.db.listLabels(accountId).filter(l => /^Tomail\/until\//.test(l.name)).map(l => l.id));
      const markers = new Set();
      for (const id of ids) for (const l of this.db.getMessage(accountId, id)?.labels || []) if (/^\$TomailUntil/.test(l) || untilLabels.has(l)) markers.add(l);
      this.db.setSnooze(accountId, ids, null);
      await this.modify(ids.map(id => ({ accountId, id })), { add: ['INBOX', 'UNREAD'], remove: [label, ...markers] });
    }
    this.onChange();
  }
  async wakeDueSnoozes() {
    const due = this.db.dueSnoozes(Date.now());
    if (!due.length) return 0;
    await this.unsnooze(due.map(d => ({ accountId: d.account_id, id: d.id })));
    return due.length;
  }

  // ── reading ──
  async getMessage(accountId, id) {
    let m = this.db.getMessage(accountId, id);
    if (!m) return null;
    if (m.bodyFetched) return m;
    const p = this.providers(accountId);
    const full = await p.fetchFull(id);
    let html = full.html || '';
    for (const a of full.attachments) {
      if (!a.contentId || !html.includes('cid:' + a.contentId) || (a.size || 0) > INLINE_MAX) continue;
      try { const data = await full.inlineData(a); html = html.split('cid:' + a.contentId).join(`data:${a.mimeType};base64,${Buffer.from(data).toString('base64')}`); a.inline = true; }
      catch (e) { this.log(`inline image ${a.contentId}: ${e.message}`); }
    }
    const text = full.text || htmlToText(html);
    // calendar invite: text/calendar part, or an .ics attachment
    let ics = full.calendar || null;
    if (!ics) { const icsAtt = full.attachments.find(a => /text\/calendar/i.test(a.mimeType) || /\.ics$/i.test(a.filename || '')); if (icsAtt) { try { ics = Buffer.from(await full.inlineData(icsAtt)).toString('utf8'); } catch {} } }
    const event = ics ? parseIcs(ics) : null;
    const attachments = full.attachments.filter(a => !a.inline).map(({ data, _content, ...rest }) => rest);
    if (full.meta) this.db.upsertMessages(accountId, [full.meta]);
    this.db.setBody(accountId, id, { text, html, attachments });
    if (event) this.db.setCalendar(accountId, id, event);
    m = this.db.getMessage(accountId, id);
    this.onChange();
    return m;
  }
  getAttachment(accountId, messageId, attachmentId) { return this.providers(accountId).getAttachment(messageId, attachmentId); }
  async deepSearch(q, accountId = null, limit = 100) {
    const accounts = accountId ? [this.db.getAccount(accountId)] : this.db.listAccounts();
    const out = [];
    for (const acct of accounts) { if (!acct) continue; const ids = await this.providers(acct.id).search(q, limit); for (const id of ids) out.push({ accountId: acct.id, id }); }
    return out;
  }

  // ── compose ──
  fromHeader(acct) {
    const name = acct.display_name && acct.display_name !== acct.email ? acct.display_name : '';
    return name ? `"${name.replace(/"/g, '')}" <${acct.email}>` : acct.email;
  }
  /** Build the raw MIME for a draft/send payload. */
  async buildOutgoing(opts, acct) {
    let inReplyTo, references, threadId;
    if (opts.replyTo && opts.mode !== 'forward') {
      const orig = this.db.getMessage(opts.replyTo.accountId, opts.replyTo.id);
      if (orig) { inReplyTo = orig.messageIdHdr || undefined; references = [orig.references, orig.messageIdHdr].filter(Boolean).join(' ') || undefined; threadId = orig.threadId; }
    }
    const bodyHtml = opts.html || textToHtml(opts.text || '');
    const html = bodyHtml + (opts.quotedHtml ? `<br><div class="tomail_quote">${opts.quotedHtml}</div>` : '');
    const text = (opts.text || htmlToText(opts.html || '')) + (opts.quotedText ? `\n\n${opts.quotedText}` : '');
    const attachments = (opts.attachments || []).map(a => ({ filename: a.filename, path: a.path, content: a.content ? Buffer.from(a.content, 'base64') : undefined, contentType: a.contentType, cid: a.cid }));
    if (opts.forwardAttachments && opts.replyTo) {
      const orig = this.db.getMessage(opts.replyTo.accountId, opts.replyTo.id);
      for (const a of orig?.attachments || []) { if (a.attachmentId == null) continue; attachments.push({ filename: a.filename, contentType: a.mimeType, content: await this.getAttachment(opts.replyTo.accountId, opts.replyTo.id, a.attachmentId) }); }
    }
    const messageId = `<${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}@${acct.email.split('@')[1] || 'tomail'}>`;
    const raw = await buildRaw({ from: this.fromHeader(acct), to: opts.to, cc: opts.cc, bcc: opts.bcc, subject: opts.subject, text, html, attachments, inReplyTo, references, icalEvent: opts.icalEvent, messageId });
    return { raw, threadId, messageId };
  }
  isNetworkError(e) { return /fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket hang up|network|Connection not available|timed out/i.test(e?.message || '') || /^(ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN)/.test(e?.code || ''); }
  /** Send now; on a connection failure the message goes to the Outbox and is retried automatically. */
  async send(opts, { fromOutbox = false } = {}) {
    try { return await this.sendNow(opts); }
    catch (e) {
      if (!fromOutbox && this.isNetworkError(e)) {
        const id = this.db.enqueueOutbox(opts.accountId, opts, e.message);
        if (opts.draftId) await this.deleteDraft(opts.draftId).catch(() => {});
        this.onChange();
        const err = new Error('No connection — saved to Outbox, will send automatically'); err.code = 'OUTBOX'; err.outboxId = id; throw err;
      }
      throw e;
    }
  }
  async processOutbox() {
    const due = this.db.dueOutbox(Date.now());
    let sent = 0;
    for (const item of due) {
      try { await this.sendNow({ ...item.payload, draftId: undefined }); this.db.removeOutbox(item.id); sent++; }
      catch (e) { this.db.outboxFailed(item.id, e.message); this.log('outbox send failed: ' + e.message); if (!this.isNetworkError(e)) this.db.prep('UPDATE outbox SET next_try = ? WHERE id = ?').run(Date.now() + 3600000, item.id); }
    }
    if (due.length) this.onChange();
    return sent;
  }
  async sendOutboxItem(id) {
    const item = this.db.getOutbox(id); if (!item) throw new Error('Not in outbox');
    await this.sendNow({ ...item.payload, draftId: undefined }); this.db.removeOutbox(id); this.onChange();
  }
  async sendNow(opts) {
    const acct = this.db.getAccount(opts.accountId);
    if (!acct) throw new Error('Unknown account');
    const { raw, threadId, messageId } = await this.buildOutgoing(opts, acct);
    const p = this.providers(opts.accountId);
    const sent = await p.send({ raw, threadId });
    if (opts.followUpAt) this.db.addFollowup({ accountId: opts.accountId, messageId: sent.id, threadId: sent.threadId || threadId || null, messageIdHdr: messageId, subject: opts.subject, to: opts.to, dueAt: Number(opts.followUpAt) });
    if (opts.replyTo && opts.mode !== 'forward' && p.kind === 'imap') {
      try { await p.modify([opts.replyTo.id], { add: ['ANSWERED'] }); } catch {}
      this.db.prep('UPDATE messages SET answered = 1 WHERE account_id = ? AND id = ?').run(opts.replyTo.accountId, opts.replyTo.id);
    }
    if (opts.draftId) await this.deleteDraft(opts.draftId).catch(e => this.log('draft cleanup: ' + e.message));
    this.onChange();
    return sent;
  }

  async renameLabel(accountId, id, name) { await this.providers(accountId).renameLabel(id, name); this.onChange(); }
  async deleteLabel(accountId, id) { await this.providers(accountId).deleteLabel(id); this.onChange(); }
  async setLabelColor(accountId, id, bg, fg) { await this.providers(accountId).setLabelColor(id, bg, fg); this.onChange(); }

  // ── follow-ups ──
  ownEmails() { return this.db.listAccounts().map(a => a.email); }
  addFollowup(accountId, messageId, dueAt) {
    const m = this.db.getMessage(accountId, messageId); if (!m) throw new Error('Message not found');
    const id = this.db.addFollowup({ accountId, messageId, threadId: m.threadId, messageIdHdr: m.messageIdHdr, subject: m.subject, to: (m.to || []).map(a => a.email).join(', ') || m.fromEmail, dueAt });
    this.onChange(); return this.db.getFollowup(id);
  }
  /** Resolve follow-ups that got a reply; mark overdue ones due. Returns the newly-due list. */
  checkFollowups() {
    const own = this.ownEmails(); const newlyDue = [];
    for (const f of this.db.listFollowups()) {
      const reply = this.db.replyInThread(f.accountId, f, f.createdAt, own);
      if (reply) { this.db.updateFollowup(f.id, { status: 'replied', replied_by: reply.fromEmail, replied_at: reply.date }); continue; }
      if (f.status === 'waiting' && Date.now() >= f.dueAt) { this.db.updateFollowup(f.id, { status: 'due' }); newlyDue.push({ ...f, status: 'due' }); }
    }
    if (newlyDue.length) this.onChange();
    return newlyDue;
  }
  markFollowupNotified(id) { this.db.updateFollowup(id, { notified: 1 }); }

  // ── drafts (local first; mirrored to the provider's Drafts best-effort) ──
  listDrafts() { return this.db.listDrafts(); }
  /** Server-side drafts not already represented by a local draft (so the Drafts folder shows each once). */
  remoteDraftMessages() {
    const out = [];
    for (const a of this.db.listAccounts()) { const known = this.db.draftRemoteMessageIds(a.id); for (const m of this.db.listMessages({ kind: 'label', accountId: a.id, labelId: 'DRAFT' }, { limit: 500 })) if (!known.has(m.id)) out.push(m); }
    return out;
  }
  getDraft(id) { return this.db.getDraft(id); }
  async saveDraft(d, { syncRemote = true } = {}) {
    const saved = this.db.saveDraft(d);
    this.onChange();
    if (syncRemote) this.syncDraftRemote(saved.id).catch(e => this.log('draft remote sync: ' + e.message));
    return saved;
  }
  async syncDraftRemote(id) {
    const d = this.db.getDraft(id); if (!d) return;
    const acct = this.db.getAccount(d.accountId); if (!acct) return;
    const { raw, threadId } = await this.buildOutgoing({ ...d, text: d.bodyText, html: d.bodyHtml, attachments: d.attachments.filter(a => a.path || a.content) }, acct);
    const r = await this.providers(d.accountId).saveDraft({ raw, threadId, remoteId: d.remoteId });
    if (this.db.getDraft(id)) this.db.setDraftRemote(id, r.id, r.messageId);
  }
  async deleteDraft(id) {
    const d = this.db.getDraft(id); if (!d) return;
    this.db.deleteDraft(id);
    this.onChange();
    if (d.remoteId) await this.providers(d.accountId).deleteDraft(d.remoteId).catch(e => this.log('remote draft delete: ' + e.message));
  }
  /** Open a draft that exists on the server (DRAFT-labelled message) as a local draft. */
  async openRemoteDraft(accountId, messageId) {
    const p = this.providers(accountId);
    const remoteId = p.kind === 'gmail' ? await p.draftIdForMessage(messageId) : messageId;
    const existing = remoteId ? this.db.getDraftByRemote(accountId, remoteId) : null;
    if (existing) return existing;
    const m = await this.getMessage(accountId, messageId);
    if (!m) throw new Error('Draft not found');
    const addr = (l) => (l || []).map(a => a.name ? `${a.name} <${a.email}>` : a.email).join(', ');
    const d = this.db.saveDraft({ accountId, mode: 'new', to: addr(m.to), cc: addr(m.cc), subject: m.subject, bodyHtml: m.bodyHtml || textToHtml(m.bodyText || ''), bodyText: m.bodyText || '', attachments: [], remoteId });
    this.db.setDraftRemote(d.id, remoteId, messageId);
    return this.db.getDraft(d.id);
  }

  // ── calendar ──
  async respondInvite(accountId, messageId, partstat) {
    const m = this.db.getMessage(accountId, messageId);
    const ev = m?.calendar;
    if (!ev?.organizer?.email) throw new Error('This invitation has no organiser to reply to');
    const acct = this.db.getAccount(accountId);
    const me = acct.email.toLowerCase();
    const ics = buildReply(ev, { email: me, name: acct.display_name !== acct.email ? acct.display_name : '', partstat });
    const word = { ACCEPTED: 'Accepted', TENTATIVE: 'Tentative', DECLINED: 'Declined' }[partstat];
    await this.send({ accountId, to: ev.organizer.email, subject: `${word}: ${ev.summary || 'Invitation'}`, text: `${acct.display_name || me} has ${word.toLowerCase()} this invitation.`,
      icalEvent: { method: 'REPLY', content: ics, filename: 'invite.ics' }, mode: 'new' });
    ev.myResponse = partstat;
    this.db.setCalendar(accountId, messageId, ev);
    this.onChange();
    return ev;
  }
}
module.exports = { Actions };
