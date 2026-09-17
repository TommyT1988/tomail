import React, { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { CATEGORIES, dayGroup, fmtAddr, fmtSize, fmtTime, keyOf } from '../util.js';
import Icon from './Icons.jsx';

export default function MessageList({ items, total, loading, view, setView, selected, onSelect, onOpen, onLoadMore, hasMore, ascending, accounts, labelsById, showCategories, onKey, threaded, setThreaded, onSort }) {
  const ref = useRef(null);
  const anchor = useRef({ viewKey: null, firstKey: null, len: 0, h: 0, top: 0, atEnd: true });
  const viewKey = useMemo(() => JSON.stringify(view), [view]);
  const selSet = useMemo(() => new Set(selected.map(keyOf)), [selected]);
  const multiAccount = accounts.length > 1;
  const sortCol = view.sort?.col || 'date', sortDir = view.sort?.dir || 'desc';
  const groups = useMemo(() => {
    if (sortCol !== 'date') return [{ name: null, items }];
    const out = []; let cur = null;
    for (const m of items) { const g = dayGroup(m.date); if (!cur || cur.name !== g) { cur = { name: g, items: [] }; out.push(cur); } cur.items.push(m); }
    return out;
  }, [items, sortCol]);
  const Th = ({ col, children, right }) => <span className={'th' + (sortCol === col ? ' on' : '')} style={right ? { textAlign: 'right' } : undefined} onClick={() => onSort?.(col)} title="Click to sort">{children}{sortCol === col && <span className="arrow">{sortDir === 'asc' ? '▲' : '▼'}</span>}</span>;
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const h = () => { if (hasMore && !loading && (ascending ? el.scrollTop < 300 : el.scrollTop + el.clientHeight > el.scrollHeight - 300)) onLoadMore(); };
    el.addEventListener('scroll', h); return () => el.removeEventListener('scroll', h);
  }, [hasMore, loading, onLoadMore, ascending]);
  // Newest-at-the-bottom: open on the newest mail, hold your place when older pages load in above you,
  // and stay pinned to the bottom (today) when a background refresh brings new mail in.
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const firstKey = items.length ? keyOf(items[0]) : null;
    const p = anchor.current;
    if (p.viewKey !== viewKey) el.scrollTop = ascending ? el.scrollHeight : 0;
    else if (ascending && items.length > p.len && firstKey !== p.firstKey) el.scrollTop = el.scrollHeight - p.h + p.top;
    else if (ascending && p.atEnd) el.scrollTop = el.scrollHeight;
    anchor.current = { viewKey, firstKey, len: items.length, h: el.scrollHeight, top: el.scrollTop, atEnd: el.scrollHeight - el.scrollTop - el.clientHeight < 60 };
  }, [items, ascending, viewKey]);
  useEffect(() => {
    if (!selected.length) return;
    const k = keyOf(selected[selected.length - 1]);
    ref.current?.querySelector(`[data-k="${CSS.escape(k)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  const otherLabels = (m) => {
    const skip = new Set(['INBOX', 'UNREAD', 'STARRED', 'IMPORTANT', 'SENT', 'DRAFT', 'TRASH', 'SPAM', 'ARCHIVE', view.labelId]);
    return m.labels.filter(l => !skip.has(l) && !l.startsWith('CATEGORY_')).map(l => labelsById[m.accountId]?.[l]?.name?.split('/').pop()).filter(Boolean);
  };
  const isDrafts = view.kind === 'drafts';
  return (
    <>
      <div className="tabs">
        {showCategories ? CATEGORIES.map(c => (
          <button key={c.id} className={'tab' + ((view.category || 'primary') === c.id ? ' active' : '')} onClick={() => setView({ ...view, category: c.id })}>{c.name}</button>
        )) : <span className="tab active" style={{ cursor: 'default' }}>{viewTitle(view, labelsById, accounts)}</span>}
        <span className="spacer" />
        {!isDrafts && <button className="tab" title="Group messages by conversation" onClick={() => setThreaded(!threaded)} style={{ padding: '4px 8px' }}><Icon name="layers" size={12} /> {threaded ? 'Conversations: on' : 'Conversations: off'}</button>}
        <span className="count">{loading && !items.length ? 'Loading…' : `${total == null ? '…' : total.toLocaleString()} ${isDrafts ? 'draft' : threaded ? 'conversation' : 'message'}${total === 1 ? '' : 's'}`}</span>
      </div>
      <div className="cols"><span /><Th col="from">{isDrafts ? 'To' : 'From'}</Th><Th col="subject">Subject</Th><Th col="date" right>{isDrafts ? 'Saved' : 'Received'}</Th><Th col="size" right>Size</Th></div>
      <div className="rows" ref={ref} tabIndex={0} onKeyDown={onKey}>
        {hasMore && ascending && <div className="loadmore"><button onClick={onLoadMore} disabled={loading}>{loading ? 'Loading…' : 'Load older'}</button></div>}
        {!items.length && !loading && <div className="empty"><div className="big">▭</div><div>{isDrafts ? 'No drafts' : 'No messages here'}</div></div>}
        {groups.map(g => (
          <React.Fragment key={g.name || 'all'}>
            {g.name && <div className="grp">{g.name}</div>}
            {g.items.map(m => {
              const k = keyOf(m);
              const labs = isDrafts ? [] : otherLabels(m);
              return (
                <div key={k} data-k={k} className={'row' + (m.unread || (m.threadUnread > 0) ? ' unread' : '') + (selSet.has(k) ? ' sel' : '') + (m.isDraft ? ' draft' : '')}
                  onMouseDown={(e) => { if (e.button === 0) onSelect(m, e); }} onDoubleClick={() => onOpen(m)}>
                  <span>{(m.unread || m.threadUnread > 0) && <span className="dot" />}</span>
                  <span className="from" title={m.fromEmail}>{m.isDraft ? <span>Draft{m.toText ? ' · to ' + m.toText : ''}</span> : (fmtAddr({ name: m.fromName, email: m.fromEmail }) || m.fromEmail)}{multiAccount && <span className="acct">{accounts.find(a => a.id === m.accountId)?.email?.split('@')[0]}</span>}</span>
                  <span className="subj" title={m.snippet}>{m.answered && <span className="reply-ico"><Icon name="reply" size={11} /></span>}{m.starred && <span className="star"><Icon name="star" size={12} fill /></span>}{m.subject || '(no subject)'}{m.threadCount > 1 && <span className="tcount">{m.threadCount}</span>}{m.hasAttachment && <span className="clip"><Icon name="clip" size={12} /></span>}{labs.map(l => <span key={l} className="lab">{l}</span>)}</span>
                  <span className="when">{fmtTime(m.date)}</span>
                  <span className="size">{fmtSize(m.size)}</span>
                </div>
              );
            })}
          </React.Fragment>
        ))}
        {hasMore && !ascending && <div className="loadmore"><button onClick={onLoadMore} disabled={loading}>{loading ? 'Loading…' : 'Load more'}</button></div>}
      </div>
    </>
  );
}
export function viewTitle(view, labelsById, accounts) {
  switch (view.kind) {
    case 'all-inboxes': return 'All Inboxes'; case 'unread': return 'Unread'; case 'starred': return 'Flagged'; case 'snoozed': return 'Snoozed';
    case 'all': return 'All Mail'; case 'drafts': return 'Drafts'; case 'search': return `Search: ${view.q}`; case 'ids': return `Deep search: ${view.q}`;
    case 'label': { const sys = { INBOX: 'Inbox', SENT: 'Sent', TRASH: 'Trash', DRAFT: 'Drafts', SPAM: 'Junk Email', ARCHIVE: 'Archive' }; return sys[view.labelId] || labelsById[view.accountId]?.[view.labelId]?.name || view.labelId; }
    default: return '';
  }
}
