import React, { useEffect, useState } from 'react';
import Icon from './Icons.jsx';
import RulesTab from './RulesTab.jsx';

function ImapForm({ onDone, toast }) {
  const [email, setEmail] = useState('');
  const [cfg, setCfg] = useState(null);
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const set = (k) => (e) => setCfg(c => ({ ...c, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.type === 'number' ? Number(e.target.value) : e.target.value }));
  const lookup = async () => {
    if (!/@/.test(email)) { toast('Enter your full email address', true); return; }
    setBusy('lookup');
    try { const c = await window.mail.accounts.autoconfig(email); setCfg({ ...c, email, displayName: c.displayName || '' }); setAdvanced(c.source === 'guess'); }
    catch (e) { toast(e.message, true); } finally { setBusy(''); }
  };
  const submit = async (testOnly) => {
    const full = { ...cfg, email, pass, user: cfg.user || email };
    setBusy(testOnly ? 'test' : 'add');
    try {
      if (testOnly) { await window.mail.accounts.testImap(full); toast('Connection OK'); }
      else { const r = await window.mail.accounts.addImap(full); toast(`Added ${r.account.email} — syncing`); onDone(); }
    } catch (e) { toast(e.message, true); setAdvanced(true); } finally { setBusy(''); }
  };
  return (
    <div className="imapform">
      <div className="frow"><label>Email address</label><div style={{ display: 'flex', gap: 6 }}><input type="email" value={email} onChange={e => setEmail(e.target.value)} onKeyDown={e => e.key === 'Enter' && lookup()} placeholder="you@example.com" autoFocus /><button onClick={lookup} disabled={busy === 'lookup'}>{busy === 'lookup' ? 'Looking up…' : 'Next'}</button></div></div>
      {cfg && <>
        {cfg.note && <p className="muted" style={{ marginLeft: 198 }}>{cfg.note}</p>}
        <div className="frow"><label>Password</label><input type="password" value={pass} onChange={e => setPass(e.target.value)} placeholder={/app password/i.test(cfg.note || '') ? 'App password' : 'Mailbox password'} /></div>
        <div className="frow"><label>Your name</label><input type="text" value={cfg.displayName || ''} onChange={set('displayName')} placeholder="Shown on messages you send" /></div>
        <div className="frow"><label></label><small>Found via {cfg.source === 'autoconfig' ? "Mozilla's provider database" : cfg.source === 'preset' ? 'built-in provider list' : 'a guess from the domain'}: {cfg.host} · {cfg.smtpHost} <button className="ccbcc" onClick={() => setAdvanced(a => !a)}>{advanced ? 'hide' : 'edit'} server settings</button></small></div>
        {advanced && <>
          <div className="frow"><label>IMAP server</label><div style={{ display: 'flex', gap: 6 }}><input type="text" value={cfg.host || ''} onChange={set('host')} style={{ flex: 1 }} /><input type="number" value={cfg.port || 993} onChange={set('port')} style={{ width: 80 }} /><label><input type="checkbox" checked={cfg.secure !== false} onChange={set('secure')} /> SSL</label></div></div>
          <div className="frow"><label>IMAP username</label><input type="text" value={cfg.user || email} onChange={set('user')} /></div>
          <div className="frow"><label>SMTP server</label><div style={{ display: 'flex', gap: 6 }}><input type="text" value={cfg.smtpHost || ''} onChange={set('smtpHost')} style={{ flex: 1 }} /><input type="number" value={cfg.smtpPort || 587} onChange={set('smtpPort')} style={{ width: 80 }} /><label><input type="checkbox" checked={!!cfg.smtpSecure} onChange={set('smtpSecure')} /> SSL</label></div></div>
          <div className="frow"><label>SMTP username</label><input type="text" value={cfg.smtpUser || ''} onChange={set('smtpUser')} placeholder="same as IMAP" /></div>
          <div className="frow"><label>SMTP password</label><input type="password" value={cfg.smtpPass || ''} onChange={set('smtpPass')} placeholder="same as IMAP" /></div>
        </>}
        <div className="frow"><label></label><div><button onClick={() => submit(true)} disabled={!pass || !!busy}>{busy === 'test' ? 'Testing…' : 'Test connection'}</button> <button className="primary" onClick={() => submit(false)} disabled={!pass || !!busy}>{busy === 'add' ? 'Adding…' : 'Add account'}</button></div></div>
      </>}
    </div>
  );
}

