'use strict';
// Google OAuth 2.0 for a "Desktop app" client: PKCE + loopback redirect.
// The browser is opened by the caller (shell.openExternal); we listen on
// 127.0.0.1:<random port>/oauth2callback for the code and exchange it.
const http = require('node:http');
const crypto = require('node:crypto');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
// gmail.modify = every read/write op except permanent (bypass-trash) deletion. Covers send.
const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];
// Opt-in: full access additionally allows permanent delete / empty trash.
const SCOPES_FULL = ['https://mail.google.com/'];

function b64url(buf) { return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

/**
 * Runs the interactive flow. `openUrl(url)` is called once with the consent URL.
 * Resolves with { access_token, refresh_token, expires_at, scope }.
 */
function authorize({ clientId, clientSecret, openUrl, timeoutMs = 5 * 60 * 1000, loginHint, scopes = SCOPES }) {
  return new Promise((resolve, reject) => {
    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));
    let done = false;
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/oauth2callback') { res.writeHead(404); res.end(); return; }
      const finish = (html) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); };
      if (url.searchParams.get('state') !== state) { finish(page('Sign-in failed', 'State mismatch. Close this tab and try again.')); return; }
      const err = url.searchParams.get('error');
      if (err) { finish(page('Sign-in cancelled', err)); cleanup(); reject(new Error('Google sign-in was cancelled: ' + err)); return; }
      const code = url.searchParams.get('code');
      try {
        const tokens = await exchange({ clientId, clientSecret, code, verifier, redirectUri });
        finish(page('Signed in', 'You can close this tab and return to Mail.'));
        cleanup(); resolve(tokens);
      } catch (e) { finish(page('Sign-in failed', e.message)); cleanup(); reject(e); }
    });
    let redirectUri;
    const timer = setTimeout(() => { cleanup(); reject(new Error('Google sign-in timed out')); }, timeoutMs);
    function cleanup() { if (done) return; done = true; clearTimeout(timer); server.close(); }
    server.listen(0, '127.0.0.1', () => {
      redirectUri = `http://127.0.0.1:${server.address().port}/oauth2callback`;
      const u = new URL(AUTH_URL);
      u.search = new URLSearchParams({
        client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: scopes.join(' '),
        access_type: 'offline', prompt: 'consent select_account', code_challenge: challenge, code_challenge_method: 'S256',
        state, ...(loginHint ? { login_hint: loginHint } : {}),
      }).toString();
      Promise.resolve(openUrl(u.toString())).catch(e => { cleanup(); reject(e); });
    });
    server.on('error', e => { cleanup(); reject(e); });
  });
}

async function exchange({ clientId, clientSecret, code, verifier, redirectUri }) {
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, code_verifier: verifier,
    grant_type: 'authorization_code', redirect_uri: redirectUri });
  const r = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const j = await r.json();
  if (!r.ok) throw new Error(`Token exchange failed: ${j.error_description || j.error || r.status}`);
  if (!j.refresh_token) throw new Error('Google did not return a refresh token — remove the app from your Google account permissions and sign in again.');
  return { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (j.expires_in - 60) * 1000, scope: j.scope };
}

async function refresh({ clientId, clientSecret, refreshToken }) {
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' });
  const r = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const j = await r.json();
  if (!r.ok) {
    const e = new Error(`Token refresh failed: ${j.error_description || j.error || r.status}`);
    e.code = j.error === 'invalid_grant' ? 'REAUTH' : 'REFRESH';
    throw e;
  }
  return { access_token: j.access_token, expires_at: Date.now() + (j.expires_in - 60) * 1000 };
}

function page(title, msg) {
  return `<!doctype html><meta charset=utf-8><title>${title}</title><body style="font-family:system-ui;padding:40px;color:#222"><h2>${title}</h2><p>${msg}</p>`;
}

module.exports = { authorize, refresh, SCOPES, SCOPES_FULL };
