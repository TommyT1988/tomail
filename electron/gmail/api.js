'use strict';
// Thin Gmail REST client: token refresh on 401, exponential backoff on
// 429/5xx/rateLimit, and multipart batch GETs (up to 100 per call).
const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const BATCH_URL = 'https://www.googleapis.com/batch/gmail/v1';

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

  async request(method, path, { query, body, raw = false, retries = 6 } = {}) {
    const url = new URL(path.startsWith('http') ? path : BASE + path);
    if (query) for (const [k, v] of Object.entries(query)) {
      if (v == null) continue;
      if (Array.isArray(v)) v.forEach(x => url.searchParams.append(k, x)); else url.searchParams.set(k, v);
    }
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const token = await this.tokens.getAccessToken();
      const r = await this.fetch(url, {
        method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (r.ok) return r.status === 204 ? null : raw ? r : r.json();
      const text = await r.text();
      let j = null; try { j = JSON.parse(text); } catch {}
      const reason = j?.error?.errors?.[0]?.reason || j?.error?.status || '';
      if (r.status === 401 && !refreshed) { refreshed = true; await this.tokens.forceRefresh(); continue; }
      const retryable = r.status === 429 || r.status >= 500 || /rateLimitExceeded|userRateLimitExceeded|backendError/.test(reason);
      if (retryable && attempt < retries) {
        const wait = Math.min(30000, 500 * 2 ** attempt) + Math.random() * 250;
        this.log(`gmail ${r.status} ${reason || ''} — retry in ${Math.round(wait)}ms`);
        await sleep(wait); continue;
      }
      throw new GmailError(r.status, j?.error?.message || `Gmail ${method} ${url.pathname} → ${r.status}`, j);
    }
  }

  get(path, query) { return this.request('GET', path, { query }); }
  post(path, body, query) { return this.request('POST', path, { body, query }); }

  /** Batch GET of many resources. Returns array aligned with `paths` ({ok, status, body}). */
  async batchGet(paths, { retries = 6 } = {}) {
    if (!paths.length) return [];
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
        if ((r.status === 429 || r.status >= 500) && attempt < retries) { await sleep(Math.min(30000, 800 * 2 ** attempt)); continue; }
        throw new GmailError(r.status, `Gmail batch → ${r.status}: ${text.slice(0, 200)}`);
      }
      const ct = r.headers.get('content-type') || '';
      const m = /boundary="?([^";]+)"?/i.exec(ct);
      const results = parseBatchResponse(text, m ? m[1] : null, paths.length);
      // Per-item rate limiting inside a batch: retry just the failed items.
      const failedIdx = results.map((x, i) => (x.status === 429 || x.status >= 500) ? i : -1).filter(i => i >= 0);
      if (failedIdx.length && attempt < retries) {
        await sleep(Math.min(30000, 800 * 2 ** attempt));
        const again = await this.batchGet(failedIdx.map(i => paths[i]), { retries: retries - attempt - 1 });
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

module.exports = { GmailClient, GmailError, parseBatchResponse, sleep };