export default function SettingsModal({ onClose, accounts, refreshAccounts, toast, info, initialTab, labels = {}, ruleSeed }) {
  const [tab, setTab] = useState(initialTab || (accounts.length ? 'general' : 'accounts'));
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState(false);
  const [showImap, setShowImap] = useState(false);
  const [sigEdit, setSigEdit] = useState(null);
  const [dbInfo, setDbInfo] = useState(null);
  const [contacts, setContacts] = useState(null);
  const [importing, setImporting] = useState(null);
  const loadContacts = () => window.mail.contacts.stats().then(setContacts).catch(() => {});
  useEffect(() => { loadContacts(); }, [accounts]);
  const importContacts = async (a) => { setImporting(a.id); try { const r = await window.mail.contacts.importGoogle(a.id); toast(`Imported ${r.imported} Google contacts`); await refreshAccounts(); loadContacts(); } catch (e) { toast(e.message, true); } finally { setImporting(null); } };
  const [problem, setProblem] = useState('');
  useEffect(() => { window.mail.app.dbInfo().then(setDbInfo).catch(() => {}); }, []);
  useEffect(() => { window.mail.settings.get().then(setS); }, []);
  useEffect(() => { const k = (e) => { if (e.key === 'Escape') onClose(); }; document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k); }, [onClose]);
  if (!s) return null;
  const save = async (patch) => { const n = await window.mail.settings.set(patch); setS(n); toast('Settings saved'); };
  const pref = (k, v) => setS({ ...s, prefs: { ...s.prefs, [k]: v } });
  const addGoogle = async (fullAccess = false) => {
    const ownClient = s.oauth.clientId && s.oauth.clientSecret;
    if (!ownClient && !info?.hasGoogleClient) { toast('This build has no Google sign-in client — add your own under Advanced', true); setTab('google'); return; }
    setBusy(true);
    try { const r = await window.mail.accounts.add({ fullAccess }); toast(r.existed ? `Re-connected ${r.account.email}` : `Added ${r.account.email} — syncing`); await refreshAccounts(); }
    catch (e) { toast(e.message, true); } finally { setBusy(false); }
  };
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal settings" style={{ width: 820 }}>
        <div className="mh">Settings<button className="x" onClick={onClose}>✕</button></div>
        <div className="mb">
          <div className="tabs">
            {[['general', 'General'], ['accounts', 'Accounts'], ['rules', 'Rules'], ['google', 'Advanced']].map(([id, n]) => <button key={id} className={'tab' + (tab === id ? ' active' : '')} onClick={() => setTab(id)}>{n}</button>)}
          </div>
          {tab === 'general' && <>
            <div className="frow"><label>Appearance</label><div style={{ display: 'flex', gap: 4 }}>{[['system', 'System'], ['light', 'Light'], ['dark', 'Dark']].map(([v, n]) => <button key={v} className={s.prefs.theme === v || (!s.prefs.theme && v === 'system') ? 'primary' : ''} onClick={() => { pref('theme', v); window.mail.settings.set({ prefs: { theme: v } }); document.documentElement.dataset.theme = v === 'system' ? '' : v; document.documentElement.classList.toggle('dark', v === 'dark' || (v === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)); }}>{v === 'light' ? <Icon name="sun" size={12} /> : v === 'dark' ? <Icon name="moon" size={12} /> : null} {n}</button>)}</div></div>
            <div className="frow"><label>Check for new mail every</label><div><input type="number" min="15" style={{ width: 80 }} value={s.prefs.syncIntervalSec} onChange={e => pref('syncIntervalSec', Number(e.target.value))} /> seconds in the background, <input type="number" min="10" style={{ width: 70 }} value={s.prefs.fastPollSec ?? 20} onChange={e => pref('fastPollSec', Number(e.target.value))} /> while Tomail is the active window</div></div>
            <div className="frow"><label></label><small>IMAP accounts are also pushed to instantly by the server (IMAP IDLE).</small></div>
            <div className="frow"><label>Notifications</label><label><input type="checkbox" checked={s.prefs.notifications !== false} onChange={e => pref('notifications', e.target.checked)} /> <Icon name="bell" size={12} /> show a system notification for new inbox mail</label></div>
            <div className="frow"><label></label><label><input type="checkbox" checked={s.prefs.notifyWhenFocused !== false} onChange={e => pref('notifyWhenFocused', e.target.checked)} /> even while Tomail is the active window</label></div>
            <div className="frow"><label>Conversation view</label><label><input type="checkbox" checked={!!s.prefs.threaded} onChange={e => pref('threaded', e.target.checked)} /> group messages by conversation by default</label></div>
            <div className="frow"><label>Mark as read after</label><div><input type="number" min="0" style={{ width: 80 }} value={s.prefs.markReadDelayMs} onChange={e => pref('markReadDelayMs', Number(e.target.value))} /> ms in the reading pane (0 = immediately)</div></div>
            <div className="frow"><label>Remote images</label><label><input type="checkbox" checked={!!s.prefs.loadRemoteImages} onChange={e => pref('loadRemoteImages', e.target.checked)} /> always load images in messages (tracking pixels will fire)</label></div>
            <div className="frow"><label>Undo send</label><div><input type="number" min="0" max="30" style={{ width: 70 }} value={s.prefs.sendDelaySec ?? 5} onChange={e => pref('sendDelaySec', Number(e.target.value))} /> seconds to cancel after pressing Send (0 = send immediately)</div></div>
            <div className="frow"><label>Keep downloaded bodies</label><div><select value={s.prefs.bodyRetentionDays || 0} onChange={e => pref('bodyRetentionDays', Number(e.target.value))}><option value={0}>forever</option><option value={30}>30 days</option><option value={90}>90 days</option><option value={365}>1 year</option></select> <small>(headers stay; older bodies re-download when opened)</small></div></div>
            <div className="frow"><label>Default signature</label><textarea rows={3} value={s.prefs.signature} onChange={e => pref('signature', e.target.value)} placeholder="Used by accounts without their own signature" /></div>
            <div className="frow"><label></label><button className="primary" onClick={() => save({ prefs: s.prefs })}>Save</button></div>
            <div className="frow"><label>Local database</label><div><small>{dbInfo ? `${(dbInfo.size / 1048576).toFixed(0)} MB · ${dbInfo.messages.toLocaleString()} messages, ${dbInfo.bodies.toLocaleString()} bodies cached · compacted ${dbInfo.lastVacuum ? new Date(dbInfo.lastVacuum).toLocaleDateString('en-GB') : 'never'}` : '…'}</small> <button onClick={async () => { await window.mail.settings.set({ prefs: s.prefs }); const r = await window.mail.app.compactDb(); toast(`Compacted${r.pruned ? `, cleared ${r.pruned} old bodies` : ''}`); window.mail.app.dbInfo().then(setDbInfo); }}>Compact now</button></div></div>
            <div className="frow"><label>Data folder</label><small style={{ gridColumn: 2 }}>{info?.userData} · secrets {info?.encrypted ? 'encrypted with the OS keychain' : 'stored unencrypted (no keychain available)'} · v{info?.version}</small></div>
            <div className="frow"><label>Something wrong?</label><div><textarea rows={2} style={{ width: '100%' }} placeholder="What happened? (a GitHub issue opens in your browser with the app version and recent log attached, email addresses redacted)" value={problem} onChange={e => setProblem(e.target.value)} />
              <div style={{ display: 'flex', gap: 6, marginTop: 4 }}><button className="primary" onClick={() => window.mail.app.reportProblem(problem)}><Icon name="external" size={12} /> Report a problem</button><button onClick={() => window.mail.app.openLogs()}>Open log folder</button></div></div></div>
          </>}
          {tab === 'accounts' && <>
            {accounts.map((a, i) => (
              <div className="acct" key={a.id} style={{ flexWrap: 'wrap' }}>
                <span className="em">{a.email}</span>
                <span className="muted" style={{ fontSize: 11, border: '1px solid var(--border)', borderRadius: 3, padding: '0 4px' }}>{a.kind === 'imap' ? 'IMAP' : 'Google'}</span>
                <span className="muted">{a.initial_done ? `${(a.synced_count || 0).toLocaleString()} messages` : `syncing ${(a.synced_count || 0).toLocaleString()}${a.total_estimate ? ' / ' + a.total_estimate.toLocaleString() : ''}`}</span>
                {a.last_error && <span style={{ color: '#c0392b' }} title={a.last_error}>⚠ {a.last_error.slice(0, 60)}</span>}
                <span className="spacer" />
                {/Token refresh failed|invalid_grant|sign in again|auth|login/i.test(a.last_error || '') && (a.kind === 'imap' ? <button className="primary" onClick={() => setShowImap(true)}>Re-enter password</button> : <button className="primary" onClick={() => addGoogle(false)} disabled={busy}>Sign in again</button>)}
                <button title="Move up" disabled={i === 0} onClick={async () => { const ids = accounts.map(x => x.id); ids.splice(i, 1); ids.splice(i - 1, 0, a.id); await window.mail.accounts.reorder(ids); refreshAccounts(); }}>▲</button>
                <button title="Move down" disabled={i === accounts.length - 1} onClick={async () => { const ids = accounts.map(x => x.id); ids.splice(i, 1); ids.splice(i + 1, 0, a.id); await window.mail.accounts.reorder(ids); refreshAccounts(); }}>▼</button>
                <button onClick={() => setSigEdit(sigEdit === a.id ? null : a.id)}>Signature</button>
                <button onClick={async () => { const n = prompt('Display name (used in From):', a.display_name || ''); if (n != null) { await window.mail.accounts.rename(a.id, n); refreshAccounts(); } }}>Rename</button>
                {a.kind !== 'imap' && <button title={contacts?.accounts?.[a.id]?.granted ? `Contacts imported ${contacts.accounts[a.id].importedAt ? new Date(contacts.accounts[a.id].importedAt).toLocaleString('en-GB') : 'never'} — refreshes daily` : 'Import your Google address book for To/Cc suggestions (asks Google for read-only contacts access)'} onClick={() => importContacts(a)} disabled={importing === a.id}>{importing === a.id ? 'Importing…' : contacts?.accounts?.[a.id]?.granted ? 'Refresh contacts' : 'Import Google Contacts'}</button>}
                {a.kind !== 'imap' && !a.canDeleteForever && <button title="Re-sign-in granting full Gmail access so Tomail can empty Trash / delete permanently" onClick={() => addGoogle(true)} disabled={busy}>Grant full access</button>}
                <button onClick={async () => { if (confirm(`Re-download the whole mailbox for ${a.email}? Cached bodies are dropped.`)) { await window.mail.accounts.resync(a.id); refreshAccounts(); } }}>Resync</button>
                <button onClick={async () => { if (confirm(`Remove ${a.email} from this PC? (Nothing is deleted on the server.)`)) { await window.mail.accounts.remove(a.id); refreshAccounts(); } }}>Remove</button>
                {sigEdit === a.id && <div style={{ width: '100%', marginTop: 6 }}><textarea rows={3} style={{ width: '100%' }} defaultValue={a.signature || ''} placeholder="Signature for this account (blank = default signature)" onBlur={async e => { await window.mail.accounts.setSignature(a.id, e.target.value); refreshAccounts(); toast('Signature saved'); }} /></div>}
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '12px 0' }}>
              <button className="primary" onClick={() => addGoogle(false)} disabled={busy}>{busy ? 'Waiting for Google sign-in in your browser…' : 'Sign in with Google'}</button>
              <button onClick={() => setShowImap(v => !v)}>{showImap ? 'Cancel' : 'Add other account (IMAP)'}</button>
            </div>
            {showImap && <ImapForm toast={toast} onDone={() => { setShowImap(false); refreshAccounts(); }} />}
            {contacts && <p className="muted">Address book: {contacts.total.toLocaleString()} people ({contacts.google.toLocaleString()} from Google Contacts, the rest learned from your mail). Importing needs the <b>People API</b> enabled in the same Google Cloud project as the Gmail API.</p>}
            <p className="muted">Google accounts sign in through your browser; Tomail never sees the password. Other providers (Outlook, Yahoo, iCloud, Fastmail, your own domain…) connect over IMAP/SMTP, usually with an app password. "All Inboxes" merges every account.</p>
          </>}
          {tab === 'rules' && <RulesTab accounts={accounts} labels={labels} toast={toast} seed={ruleSeed} />}
          {tab === 'google' && <>
            <p><b>Use your own Google API client (optional).</b> Tomail releases ship with a built-in Google sign-in{info?.hasGoogleClient ? ' (present in this build)' : ' — but this build has none, so you need your own'}. You only need this if you build Tomail yourself or prefer your own Google Cloud project:</p>
            <ol>
              <li>Open <a href="#" onClick={e => { e.preventDefault(); window.mail.shell.openExternal('https://console.cloud.google.com/apis/library/gmail.googleapis.com'); }}>Google Cloud Console → Gmail API</a>, create a project and click <b>Enable</b>.</li>
              <li><b>APIs &amp; Services → OAuth consent screen</b>: User type <b>Internal</b> if you're on Google Workspace (no verification needed), otherwise External + add yourself as a test user. Save.</li>
              <li><b>Credentials → Create credentials → OAuth client ID</b>, application type <b>Desktop app</b>. Copy the client ID and client secret below.</li>
            </ol>
            <div className="frow"><label>Client ID</label><input type="text" value={s.oauth.clientId} onChange={e => setS({ ...s, oauth: { ...s.oauth, clientId: e.target.value } })} placeholder="…apps.googleusercontent.com" /></div>
            <div className="frow"><label>Client secret</label><input type="password" value={s.oauth.clientSecret} onChange={e => setS({ ...s, oauth: { ...s.oauth, clientSecret: e.target.value } })} /></div>
            <div className="frow"><label></label><div><button className="primary" onClick={() => save({ oauth: s.oauth })}>Save</button> <button onClick={() => save({ oauth: { clientId: '', clientSecret: '' } })}>Use built-in</button></div></div>
            <p className="muted">Default scope: <code>gmail.modify</code> (read, label, archive, trash, send). "Grant full access" on an account adds <code>https://mail.google.com/</code> so Tomail can empty Trash / delete permanently.</p>
          </>}
        </div>
      </div>
    </div>
  );
}
