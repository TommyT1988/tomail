'use strict';
// Accounts: encrypted secret storage (Electron safeStorage when the OS keychain is
// available), Gmail token refresh, and the per-account provider factory.
const { GmailClient } = require('./gmail/api');
const oauth = require('./gmail/oauth');
const { BUILTIN, hasBuiltin } = require('./gmail/oauthClient');
const { GmailProvider } = require('./providers/gmail');
const { ImapProvider } = require('./providers/imap');

class AccountManager {
  constructor({ db, settings, safeStorage, log = () => {} }) {
    this.db = db; this.settings = settings; this.safeStorage = safeStorage; this.log = log;
    this.clients = new Map(); this.providers = new Map(); this.refreshing = new Map();
  }
  /** Custom client from Settings → Advanced wins; otherwise the client built into this release. */
  get oauthConfig() {
    const { clientId, clientSecret } = this.settings.get().oauth;
    if (clientId && clientSecret) return { clientId, clientSecret };
    if (hasBuiltin()) return { ...BUILTIN };
    const e = new Error('This build has no Google sign-in client. Add your own under Settings → Advanced.'); e.code = 'NO_OAUTH'; throw e;
  }
  hasClient() { try { return !!this.oauthConfig; } catch { return false; } }
  encrypt(obj) {
    const s = JSON.stringify(obj);
    if (this.safeStorage?.isEncryptionAvailable?.()) return Buffer.concat([Buffer.from('enc:'), this.safeStorage.encryptString(s)]);
    this.log('safeStorage unavailable — storing secrets unencrypted');
    return Buffer.from('plain:' + s);
  }
  decrypt(buf) {
    if (!buf) return null;
    const b = Buffer.from(buf);
    if (b.subarray(0, 4).toString() === 'enc:') return JSON.parse(this.safeStorage.decryptString(b.subarray(4)));
    if (b.subarray(0, 6).toString() === 'plain:') return JSON.parse(b.subarray(6).toString());
    return JSON.parse(b.toString());
  }
  secretsFor(accountId) { const a = this.db.getAccount(accountId); if (!a) throw new Error('Unknown account ' + accountId); return this.decrypt(a.token_enc); }
  saveSecrets(accountId, t) { this.db.updateAccount(accountId, { token_enc: this.encrypt(t) }); }

  // ── Gmail tokens ──
  async refresh(accountId) {
    if (this.refreshing.has(accountId)) return this.refreshing.get(accountId);
    const p = (async () => {
      const t = this.secretsFor(accountId);
      const { clientId, clientSecret } = this.oauthConfig;
      const fresh = await oauth.refresh({ clientId, clientSecret, refreshToken: t.refresh_token });
      const merged = { ...t, ...fresh };
      this.saveSecrets(accountId, merged);
      return merged.access_token;
    })().finally(() => this.refreshing.delete(accountId));
    this.refreshing.set(accountId, p);
    return p;
  }
  client(accountId) {
    let c = this.clients.get(accountId);
    if (c) return c;
    const provider = {
      getAccessToken: async () => { const t = this.secretsFor(accountId); if (t?.access_token && t.expires_at > Date.now()) return t.access_token; return this.refresh(accountId); },
      forceRefresh: () => this.refresh(accountId),
    };
    c = new GmailClient(provider, { log: this.log });
    this.clients.set(accountId, c);
    return c;
  }
  /** Interactive Google sign-in. fullAccess grants https://mail.google.com/ (permanent delete). */
  async add({ openUrl, fullAccess = false, contacts = false, loginHint } = {}) {
    const { clientId, clientSecret } = this.oauthConfig;
    const scopes = [...(fullAccess ? oauth.SCOPES_FULL : oauth.SCOPES), ...(contacts ? oauth.SCOPES_CONTACTS : [])];
    const tokens = await oauth.authorize({ clientId, clientSecret, openUrl, scopes, loginHint });
    const tmp = new GmailClient({ getAccessToken: async () => tokens.access_token, forceRefresh: async () => tokens.access_token });
    const prof = await tmp.get('/profile');
    const email = prof.emailAddress.toLowerCase();
    const existing = this.db.getAccountByEmail(email);
    if (existing) {
      this.saveSecrets(existing.id, tokens); this.db.updateAccount(existing.id, { scopes: tokens.scope, last_error: null, kind: 'gmail' });
      this.clients.delete(existing.id); this.providers.delete(existing.id);
      return { account: this.db.getAccount(existing.id), existed: true };
    }
    const acct = this.db.addAccount({ email, displayName: email, tokenEnc: this.encrypt(tokens), kind: 'gmail' });
    this.db.updateAccount(acct.id, { scopes: tokens.scope });
    return { account: this.db.getAccount(acct.id), existed: false };
  }

  // ── IMAP ──
  /** cfg: { email, host, port, secure, user, pass, smtpHost, smtpPort, smtpSecure, smtpUser, smtpPass, displayName } */
  async addImap(cfg) {
    await ImapProvider.test(cfg);
    const email = (cfg.email || cfg.user).toLowerCase();
    const pub = { host: cfg.host, port: cfg.port, secure: cfg.secure, user: cfg.user, smtpHost: cfg.smtpHost, smtpPort: cfg.smtpPort, smtpSecure: cfg.smtpSecure, smtpUser: cfg.smtpUser || null };
    const secret = { pass: cfg.pass, smtpPass: cfg.smtpPass || null };
    const existing = this.db.getAccountByEmail(email);
    if (existing) {
      this.db.updateAccount(existing.id, { imap_json: JSON.stringify(pub), token_enc: this.encrypt(secret), kind: 'imap', last_error: null });
      this.providers.delete(existing.id);
      return { account: this.db.getAccount(existing.id), existed: true };
    }
    const acct = this.db.addAccount({ email, displayName: cfg.displayName || email, tokenEnc: this.encrypt(secret), kind: 'imap', imapJson: JSON.stringify(pub) });
    return { account: acct, existed: false };
  }

  provider(accountId) {
    let p = this.providers.get(accountId);
    if (p) return p;
    const a = this.db.getAccount(accountId);
    if (!a) throw new Error('Unknown account ' + accountId);
    if (a.kind === 'imap') p = new ImapProvider({ db: this.db, accountId, cfg: { ...JSON.parse(a.imap_json || '{}'), ...this.secretsFor(accountId) }, log: this.log });
    else p = new GmailProvider({ db: this.db, accountId, client: this.client(accountId), log: this.log });
    this.providers.set(accountId, p);
    return p;
  }
  async remove(accountId) {
    const p = this.providers.get(accountId); p?.cancel(); if (p?.close) await p.close().catch(() => {});
    this.clients.delete(accountId); this.providers.delete(accountId);
    this.db.removeAccount(accountId);
  }
  forget(accountId) { this.providers.get(accountId)?.cancel(); this.providers.delete(accountId); this.clients.delete(accountId); }
}
module.exports = { AccountManager };
