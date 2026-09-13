'use strict';
// Per-account sync: a resumable initial pass (newest first, metadata only),
// then history.list increments. Bodies are fetched lazily when a message is opened.
const { parseAddresses, headersToObj } = require('./mime');
const { sleep, GmailError } = require('./api');

const META_HEADERS = ['From', 'To', 'Cc', 'Subject', 'Date', 'Message-ID', 'In-Reply-To', 'References', 'Reply-To', 'Content-Type'];
const BATCH = 40;          // 40 × 5 units = 200 units per batch; the client's budget paces to ~1 batch/s
const PAGE = 500;          // messages.list max
const PAUSE_MS = 50;       // budget does the real pacing

/** Gmail message resource (format=metadata|full) → normalised row for db.upsertMessages */
function normaliseMessage(m) {
  const h = headersToObj(m.payload?.headers);
  const from = parseAddresses(h.from)[0] || { name: '', email: '' };
  const ct = (h['content-type'] || '').toLowerCase();
  return {
    id: m.id, threadId: m.threadId, historyId: m.historyId, internalDate: Number(m.internalDate) || 0,
    size: m.sizeEstimate || 0, snippet: decodeEntities(m.snippet || ''), subject: h.subject || '',
    fromName: from.name, fromEmail: from.email, to: parseAddresses(h.to), cc: parseAddresses(h.cc),
    replyTo: h['reply-to'] || null, messageIdHdr: h['message-id'] || null, inReplyTo: h['in-reply-to'] || null,
    references: h.references || null, hasAttachment: ct.startsWith('multipart/mixed'), labels: m.labelIds || [],
  };
}
function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

class AccountSync {
  /**
   * @param {object} o  { db, client, account, onProgress(status), log }
   */
  constructor({ db, client, account, onProgress = () => {}, log = () => {} }) {
    this.db = db; this.client = client; this.accountId = account.id; this.onProgress = onProgress; this.log = log;
    this.running = false; this.cancelled = false;
  }
  get account() { return this.db.getAccount(this.accountId); }
  cancel() { this.cancelled = true; }

  async syncLabels() {
    const j = await this.client.get('/labels');
    this.db.replaceLabels(this.accountId, j.labels || []);
    return j.labels || [];
  }

  /** Entry point: does whatever this account needs next. */
  async run() {
    if (this.running) return;
    this.running = true; this.cancelled = false;
    try {
      const acct = this.account;
      if (!acct) return;
      await this.syncLabels();
      if (!acct.initial_done) await this.initial();
      else await this.incremental();
      this.db.updateAccount(this.accountId, { last_sync_at: Date.now(), last_error: null });
      this.onProgress({ phase: 'idle' });
    } catch (e) {
      const friendly = /Quota exceeded|rateLimit/i.test(e.message) ? 'Gmail rate limit reached — pausing, will resume automatically' : e.message;
      this.log(`sync error (${this.accountId}): ${e.message}`);
      this.db.updateAccount(this.accountId, { last_error: friendly });
      this.onProgress({ phase: 'error', error: friendly, code: e.code });
      throw e;
    } finally { this.running = false; }
  }

  async initial() {
    let acct = this.account;
    if (!acct.history_id) {
      // Pin the history cursor BEFORE listing so nothing that changes mid-sync is lost.
      const prof = await this.client.get('/profile');
      this.db.updateAccount(this.accountId, { history_id: String(prof.historyId), total_estimate: prof.messagesTotal || null,
        display_name: acct.display_name || prof.emailAddress });
      acct = this.account;
    }
    let pageToken = acct.next_page_token || undefined;
    let synced = acct.synced_count || 0;
    for (;;) {
      if (this.cancelled) return;
      this.onProgress({ phase: 'initial', synced, total: acct.total_estimate });
      const page = await this.client.get('/messages', { maxResults: PAGE, includeSpamTrash: true, pageToken });
      const ids = (page.messages || []).map(m => m.id);
      const known = this.db.existingIds(this.accountId, ids);
      const need = ids.filter(id => !known.has(id));
      for (let i = 0; i < need.length; i += BATCH) {
        if (this.cancelled) return;
        const chunk = need.slice(i, i + BATCH);
        await this.fetchAndStore(chunk);
        synced += chunk.length;
        this.onProgress({ phase: 'initial', synced, total: acct.total_estimate });
        await sleep(PAUSE_MS);
      }
      synced += ids.length - need.length;
      pageToken = page.nextPageToken;
      this.db.updateAccount(this.accountId, { next_page_token: pageToken || null, synced_count: synced });
      if (!pageToken) break;
    }
    this.db.updateAccount(this.accountId, { initial_done: 1, next_page_token: null });
    // Anything that changed during the (possibly long) initial pass:
    await this.incremental();
  }

