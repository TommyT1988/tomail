import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Sidebar from './components/Sidebar.jsx';
import MessageList from './components/MessageList.jsx';
import ReadingPane from './components/ReadingPane.jsx';
import Compose from './components/Compose.jsx';
import SettingsModal from './components/SettingsModal.jsx';
import { Dropdown, MI, MarkMenu, QuickActionsMenu, SnoozeMenu, FilterMenu } from './components/Menus.jsx';
import { ago, gmailQuery, keyOf, sameView } from './util.js';
import Icon from './components/Icons.jsx';

const PAGE = 100;
const mail = window.mail;
const HOME = { kind: 'all-inboxes', category: 'primary' };

function drawBadge(n) {
  const c = document.createElement('canvas'); c.width = c.height = 32;
  const x = c.getContext('2d'); x.fillStyle = '#e03e2d'; x.beginPath(); x.arc(16, 16, 15, 0, Math.PI * 2); x.fill();
  x.fillStyle = '#fff'; x.font = `bold ${n > 99 ? 14 : 18}px sans-serif`; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(n > 99 ? '99+' : String(n), 16, 17);
  return c.toDataURL();
}

export default function App() {
  const [info, setInfo] = useState(null);
  const [prefs, setPrefs] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [labels, setLabels] = useState({});
  const [counts, setCounts] = useState(null);
  const [drafts, setDrafts] = useState({ local: [], remote: [] });
  const [status, setStatus] = useState({ accounts: {}, lastCheckedAt: null });
  const [view, setViewRaw] = useState(HOME);
  const [threaded, setThreadedRaw] = useState(() => localStorage.getItem('threaded') === '1');
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(null);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [selected, setSelected] = useState([]);
  const [anchor, setAnchor] = useState(null);
  const [message, setMessage] = useState(null);
  const [thread, setThread] = useState(null);
  const [msgLoading, setMsgLoading] = useState(false);
  const [msgError, setMsgError] = useState(null);
  const [search, setSearch] = useState('');
  const [compose, setCompose] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [ruleSeed, setRuleSeed] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [toastMsg, setToastMsg] = useState(null);
  const [signingIn, setSigningIn] = useState(false);
  const [updateReady, setUpdateReady] = useState(null);
  const [listH, setListH] = useState(() => Number(localStorage.getItem('listH')) || 440);
  const [, tick] = useState(0);
  const viewRef = useRef(view); viewRef.current = view;
  const itemsRef = useRef(items); itemsRef.current = items;
  const threadedRef = useRef(threaded); threadedRef.current = threaded;
  const markTimer = useRef(null);
  const draftsRef = useRef(drafts); draftsRef.current = drafts;

  const toast = useCallback((m, err) => { setToastMsg({ m, err }); setTimeout(() => setToastMsg(t => (t?.m === m ? null : t)), err ? 6000 : 2500); }, []);
  const labelsById = useMemo(() => { const o = {}; for (const [aid, ls] of Object.entries(labels)) o[aid] = Object.fromEntries(ls.map(l => [l.id, l])); return o; }, [labels]);
  const setView = useCallback((v) => { setViewRaw(v); setSelected([]); setAnchor(null); setMessage(null); setThread(null); setMsgError(null); }, []);
  const setThreaded = (v) => { setThreadedRaw(v); localStorage.setItem('threaded', v ? '1' : '0'); setSelected([]); setMessage(null); setThread(null); };
  const applyTheme = (t) => { document.documentElement.dataset.theme = !t || t === 'system' ? '' : t; };

  // ── loaders ──
  const loadMeta = useCallback(async () => {
    const [accs, c, st, d] = await Promise.all([mail.accounts.list(), mail.messages.counts(), mail.sync.status(), mail.drafts.list()]);
    setAccounts(accs); setCounts(c); setStatus(st); setDrafts(d);
    const ls = {}; await Promise.all(accs.map(async a => { ls[a.id] = await mail.labels.list(a.id); })); setLabels(ls);
    const unread = c?.favourites?.inboxUnread || 0;
    mail.app.setBadge(unread, unread > 0 ? drawBadge(unread) : null).catch(() => {});
  }, []);
  const draftItems = useCallback((v, d) => {
    const local = d.local.filter(x => !v.accountId || x.accountId === v.accountId).map(x => ({ accountId: x.accountId, id: 'draft:' + x.id, draftId: x.id, isDraft: true, subject: x.subject, toText: x.to, snippet: x.bodyText?.slice(0, 120), date: x.updatedAt, size: (x.bodyHtml || '').length, labels: [], to: [], unread: false, starred: false }));
    const remote = d.remote.filter(x => !v.accountId || x.accountId === v.accountId).map(x => ({ ...x, isDraft: true, remoteDraft: true, toText: (x.to || []).map(a => a.email).join(', '), unread: false }));
    return [...local, ...remote].sort((a, b) => b.date - a.date);
  }, []);
  const loadList = useCallback(async (v, { append = false } = {}) => {
    if (v.kind === 'drafts') { const d = await mail.drafts.list(); setDrafts(d); const it = draftItems(v, d); setItems(it); setTotal(it.length); setHasMore(false); return; }
    setLoading(true);
    try {
      const offset = append ? itemsRef.current.length : 0;
      const q = { ...v, threaded: threadedRef.current && !['drafts', 'snoozed'].includes(v.kind) };
      const [rows, n] = await Promise.all([mail.messages.list(q, { offset, limit: PAGE }), append ? Promise.resolve(null) : mail.messages.count(q)]);
      if (!sameView(viewRef.current, v)) return;
      setItems(append ? [...itemsRef.current, ...rows] : rows);
      if (n != null) setTotal(n);
      setHasMore(rows.length === PAGE);
    } catch (e) { toast(e.message, true); }
    finally { setLoading(false); }
  }, [toast, draftItems]);

  useEffect(() => { mail.app.info().then(setInfo); mail.settings.get().then(s => { setPrefs(s.prefs); applyTheme(s.prefs.theme); if (s.prefs.threaded && localStorage.getItem('threaded') == null) setThreadedRaw(true); }); loadMeta(); }, [loadMeta]);
  useEffect(() => { loadList(view); }, [view, threaded, loadList]);
  useEffect(() => {
    const off1 = mail.on('mail:changed', () => { loadMeta(); loadList(viewRef.current); });
    const off2 = mail.on('sync:status', (s) => setStatus(s));
    const off3 = mail.on('app:update-ready', (u) => setUpdateReady(u));
    const off4 = mail.on('app:open-message', ({ accountId, id }) => { setView(HOME); setTimeout(() => setSelected([{ accountId, id }]), 300); });
    const mq = window.matchMedia('(prefers-color-scheme: dark)'); const onMq = () => tick(x => x + 1); mq.addEventListener('change', onMq);
    const t = setInterval(() => tick(x => x + 1), 30000);
    return () => { off1(); off2(); off3(); off4(); clearInterval(t); mq.removeEventListener('change', onMq); };
  }, [loadMeta, loadList, setView]);
  useEffect(() => { if (!settingsOpen) mail.settings.get().then(s => { setPrefs(s.prefs); applyTheme(s.prefs.theme); }); }, [settingsOpen]);

  // ── open message / thread ──
  const openMessage = useCallback(async (m) => {
    if (!m) { setMessage(null); setThread(null); return; }
    if (m.isDraft) { setMessage(null); setThread(null); return; }
    setMsgError(null); setMsgLoading(true);
    setMessage({ ...m, bodyFetched: false }); setThread(null);
    try {
      const inTrash = ['TRASH', 'SPAM'].includes(viewRef.current.labelId);
      const [full, th] = await Promise.all([mail.messages.get(m.accountId, m.id), threadedRef.current && m.threadId ? mail.messages.thread(m.accountId, m.threadId, { includeTrash: inTrash }) : Promise.resolve(null)]);
      setMessage(cur => (cur && cur.id === m.id ? full : cur));
      if (th && th.length > 1) setThread(th);
      clearTimeout(markTimer.current);
      const toMark = th && th.length > 1 ? th.filter(x => x.unread).map(x => ({ accountId: x.accountId, id: x.id })) : (full?.unread ? [{ accountId: m.accountId, id: m.id }] : []);
      if (toMark.length) markTimer.current = setTimeout(() => mail.actions.markRead(toMark, true).catch(() => {}), prefs?.markReadDelayMs ?? 1500);
    } catch (e) { setMsgError(e.message); }
    finally { setMsgLoading(false); }
  }, [prefs]);
  useEffect(() => {
    if (selected.length === 1) { const s = selected[0]; if (message?.id !== s.id || message?.accountId !== s.accountId) openMessage(itemsRef.current.find(i => i.id === s.id && i.accountId === s.accountId) || s); }
    else if (selected.length === 0) { setMessage(null); setThread(null); }
  }, [selected]); // eslint-disable-line

  // ── selection ──
  const onSelect = useCallback((m, e) => {
    const idx = itemsRef.current.findIndex(i => i.id === m.id && i.accountId === m.accountId);
    if (e.shiftKey && anchor != null) { const [a, b] = [Math.min(anchor, idx), Math.max(anchor, idx)]; setSelected(itemsRef.current.slice(a, b + 1).map(x => ({ accountId: x.accountId, id: x.id }))); }
    else if (e.ctrlKey || e.metaKey) { setSelected(sel => sel.some(s => keyOf(s) === keyOf(m)) ? sel.filter(s => keyOf(s) !== keyOf(m)) : [...sel, { accountId: m.accountId, id: m.id }]); setAnchor(idx); }
    else { setSelected([{ accountId: m.accountId, id: m.id }]); setAnchor(idx); }
  }, [anchor]);
  const selectIndex = (i) => { const m = itemsRef.current[i]; if (m) { setSelected([{ accountId: m.accountId, id: m.id }]); setAnchor(i); } };
  const curIndex = () => { const s = selected[selected.length - 1]; return s ? itemsRef.current.findIndex(i => i.id === s.id && i.accountId === s.accountId) : -1; };
  const openItem = async (m) => {
    if (!m?.isDraft) return;
    if (m.remoteDraft) { try { const d = await mail.drafts.openRemote(m.accountId, m.id); setCompose({ mode: 'new', accountId: m.accountId, draftId: d.id }); } catch (e) { toast(e.message, true); } }
    else setCompose({ mode: 'new', accountId: m.accountId, draftId: m.draftId });
  };

  // ── actions ──
  /** Selected rows expanded to every message they stand for (a conversation row acts on its whole thread). */
  const expandTargets = async () => {
    if (!threaded) return selected;
    const out = [];
    for (const s of selected) { const it = itemsRef.current.find(i => i.id === s.id && i.accountId === s.accountId); if (it?.threadCount > 1) { const th = await mail.messages.thread(s.accountId, it.threadId, { includeTrash: ['TRASH', 'SPAM'].includes(view.labelId) }); out.push(...th.map(x => ({ accountId: x.accountId, id: x.id }))); } else out.push(s); }
    return out;
  };
  const act = async (fn, okMsg) => {
    try {
      const i = curIndex();
      const targets = await expandTargets();
      await fn(targets);
      if (okMsg) toast(okMsg.replace('%n', String(targets.length)));
      if (okMsg && i >= 0) { const rest = itemsRef.current.filter(x => !selected.some(s => keyOf(s) === keyOf(x))); const next = rest[Math.min(i, rest.length - 1)]; setSelected(next ? [{ accountId: next.accountId, id: next.id }] : []); }
    } catch (e) { toast(e.message, true); }
  };
  const inTrash = view.kind === 'label' && ['TRASH', 'SPAM'].includes(view.labelId);
  const selAccount = accounts.find(a => a.id === selected[0]?.accountId) || accounts.find(a => a.id === view.accountId);
  const doArchive = () => act((t) => mail.actions.archive(t), 'Archived %n');
  const doTrash = () => inTrash ? doDeleteForever() : act((t) => mail.actions.trash(t), 'Deleted %n');
  const doDeleteForever = () => { if (!confirm(`Permanently delete ${selected.length} message(s)? This cannot be undone.`)) return; act((t) => mail.actions.deleteForever(t), 'Deleted forever: %n'); };
  const doRestore = () => act((t) => mail.actions.untrash(t), 'Restored %n to Inbox');
  const doEmpty = async () => { const name = view.labelId === 'SPAM' ? 'Junk' : 'Trash'; if (!confirm(`Permanently delete everything in ${name} for ${selAccount?.email}?`)) return; try { const n = await mail.actions.emptyFolder(view.accountId, view.labelId); toast(`${name} emptied (${n})`); } catch (e) { toast(e.message, true); } };
  const doMark = (what) => act((t) => ({ read: () => mail.actions.markRead(t, true), unread: () => mail.actions.markRead(t, false), flag: () => mail.actions.star(t, true), unflag: () => mail.actions.star(t, false), spam: () => mail.actions.spam(t, true), notspam: () => mail.actions.spam(t, false) })[what]());
  const doSnooze = (until) => act((t) => mail.actions.snooze(t, until), `Snoozed until ${new Date(until).toLocaleString('en-GB')}`);
  const doMove = (labelId) => act((t) => mail.actions.move(t, labelId, view.kind === 'label' ? view.labelId : (view.kind === 'all-inboxes' ? 'INBOX' : null)), 'Moved %n');
  const openCompose = (mode, m = message) => {
    if (mode === 'new') { setCompose({ mode, accountId: view.accountId || selAccount?.id || accounts[0]?.id }); return; }
    if (!m || !m.bodyFetched) { toast('Open a message first', true); return; }
    setCompose({ mode, accountId: m.accountId, original: m });
  };
  const runSearch = (deep) => {
    const q = search.trim();
    const filters = view.filters;
    if (!q && !deep) { setView({ ...HOME, filters }); return; }
    if (!deep) { setView({ kind: 'search', q, filters }); return; }
    setLoading(true);
    mail.messages.deepSearch(gmailQuery(q, filters), filters?.accountId || null).then(ids => setView({ kind: 'ids', ids, q })).catch(e => toast(e.message, true)).finally(() => setLoading(false));
  };
  const onKey = (e) => {
    if (compose || settingsOpen) return;
    const i = curIndex(); const k = e.key; const cur = itemsRef.current[i];
    if (k === 'ArrowDown') { e.preventDefault(); selectIndex(Math.min(itemsRef.current.length - 1, i + 1)); }
    else if (k === 'ArrowUp') { e.preventDefault(); selectIndex(Math.max(0, i - 1)); }
    else if (k === 'Enter') { if (cur?.isDraft) openItem(cur); }
    else if (k === 'Delete' || k === 'Backspace') { if (cur?.isDraft) { mail.drafts.remove(cur.draftId).then(() => loadList(view)); return; } if (selected.length) { e.preventDefault(); doTrash(); } }
    else if (k === 'e') { if (selected.length) doArchive(); }
    else if (k === 'u') { if (selected.length) doMark(cur?.unread || cur?.threadUnread ? 'read' : 'unread'); }
    else if (k === 's') { if (selected.length) doMark(cur?.starred ? 'unflag' : 'flag'); }
    else if (k === 'r') openCompose('reply'); else if (k === 'a') openCompose('replyAll'); else if (k === 'f') openCompose('forward'); else if (k === 'n') openCompose('new');
    else if (k === 'p') { if (message) mail.messages.print(message.accountId, message.id); }
    else if (k === 'Escape') setSelected([]);
  };
  const startDrag = (e) => {
    const y0 = e.clientY, h0 = listH;
    const mv = (ev) => setListH(Math.max(120, h0 + ev.clientY - y0));
    const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); localStorage.setItem('listH', String(listH)); };
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  };
  const setFilters = (f) => { const clean = Object.fromEntries(Object.entries(f || {}).filter(([, v]) => v !== undefined && v !== '' && v !== false)); setView({ ...view, filters: Object.keys(clean).length ? clean : undefined }); };
  const filterChips = Object.entries(view.filters || {}).map(([k, v]) => [k, k === 'accountId' ? accounts.find(a => a.id === v)?.email : k === 'labelId' ? (labelsById[view.accountId]?.[v]?.name || Object.values(labelsById).map(m => m[v]?.name).find(Boolean) || v) : /after|before/.test(k) ? new Date(Number(v)).toLocaleDateString('en-GB') : v === true ? '' : v]);

  const anyBusy = Object.values(status.accounts || {}).some(s => s?.phase === 'initial' || s?.phase === 'incremental');
  const anyErr = Object.values(status.accounts || {}).find(s => s?.phase === 'error');
  const initial = Object.entries(status.accounts || {}).find(([, s]) => s?.phase === 'initial');
  const viewAcct = accounts.find(a => a.id === view.accountId);
  const showCategories = view.kind === 'all-inboxes' ? accounts.some(a => a.kind !== 'imap') : (view.kind === 'label' && view.labelId === 'INBOX' && viewAcct?.kind !== 'imap');
  const hasSel = selected.length > 0;
  const canReply = !!message && message.bodyFetched;
  const draftCounts = useMemo(() => { const o = { all: drafts.local.length + drafts.remote.length }; for (const d of [...drafts.local, ...drafts.remote]) o[d.accountId] = (o[d.accountId] || 0) + 1; return o; }, [drafts]);
  const selLabels = labels[selected[0]?.accountId || view.accountId] || [];

  return (
    <div className="app">
      <div className="topbar">
        <button className="burger" onClick={() => setSidebarOpen(o => !o)} title="Toggle folder list"><Icon name="menu" size={18} /></button>
        <div className="search">
          <div className="wrap">
            <input type="text" placeholder="Search  (Enter = local · Deep search = on the server, inside attachments)" value={search} onChange={e => setSearch(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') runSearch(false); if (e.key === 'Escape') { setSearch(''); if (view.kind === 'search' || view.kind === 'ids') setView(HOME); } }} />
            {search && <button className="clear" onClick={() => { setSearch(''); if (view.kind === 'search' || view.kind === 'ids') setView(HOME); }}>✕</button>}
          </div>
          <button onClick={() => runSearch(true)} disabled={!search.trim() && !view.filters} title="Search on the mail server — bodies and attachment contents"><Icon name="search" /> Deep search</button>
          <FilterMenu filters={view.filters} setFilters={setFilters} accounts={accounts} labels={Object.values(labels).flat()} />
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
        <MarkMenu disabled={!hasSel} onMark={doMark} inSpam={view.labelId === 'SPAM'} />
        <span className="sep" />
        {inTrash ? <button disabled={!hasSel} onClick={doRestore}><span className="ico"><Icon name="inbox" /></span>Restore</button>
          : <button disabled={!hasSel} onClick={doArchive}><span className="ico"><Icon name="archive" /></span>Archive</button>}
        <SnoozeMenu disabled={!hasSel || inTrash} onSnooze={doSnooze} />
        <QuickActionsMenu disabled={!hasSel} labels={selLabels} onMove={doMove} inTrash={inTrash} onRestore={doRestore} onEmpty={doEmpty} onDeleteForever={doDeleteForever}
          canDeleteForever={!!(selAccount?.canDeleteForever)} folderName={view.labelId === 'SPAM' ? 'Junk' : 'Trash'}
          canUnsnooze={view.kind === 'snoozed'} onUnsnooze={() => act((t) => mail.actions.unsnooze(t), 'Back in inbox')}
          onRuleFromSender={() => { const m = itemsRef.current.find(i => i.id === selected[0]?.id && i.accountId === selected[0]?.accountId); if (!m) return; setRuleSeed({ accountId: m.accountId, name: `From ${m.fromName || m.fromEmail}`, conditions: [{ field: 'from', op: 'contains', value: m.fromEmail }], actions: [{ type: 'moveTo', labelId: '' }] }); setSettingsOpen('rules'); }}
          onNewLabel={(n) => mail.labels.create(selected[0]?.accountId || view.accountId || accounts[0]?.id, n).then(() => toast('Folder created')).catch(e => toast(e.message, true))} />
        <span className="sep" />
        <button disabled={!hasSel} onClick={doTrash} title={inTrash ? 'Delete permanently' : 'Move to Trash'}><span className="ico"><Icon name="trash" /></span>{inTrash ? 'Delete forever' : 'Delete'}</button>
      </div>
      <div className={'body' + (sidebarOpen ? '' : ' nosidebar')}>
        {sidebarOpen && <Sidebar accounts={accounts} labels={labels} counts={counts} view={view} setView={setView} status={status} draftCounts={draftCounts} />}
        <div className="main">
          {!accounts.length && info && !info.demo ? (
            <div className="onboard">
              <h2>Welcome to Tomail</h2>
              <p>A fast desktop client for Gmail, Google Workspace and any IMAP mailbox. Tomail keeps a local copy of your mail for instant search and works with your provider's folders and labels, so anything you do here shows up everywhere else too.</p>
              <p style={{ display: 'flex', gap: 8 }}>
                {info.hasGoogleClient && <button className="primary" disabled={signingIn} onClick={async () => { setSigningIn(true); try { const r = await mail.accounts.add({}); toast(`Signed in as ${r.account.email} — downloading mailbox`); loadMeta(); } catch (e) { toast(e.message, true); } finally { setSigningIn(false); } }}>{signingIn ? 'Waiting for Google sign-in in your browser…' : 'Sign in with Google'}</button>}
                <button onClick={() => setSettingsOpen('accounts')}>Add another provider (IMAP)</button>
              </p>
              {!info.hasGoogleClient && <div className="steps"><p>This build has no built-in Google sign-in. Add your own Google API client under <b>Settings → Advanced</b>, or add an IMAP account.</p></div>}
              <p className="muted">Google accounts sign in through your browser. Tomail asks for Gmail read/label/send access only and never deletes mail permanently unless you grant that separately.</p>
            </div>
          ) : (
            <div className="split">
              <div className="list-wrap" style={{ height: listH }}>
                {filterChips.length > 0 && <div className="chips"><Icon name="settings" size={12} /> {filterChips.map(([k, v]) => <span className="chip" key={k}>{k}{v ? `: ${v}` : ''}<button onClick={() => setFilters({ ...view.filters, [k]: undefined })}>✕</button></span>)}<button style={{ fontSize: 11 }} onClick={() => setFilters({})}>clear</button></div>}
                <MessageList items={items} total={total} loading={loading} view={view} setView={setViewRaw} selected={selected} onSelect={onSelect}
                  onOpen={(m) => { setSelected([{ accountId: m.accountId, id: m.id }]); openItem(m); }} onLoadMore={() => loadList(view, { append: true })} hasMore={hasMore}
                  accounts={accounts} labelsById={labelsById} showCategories={showCategories} onKey={onKey} threaded={threaded} setThreaded={setThreaded} />
              </div>
              <div className="divider" onMouseDown={startDrag} />
              <div className="read-wrap">
                {view.kind === 'drafts' && selected.length === 1 ? <div className="read"><div className="empty"><div className="big"><Icon name="edit" size={56} style={{ strokeWidth: 1 }} /></div><div><button className="primary" onClick={() => openItem(itemsRef.current.find(i => i.id === selected[0].id))}>Open draft</button> <button onClick={() => { const it = itemsRef.current.find(i => i.id === selected[0].id); if (it?.draftId) mail.drafts.remove(it.draftId).then(() => loadList(view)); else if (it?.remoteDraft) mail.actions.trash([{ accountId: it.accountId, id: it.id }]); }}>Delete</button></div></div></div>
                  : <ReadingPane message={message} thread={thread} loading={msgLoading} prefs={prefs} error={msgError}
                    onRespond={async (m, p) => { try { await mail.actions.respondInvite(m.accountId, m.id, p); toast('Reply sent to the organiser'); const full = await mail.messages.get(m.accountId, m.id); setMessage(cur => cur?.id === m.id ? full : cur); } catch (e) { toast(e.message, true); } }}
                    onPrint={(m) => mail.messages.print(m.accountId, m.id).catch(e => toast(e.message, true))} onReplyTo={(m, mode) => openCompose(mode, m)} />}
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="status">
        <span><span className={'led' + (anyErr ? ' err' : anyBusy ? ' busy' : '')} />
          {anyErr ? `Sync problem: ${anyErr.error}` : initial ? `Downloading mailbox… ${(initial[1].synced || 0).toLocaleString()}${initial[1].total ? ' of ' + initial[1].total.toLocaleString() : ''}${initial[1].folder ? ' · ' + initial[1].folder : ''}` : anyBusy ? 'Checking for new mail…' : `Last checked ${ago(status.lastCheckedAt)}`}</span>
        {info?.demo && <span style={{ color: '#c0392b' }}>DEMO MODE — sample data, not connected to any server</span>}
        {updateReady && <span>Tomail {updateReady.version} downloaded — <button className="primary" onClick={() => mail.app.installUpdate()}>Restart to update</button></span>}
        <span className="spacer" />
        <button onClick={() => setSettingsOpen(true)}><Icon name="settings" size={12} /> Settings</button>
        <button onClick={() => { mail.sync.now(); }} disabled={!accounts.length || info?.demo}><Icon name="refresh" size={12} /> Sync now</button>
      </div>
      {compose && <Compose key={compose.draftId || compose.original?.id || 'new'} draft={compose} accounts={accounts} prefs={prefs} onClose={() => { setCompose(null); loadMeta(); if (viewRef.current.kind === 'drafts') loadList(viewRef.current); }} toast={toast} />}
      {settingsOpen && <SettingsModal onClose={() => { setSettingsOpen(false); setRuleSeed(null); }} accounts={accounts} labels={labels} ruleSeed={ruleSeed} refreshAccounts={loadMeta} toast={toast} info={info} initialTab={typeof settingsOpen === 'string' ? settingsOpen : undefined} />}
      {toastMsg && <div className={'toast' + (toastMsg.err ? ' err' : '')}>{toastMsg.m}</div>}
    </div>
  );
}
