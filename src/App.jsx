import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Sidebar from './components/Sidebar.jsx';
import MessageList from './components/MessageList.jsx';
import ReadingPane from './components/ReadingPane.jsx';
import SettingsModal from './components/SettingsModal.jsx';
import { Dropdown, MI, MarkMenu, QuickActionsMenu, SnoozeMenu, FilterMenu } from './components/Menus.jsx';
import { ago, gmailQuery, keyOf, sameView, isDateAsc, mergePage, parseSearch, followUpPresets, sendLaterPresets } from './util.js';
import Icon from './components/Icons.jsx';

const PAGE = 100;
/** Newest-first vs oldest-first is a standing preference, not a per-folder one — it survives folder clicks and restarts. */
const savedDateSort = () => (localStorage.getItem('dateSort') === 'asc' ? { col: 'date', dir: 'asc' } : undefined);
const withSavedSort = (v) => (v && v.sort === undefined ? { ...v, sort: savedDateSort() } : v);
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
  const [view, setViewRaw] = useState(() => withSavedSort(HOME));
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [ruleSeed, setRuleSeed] = useState(null);
  const [sideW, setSideW] = useState(() => { const raw = localStorage.getItem('sideW'); const n = Number(raw); return raw != null && Number.isFinite(n) && n >= 0 ? n : 222; });   // Number(null) is 0, so check the key itself
  const [toastMsg, setToastMsg] = useState(null);
  const [sendState, setSendState] = useState(null);
  const [outbox, setOutbox] = useState([]);
  const [followups, setFollowups] = useState([]);
  const [scheduled, setScheduled] = useState([]);
  const [tabs, setTabs] = useState(() => { try { return JSON.parse(localStorage.getItem('tabs') || 'null') || [{ id: 1, view: HOME }]; } catch { return [{ id: 1, view: HOME }]; } });
  const [activeTab, setActiveTab] = useState(() => Number(localStorage.getItem('activeTab')) || 1);
  const [locked, setLocked] = useState(false);
  const [lockInfo, setLockInfo] = useState(null);
  const [quickReplyFocus, setQuickReplyFocus] = useState(false);
  const lastActivity = useRef(Date.now());
  const [labelMenu, setLabelMenu] = useState(null);
  const [shortcuts, setShortcuts] = useState(false);
  const undoRef = useRef(null);
  const [signingIn, setSigningIn] = useState(false);
  const [updateReady, setUpdateReady] = useState(null);
  const [checking, setChecking] = useState(false);
  const [listH, setListH] = useState(() => Number(localStorage.getItem('listH')) || 440);
  const [, tick] = useState(0);
  const viewRef = useRef(view); viewRef.current = view;
  const itemsRef = useRef(items); itemsRef.current = items;
  const messageRef = useRef(message); messageRef.current = message;
  const threadedRef = useRef(threaded); threadedRef.current = threaded;
  const markTimer = useRef(null);
  const draftsRef = useRef(drafts); draftsRef.current = drafts;

  const toast = useCallback((m, err, undo) => { setToastMsg({ m, err, undo }); setTimeout(() => setToastMsg(t => (t?.m === m ? null : t)), err ? 6000 : undo ? 8000 : 2500); }, []);
  const labelsById = useMemo(() => { const o = {}; for (const [aid, ls] of Object.entries(labels)) o[aid] = Object.fromEntries(ls.map(l => [l.id, l])); return o; }, [labels]);
  const setView = useCallback((v) => { setViewRaw(withSavedSort(v)); setSelected([]); setAnchor(null); setMessage(null); setThread(null); setMsgError(null); setQuickReplyFocus(false); }, []);
  useEffect(() => { setTabs(ts => ts.map(t => t.id === activeTab && t.kind !== 'message' ? { ...t, view } : t)); }, [view, activeTab]);
  useEffect(() => { try { localStorage.setItem('tabs', JSON.stringify(tabs.map(t => ({ id: t.id, view: t.view, kind: t.kind, msg: t.msg, title: t.title })))); localStorage.setItem('activeTab', String(activeTab)); } catch {} }, [tabs, activeTab]);
  const openTab = (v, opts = {}) => { const id = Date.now(); setTabs(ts => [...ts, { id, view: v, ...opts }]); setActiveTab(id); if (opts.kind !== 'message') setView(v); };
  const switchTab = (t) => { setActiveTab(t.id); if (t.kind === 'message') { setViewRaw(t.view); setSelected([{ accountId: t.msg.accountId, id: t.msg.id }]); } else setView(t.view); };
  const closeTab = (id) => { setTabs(ts => { const rest = ts.filter(t => t.id !== id); if (!rest.length) rest.push({ id: 1, view: HOME }); if (id === activeTab) { const nt = rest[rest.length - 1]; setTimeout(() => switchTab(nt), 0); } return rest; }); };
  const tabTitle = (t) => t.kind === 'message' ? (t.title || 'Message') : viewTitleFor(t.view);
  const viewTitleFor = (v) => ({ 'all-inboxes': 'Inbox', unread: 'Unread', starred: 'Flagged', snoozed: 'Snoozed', drafts: 'Drafts', outbox: 'Outbox', followups: 'Follow-ups', scheduled: 'Scheduled', all: 'All Mail', search: `Search: ${v.q}`, ids: `Deep: ${v.q}` })[v.kind] || (v.kind === 'label' ? ({ INBOX: 'Inbox', SENT: 'Sent', TRASH: 'Trash', SPAM: 'Junk', ARCHIVE: 'Archive' })[v.labelId] || labelsById[v.accountId]?.[v.labelId]?.name || v.labelId : 'Mail');
  const setThreaded = (v) => { setThreadedRaw(v); localStorage.setItem('threaded', v ? '1' : '0'); setSelected([]); setMessage(null); setThread(null); };
  const applyTheme = (t) => {
    const root = document.documentElement;
    root.dataset.theme = !t || t === 'system' ? '' : t;
    const dark = t === 'dark' || ((!t || t === 'system') && window.matchMedia('(prefers-color-scheme: dark)').matches);
    root.classList.toggle('dark', dark);
  };

  // ── loaders ──
  const loadMeta = useCallback(async () => {
    const [accs, c, st, d, ob, fu, sc] = await Promise.all([mail.accounts.list(), mail.messages.counts(), mail.sync.status(), mail.drafts.list(), mail.outbox.list(), mail.followups.list(), mail.scheduled.list()]);
    setAccounts(accs); setCounts(c); setStatus(st); setDrafts(d); setOutbox(ob); setFollowups(fu); setScheduled(sc);
    const ls = {}; await Promise.all(accs.map(async a => { ls[a.id] = await mail.labels.list(a.id); })); setLabels(ls);
    const unread = c?.favourites?.inboxUnread || 0;
    mail.app.setBadge(unread, unread > 0 ? drawBadge(unread) : null).catch(() => {});
  }, []);
  const draftItems = useCallback((v, d) => {
    const local = d.local.filter(x => !v.accountId || x.accountId === v.accountId).map(x => ({ accountId: x.accountId, id: 'draft:' + x.id, draftId: x.id, isDraft: true, subject: x.subject, toText: x.to, snippet: x.bodyText?.slice(0, 120), date: x.updatedAt, size: (x.bodyHtml || '').length, labels: [], to: [], unread: false, starred: false }));
    const remote = d.remote.filter(x => !v.accountId || x.accountId === v.accountId).map(x => ({ ...x, isDraft: true, remoteDraft: true, toText: (x.to || []).map(a => a.email).join(', '), unread: false }));
    return [...local, ...remote].sort((a, b) => b.date - a.date);
  }, []);
  const loadList = useCallback(async (v, { append = false, keep = false } = {}) => {
    if (v.kind === 'drafts') { const d = await mail.drafts.list(); setDrafts(d); const it = draftItems(v, d); setItems(it); setTotal(it.length); setHasMore(false); return; }
    if (v.kind === 'scheduled') { const sc = await mail.scheduled.list(); setScheduled(sc); const it = sc.map(s => ({ accountId: s.accountId, id: 'sc:' + s.id, sched: s, isScheduled: true, subject: s.subject, toText: s.to, fromName: 'Scheduled', fromEmail: '', snippet: `sends ${new Date(s.sendAt).toLocaleString('en-GB')}`, date: s.sendAt, size: 0, labels: [], to: [], unread: false, starred: false })); setItems(it); setTotal(it.length); setHasMore(false); return; }
    if (v.kind === 'followups') { const fu = await mail.followups.list(); setFollowups(fu); const it = fu.map(f => ({ accountId: f.accountId, id: 'fu:' + f.id, followup: f, isFollowup: true, subject: f.subject, toText: f.to, fromName: f.status === 'due' ? 'No reply yet' : 'Waiting for reply', fromEmail: '', snippet: `sent ${new Date(f.createdAt).toLocaleDateString('en-GB')} · reminder ${new Date(f.dueAt).toLocaleDateString('en-GB')}`, date: f.dueAt, size: 0, labels: [], to: [], unread: f.status === 'due', starred: false })); setItems(it); setTotal(it.length); setHasMore(false); return; }
    if (v.kind === 'outbox') { const ob = await mail.outbox.list(); setOutbox(ob); const it = ob.map(o => ({ accountId: o.accountId, id: 'outbox:' + o.id, outboxId: o.id, isOutbox: true, subject: o.subject, toText: o.to, snippet: o.lastError || '', fromName: 'Outbox', fromEmail: '', date: o.createdAt, size: 0, labels: [], to: [], unread: false, starred: false })); setItems(it); setTotal(it.length); setHasMore(false); return; }
    setLoading(true);
    try {
      const offset = append ? itemsRef.current.length : 0;
      // keep: reload everything currently shown (rounded up to a page) so a background refresh doesn't snap a scrolled list back to the top
      const limit = keep ? Math.max(PAGE, Math.ceil(itemsRef.current.length / PAGE) * PAGE) : PAGE;
      // Oldest-first still PAGES FROM THE NEWEST END: ask for newest-first, show the page reversed, put older
      // pages ABOVE. Paging from the oldest end put today thousands of rows below page 1.
      const asc = isDateAsc(v);
      const q = { ...v, sort: asc ? { col: 'date', dir: 'desc' } : v.sort, threaded: threadedRef.current && !['drafts', 'snoozed'].includes(v.kind) };
      // The page and the "N messages" total are asked for together but NOT waited for together:
      // counting a folder takes ~100ms on a big mailbox and the list itself takes ~1ms.
      if (!append) {
        setTotal(null);
        mail.messages.count(q).then(n => { if (sameView(viewRef.current, v)) setTotal(n); }).catch(() => {});
      }
      const rows = await mail.messages.list(q, { offset, limit });
      if (!sameView(viewRef.current, v)) return;
      setItems(mergePage(itemsRef.current, rows, { asc, append }));
      setHasMore(rows.length === limit);
    } catch (e) { toast(e.message, true); }
    finally { setLoading(false); }
  }, [toast, draftItems]);

  useEffect(() => { mail.app.info().then(i => { setInfo(i); document.title = `Tomail ${i.version}${i.demo ? ' (demo)' : ''}`; }); mail.settings.get().then(s => { setPrefs(s.prefs); applyTheme(s.prefs.theme); if (s.prefs.threaded && localStorage.getItem('threaded') == null) setThreadedRaw(true); }); loadMeta(); }, [loadMeta]);
  useEffect(() => { loadList(view); }, [view, threaded, loadList]);
  useEffect(() => {
    const off1 = mail.on('mail:changed', () => { loadMeta(); loadList(viewRef.current, { keep: true }); });
    // a message whose inline images arrived after it was shown: refresh it in place if it's still open
    const off8 = mail.on('message:updated', ({ accountId, id }) => {
      if (messageRef.current?.id !== id || messageRef.current?.accountId !== accountId) return;
      mail.messages.get(accountId, id).then(full => setMessage(cur => (cur && cur.id === id ? full : cur))).catch(() => {});
    });
    const off2 = mail.on('sync:status', (s) => setStatus(s));
    const off3 = mail.on('app:update-ready', (u) => setUpdateReady(u));
    const off4 = mail.on('app:open-message', ({ accountId, id, quickReply }) => { setView(HOME); setTimeout(() => { setSelected([{ accountId, id }]); if (quickReply) setQuickReplyFocus(true); }, 300); });
    const off7 = mail.on('achievements:unlocked', (list) => { for (const a of list) setTimeout(() => setToastMsg({ m: `🏆 ${a.title} — ${a.body}`, ach: true }), 0); setTimeout(() => setToastMsg(t => (t?.ach ? null : t)), 6000); });
    mail.lock.status().then(s => { setLockInfo(s); if (s.enabled) setLocked(true); });
    const act = () => { lastActivity.current = Date.now(); }; ['mousemove', 'keydown', 'mousedown'].forEach(ev => window.addEventListener(ev, act));
    const idle = setInterval(() => { mail.lock.status().then(s => { setLockInfo(s); if (s.enabled && s.idleMinutes > 0 && Date.now() - lastActivity.current > s.idleMinutes * 60000) setLocked(true); }); }, 30000);
    const off6 = mail.on('app:open-followups', () => setView({ kind: 'followups' }));
    const off5 = mail.on('send:state', (s) => { if (s.state === 'pending' || s.state === 'sending') setSendState(s); else { setSendState(null); if (s.state === 'sent') toast('Message sent'); else if (s.state === 'outbox') toast(s.error); else if (s.state === 'failed') toast('Send failed: ' + s.error + (s.draftId ? ' — the draft is kept' : ''), true); } loadMeta(); });
    const mq = window.matchMedia('(prefers-color-scheme: dark)'); const onMq = () => { mail.settings.get().then(s => applyTheme(s.prefs.theme)); tick(x => x + 1); }; mq.addEventListener('change', onMq);
    const t = setInterval(() => tick(x => x + 1), 30000);
    return () => { off1(); off2(); off3(); off4(); off5(); off6(); off7(); off8(); clearInterval(t); clearInterval(idle); mq.removeEventListener('change', onMq); };
  }, [loadMeta, loadList, setView]);
  useEffect(() => { if (!settingsOpen) mail.settings.get().then(s => { setPrefs(s.prefs); applyTheme(s.prefs.theme); }); }, [settingsOpen]);

  // ── open message / thread ──
  const openMessage = useCallback(async (m) => {
    if (!m) { setMessage(null); setThread(null); return; }
    if (m.isDraft || m.isFollowup || m.isOutbox || m.isScheduled) { setMessage(null); setThread(null); return; }
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
    if (e.button === 1 && !m.isDraft && !m.isOutbox && !m.isFollowup && !m.isScheduled) { e.preventDefault(); openTab(viewRef.current, { kind: 'message', msg: { accountId: m.accountId, id: m.id }, title: m.subject || '(no subject)' }); setTimeout(() => setSelected([{ accountId: m.accountId, id: m.id }]), 0); return; }
    const idx = itemsRef.current.findIndex(i => i.id === m.id && i.accountId === m.accountId);
    if (e.shiftKey && anchor != null) { const [a, b] = [Math.min(anchor, idx), Math.max(anchor, idx)]; setSelected(itemsRef.current.slice(a, b + 1).map(x => ({ accountId: x.accountId, id: x.id }))); }
    else if (e.ctrlKey || e.metaKey) { setSelected(sel => sel.some(s => keyOf(s) === keyOf(m)) ? sel.filter(s => keyOf(s) !== keyOf(m)) : [...sel, { accountId: m.accountId, id: m.id }]); setAnchor(idx); }
    else { setSelected([{ accountId: m.accountId, id: m.id }]); setAnchor(idx); }
  }, [anchor]);
  const selectIndex = (i) => { const m = itemsRef.current[i]; if (m) { setSelected([{ accountId: m.accountId, id: m.id }]); setAnchor(i); } };
  const curIndex = () => { const s = selected[selected.length - 1]; return s ? itemsRef.current.findIndex(i => i.id === s.id && i.accountId === s.accountId) : -1; };
  const openItem = async (m) => {
    if (!m) return;
    if (m.isScheduled) { try { await mail.scheduled.sendNow(m.sched.id); toast('Sent'); loadList(view); loadMeta(); } catch (e) { toast(e.message, true); } return; }
    if (m.isFollowup) { const f = m.followup; if (f.messageId) { setView({ kind: 'all', accountId: f.accountId }); setTimeout(() => setSelected([{ accountId: f.accountId, id: f.messageId }]), 300); } return; }
    if (m.isOutbox) { try { await mail.outbox.sendNow(m.outboxId); toast('Sent'); loadList(view); } catch (e) { toast(e.message, true); } return; }
    if (!m.isDraft) { openCompose('reply', m); return; }   // double-click a message = reply
    if (m.remoteDraft) { try { const d = await mail.drafts.openRemote(m.accountId, m.id); mail.compose.open({ mode: 'new', accountId: m.accountId, draftId: d.id }); } catch (e) { toast(e.message, true); } }
    else mail.compose.open({ mode: 'new', accountId: m.accountId, draftId: m.draftId });
  };

  // ── actions ──
  /** Selected rows expanded to every message they stand for (a conversation row acts on its whole thread). */
  const expandTargets = async () => {
    if (!threaded) return selected;
    const out = [];
    for (const s of selected) { const it = itemsRef.current.find(i => i.id === s.id && i.accountId === s.accountId); if (it?.threadCount > 1) { const th = await mail.messages.thread(s.accountId, it.threadId, { includeTrash: ['TRASH', 'SPAM'].includes(view.labelId) }); out.push(...th.map(x => ({ accountId: x.accountId, id: x.id }))); } else out.push(s); }
    return out;
  };
  /** fn(targets) → result of actions.modify ({ids}) when undoable; inverse = { add, remove } to apply to those ids. */
  const act = async (fn, okMsg, inverse) => {
    try {
      const i = curIndex();
      const targets = await expandTargets();
      const res = await fn(targets);
      const undo = inverse && res?.ids?.length ? async () => { try { await mail.actions.undo(res.ids, inverse); toast('Undone'); } catch (e) { toast('Could not undo: ' + e.message, true); } } : null;
      if (okMsg) toast(okMsg.replace('%n', String(targets.length)), false, undo);
      if (okMsg && i >= 0) { const rest = itemsRef.current.filter(x => !selected.some(s => keyOf(s) === keyOf(x))); const next = rest[Math.min(i, rest.length - 1)]; setSelected(next ? [{ accountId: next.accountId, id: next.id }] : []); }
    } catch (e) { toast(e.message, true); }
  };
  const inTrash = view.kind === 'label' && ['TRASH', 'SPAM'].includes(view.labelId);
  const selAccount = accounts.find(a => a.id === selected[0]?.accountId) || accounts.find(a => a.id === view.accountId);
  const doArchive = () => act((t) => mail.actions.archive(t), 'Archived %n', { add: ['INBOX'] });
  const doTrash = () => inTrash ? doDeleteForever() : act((t) => mail.actions.trash(t), 'Deleted %n', { remove: ['TRASH'], add: [view.labelId === 'SPAM' ? 'SPAM' : 'INBOX'] });
  const doDeleteForever = () => { if (!confirm(`Permanently delete ${selected.length} message(s)? This cannot be undone.`)) return; act((t) => mail.actions.deleteForever(t), 'Deleted forever: %n'); };
  const doRestore = () => act((t) => mail.actions.untrash(t), 'Restored %n to Inbox', { add: [view.labelId], remove: ['INBOX'] });
  const doEmpty = async () => { const name = view.labelId === 'SPAM' ? 'Junk' : 'Trash'; if (!confirm(`Permanently delete everything in ${name} for ${selAccount?.email}?`)) return; try { const n = await mail.actions.emptyFolder(view.accountId, view.labelId); toast(`${name} emptied (${n})`); } catch (e) { toast(e.message, true); } };
  const doMark = (what) => act((t) => ({ read: () => mail.actions.markRead(t, true), unread: () => mail.actions.markRead(t, false), flag: () => mail.actions.star(t, true), unflag: () => mail.actions.star(t, false), spam: () => mail.actions.spam(t, true), notspam: () => mail.actions.spam(t, false) })[what](), what === 'spam' ? 'Marked as junk' : what === 'notspam' ? 'Not junk' : null, what === 'spam' ? { remove: ['SPAM'], add: ['INBOX'] } : what === 'notspam' ? { add: ['SPAM'], remove: ['INBOX'] } : null);
  const doSnooze = (until) => act((t) => mail.actions.snooze(t, until), `Snoozed until ${new Date(until).toLocaleString('en-GB')}`);
  const doMove = (labelId) => { const from = view.kind === 'label' ? view.labelId : (view.kind === 'all-inboxes' ? 'INBOX' : null); act((t) => mail.actions.move(t, labelId, from), 'Moved %n', { remove: [labelId], add: from ? [from] : [] }); };
  const openCompose = (mode, m = message) => {
    if (mode === 'new') { mail.compose.open({ mode, accountId: view.accountId || selAccount?.id || accounts[0]?.id }).catch(e => toast(e.message, true)); return; }
    if (!m) { toast('Select a message first', true); return; }
    mail.compose.open({ mode, accountId: m.accountId, originalId: m.id }).catch(e => toast(e.message, true));
  };
  const runSearch = (deep) => {
    const raw = search.trim();
    const parsed = parseSearch(raw, Object.values(labels).flat());
    const filters = { ...(view.filters || {}), ...parsed.filters };
    const q = parsed.text;
    if (!raw && !deep) { setView({ ...HOME, filters: view.filters }); return; }
    if (!deep) { const nv = q ? { kind: 'search', q, filters } : { ...HOME, filters }; if (q && !['search', 'ids'].includes(view.kind)) openTab(nv); else setView(nv); return; }
    setLoading(true);
    mail.messages.deepSearch(gmailQuery(q, filters), filters?.accountId || null).then(ids => { const nv = { kind: 'ids', ids, q }; if (!['search', 'ids'].includes(view.kind)) openTab(nv); else setView(nv); }).catch(e => toast(e.message, true)).finally(() => setLoading(false));
  };
  const onKey = (e) => {
    if (settingsOpen) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 't') { e.preventDefault(); openTab(HOME); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === 'w') { e.preventDefault(); if (tabs.length > 1) closeTab(activeTab); return; }
    const i = curIndex(); const k = e.key; const cur = itemsRef.current[i];
    if (k === 'ArrowDown') { e.preventDefault(); selectIndex(Math.min(itemsRef.current.length - 1, i + 1)); }
    else if (k === 'ArrowUp') { e.preventDefault(); selectIndex(Math.max(0, i - 1)); }
    else if (k === 'Enter') { if (cur?.isDraft || cur?.isOutbox) openItem(cur); }
    else if (k === 'Delete' || k === 'Backspace') { if (cur?.isDraft) { mail.drafts.remove(cur.draftId).then(() => loadList(view)); return; } if (selected.length) { e.preventDefault(); doTrash(); } }
    else if (k === 'e') { if (selected.length) doArchive(); }
    else if (k === 'u') { if (selected.length) doMark(cur?.unread || cur?.threadUnread ? 'read' : 'unread'); }
    else if (k === 's') { if (selected.length) doMark(cur?.starred ? 'unflag' : 'flag'); }
    else if (k === 'r') openCompose('reply'); else if (k === 'a') openCompose('replyAll'); else if (k === 'f') openCompose('forward'); else if (k === 'n') openCompose('new');
    else if (k === 'p') { if (message) mail.messages.print(message.accountId, message.id); }
    else if (k === 'o') { if (message) mail.messages.openWindow(message.accountId, message.id); }
    else if (k === '?') { setShortcuts(true); }
    else if (k === 'Escape') setSelected([]);
  };
  const startDrag = (e) => {
    const y0 = e.clientY, h0 = listH;
    let last = h0;
    const mv = (ev) => { last = Math.max(120, h0 + ev.clientY - y0); setListH(last); };
    const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); localStorage.setItem('listH', String(last)); };
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  };
  /** Folder list width: drag the strip beside it; pull it under 90px and it closes. */
  const startSideDrag = (e) => {
    e.preventDefault();
    const x0 = e.clientX, w0 = sideW;
    let last = w0;
    const mv = (ev) => { const w = w0 + ev.clientX - x0; last = w < 90 ? 0 : Math.min(520, w); setSideW(last); };
    const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); localStorage.setItem('sideW', String(last)); };
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  };
  const onSort = (col) => { const cur = view.sort || { col: 'date', dir: 'desc' }; const dir = cur.col === col ? (cur.dir === 'desc' ? 'asc' : 'desc') : (col === 'date' || col === 'size' ? 'desc' : 'asc'); if (col === 'date') localStorage.setItem('dateSort', dir); setViewRaw({ ...view, sort: col === 'date' && dir === 'desc' ? undefined : { col, dir } }); };
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

  if (locked) return <LockScreen onUnlock={() => { setLocked(false); lastActivity.current = Date.now(); }} />;
  return (
    <div className="app">
      <div className="topbar">
        <div className="search">
          <div className="wrap">
            <input type="text" placeholder="Search  (Enter = local · Deep search = on the server, inside attachments)" value={search} onChange={e => setSearch(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') runSearch(false); if (e.key === 'Escape') { setSearch(''); if (view.kind === 'search' || view.kind === 'ids') setView(HOME); } }} />
            {search && <button className="clear" onClick={() => { setSearch(''); if (view.kind === 'search' || view.kind === 'ids') setView(HOME); }}>✕</button>}
          </div>
          <button onClick={() => runSearch(true)} disabled={!search.trim() && !view.filters} title="Search on the mail server — bodies and attachment contents"><Icon name="search" /> Deep search</button>
          <FilterMenu filters={view.filters} setFilters={setFilters} accounts={accounts} labels={Object.values(labels).flat()} />
        </div>
        <div className="right"><button onClick={() => setSettingsOpen(true)} title="Settings"><Icon name="settings" size={14} /> Settings</button></div>
      </div>
      <div className="toolbar">
        {accounts.length > 1
          ? <Dropdown className="newdd" btnClass="new-btn" label={<><Icon name="plus" /> New</>}>{accounts.map(a => <MI key={a.id} onClick={() => mail.compose.open({ mode: 'new', accountId: a.id })}><Icon name="mail" /> from {a.email}</MI>)}</Dropdown>
          : <button className="new-btn" onClick={() => openCompose('new')} disabled={!accounts.length}><Icon name="plus" /> New</button>}
        <button onClick={() => { mail.sync.now(); toast('Checking for new mail…'); }} disabled={!accounts.length || info?.demo}><span className="ico"><Icon name="refresh" /></span>Refresh</button>
        <span className="spacer" />
        <button className="act reply" disabled={!canReply} onClick={() => openCompose('reply')}><span className="ico"><Icon name="reply" /></span>Reply</button>
        <button className="act reply" disabled={!canReply} onClick={() => openCompose('replyAll')}><span className="ico"><Icon name="replyAll" /></span>Reply All</button>
        <button className="act fwd" disabled={!canReply} onClick={() => openCompose('forward')}><span className="ico"><Icon name="forward" /></span>Forward</button>
        <span className="sep" />
        <MarkMenu disabled={!hasSel} onMark={doMark} inSpam={view.labelId === 'SPAM'} />
        <span className="sep" />
        {inTrash ? <button className="act arch" disabled={!hasSel} onClick={doRestore}><span className="ico"><Icon name="inbox" /></span>Restore</button>
          : <button className="act arch" disabled={!hasSel} onClick={doArchive}><span className="ico"><Icon name="archive" /></span>Archive</button>}
        <SnoozeMenu disabled={!hasSel || inTrash} onSnooze={doSnooze} />
        <QuickActionsMenu disabled={!hasSel} labels={selLabels} onMove={doMove} inTrash={inTrash} onRestore={doRestore} onEmpty={doEmpty} onDeleteForever={doDeleteForever}
          canDeleteForever={!!(selAccount?.canDeleteForever)} folderName={view.labelId === 'SPAM' ? 'Junk' : 'Trash'}
          canUnsnooze={view.kind === 'snoozed'} onUnsnooze={() => act((t) => mail.actions.unsnooze(t), 'Back in inbox')}
          onRuleFromSender={() => { const m = itemsRef.current.find(i => i.id === selected[0]?.id && i.accountId === selected[0]?.accountId); if (!m) return; setRuleSeed({ accountId: m.accountId, name: `From ${m.fromName || m.fromEmail}`, conditions: [{ field: 'from', op: 'contains', value: m.fromEmail }], actions: [{ type: 'moveTo', labelId: '' }] }); setSettingsOpen('rules'); }}
          onNewLabel={(n) => mail.labels.create(selected[0]?.accountId || view.accountId || accounts[0]?.id, n).then(() => toast('Folder created')).catch(e => toast(e.message, true))} />
        <span className="sep" />
        <button className="act del" disabled={!hasSel} onClick={doTrash} title={inTrash ? 'Delete permanently' : 'Move to Trash'}><span className="ico"><Icon name="trash" /></span>{inTrash ? 'Delete forever' : 'Delete'}</button>
      </div>
      <div className="body" style={{ gridTemplateColumns: `${sideW}px 6px 1fr` }}>
        {sideW > 0 ? <Sidebar accounts={accounts} labels={labels} counts={counts} view={view} setView={setView} status={status} draftCounts={draftCounts} onReorder={(ids) => mail.accounts.reorder(ids).then(loadMeta)} outboxCount={outbox.length} scheduledCount={scheduled.length} onOpenTab={(v) => openTab(v)} followups={{ total: followups.length, due: followups.filter(f => f.status === 'due').length }} onLabelMenu={(e, accountId, l) => setLabelMenu({ x: e.clientX, y: e.clientY, accountId, label: l })} /> : <div />}
        <div className="vdivider" onMouseDown={startSideDrag} title="Drag to resize · double-click to hide or show" onDoubleClick={() => { const w = sideW > 0 ? 0 : 222; setSideW(w); localStorage.setItem('sideW', String(w)); }} />
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
              {tabs.length > 1 && <div className="vtabs">{tabs.map(t => <span key={t.id} className={'vt' + (t.id === activeTab ? ' on' : '')} onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); closeTab(t.id); } else if (e.button === 0) switchTab(t); }} title={tabTitle(t)}><Icon name={t.kind === 'message' ? 'mail' : 'folder'} size={11} /><span className="t">{tabTitle(t)}</span>{tabs.length > 1 && <button onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}>✕</button>}</span>)}<button className="add" title="New tab (or Ctrl+click a folder / middle-click a message)" onClick={() => openTab(HOME)}>+</button></div>}
              <div className="list-wrap" style={{ height: listH }}>
                {filterChips.length > 0 && <div className="chips"><Icon name="settings" size={12} /> {filterChips.map(([k, v]) => <span className="chip" key={k}>{k}{v ? `: ${v}` : ''}<button onClick={() => setFilters({ ...view.filters, [k]: undefined })}>✕</button></span>)}<button style={{ fontSize: 11 }} onClick={() => setFilters({})}>clear</button></div>}
                <MessageList items={items} total={total} loading={loading} view={view} setView={setViewRaw} selected={selected} onSelect={onSelect}
                  onOpen={(m) => { setSelected([{ accountId: m.accountId, id: m.id }]); openItem(m); }} onLoadMore={() => loadList(view, { append: true })} hasMore={hasMore} ascending={isDateAsc(view)}
                  accounts={accounts} labelsById={labelsById} showCategories={showCategories} onKey={onKey} threaded={threaded} setThreaded={setThreaded} onSort={onSort} />
              </div>
              <div className="divider" onMouseDown={startDrag} />
              <div className="read-wrap">
                {view.kind === 'scheduled' && selected.length === 1 ? (() => { const it = itemsRef.current.find(i => i.id === selected[0].id); const s = it?.sched; if (!s) return null; return (
                  <div className="read"><div className="fu-detail"><h2>{s.subject || '(no subject)'}</h2><p>To <b>{s.to}</b> · sends <b>{new Date(s.sendAt).toLocaleString('en-GB')}</b></p>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button className="primary" onClick={() => openItem(it)}>Send now</button>
                      <Dropdown label="Reschedule"><div className="mhead">Send at</div>{sendLaterPresets().map(p => <MI key={p.label} sub={new Date(p.at).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })} onClick={() => mail.scheduled.reschedule(s.id, p.at).then(() => { toast('Rescheduled'); loadList(view); })}>{p.label}</MI>)}</Dropdown>
                      <button onClick={() => mail.scheduled.cancel(s.id).then(dId => { toast('Back in Drafts'); setSelected([]); loadList(view); loadMeta(); if (dId) mail.compose.open({ mode: 'new', accountId: s.accountId, draftId: dId }); })}>Cancel &amp; edit</button>
                    </div></div></div>); })()
                  : view.kind === 'followups' && selected.length === 1 ? (() => { const it = itemsRef.current.find(i => i.id === selected[0].id); const f = it?.followup; if (!f) return null; return (
                  <div className="read"><div className="fu-detail">
                    <h2>{f.subject || '(no subject)'}</h2>
                    <p>Sent to <b>{f.to}</b> on {new Date(f.createdAt).toLocaleString('en-GB')}. {f.status === 'due' ? <span style={{ color: '#c0392b', fontWeight: 600 }}>No reply by {new Date(f.dueAt).toLocaleDateString('en-GB')}.</span> : <>Reminder on {new Date(f.dueAt).toLocaleString('en-GB')} if nobody replies.</>}</p>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {f.messageId && <button className="primary" onClick={() => openItem(it)}>Open the message</button>}
                      {f.messageId && <button onClick={async () => { const m = await mail.messages.get(f.accountId, f.messageId).catch(() => null); if (m) mail.compose.open({ mode: 'replyAll', accountId: f.accountId, originalId: f.messageId, subject: m.subject }); }}>Chase (reply all)</button>}
                      <Dropdown label="Remind me later"><div className="mhead">New reminder</div>{followUpPresets().map(p => <MI key={p.label} sub={new Date(p.at).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} onClick={() => mail.followups.update(f.id, { dueAt: p.at }).then(() => { toast('Reminder moved'); loadList(view); })}>{p.label}</MI>)}</Dropdown>
                      <button onClick={() => mail.followups.update(f.id, { status: 'done' }).then(() => { toast('Done'); setSelected([]); loadList(view); loadMeta(); })}>Done</button>
                      <button onClick={() => mail.followups.remove(f.id).then(() => { setSelected([]); loadList(view); loadMeta(); })}>Remove</button>
                    </div>
                  </div></div>); })()
                  : view.kind === 'outbox' && selected.length === 1 ? <div className="read"><div className="empty"><div className="big"><Icon name="send" size={56} style={{ strokeWidth: 1 }} /></div><div>Waiting for a connection{itemsRef.current.find(i => i.id === selected[0].id)?.snippet ? ': ' + itemsRef.current.find(i => i.id === selected[0].id).snippet : ''}</div><div><button className="primary" onClick={() => openItem(itemsRef.current.find(i => i.id === selected[0].id))}>Send now</button> <button onClick={() => { const it = itemsRef.current.find(i => i.id === selected[0].id); mail.outbox.remove(it.outboxId).then(() => loadList(view)); }}>Delete</button></div></div></div>
                  : view.kind === 'drafts' && selected.length === 1 ? <div className="read"><div className="empty"><div className="big"><Icon name="edit" size={56} style={{ strokeWidth: 1 }} /></div><div><button className="primary" onClick={() => openItem(itemsRef.current.find(i => i.id === selected[0].id))}>Open draft</button> <button onClick={() => { const it = itemsRef.current.find(i => i.id === selected[0].id); if (it?.draftId) mail.drafts.remove(it.draftId).then(() => loadList(view)); else if (it?.remoteDraft) mail.actions.trash([{ accountId: it.accountId, id: it.id }]); }}>Delete</button></div></div></div>
                  : <ReadingPane message={message} thread={thread} loading={msgLoading} prefs={prefs} error={msgError}
                    onRespond={async (m, p) => { try { await mail.actions.respondInvite(m.accountId, m.id, p); toast('Reply sent to the organiser'); const full = await mail.messages.get(m.accountId, m.id); setMessage(cur => cur?.id === m.id ? full : cur); } catch (e) { toast(e.message, true); } }}
                    onPrint={(m) => mail.messages.print(m.accountId, m.id).catch(e => toast(e.message, true))} onReplyTo={(m, mode) => openCompose(mode, m)} onPopOut={(m) => mail.messages.openWindow(m.accountId, m.id)} toast={toast} quickReply={quickReplyFocus}
                    onOpenMessage={(r) => { setView({ kind: 'all', accountId: r.accountId }); setTimeout(() => setSelected([{ accountId: r.accountId, id: r.id }]), 300); }}
                    onRuleFromSender={(m) => { setRuleSeed({ accountId: m.accountId, name: `From ${m.fromName || m.fromEmail}`, conditions: [{ field: 'from', op: 'contains', value: m.fromEmail }], actions: [{ type: 'moveTo', labelId: '' }] }); setSettingsOpen('rules'); }} />}
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="status">
        <span><span className={'led' + (anyErr ? ' err' : anyBusy ? ' busy' : '')} />
          {anyErr ? `Sync problem: ${anyErr.error}` : initial ? <>Downloading mailbox… {(initial[1].synced || 0).toLocaleString()}{initial[1].total ? ' of ' + initial[1].total.toLocaleString() : ''}{initial[1].folder ? ' · ' + initial[1].folder : ''} <span className="faint" title="Gmail allows a fixed number of requests per minute. Tomail runs just under that limit; going faster would get the account rate-limited.">· speed limited by Google, not by Tomail</span></> : anyBusy ? 'Checking for new mail…' : `Last checked ${ago(status.lastCheckedAt)}`}</span>
        {info?.demo && <span style={{ color: '#c0392b' }}>DEMO MODE — sample data, not connected to any server</span>}
        {updateReady && <span>Tomail {updateReady.version} downloaded — <button className="primary" onClick={() => mail.app.installUpdate()}>Restart to update</button></span>}
        <span className="spacer" />
        {info?.version && <button className="ver" disabled={checking} title="Check for a new version of Tomail" onClick={async () => {
          setChecking(true);
          try {
            const r = await mail.app.checkForUpdates();
            if (r.unsupported) toast(`Tomail v${r.version} — automatic updates only work in an installed build`);
            else if (r.error) toast(`Couldn't check for updates: ${r.error}`, true);
            else if (r.available) toast(`Tomail ${r.latest} is available — downloading it now`);
            else toast(`You're on the latest version (v${r.version})`);
          } finally { setChecking(false); }
        }}>{checking ? 'Checking…' : `v${info.version}`}</button>}
        <button onClick={() => { mail.sync.now(); }} disabled={!accounts.length || info?.demo}><Icon name="refresh" size={12} /> Sync now</button>
      </div>
      {settingsOpen && <SettingsModal onClose={() => { setSettingsOpen(false); setRuleSeed(null); }} accounts={accounts} labels={labels} ruleSeed={ruleSeed} refreshAccounts={loadMeta} toast={toast} info={info} initialTab={typeof settingsOpen === 'string' ? settingsOpen : undefined} />}
      {toastMsg && <div className={'toast' + (toastMsg.err ? ' err' : '') + (toastMsg.ach ? ' ach-toast' : '')}>{toastMsg.m}{toastMsg.undo && <button onClick={() => { const u = toastMsg.undo; setToastMsg(null); u(); }}>Undo</button>}</div>}
      {sendState && <SendBanner s={sendState} onUndo={async () => { const ok = await mail.send.cancel(sendState.id); setSendState(null); if (ok && sendState.draftId) mail.compose.open({ mode: 'new', accountId: sendState.accountId, draftId: sendState.draftId }); }} />}
      {labelMenu && <LabelMenu m={labelMenu} labels={labels[labelMenu.accountId] || []} account={accounts.find(a => a.id === labelMenu.accountId)} onClose={() => setLabelMenu(null)} toast={toast} refresh={loadMeta} setView={setView} view={view} />}
      {shortcuts && <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setShortcuts(false); }}><div className="modal" style={{ width: 640 }}><div className="mh">Keyboard shortcuts<button className="x" onClick={() => setShortcuts(false)}>✕</button></div><div className="mb"><div className="shortcuts">
        {[['↑ / ↓', 'Move selection'], ['Enter', 'Open draft / send outbox item'], ['Double-click', 'Reply'], ['r / a / f', 'Reply / Reply all / Forward'], ['n', 'New message'], ['o', 'Open message in a window'], ['e', 'Archive'], ['Delete', 'Move to Trash'], ['u', 'Read / unread'], ['s', 'Flag / unflag'], ['p', 'Print'], ['Esc', 'Clear selection / close'], ['?', 'This list'], ['Ctrl+B / I / U / K', 'Bold / italic / underline / link (compose)']].map(([k, d]) => <div key={k}><span>{d}</span><kbd>{k}</kbd></div>)}
      </div><p className="muted" style={{ marginTop: 12 }}>Search operators: <code>from:</code> <code>to:</code> <code>subject:</code> <code>in:folder</code> <code>is:unread</code> <code>is:flagged</code> <code>has:attachment</code> <code>after:2026-01-01</code> <code>before:2026-02-01</code></p></div></div></div>}
    </div>
  );
}

