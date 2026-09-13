import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Sidebar from './components/Sidebar.jsx';
import MessageList, { viewTitle } from './components/MessageList.jsx';
import ReadingPane from './components/ReadingPane.jsx';
import Compose from './components/Compose.jsx';
import SettingsModal from './components/SettingsModal.jsx';
import { Dropdown, MI, MarkMenu, QuickActionsMenu, SnoozeMenu } from './components/Menus.jsx';
import { ago, keyOf, sameView } from './util.js';
import Icon from './components/Icons.jsx';

const PAGE = 100;
const mail = window.mail;

export default function App() {
  const [info, setInfo] = useState(null);
  const [prefs, setPrefs] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [labels, setLabels] = useState({});         // accountId → labels[]
  const [counts, setCounts] = useState(null);
  const [status, setStatus] = useState({ accounts: {}, lastCheckedAt: null });
  const [view, setViewRaw] = useState({ kind: 'all-inboxes', category: 'primary' });
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(null);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [selected, setSelected] = useState([]);       // [{accountId,id}]
  const [anchor, setAnchor] = useState(null);
  const [message, setMessage] = useState(null);       // opened full message
  const [msgLoading, setMsgLoading] = useState(false);
  const [msgError, setMsgError] = useState(null);
  const [search, setSearch] = useState('');
  const [compose, setCompose] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [toastMsg, setToastMsg] = useState(null);
  const [listH, setListH] = useState(() => Number(localStorage.getItem('listH')) || 440);
  const [, tick] = useState(0);
  const viewRef = useRef(view); viewRef.current = view;
  const itemsRef = useRef(items); itemsRef.current = items;
  const markTimer = useRef(null);

  const toast = useCallback((m, err) => { setToastMsg({ m, err }); setTimeout(() => setToastMsg(t => (t?.m === m ? null : t)), err ? 6000 : 2500); }, []);
  const labelsById = useMemo(() => { const o = {}; for (const [aid, ls] of Object.entries(labels)) o[aid] = Object.fromEntries(ls.map(l => [l.id, l])); return o; }, [labels]);
  const setView = useCallback((v) => { setViewRaw(v); setSelected([]); setAnchor(null); setMessage(null); setMsgError(null); }, []);

  // ── loaders ──
  const loadMeta = useCallback(async () => {
    const [accs, c, st] = await Promise.all([mail.accounts.list(), mail.messages.counts(), mail.sync.status()]);
    setAccounts(accs); setCounts(c); setStatus(st);
    const ls = {}; await Promise.all(accs.map(async a => { ls[a.id] = await mail.labels.list(a.id); })); setLabels(ls);
  }, []);
  const loadList = useCallback(async (v, { append = false } = {}) => {
    setLoading(true);
    try {
      const offset = append ? itemsRef.current.length : 0;
      const [rows, n] = await Promise.all([mail.messages.list(v, { offset, limit: PAGE }), append ? Promise.resolve(null) : mail.messages.count(v)]);
      if (!sameView(viewRef.current, v)) return;
      setItems(append ? [...itemsRef.current, ...rows] : rows);
      if (n != null) setTotal(n);
      setHasMore(rows.length === PAGE);
    } catch (e) { toast(e.message, true); }
    finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { mail.app.info().then(setInfo); mail.settings.get().then(s => setPrefs(s.prefs)); loadMeta(); }, [loadMeta]);
  useEffect(() => { loadList(view); }, [view, loadList]);
  useEffect(() => {
    const off1 = mail.on('mail:changed', () => { loadMeta(); loadList(viewRef.current); });
    const off2 = mail.on('sync:status', (s) => setStatus(s));
    const t = setInterval(() => tick(x => x + 1), 30000);
    return () => { off1(); off2(); clearInterval(t); };
  }, [loadMeta, loadList]);
  useEffect(() => { if (!settingsOpen) mail.settings.get().then(s => setPrefs(s.prefs)); }, [settingsOpen]);

  // ── open message ──
  const openMessage = useCallback(async (m) => {
    if (!m) { setMessage(null); return; }
    setMsgError(null); setMsgLoading(true);
    setMessage({ ...m, bodyFetched: false });
    try {
      const full = await mail.messages.get(m.accountId, m.id);
      setMessage(cur => (cur && cur.id === m.id ? full : cur));
      clearTimeout(markTimer.current);
      if (full?.unread) markTimer.current = setTimeout(() => mail.actions.markRead([{ accountId: m.accountId, id: m.id }], true).catch(() => {}), prefs?.markReadDelayMs ?? 1500);
    } catch (e) { setMsgError(e.message); }
    finally { setMsgLoading(false); }
  }, [prefs]);
  useEffect(() => {
    if (selected.length === 1) { const s = selected[0]; if (message?.id !== s.id || message?.accountId !== s.accountId) openMessage(itemsRef.current.find(i => i.id === s.id && i.accountId === s.accountId) || s); }
    else if (selected.length === 0) setMessage(null);
  }, [selected]); // eslint-disable-line

  // ── selection ──
  const onSelect = useCallback((m, e) => {
    const idx = itemsRef.current.findIndex(i => i.id === m.id && i.accountId === m.accountId);
    if (e.shiftKey && anchor != null) {
      const [a, b] = [Math.min(anchor, idx), Math.max(anchor, idx)];
      setSelected(itemsRef.current.slice(a, b + 1).map(x => ({ accountId: x.accountId, id: x.id })));
    } else if (e.ctrlKey || e.metaKey) {
      setSelected(sel => sel.some(s => keyOf(s) === keyOf(m)) ? sel.filter(s => keyOf(s) !== keyOf(m)) : [...sel, { accountId: m.accountId, id: m.id }]);
      setAnchor(idx);
    } else { setSelected([{ accountId: m.accountId, id: m.id }]); setAnchor(idx); }
  }, [anchor]);
  const selectIndex = (i) => { const m = itemsRef.current[i]; if (m) { setSelected([{ accountId: m.accountId, id: m.id }]); setAnchor(i); } };
  const curIndex = () => { const s = selected[selected.length - 1]; return s ? itemsRef.current.findIndex(i => i.id === s.id && i.accountId === s.accountId) : -1; };

  // ── actions ──
  const targets = selected;
  const act = async (fn, okMsg) => {
    try {
      // After a removing action, move selection to the next row
      const i = curIndex();
      await fn();
      if (okMsg) toast(okMsg);
      if (okMsg && i >= 0) { const next = itemsRef.current.filter(x => !selected.some(s => keyOf(s) === keyOf(x)))[Math.min(i, itemsRef.current.length - selected.length - 1)]; setSelected(next ? [{ accountId: next.accountId, id: next.id }] : []); }
    } catch (e) { toast(e.message, true); }
  };
  const doArchive = () => act(() => mail.actions.archive(targets), `Archived ${targets.length}`);
  const doTrash = () => act(() => (view.labelId === 'TRASH' ? Promise.reject(new Error('Already in Trash — empty it from Gmail')) : mail.actions.trash(targets)), `Deleted ${targets.length}`);
  const doMark = (what) => act(() => ({ read: () => mail.actions.markRead(targets, true), unread: () => mail.actions.markRead(targets, false), flag: () => mail.actions.star(targets, true), unflag: () => mail.actions.star(targets, false), spam: () => mail.actions.spam(targets, true), notspam: () => mail.actions.spam(targets, false) })[what]());
  const doSnooze = (until) => act(() => mail.actions.snooze(targets, until), `Snoozed until ${new Date(until).toLocaleString('en-GB')}`);
  const doMove = (labelId) => act(() => mail.actions.move(targets, labelId, view.kind === 'label' ? view.labelId : (view.kind === 'all-inboxes' ? 'INBOX' : null)), 'Moved');
  const openCompose = (mode) => {
    if (mode === 'new') { setCompose({ mode, accountId: view.accountId || accounts[0]?.id }); return; }
    if (!message || !message.bodyFetched) { toast('Open a message first', true); return; }
    setCompose({ mode, accountId: message.accountId, original: message });
  };
  const runSearch = (deep) => {
    const q = search.trim();
    if (!q) { setView({ kind: 'all-inboxes', category: 'primary' }); return; }
    if (!deep) { setView({ kind: 'search', q }); return; }
    setLoading(true);
    mail.messages.deepSearch(q, null).then(ids => setView({ kind: 'ids', ids, q })).catch(e => toast(e.message, true)).finally(() => setLoading(false));
  };
  const onKey = (e) => {
    if (compose || settingsOpen) return;
    const i = curIndex();
    const k = e.key;
    if (k === 'ArrowDown') { e.preventDefault(); selectIndex(Math.min(itemsRef.current.length - 1, i + 1)); }
    else if (k === 'ArrowUp') { e.preventDefault(); selectIndex(Math.max(0, i - 1)); }
    else if (k === 'Delete' || k === 'Backspace') { if (targets.length) { e.preventDefault(); doTrash(); } }
    else if (k === 'e') { if (targets.length) doArchive(); }
    else if (k === 'u') { if (targets.length) doMark(message?.unread || itemsRef.current[i]?.unread ? 'read' : 'unread'); }
    else if (k === 's') { if (targets.length) doMark(itemsRef.current[i]?.starred ? 'unflag' : 'flag'); }
    else if (k === 'r') openCompose('reply');
    else if (k === 'a') openCompose('replyAll');
    else if (k === 'f') openCompose('forward');
    else if (k === 'n') openCompose('new');
    else if (k === 'Escape') setSelected([]);
  };

  // ── divider drag ──
  const startDrag = (e) => {
    const y0 = e.clientY, h0 = listH;
    const mv = (ev) => setListH(Math.max(120, h0 + ev.clientY - y0));
    const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); localStorage.setItem('listH', String(listH)); };
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  };

  const anyBusy = Object.values(status.accounts || {}).some(s => s?.phase === 'initial' || s?.phase === 'incremental');
  const anyErr = Object.values(status.accounts || {}).find(s => s?.phase === 'error');
  const initial = Object.entries(status.accounts || {}).find(([, s]) => s?.phase === 'initial');
  const showCategories = view.kind === 'all-inboxes' || (view.kind === 'label' && view.labelId === 'INBOX');
  const hasSel = targets.length > 0;
  const canReply = !!message && message.bodyFetched;

  return (
    <div className="app">
      <div className="topbar">
        <button className="burger" onClick={() => setSidebarOpen(o => !o)} title="Toggle folder list"><Icon name="menu" size={18} /></button>
        <div className="search">
          <div className="wrap">
            <input type="text" placeholder="Search  (Enter = local · Deep search = inside attachments)" value={search} onChange={e => setSearch(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') runSearch(false); if (e.key === 'Escape') { setSearch(''); if (view.kind === 'search' || view.kind === 'ids') setView({ kind: 'all-inboxes', category: 'primary' }); } }} />
            {search && <button className="clear" onClick={() => { setSearch(''); if (view.kind === 'search' || view.kind === 'ids') setView({ kind: 'all-inboxes', category: 'primary' }); }}>✕</button>}
          </div>
          <button onClick={() => runSearch(true)} disabled={!search.trim()} title="Search on Gmail — bodies and attachment contents"><Icon name="search" /> Deep search</button>
        </div>
      </div>
      <div className="toolbar">
        {accounts.length > 1
          ? <Dropdown className="newdd" btnClass="new-btn" label={<><Icon name="plus" /> New</>}>{accounts.map(a => <MI key={a.id} onClick={() => setCompose({ mode: 'new', accountId: a.id })}><Icon name="mail" /> from {a.email}</MI>)}</Dropdown>
          : <button className="new-btn" onClick={() => openCompose('new')} disabled={!accounts.length}><Icon name="plus" /> New</button>}
        <button onClick={() => { mail.sync.now(); toast('Checking for new mail…'); }} disabled={!accounts.length || info?.demo}><span className="ico"><Icon name="refresh" /></span>Refresh</button>
        <span className="spacer" />
        <button disabled={!canReply} onClick={() => openCompose('reply')}><span className="ico"><Icon name="reply" /></span>Reply</button>
        <button disabled={!canReply} onClick={() => openCompose('replyAll')}><span className="ico"><Icon name="replyAll" /></span>Reply All</button>
        <button disabled={!canReply} onClick={() => openCompose('forward')}><span className="ico"><Icon name="forward" /></span>Forward</button>
        <span className="sep" />
        <MarkMenu disabled={!hasSel} onMark={doMark} />
        <span className="sep" />
        <button disabled={!hasSel} onClick={doArchive}><span className="ico"><Icon name="archive" /></span>Archive</button>
        <SnoozeMenu disabled={!hasSel} onSnooze={doSnooze} />
        <QuickActionsMenu disabled={!hasSel} labels={labels[targets[0]?.accountId] || []} onMove={doMove}
          canUnsnooze={view.kind === 'snoozed'} onUnsnooze={() => act(() => mail.actions.unsnooze(targets), 'Back in inbox')}
          onNewLabel={(n) => mail.labels.create(targets[0]?.accountId || accounts[0]?.id, n).then(() => toast('Folder created')).catch(e => toast(e.message, true))} />
        <span className="sep" />
        <button disabled={!hasSel} onClick={doTrash}><span className="ico"><Icon name="trash" /></span>Delete</button>
      </div>
      <div className={'body' + (sidebarOpen ? '' : ' nosidebar')}>
        {sidebarOpen && <Sidebar accounts={accounts} labels={labels} counts={counts} view={view} setView={setView} status={status} />}
        <div className="main">
          {!accounts.length && info && !info.demo ? (
            <div className="onboard">
              <h2>Welcome to Mail</h2>
              <p>Connect a Google Workspace account to get started. Mail keeps a local copy of your mailbox for instant search and works with Gmail labels, so anything you do here shows up in Gmail too.</p>
              <div className="steps"><ol>
                <li>Open <b>Settings → Google API</b> and paste the OAuth client ID + secret (instructions there).</li>
                <li><b>Settings → Accounts → Add Google account</b> and sign in.</li>
                <li>Initial sync runs in the background; the newest mail appears first.</li>
              </ol></div>
              <p><button className="primary" onClick={() => setSettingsOpen(true)}>Open Settings</button></p>
            </div>
          ) : (
            <div className="split">
              <div className="list-wrap" style={{ height: listH }}>
                <MessageList items={items} total={total} loading={loading} view={view} setView={setViewRaw} selected={selected} onSelect={onSelect}
                  onOpen={(m) => { setSelected([{ accountId: m.accountId, id: m.id }]); }} onLoadMore={() => loadList(view, { append: true })} hasMore={hasMore}
                  accounts={accounts} labelsById={labelsById} showCategories={showCategories} onKey={onKey} />
              </div>
              <div className="divider" onMouseDown={startDrag} />
              <div className="read-wrap">
                <ReadingPane message={message} loading={msgLoading} prefs={prefs} error={msgError} />
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="status">
        <span><span className={'led' + (anyErr ? ' err' : anyBusy ? ' busy' : '')} />
          {anyErr ? `Sync problem: ${anyErr.error}` : initial ? `Downloading mailbox… ${(initial[1].synced || 0).toLocaleString()}${initial[1].total ? ' of ' + initial[1].total.toLocaleString() : ''}` : anyBusy ? 'Checking for new mail…' : `Last checked ${ago(status.lastCheckedAt)}`}</span>
        {info?.demo && <span style={{ color: '#c0392b' }}>DEMO MODE — sample data, not connected to Google</span>}
        <span className="spacer" />
        <button onClick={() => setSettingsOpen(true)}><Icon name="settings" size={12} /> Settings</button>
        <button onClick={() => { mail.sync.now(); }} disabled={!accounts.length || info?.demo}><Icon name="refresh" size={12} /> Sync now</button>
      </div>
      {compose && <Compose draft={compose} accounts={accounts} prefs={prefs} onClose={() => setCompose(null)} toast={toast} />}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} accounts={accounts} refreshAccounts={loadMeta} toast={toast} info={info} />}
      {toastMsg && <div className={'toast' + (toastMsg.err ? ' err' : '')}>{toastMsg.m}</div>}
    </div>
  );
}
