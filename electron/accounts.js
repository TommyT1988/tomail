'use strict';
// Token storage (encrypted with Electron safeStorage when the OS keychain is
// available) + per-account GmailClient factory with automatic refresh.
const { GmailClient } = require('./gmail/api');
const oauth = require('./gmail/oauth');

class AccountManager {
  constructor({ db, settings, safeStorage, log = () => {} }) {
    this.db = db; this.settings = settings; this.safeStorage = safeStorage; this.log = log;
    this.clients = new Map();
    this.refreshing = new Map();
  }
  get oauthConfig() {
    const { clientId, clientSecret } = this.settings.get().oauth;
    if (!clientId || !clientSecret) { const e = new Error('Google OAuth client ID / secret not set — open Settings first.'); e.code = 'NO_OAUTH'; throw e; }
    return { clientId, clientSecret };
  }
  encryptTokens(t) {
    const s = JSON.stringify(t);
    if (this.safeStorage?.isEncryptionAvailable?.()) return Buffer.concat([Buffer.from('enc:'), this.safeStorage.encryptString(s)]);
    this.log('safeStorage unavailable — storing tokens unencrypted');
    return Buffer.from('plain:' + s);
  }
  decryptTokens(buf) {
    if (!buf) return null;
    const b = Buffer.from(buf);
    if (b.subarray(0, 4).toString() === 'enc:') return JSON.parse(this.safeStorage.decryptString(b.subarray(4)));
    if (b.subarray(0, 6).toString() === 'plain:') return JSON.parse(b.subarray(6).toString());
    return JSON.parse(b.toString());
  }
  tokensFor(accountId) {
    const a = this.db.getAccount(accountId);
    if (!a) throw new Error('Unknown account ' + accountId);
    return this.decryptTokens(a.token_enc);
  }
  saveTokens(accountId, t) { this.db.updateAccount(accountId, { token_enc: this.encryptTokens(t) }); }

  async refresh(accountId) {
    if (this.refreshing.has(accountId)) return this.refreshing.get(accountId);
    const p = (async () => {
      const t = this.tokensFor(accountId);
      const { clientId, clientSecret } = this.oauthConfig;
      const fresh = await oauth.refresh({ clientId, clientSecret, refreshToken: t.refresh_token });
      const merged = { ...t, ...fresh };
      this.saveTokens(accountId, merged);
      return merged.access_token;
    })().finally(() => this.refreshing.delete(accountId));
    this.refreshing.set(accountId, p);
    return p;
  }

  client(accountId) {
    let c = this.clients.get(accountId);
    if (c) return c;
    const provider = {
      getAccessToken: async () => {
        const t = this.tokensFor(accountId);
        if (t?.access_token && t.expires_at > Date.now()) return t.access_token;
        return this.refresh(accountId);
      },
      forceRefresh: () => this.refresh(accountId),
    };
    c = new GmailClient(provider, { log: this.log });
    this.clients.set(accountId, c);
    return c;
  }

  /** Interactive add: opens the browser, waits for consent, stores tokens, returns the account row. */
  async add({ openUrl }) {
    const { clientId, clientSecret } = this.oauthConfig;
    const tokens = await oauth.authorize({ clientId, clientSecret, openUrl });
    const tmp = new GmailClient({ getAccessToken: async () => tokens.access_token, forceRefresh: async () => tokens.access_token });
    const prof = await tmp.get('/profile');
    const email = prof.emailAddress.toLowerCase();
    const existing = this.db.getAccountByEmail(email);
    if (existing) { this.saveTokens(existing.id, tokens); this.clients.delete(existing.id); return { account: this.db.getAccount(existing.id), existed: true }; }
    const acct = this.db.addAccount({ email, displayName: email, tokenEnc: this.encryptTokens(tokens) });
    return { account: acct, existed: false };
  }
  remove(accountId) { this.clients.delete(accountId); this.db.removeAccount(accountId); }
}
module.exports = { AccountManager };