function LockScreen({ onUnlock }) {
  const [p, setP] = useState(''); const [err, setErr] = useState('');
  const go = async () => { if (await mail.lock.verify(p)) onUnlock(); else { setErr('Wrong passphrase'); setP(''); } };
  return <div className="lockscreen"><div className="box"><Icon name="mail" size={40} /><h2>Tomail is locked</h2><input type="password" value={p} onChange={e => setP(e.target.value)} onKeyDown={e => e.key === 'Enter' && go()} placeholder="Passphrase" autoFocus /><p><button className="primary" onClick={go}>Unlock</button></p>{err && <div className="err">{err}</div>}</div></div>;
}
function SendBanner({ s, onUndo }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick(x => x + 1), 500); return () => clearInterval(t); }, []);
  const left = s.until ? Math.max(0, Math.ceil((s.until - Date.now()) / 1000)) : 0;
  const pct = s.until ? Math.max(0, Math.min(100, ((s.until - Date.now()) / ((s.until - (s.until - left * 1000)) || 1)) * 100)) : 0;
  return <div className="sendbar"><span>{s.state === 'sending' ? 'Sending…' : `Sending "${s.subject || '(no subject)'}" in ${left}s`}</span>{s.state === 'pending' && <><span className="bar"><i style={{ width: `${Math.min(100, left * 100 / Math.max(1, Math.round((s.until - Date.now()) / 1000) || 1))}%` }} /></span><button onClick={onUndo}>Undo</button></>}</div>;
}

