import React, { useEffect, useState } from 'react';

export default function SettingsModal({ onClose, accounts, refreshAccounts, toast, info }) {
  const [tab, setTab] = useState(accounts.length ? 'general' : 'accounts');
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { window.mail.settings.get().then(setS); }, []);
  useEffect(() => { const k = (e) => { if (e.key === 'Escape') onClose(); }; document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k); }, [onClose]);
  if (!s) return null;
  const save = async (patch) => { const n = await window.mail.settings.set(patch); setS(n); toast('Settings saved'); };
  const addAccount = async () => {
    const ownClient = s.oauth.clientId && s.oauth.clientSecret;
    if (!ownClient && !info?.hasGoogleClient) { toast('This build has no Google sign-in client — add your own under Advanced', true); setTab('google'); return; }
    setBusy(true);
    try { const r = await window.mail.accounts.add(); toast(r.existed ? `Re-connected ${r.account.email}` : `Added ${r.account.email} — syncing`); await refreshAccounts(); }
    catch (e) { toast(e.message, true); } finally { setBusy(false); }
  };
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal settings">
        <div className="mh">Settings<button className="x" onClick={onClose}>✕</button></div>
        <div className="mb">
          <div className="tabs">
            {[['general', 'General'], ['accounts', 'Accounts'], ['google', 'Advanced']].map(([id, n]) => <button key={id} className={'tab' + (tab === id ? ' active' : '')} onClick={() => setTab(id)}>{n}</button>)}
          </div>
          {tab === 'general' && <>
            <div className="frow"><label>Check for new mail every</label><div><input type="number" min="15" style={{ width: 80 }} value={s.prefs.syncIntervalSec} onChange={e => setS({ ...s, prefs: { ...s.prefs, syncIntervalSec: Number(e.target.value) } })} /> seconds</div></div>
            <div className="frow"><label>Mark as read after</label><div><input type="number" min="0" style={{ width: 80 }} value={s.prefs.markReadDelayMs} onChange={e => setS({ ...s, prefs: { ...s.prefs, markReadDelayMs: Number(e.target.value) } })} /> ms in the reading pane (0 = immediately)</div></div>
            <div className="frow"><label>Remote images</label><label><input type="checkbox" checked={!!s.prefs.loadRemoteImages} onChange={e => setS({ ...s, prefs: { ...s.prefs, loadRemoteImages: e.target.checked } })} /> always load images in messages (tracking pixels will fire)</label></div>
            <div className="frow"><label>Signature</label><textarea rows={4} value={s.prefs.signature} onChange={e => setS({ ...s, prefs: { ...s.prefs, signature: e.target.value } })} /></div>
            <div className="frow"><label></label><button className="primary" onClick={() => save({ prefs: s.prefs })}>Save</button></div>
            <div className="frow"><label>Data folder</label><small style={{ gridColumn: 2 }}>{info?.userData} · tokens {info?.encrypted ? 'encrypted with the OS keychain' : 'stored unencrypted (no keychain available)'}</small></div>
          </>}
          {tab === 'accounts' && <>
            {accounts.map(a => (
              <div className="acct" key={a.id}>
                <span className="em">{a.email}</span>
                <span className="muted">{a.initial_done ? `${(a.synced_count || 0).toLocaleString()} messages synced` : `initial sync ${(a.synced_count || 0).toLocaleString()}${a.total_estimate ? ' / ' + a.total_estimate.toLocaleString() : ''}`}</span>
                {a.last_error && <span style={{ color: '#c0392b' }} title={a.last_error}>⚠ {a.last_error.slice(0, 60)}</span>}
                <span className="spacer" />
                {/Token refresh failed|invalid_grant|sign in again/i.test(a.last_error || '') && <button className="primary" onClick={addAccount} disabled={busy}>Sign in again</button>}
                <button onClick={async () => { const n = prompt('Display name (used in From):', a.display_name || ''); if (n != null) { await window.mail.accounts.rename(a.id, n); refreshAccounts(); } }}>Rename</button>
                <button onClick={async () => { if (confirm(`Re-download the whole mailbox for ${a.email}? Cached bodies are dropped.`)) { await window.mail.accounts.resync(a.id); refreshAccounts(); } }}>Resync</button>
                <button onClick={async () => { if (confirm(`Remove ${a.email} from this PC? (Nothing is deleted on Google.)`)) { await window.mail.accounts.remove(a.id); refreshAccounts(); } }}>Remove</button>
              </div>
            ))}
            <button className="primary" onClick={addAccount} disabled={busy}>{busy ? 'Waiting for Google sign-in in your browser…' : 'Sign in with Google'}</button>
            <p className="muted">Your browser opens for Google sign-in; Tomail never sees your password. Add as many Gmail / Google Workspace accounts as you like — "All Inboxes" merges them. Nothing on Google is ever deleted permanently by Tomail.</p>
          </>}
          {tab === 'google' && <>
            <p><b>Use your own Google API client (optional).</b> Tomail releases ship with a built-in Google sign-in{info?.hasGoogleClient ? ' (present in this build)' : ' — but this build has none, so you need your own'}. You only need this if you build Tomail yourself or prefer your own Google Cloud project:</p>
            <ol>
              <li>Open <a href="#" onClick={e => { e.preventDefault(); window.mail.shell.openExternal('https://console.cloud.google.com/apis/library/gmail.googleapis.com'); }}>Google Cloud Console → Gmail API</a>, create a project and click <b>Enable</b>.</li>
              <li><b>APIs &amp; Services → OAuth consent screen</b>: User type <b>Internal</b> if you're on Google Workspace (no verification needed), otherwise External + add yourself as a test user. Save.</li>
              <li><b>Credentials → Create credentials → OAuth client ID</b>, application type <b>Desktop app</b>. Copy the client ID and client secret below.</li>
              <li>If the Workspace admin has restricted third-party apps, allow this client ID under <b>Admin console → Security → API controls</b>.</li>
            </ol>
            <div className="frow"><label>Client ID</label><input type="text" value={s.oauth.clientId} onChange={e => setS({ ...s, oauth: { ...s.oauth, clientId: e.target.value } })} placeholder="…apps.googleusercontent.com" /></div>
            <div className="frow"><label>Client secret</label><input type="password" value={s.oauth.clientSecret} onChange={e => setS({ ...s, oauth: { ...s.oauth, clientSecret: e.target.value } })} /></div>
            <div className="frow"><label></label><div><button className="primary" onClick={() => save({ oauth: s.oauth })}>Save</button> <button onClick={() => save({ oauth: { clientId: '', clientSecret: '' } })}>Use built-in</button></div></div>
            <p className="muted">Scope requested: <code>gmail.modify</code> (read, label, archive, trash, send). Permanent delete is never requested.</p>
          </>}
        </div>
      </div>
    </div>
  );
}
