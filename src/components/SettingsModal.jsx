import React, { useEffect, useState } from 'react';
import Icon from './Icons.jsx';
import RulesTab from './RulesTab.jsx';

/** "Sales <sales@x.com>" or a bare address, one per line. */
function parseAliases(text) {
  return String(text || '').split(/[\n,;]+/).map(line => {
    const t = line.trim(); if (!t) return null;
    const m = /^"?([^"<]*?)"?\s*<([^>]+)>$/.exec(t);
    return m ? { name: m[1].trim(), email: m[2].trim() } : { name: '', email: t };
  }).filter(Boolean);
}
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
  const [aliasEdit, setAliasEdit] = useState(null);
  const [dbInfo, setDbInfo] = useState(null);
  const [contacts, setContacts] = useState(null);
  const [snips, setSnips] = useState([]); const [snipEdit, setSnipEdit] = useState(null);
  const [lock, setLock] = useState(null); const [lp, setLp] = useState({ cur: '', a: '', b: '' });
  const [ach, setAch] = useState(null); const [exporting, setExporting] = useState(null);
  const [aiSt, setAiSt] = useState(null); const [rec, setRec] = useState([]); const [pull, setPull] = useState(null);
  const aiCfg = { enabled: false, kind: 'ollama', endpoint: 'http://localhost:11434', model: 'llama3.2:3b', apiKey: '', styleLearning: true, ...(s?.prefs?.ai || {}) };
  const setAi = (patch) => setS({ ...s, prefs: { ...s.prefs, ai: { ...aiCfg, ...patch } } });
  const refreshAi = () => window.mail.ai.status().then(setAiSt).catch(() => {});
  useEffect(() => { refreshAi(); window.mail.ai.recommended().then(setRec).catch(() => {}); return window.mail.on('ai:pull-progress', setPull); }, []);
  const pullModel = async (m) => { setPull({ status: 'starting' }); try { await window.mail.settings.set({ prefs: { ai: aiCfg } }); await window.mail.ai.pull(m); toast(`Downloaded ${m}`); setAi({ model: m }); await window.mail.settings.set({ prefs: { ai: { ...aiCfg, model: m } } }); refreshAi(); } catch (e) { toast(e.message, true); } finally { setPull(null); } };
  useEffect(() => { window.mail.snippets.list().then(setSnips).catch(() => {}); window.mail.lock.status().then(setLock).catch(() => {}); window.mail.achievements.list().then(setAch).catch(() => {}); return window.mail.on('export:progress', ({ n }) => setExporting(n)); }, []);
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
            {[['general', 'General'], ['accounts', 'Accounts'], ['rules', 'Rules'], ['snippets', 'Snippets'], ['ai', '✨ AI'], ['security', 'Security & data'], ['google', 'Advanced']].map(([id, n]) => <button key={id} className={'tab' + (tab === id ? ' active' : '')} onClick={() => setTab(id)}>{n}</button>)}
          </div>
          {tab === 'general' && <>
            <div className="frow"><label>Appearance</label><div style={{ display: 'flex', gap: 4 }}>{[['system', 'System'], ['light', 'Light'], ['dark', 'Dark']].map(([v, n]) => <button key={v} className={s.prefs.theme === v || (!s.prefs.theme && v === 'system') ? 'primary' : ''} onClick={() => { pref('theme', v); window.mail.settings.set({ prefs: { theme: v } }); document.documentElement.dataset.theme = v === 'system' ? '' : v; document.documentElement.classList.toggle('dark', v === 'dark' || (v === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)); }}>{v === 'light' ? <Icon name="sun" size={12} /> : v === 'dark' ? <Icon name="moon" size={12} /> : null} {n}</button>)}</div></div>
            <div className="frow"><label>Check for new mail every</label><div><input type="number" min="15" style={{ width: 80 }} value={s.prefs.syncIntervalSec} onChange={e => pref('syncIntervalSec', Number(e.target.value))} /> seconds in the background, <input type="number" min="10" style={{ width: 70 }} value={s.prefs.fastPollSec ?? 20} onChange={e => pref('fastPollSec', Number(e.target.value))} /> while Tomail is the active window</div></div>
            <div className="frow"><label></label><small>IMAP accounts are also pushed to instantly by the server (IMAP IDLE).</small></div>
            <div className="frow"><label>Notifications</label><label><input type="checkbox" checked={s.prefs.notifications !== false} onChange={e => pref('notifications', e.target.checked)} /> <Icon name="bell" size={12} /> show a system notification for new inbox mail</label></div>
            <div className="frow"><label></label><label><input type="checkbox" checked={s.prefs.notifyWhenFocused !== false} onChange={e => pref('notifyWhenFocused', e.target.checked)} /> even while Tomail is the active window</label></div>
            <div className="frow"><label>Keep running</label><label title="Tomail sits in the system tray so new mail still reaches you"><input type="checkbox" checked={s.prefs.tray !== false} onChange={e => { pref('tray', e.target.checked); window.mail.settings.set({ prefs: { tray: e.target.checked } }); }} /> show a tray icon</label></div>
            <div className="frow"><label></label><label style={{ opacity: s.prefs.tray === false ? 0.5 : 1 }}><input type="checkbox" disabled={s.prefs.tray === false} checked={s.prefs.closeToTray !== false} onChange={e => { pref('closeToTray', e.target.checked); window.mail.settings.set({ prefs: { closeToTray: e.target.checked } }); }} /> closing the window leaves Tomail in the tray instead of quitting</label></div>
            <div className="frow"><label></label><label><input type="checkbox" checked={!!s.prefs.startAtLogin} onChange={e => { pref('startAtLogin', e.target.checked); window.mail.settings.set({ prefs: { startAtLogin: e.target.checked } }); }} /> start Tomail when I log in (hidden, in the tray)</label></div>
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
                <button title="Other addresses you can send from on this account" onClick={() => setAliasEdit(aliasEdit === a.id ? null : a.id)}>Aliases{a.aliases?.length ? ` (${a.aliases.length})` : ''}</button>
                <button onClick={async () => { const n = prompt('Display name (used in From):', a.display_name || ''); if (n != null) { await window.mail.accounts.rename(a.id, n); refreshAccounts(); } }}>Rename</button>
                {a.kind !== 'imap' && <button title={contacts?.accounts?.[a.id]?.granted ? `Contacts imported ${contacts.accounts[a.id].importedAt ? new Date(contacts.accounts[a.id].importedAt).toLocaleString('en-GB') : 'never'} — refreshes daily` : 'Import your Google address book for To/Cc suggestions (asks Google for read-only contacts access)'} onClick={() => importContacts(a)} disabled={importing === a.id}>{importing === a.id ? 'Importing…' : contacts?.accounts?.[a.id]?.granted ? 'Refresh contacts' : 'Import Google Contacts'}</button>}
                {a.kind !== 'imap' && !a.canDeleteForever && <button title="Re-sign-in granting full Gmail access so Tomail can empty Trash / delete permanently" onClick={() => addGoogle(true)} disabled={busy}>Grant full access</button>}
                <button onClick={async () => { if (confirm(`Re-download the whole mailbox for ${a.email}? Cached bodies are dropped.`)) { await window.mail.accounts.resync(a.id); refreshAccounts(); } }}>Resync</button>
                <button onClick={async () => { if (confirm(`Remove ${a.email} from this PC? (Nothing is deleted on the server.)`)) { await window.mail.accounts.remove(a.id); refreshAccounts(); } }}>Remove</button>
                {sigEdit === a.id && <div style={{ width: '100%', marginTop: 6 }}><textarea rows={3} style={{ width: '100%' }} defaultValue={a.signature || ''} placeholder="Signature for this account (blank = default signature)" onBlur={async e => { await window.mail.accounts.setSignature(a.id, e.target.value); refreshAccounts(); toast('Signature saved'); }} /></div>}
                {aliasEdit === a.id && <div style={{ width: '100%', marginTop: 6 }}>
                  <textarea rows={3} style={{ width: '100%' }} defaultValue={(a.aliases || []).map(x => x.name ? `${x.name} <${x.email}>` : x.email).join('\n')}
                    placeholder={'One address per line, e.g.\nSales <sales@example.com>\nbilling@example.com'}
                    onBlur={async e => { try { await window.mail.accounts.setAliases(a.id, parseAliases(e.target.value)); refreshAccounts(); toast('Aliases saved'); } catch (err) { toast(err.message, true); } }} />
                  <small className="muted">They appear in the From menu when you write. The address must already be set up with your provider ({a.kind === 'imap' ? 'your server has to let you send as it' : 'Gmail → Settings → Accounts → Send mail as'}), or the message goes out as {a.email}.</small>
                </div>}
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
          {tab === 'ai' && <div>
            <p>Summaries, reply suggestions, drafting in your own tone, rewriting and rules-from-a-sentence, all running <b>on this computer</b>. Nothing is sent to Tomail or anyone else. It uses <a href="#" onClick={e => { e.preventDefault(); window.mail.shell.openExternal('https://ollama.com/download'); }}>Ollama</a>, a free app that runs language models locally; install it, then pick a model below.</p>
            <div className="frow"><label>Enable AI features</label><label><input type="checkbox" checked={!!aiCfg.enabled} onChange={e => { setAi({ enabled: e.target.checked }); window.mail.settings.set({ prefs: { ai: { ...aiCfg, enabled: e.target.checked } } }); }} /> show ✨ buttons in messages, compose and rules</label></div>
            <div className="frow"><label>Status</label><div>{aiSt ? (aiSt.reachable ? <span style={{ color: '#1f7a33' }}>✓ Connected · {aiSt.models.length} model{aiSt.models.length === 1 ? '' : 's'} available</span> : <span style={{ color: '#c0392b' }}>✗ Not reachable at {aiCfg.endpoint} ({aiSt.error}). Is Ollama installed and running?</span>) : '…'} <button onClick={refreshAi}>Check</button></div></div>
            {aiSt?.reachable && <div className="frow"><label>Model</label><div><select value={aiCfg.model} onChange={e => { setAi({ model: e.target.value }); window.mail.settings.set({ prefs: { ai: { ...aiCfg, model: e.target.value } } }); }}>{!aiSt.models.some(m => m.name === aiCfg.model) && <option value={aiCfg.model}>{aiCfg.model} (not downloaded)</option>}{aiSt.models.map(m => <option key={m.name} value={m.name}>{m.name}{m.size ? ` · ${(m.size / 1e9).toFixed(1)} GB` : ''}</option>)}</select></div></div>}
            {aiSt?.reachable && aiCfg.kind === 'ollama' && <div className="frow"><label>Download a model</label><div>
              {rec.map(r => <div key={r.model} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}><b style={{ minWidth: 110 }}>{r.model}</b><span className="muted" style={{ flex: 1 }}>{r.size} — {r.note}</span>{aiSt.models.some(m => m.name === r.model) ? <span style={{ color: '#1f7a33' }}>✓ installed</span> : <button disabled={!!pull} onClick={() => pullModel(r.model)}>Download</button>}</div>)}
              {pull && <div className="muted">{pull.status}{pull.total ? ` · ${Math.round((pull.completed || 0) / pull.total * 100)}%` : ''}</div>}
            </div></div>}
            <div className="frow"><label>Learn my tone</label><label><input type="checkbox" checked={aiCfg.styleLearning !== false} onChange={e => { setAi({ styleLearning: e.target.checked }); window.mail.settings.set({ prefs: { ai: { ...aiCfg, styleLearning: e.target.checked } } }); }} /> show the model a few of your recent sent messages when drafting, so replies sound like you</label></div>
            <details style={{ marginTop: 8 }}><summary className="muted">Advanced: other local servers</summary>
              <div className="frow"><label>Server type</label><select value={aiCfg.kind} onChange={e => setAi({ kind: e.target.value })}><option value="ollama">Ollama</option><option value="openai">OpenAI-compatible (LM Studio, llama.cpp, Jan…)</option></select></div>
              <div className="frow"><label>Endpoint</label><input type="text" value={aiCfg.endpoint} onChange={e => setAi({ endpoint: e.target.value })} /></div>
              {aiCfg.kind === 'openai' && <><div className="frow"><label>Model name</label><input type="text" value={aiCfg.model} onChange={e => setAi({ model: e.target.value })} /></div><div className="frow"><label>API key</label><input type="password" value={aiCfg.apiKey} onChange={e => setAi({ apiKey: e.target.value })} placeholder="usually blank for local servers" /></div></>}
              <div className="frow"><label></label><button className="primary" onClick={async () => { await window.mail.settings.set({ prefs: { ai: aiCfg } }); toast('AI settings saved'); refreshAi(); }}>Save</button></div>
              <p className="muted">Pointing the endpoint at a cloud service would send your mail there. Tomail is built for local use.</p>
            </details>
          </div>}
          {tab === 'snippets' && <div>
            <p className="muted">Reusable text for the editor. Type <code>;trigger</code> then space in a message to expand it, or use the Snippets button in the toolbar. Placeholders: <code>{'{{firstName}}'}</code> (first recipient), <code>{'{{date}}'}</code>, <code>{'{{subject}}'}</code>, <code>{'{{me}}'}</code>.</p>
            {snips.map(s => <div className="snip-row" key={s.id}><code>;{s.trigger}</code><span>{s.name}</span><span className="muted" style={{ whiteSpace: 'pre-wrap', maxHeight: 60, overflow: 'hidden' }}>{s.bodyHtml.replace(/<[^>]+>/g, ' ').slice(0, 160)}</span><span><button onClick={() => setSnipEdit({ ...s })}>Edit</button> <button onClick={() => window.mail.snippets.remove(s.id).then(() => window.mail.snippets.list().then(setSnips))}>Delete</button></span></div>)}
            {snipEdit ? <div className="rule" style={{ borderColor: 'var(--accent)' }}>
              <div className="frow"><label>Trigger</label><div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>;<input type="text" value={snipEdit.trigger} onChange={e => setSnipEdit({ ...snipEdit, trigger: e.target.value.replace(/\s/g, '') })} placeholder="thanks" /></div></div>
              <div className="frow"><label>Name</label><input type="text" value={snipEdit.name} onChange={e => setSnipEdit({ ...snipEdit, name: e.target.value })} /></div>
              <div className="frow"><label>Text</label><textarea rows={5} value={snipEdit.bodyHtml} onChange={e => setSnipEdit({ ...snipEdit, bodyHtml: e.target.value })} placeholder="Hi {{firstName}},&#10;&#10;Thanks for getting in touch…" /></div>
              <div className="frow"><label></label><div><button className="primary" onClick={async () => { try { await window.mail.snippets.save({ ...snipEdit, bodyHtml: /<[a-z]/i.test(snipEdit.bodyHtml) ? snipEdit.bodyHtml : snipEdit.bodyHtml.replace(/\n/g, '<br>') }); setSnipEdit(null); setSnips(await window.mail.snippets.list()); toast('Snippet saved'); } catch (e) { toast(e.message, true); } }}>Save</button> <button onClick={() => setSnipEdit(null)}>Cancel</button></div></div>
            </div> : <button className="primary" onClick={() => setSnipEdit({ trigger: '', name: '', bodyHtml: '' })}><Icon name="plus" size={12} /> New snippet</button>}
          </div>}
          {tab === 'security' && <div>
            <h3 style={{ marginTop: 0 }}>App lock</h3>
            <p className="muted">Require a passphrase to open Tomail and after it has been idle. This locks the window, not the database file: for the file itself use your operating system's disk encryption (BitLocker, FileVault, LUKS).</p>
            {lock && <>
              <div className="frow"><label>Status</label><span>{lock.enabled ? 'Enabled' : 'Off'}</span></div>
              {lock.enabled && <div className="frow"><label>Current passphrase</label><input type="password" value={lp.cur} onChange={e => setLp({ ...lp, cur: e.target.value })} /></div>}
              <div className="frow"><label>{lock.enabled ? 'New passphrase' : 'Passphrase'}</label><input type="password" value={lp.a} onChange={e => setLp({ ...lp, a: e.target.value })} placeholder={lock.enabled ? 'leave blank to turn off' : ''} /></div>
              <div className="frow"><label>Repeat</label><input type="password" value={lp.b} onChange={e => setLp({ ...lp, b: e.target.value })} /></div>
              <div className="frow"><label>Lock after idle</label><div><input type="number" min="0" style={{ width: 70 }} value={s.prefs.lockIdleMinutes ?? 10} onChange={e => pref('lockIdleMinutes', Number(e.target.value))} /> minutes (0 = only at startup)</div></div>
              <div className="frow"><label></label><button className="primary" onClick={async () => { if (lp.a !== lp.b) { toast('Passphrases differ', true); return; } try { await window.mail.lock.set(lp.a, lp.cur); await window.mail.settings.set({ prefs: { lockIdleMinutes: s.prefs.lockIdleMinutes ?? 10 } }); setLock(await window.mail.lock.status()); setLp({ cur: '', a: '', b: '' }); toast(lp.a ? 'App lock enabled' : 'App lock turned off'); } catch (e) { toast(e.message, true); } }}>{lock.enabled ? (lp.a ? 'Change passphrase' : 'Turn off') : 'Enable'}</button></div>
            </>}
            <h3>Links</h3>
            <div className="frow"><label>Clean links</label><label><input type="checkbox" checked={s.prefs.cleanLinks !== false} onChange={e => { pref('cleanLinks', e.target.checked); window.mail.settings.set({ prefs: { cleanLinks: e.target.checked } }); }} /> strip tracking parameters (utm_, fbclid, gclid…) and unwrap redirectors before opening links in your browser</label></div>
            <h3>Export</h3>
            <p className="muted">Save an account's mail as a standard <code>.mbox</code> file (readable by Thunderbird and most tools). Messages whose body hasn't been downloaded are exported with headers and preview only.</p>
            {accounts.map(a => <div className="frow" key={a.id}><label>{a.email}</label><button disabled={exporting != null} onClick={async () => { setExporting(0); try { const r = await window.mail.exportMbox(a.id); if (r) toast(`Exported ${r.messages.toLocaleString()} messages (${r.withBody.toLocaleString()} with bodies) to ${r.file}`); } catch (e) { toast(e.message, true); } finally { setExporting(null); } }}>{exporting != null ? `Exporting… ${exporting.toLocaleString()}` : 'Export as .mbox'}</button></div>)}
            <h3>Achievements</h3>
            <div className="frow"><label>Show achievements</label><label><input type="checkbox" checked={s.prefs.achievements !== false} onChange={e => { pref('achievements', e.target.checked); window.mail.settings.set({ prefs: { achievements: e.target.checked } }); }} /> little toasts for milestones (inbox zero, 100 archived…)</label></div>
            {ach && <div className="ach">{ach.all.map(a => <div key={a.id} className={ach.unlocked[a.id] ? '' : 'locked'}><b>{ach.unlocked[a.id] ? '🏆 ' : '🔒 '}{a.title}</b><small>{a.body}{ach.unlocked[a.id] ? ` · ${new Date(ach.unlocked[a.id]).toLocaleDateString('en-GB')}` : ''}</small></div>)}</div>}
          </div>}
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
