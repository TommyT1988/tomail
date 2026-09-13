'use strict';
// Gmail provider: wraps the REST client + sync engine behind the common provider interface.
const { AccountSync, normaliseMessage } = require('../gmail/sync');
const { parsePayload, b64urlDecode } = require('../gmail/mime');
const { GmailError } = require('../gmail/api');

class GmailProvider {
  constructor({ db, accountId, client, log = () => {} }) {
    this.kind = 'gmail'; this.db = db; this.accountId = accountId; this.client = client; this.log = log;
    this.syncer = null;
  }
  cancel() { this.syncer?.cancel(); }
  async syncLabels() { return this._syncer().syncLabels(); }
  _syncer(onProgress) {
    if (!this.syncer) this.syncer = new AccountSync({ db: this.db, client: this.client, account: { id: this.accountId }, log: this.log, onProgress: (p) => this._progress?.(p) });
    if (onProgress) this._progress = onProgress;
    return this.syncer;
  }
  /** Runs whatever sync is due; resolves with ids of NEW inbox messages (for notifications). */
  async sync(onProgress) {
    const s = this._syncer(onProgress);
    const before = new Set(this.db.labelIds(this.accountId, 'INBOX'));
    await s.run();
    const after = this.db.labelIds(this.accountId, 'INBOX').filter(id => !before.has(id));
    this.reconcileSnoozes();
    return { newInbox: after, newIds: after };
  }
  async modify(ids, { add = [], remove = [] }) {
    for (let i = 0; i < ids.length; i += 1000) {
      await this.client.post('/messages/batchModify', { ids: ids.slice(i, i + 1000), addLabelIds: add, removeLabelIds: remove });
    }
  }
  async fetchFull(id) {
    const full = await this.client.get(`/messages/${id}`, { format: 'full' });
    const parsed = parsePayload(full.payload);
    return { meta: normaliseMessage(full), ...parsed, inlineData: async (a) => a.data ? b64urlDecode(a.data) : b64urlDecode((await this.client.get(`/messages/${id}/attachments/${a.attachmentId}`)).data) };
  }
  async getAttachment(id, attachmentId) { return b64urlDecode((await this.client.get(`/messages/${id}/attachments/${attachmentId}`)).data); }
  async send({ raw, threadId }) {
    const sent = await this.client.post('/messages/send', { raw, ...(threadId ? { threadId } : {}) });
    try { const full = await this.client.get(`/messages/${sent.id}`, { format: 'metadata' }); this.db.upsertMessages(this.accountId, [normaliseMessage(full)]); } catch {}
    return sent;
  }
  async search(q, limit = 100) {
    const j = await this.client.get('/messages', { q, maxResults: limit });
    const ids = (j.messages || []).map(m => m.id);
    const known = this.db.existingIds(this.accountId, ids);
    const missing = ids.filter(id => !known.has(id));
    for (let i = 0; i < missing.length; i += 50) await this._syncer().fetchAndStore(missing.slice(i, i + 50));
    return ids;
  }
  async createLabel(name) {
    const created = await this.client.post('/labels', { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' });
    this.db.addLabel(this.accountId, created);
    return created;
  }
  async renameLabel(id, name) { const l = await this.client.request('PATCH', `/labels/${id}`, { body: { name } }); this.db.updateLabel(this.accountId, id, { name: l.name }); return l; }
  async deleteLabel(id) { await this.client.request('DELETE', `/labels/${id}`); this.db.deleteLabel(this.accountId, id); }
  async setLabelColor(id, bg, fg) {
    const l = await this.client.request('PATCH', `/labels/${id}`, { body: bg ? { color: { backgroundColor: bg, textColor: fg || '#ffffff' } } : { color: null } });
    this.db.updateLabel(this.accountId, id, { color_bg: l.color?.backgroundColor || null, color_fg: l.color?.textColor || null });
    return l;
  }
  async saveDraft({ raw, threadId, remoteId }) {
    const body = { message: { raw, ...(threadId ? { threadId } : {}) } };
    if (remoteId) { try { const d = await this.client.request('PUT', `/drafts/${remoteId}`, { body }); return { id: d.id, messageId: d.message?.id }; } catch (e) { if (!(e instanceof GmailError && e.status === 404)) throw e; } }
    const d = await this.client.post('/drafts', body);
    return { id: d.id, messageId: d.message?.id };
  }
  async deleteDraft(remoteId) { try { await this.client.request('DELETE', `/drafts/${remoteId}`); } catch (e) { if (!(e instanceof GmailError && e.status === 404)) throw e; } }
  /** Map a Gmail DRAFT-labelled message id → draft id (so drafts made in Gmail can be edited here). */
  async draftIdForMessage(messageId) {
    const j = await this.client.get('/drafts', { maxResults: 500 });
    return (j.drafts || []).find(d => d.message?.id === messageId)?.id || null;
  }
  /** Wake-time marker label (hidden in Gmail's sidebar) so other devices learn the snooze. */
  async untilLabel(ts) {
    const name = 'Tomail/until/' + new Date(ts).toISOString().slice(0, 16).replace(/[-:]/g, '');
    let l = this.db.findLabelByName(this.accountId, name);
    if (!l) { try { l = await this.client.post('/labels', { name, labelListVisibility: 'labelHide', messageListVisibility: 'hide' }); } catch (e) { if (!(e instanceof GmailError && e.status === 409)) throw e; await this.syncLabels(); l = this.db.findLabelByName(this.accountId, name); } this.db.addLabel(this.accountId, l); }
    return l.id;
  }
  /** After a sync: adopt snoozes set elsewhere, drop empty until-labels. */
  reconcileSnoozes() {
    const labels = this.db.listLabels(this.accountId).filter(l => /^Tomail\/until\//.test(l.name));
    for (const l of labels) {
      const m = /(\d{8})T(\d{4})$/.exec(l.name); if (!m) continue;
      const ts = Date.UTC(+m[1].slice(0, 4), +m[1].slice(4, 6) - 1, +m[1].slice(6, 8), +m[2].slice(0, 2), +m[2].slice(2, 4));
      for (const id of this.db.labelIds(this.accountId, l.id)) this.db.adoptSnooze(this.accountId, id, ts);
    }
  }
  get canDeleteForever() { const a = this.db.getAccount(this.accountId); return /mail\.google\.com/.test(a?.scopes || ''); }
  async deleteForever(ids) {
    if (!this.canDeleteForever) { const e = new Error('Permanent delete needs full Gmail access — Settings → Accounts → "Grant full access" and sign in again. (Gmail empties Trash itself after 30 days.)'); e.code = 'SCOPE'; throw e; }
    for (let i = 0; i < ids.length; i += 1000) await this.client.post('/messages/batchDelete', { ids: ids.slice(i, i + 1000) });
    this.db.deleteMessages(this.accountId, ids);
  }
  async emptyFolder(labelId) {
    const ids = this.db.labelIds(this.accountId, labelId);
    await this.deleteForever(ids);
    return ids.length;
  }
}
module.exports = { GmailProvider };