  async fetchAndStore(ids, format = 'metadata') {
    const q = format === 'metadata' ? '?format=metadata&' + META_HEADERS.map(h => 'metadataHeaders=' + h).join('&') : '?format=' + format;
    const results = await this.client.batchGet(ids.map(id => `/messages/${id}${q}`));
    const rows = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.ok && r.body?.id) rows.push(normaliseMessage(r.body));
      else if (r.status === 404) { /* deleted between list and get */ }
      else this.log(`batch item ${ids[i]} → ${r.status}`);
    }
    if (rows.length) this.db.upsertMessages(this.accountId, rows);
    return rows;
  }

  async incremental() {
    const acct = this.account;
    if (!acct.history_id) return this.initial();
    this.onProgress({ phase: 'incremental' });
    let pageToken;
    let latest = acct.history_id;
    const added = new Set(), deleted = new Set();
    const labelOps = []; // in order
    try {
      for (;;) {
        const j = await this.client.get('/history', { startHistoryId: acct.history_id, maxResults: 500, pageToken,
          historyTypes: ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved'] });
        for (const h of j.history || []) {
          for (const x of h.messagesAdded || []) added.add(x.message.id);
          for (const x of h.messagesDeleted || []) { deleted.add(x.message.id); added.delete(x.message.id); }
          for (const x of h.labelsAdded || []) labelOps.push({ id: x.message.id, add: x.labelIds || [] });
          for (const x of h.labelsRemoved || []) labelOps.push({ id: x.message.id, remove: x.labelIds || [] });
        }
        if (j.historyId) latest = String(j.historyId);
        pageToken = j.nextPageToken;
        if (!pageToken) break;
      }
    } catch (e) {
      if (e instanceof GmailError && e.status === 404) {
        // History expired (mailbox idle > ~a week or too many changes) → full resync, keeping bodies where possible.
        this.log(`history expired for account ${this.accountId} — full resync`);
        this.db.updateAccount(this.accountId, { history_id: null, initial_done: 0, next_page_token: null, synced_count: 0 });
        return this.initial();
      }
      throw e;
    }
    // Apply in a sensible order: label ops for rows we already have, deletions, then fetch new/unknown rows fresh.
    for (const op of labelOps) {
      if (deleted.has(op.id) || added.has(op.id)) continue;
      this.db.applyLabelChange(this.accountId, [op.id], { add: op.add || [], remove: op.remove || [] });
    }
    if (deleted.size) this.db.deleteMessages(this.accountId, [...deleted]);
    const toFetch = [...added].filter(id => !deleted.has(id));
    // Label ops on messages we've never seen (e.g. read on phone before we synced) → fetch fresh too.
    for (const op of labelOps) if (!deleted.has(op.id) && !this.db.existingIds(this.accountId, [op.id]).size && !added.has(op.id)) toFetch.push(op.id);
    for (let i = 0; i < toFetch.length; i += BATCH) await this.fetchAndStore(toFetch.slice(i, i + BATCH));
    this.db.updateAccount(this.accountId, { history_id: latest });
    return { added: toFetch.length, deleted: deleted.size, labelOps: labelOps.length };
  }
}

module.exports = { AccountSync, normaliseMessage, META_HEADERS };