const SWATCHES = ['#fb4c2f', '#ffad47', '#fad165', '#16a766', '#43d692', '#4a86e8', '#a479e2', '#f691b3', '#999999', '#000000'];
function LabelMenu({ m, labels, account, onClose, toast, refresh, setView, view }) {
  useEffect(() => { const h = () => onClose(); const k = (e) => { if (e.key === 'Escape') onClose(); }; setTimeout(() => document.addEventListener('mousedown', h), 0); document.addEventListener('keydown', k); return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k); }; }, [onClose]);
  const l = m.label; const isImap = account?.kind === 'imap';
  const run = async (fn, msg) => { try { await fn(); toast(msg); refresh(); } catch (e) { toast(e.message, true); } onClose(); };
  const leaf = l.name.split('/').pop();
  return (
    <div className="ctx menu" style={{ left: Math.min(m.x, window.innerWidth - 240), top: Math.min(m.y, window.innerHeight - 320) }} onMouseDown={e => e.stopPropagation()}>
      <div className="mhead">{l.name}</div>
      <MI onClick={() => { const n = prompt('Rename folder:', leaf); if (n && n !== leaf) run(() => mail.labels.rename(m.accountId, l.id, isImap ? n : l.name.split('/').slice(0, -1).concat(n).join('/')), 'Renamed'); }}>Rename…</MI>
      <MI onClick={() => { const n = prompt(`New subfolder under "${leaf}":`); if (n) run(() => mail.labels.create(m.accountId, l.name + '/' + n), 'Folder created'); }}>New subfolder…</MI>
      <MI onClick={() => { if (confirm(`Delete folder "${l.name}"? Messages in it are not deleted${isImap ? ' on most servers, but check' : ''}.`)) run(() => mail.labels.remove(m.accountId, l.id).then(() => { if (view.labelId === l.id) setView(HOME); }), 'Folder deleted'); }} danger>Delete folder</MI>
      <div className="msep" /><div className="mhead">Colour</div>
      <div className="swatches" onMouseDown={e => e.stopPropagation()}>{SWATCHES.map(c => <span key={c} style={{ background: c }} title={c} onClick={() => run(() => mail.labels.color(m.accountId, l.id, c, '#ffffff'), 'Colour set')} />)}<span style={{ background: 'transparent', border: '2px dashed var(--border)' }} title="No colour" onClick={() => run(() => mail.labels.color(m.accountId, l.id, null, null), 'Colour cleared')} /></div>
    </div>
  );
}
