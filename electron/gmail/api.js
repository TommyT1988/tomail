'use strict';
// Thin Gmail REST client: token refresh on 401, exponential backoff on
// 429/5xx/rateLimit, and multipart batch GETs (up to 100 per call).
const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const BATCH_URL = 'https://www.googleapis.com/batch/gmail/v1';

// Gmail quota: 15,000 units per user per minute (250/s). We aim for 200/s, and the burst is deliberately
// small: 1,000 units let a quiet moment turn into a spike four times the average rate, which is what a
// short-window limiter on Gmail's side sees as abuse. The rate also HALVES whenever Gmail pushes back and
// climbs again once it stops, so the app finds a speed that works instead of insisting on one that doesn't.
const UNITS_PER_SEC = 200, BURST = 400, MIN_UNITS_PER_SEC = 40, RECOVER_AFTER_MS = 60000;
// Anything the person is waiting for goes first. A backfill batch reserves 200 units at a time, and
// when the bucket is empty that batch waits about a second; a plain queue made every click wait behind it.
const PRIORITY = { interactive: 10, background: 0, prefetch: -10 };   // prefetch yields to the sync, the sync yields to you
class Budget {
  constructor() { this.tokens = BURST; this.at = Date.now(); this.waiting = []; this.seq = 0; this.timer = null; this.rate = UNITS_PER_SEC; this.pushbackAt = 0; this.recoverAt = 0; }
  /** Gmail said we're going too fast. Halve the rate; pump() walks it back up once the pushback stops. */
  penalise(log) {
    // One episode, one slowdown: several requests failing together shouldn't compound into a crawl.
    if (this.pushbackAt && Date.now() - this.pushbackAt < 3000) { this.pushbackAt = Date.now(); return; }
    const was = this.rate;
    this.rate = Math.max(MIN_UNITS_PER_SEC, Math.round(this.rate / 2));
    this.pushbackAt = this.recoverAt = Date.now();
    this.tokens = Math.min(this.tokens, 0);
    if (log && was !== this.rate) log(`gmail pushed back — slowing from ${was} to ${this.rate} units/s`);
  }
  /** True while Gmail has complained recently — the cue for optional work to stand down. */
  get limited() { return this.pushbackAt > 0 && Date.now() - this.pushbackAt < RECOVER_AFTER_MS; }
  take(cost, priority = PRIORITY.interactive) {
    return new Promise((resolve) => {
      this.waiting.push({ cost, priority, seq: this.seq++, resolve });
      this.pump();
    });
  }
  pump() {
    const now = Date.now();
    if (this.recoverAt && now - this.recoverAt > RECOVER_AFTER_MS && this.rate < UNITS_PER_SEC) {
      this.rate = Math.min(UNITS_PER_SEC, Math.round(this.rate * 1.25));   // a quiet minute earns some speed back
      this.recoverAt = this.rate < UNITS_PER_SEC ? now : 0;
    }
    this.tokens = Math.min(BURST, this.tokens + (now - this.at) / 1000 * this.rate); this.at = now;
    // highest priority first, and first-come-first-served within a priority
    this.waiting.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
    while (this.waiting.length && this.tokens >= this.waiting[0].cost) {
      const w = this.waiting.shift(); this.tokens -= w.cost; w.resolve();
    }
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.waiting.length) {
      const need = this.waiting[0].cost - this.tokens;
      // NOT unref'd: something is waiting on quota, so the loop should stay alive for it
      this.timer = setTimeout(() => { this.timer = null; this.pump(); }, Math.max(20, Math.ceil(need / this.rate * 1000) + 20));
    }
  }
}
const budget = new Budget();
const COST = { '/profile': 1, '/labels': 1, '/history': 2, '/messages': 5, '/messages/send': 100, '/messages/batchModify': 50, '/messages/batchDelete': 50, '/drafts': 10 };
function costOf(method, pathname, query) {
  if (pathname.endsWith('/messages/send')) return 100;
  if (/\/messages\/batch(Modify|Delete)$/.test(pathname)) return 50;
  if (/\/messages\/[^/]+\/attachments\//.test(pathname)) return 5;
  if (/\/messages\/[^/]+$/.test(pathname)) return method === 'DELETE' ? 10 : 5;
  if (/\/drafts/.test(pathname)) return method === 'GET' ? 5 : 10;
  if (pathname.endsWith('/messages')) return 5;
  for (const [k, v] of Object.entries(COST)) if (pathname.endsWith(k)) return v;
  return 5;
}
function isQuotaError(status, reason, message) { return status === 429 || /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/i.test(reason || '') || /Quota exceeded/i.test(message || ''); }

class GmailError extends Error {
  constructor(status, message, body) { super(message); this.status = status; this.body = body; }
}

class GmailClient {
  /**
   * tokenProvider: { getAccessToken(): Promise<string>, forceRefresh(): Promise<string> }
   */
  constructor(tokenProvider, { fetchImpl = fetch, log = () => {} } = {}) {
    this.tokens = tokenProvider; this.fetch = fetchImpl; this.log = log;
  }

  async request(method, path, { query, body, raw = false, retries, cost, priority = PRIORITY.interactive } = {}) {
    const waiting = priority >= PRIORITY.interactive;          // someone is watching a spinner
    if (retries == null) retries = waiting ? 3 : 8;
    const url = new URL(path.startsWith('http') ? path : BASE + path);
    if (query) for (const [k, v] of Object.entries(query)) {
      if (v == null) continue;
      if (Array.isArray(v)) v.forEach(x => url.searchParams.append(k, x)); else url.searchParams.set(k, v);
    }
    let refreshed = false;
    const unitCost = cost ?? costOf(method, url.pathname, query);
    await budget.take(unitCost, priority);
    for (let attempt = 0; ; attempt++) {
      const token = await this.tokens.getAccessToken();
      let r;
      try {
        r = await this.fetch(url, {
          method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
          // nothing may hang forever: without this a stalled socket leaves the caller waiting indefinitely
          signal: AbortSignal.timeout(waiting ? 20000 : 60000),
        });
      } catch (e) {
        if (attempt < retries) { this.log(`gmail ${method} ${url.pathname} ${e.name === 'TimeoutError' ? 'timed out' : e.message} — retry`); await sleep(Math.min(8000, 500 * 2 ** attempt)); continue; }
        throw new GmailError(0, `Gmail ${method} ${url.pathname}: ${e.name === 'TimeoutError' ? 'timed out' : e.message}`);
      }
      if (r.ok) return r.status === 204 ? null : raw ? r : r.json();
      const text = await r.text();
      let j = null; try { j = JSON.parse(text); } catch {}
      const reason = j?.error?.errors?.[0]?.reason || j?.error?.status || '';
      if (r.status === 401 && !refreshed) { refreshed = true; await this.tokens.forceRefresh(); continue; }
      const quota = isQuotaError(r.status, reason, j?.error?.message);
      if (quota) budget.penalise(this.log);
      const retryable = quota || r.status >= 500 || /backendError/.test(reason);
      if (retryable && attempt < retries) {
        const ra = Number(r.headers.get('retry-after')) * 1000;
        // A backfill can afford to sleep 15s on a quota knock-back; a person waiting for a message can't.
        const quotaWait = waiting ? Math.min(4000, 1200 * (attempt + 1)) : Math.max(ra || 0, Math.min(90000, 15000 * (attempt + 1)));
        const wait = quota ? quotaWait + Math.random() * (waiting ? 300 : 2000) : Math.min(30000, 500 * 2 ** attempt) + Math.random() * 250;
        this.log(`gmail ${r.status} ${reason || ''} — retry in ${Math.round(wait)}ms`);
        await sleep(wait);
        // pay for the retry as well, so a rate that has just been halved actually slows the retries down
        await budget.take(unitCost, priority);
        continue;
      }
      if (quota) throw new GmailError(r.status, 'Gmail is limiting how fast Tomail can read this mailbox. It will sort itself out in a minute — Tomail has already slowed down.', j);
      throw new GmailError(r.status, j?.error?.message || `Gmail ${method} ${url.pathname} → ${r.status}`, j);
    }
  }

  get(path, query, opts) { return this.request('GET', path, { query, ...opts }); }
  post(path, body, query, opts) { return this.request('POST', path, { body, query, ...opts }); }

  /** Batch GET of many resources. Returns array aligned with `paths` ({ok, status, body}). */
  async batchGet(paths, { retries = 8, priority = PRIORITY.interactive } = {}) {
    if (!paths.length) return [];
    await budget.take(paths.length * 5, priority);
    const boundary = 'batch_' + Math.random().toString(36).slice(2);
    const parts = paths.map((p, i) =>
      `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <item${i}>\r\n\r\nGET /gmail/v1/users/me${p} HTTP/1.1\r\n\r\n`).join('') + `--${boundary}--\r\n`;
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const token = await this.tokens.getAccessToken();
      const r = await this.fetch(BATCH_URL, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/mixed; boundary=${boundary}` }, body: parts });
      const text = await r.text();
      if (r.status === 401 && !refreshed) { refreshed = true; await this.tokens.forceRefresh(); continue; }
      if (!r.ok) {
        const quota = isQuotaError(r.status, '', text);
        if (quota) budget.penalise(this.log);
        if ((quota || r.status >= 500) && attempt < retries) { this.log(`gmail batch ${r.status} — retry`); await sleep(quota ? Math.min(90000, 15000 * (attempt + 1)) : Math.min(30000, 800 * 2 ** attempt)); continue; }
        throw new GmailError(r.status, `Gmail batch → ${r.status}: ${text.slice(0, 200)}`);
      }
      const ct = r.headers.get('content-type') || '';
      const m = /boundary="?([^";]+)"?/i.exec(ct);
      const results = parseBatchResponse(text, m ? m[1] : null, paths.length);
      // Per-item rate limiting inside a batch: retry just the failed items.
      const failedIdx = results.map((x, i) => (isQuotaError(x.status, x.body?.error?.errors?.[0]?.reason, x.body?.error?.message) || x.status >= 500) ? i : -1).filter(i => i >= 0);
      if (failedIdx.length && attempt < retries) {
        budget.penalise(this.log);
        this.log(`gmail batch: ${failedIdx.length} item(s) rate-limited — retry`);
        await sleep(Math.min(90000, 15000 * (attempt + 1)));
        const again = await this.batchGet(failedIdx.map(i => paths[i]), { retries: retries - attempt - 1, priority });
        failedIdx.forEach((i, k) => { results[i] = again[k]; });
      }
      return results;
    }
  }
}

/** Parse a multipart/mixed batch response into [{ok,status,body}] ordered by Content-ID index. */
function parseBatchResponse(text, boundary, n) {
  const out = new Array(n).fill(null).map(() => ({ ok: false, status: 0, body: null }));
  if (!boundary) { const m = /^--([^\r\n]+)/.exec(text); boundary = m ? m[1] : null; }
  if (!boundary) return out;
  const chunks = text.split('--' + boundary).slice(1);
  let seq = 0;
  for (let chunk of chunks) {
    if (chunk.startsWith('--')) break;
    chunk = chunk.replace(/^\r?\n/, '');
    const idm = /Content-ID:\s*<response-item(\d+)>/i.exec(chunk);
    const idx = idm ? Number(idm[1]) : seq;
    seq++;
    const httpStart = chunk.indexOf('HTTP/1.1');
    if (httpStart < 0) continue;
    const http = chunk.slice(httpStart);
    const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(http)?.[1] || 0);
    const bodyStart = http.indexOf('\r\n\r\n');
    const rawBody = bodyStart >= 0 ? http.slice(bodyStart + 4).trim() : '';
    let body = null; try { body = rawBody ? JSON.parse(rawBody) : null; } catch { body = rawBody; }
    if (idx < n) out[idx] = { ok: status >= 200 && status < 300, status, body };
  }
  return out;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { GmailClient, GmailError, parseBatchResponse, sleep, isQuotaError, costOf, PRIORITY, budget };
