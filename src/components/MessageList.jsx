import React, { useEffect, useMemo, useRef } from 'react';
import { CATEGORIES, dayGroup, fmtAddr, fmtSize, fmtTime, keyOf } from '../util.js';
import Icon from './Icons.jsx';

export default function MessageList({ items, total, loading, view, setView, selected, onSelect, onOpen, onLoadMore, hasMore, accounts, labelsById, showCategories, onKey }) {
  const ref = useRef(null);
  const selSet = useMemo(() => new Set(selected.map(keyOf)), [selected]);
  const multiAccount = accounts.length > 1;
  const groups = useMemo(() => {
    const out = []; let cur = null;
    for (const m of items) {
      const g = dayGroup(m.date);
      if (!cur || cur.name !== g) { cur = { name: g, items: [] }; out.push(cur); }
      cur.items.push(m);
    }
    return out;
  }, [items]);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const h = () => { if (hasMore && !loading && el.scrollTop + el.clientHeight > el.scrollHeight - 300) onLoadMore(); };
    el.addEventListener('scroll', h); return () => el.removeEventListener('scroll', h);
  }, [hasMore, loading, onLoadMore]);
  // keep the focused/selected row in view
  useEffect(() => {
    if (!selected.length) return;
    const k = keyOf(selected[selected.length - 1]);
    const el = ref.current?.querySelector(`[data-k="${CSS.escape(k)}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const otherLabels = (m) => {
    const skip = new Set(['INBOX', 'UNREAD', 'STARRED', 'IMPORTANT', 'SENT', 'DRAFT', 'TRASH', 'SPAM', view.labelId]);
    return m.labels.filter(l => !skip.has(l) && !l.startsWith('CATEGORY_')).map(l => labelsById[m.accountId]?.[l]?.name?.split('/').pop()).filter(Boolean);
  };

  return (
    <>
      <div className="tabs">
        {showCategories ? CATEGORIES.slice(0, 3).map(c => (
          <button key={c.id} className={'tab' + ((view.category || 'primary') === c.id ? ' active' : '')} onClick={() => setView({ ...view, category: c.id })}>{c.name}</button>
        )) : <span className="tab active" style={{ cursor: 'default' }}>{viewTitle(view, labelsById, accounts)}</span>}
        <span className="spacer" />
        <span className="count">{loading && !items.length ? 'Loading…' : `${(total ?? items.length).toLocaleString()} message${total === 1 ? '' : 's'}`}</span>
      </div>
      <div className="cols"><span /><span>From</span><span>Subject</span><span style={{ textAlign: 'right' }}>Received</span><span style={{ textAlign: 'right' }}>Size</span></div>
      <div className="rows" ref={ref} tabIndex={0} onKeyDown={onKey}>
        {!items.length && !loading && <div className="empty"><div className="big">▭</div><div>No messages here</div></div>}
        {groups.map(g => (
          <React.Fragment key={g.name}>
            <div className="grp">{g.name}</div>
            {g.items.map(m => {
              const k = keyOf(m);
              const labs = otherLabels(m);
              return (
                <div key={k} data-k={k} className={'row' + (m.unread ? ' unread' : '') + (selSet.has(k) ? ' sel' : '')}
                  onMouseDown={(e) => { if (e.button === 0) onSelect(m, e); }} onDoubleClick={() => onOpen(m)}>
                  <span>{m.unread && <span className="dot" />}</span>
                  <span className="from" title={m.fromEmail}>{fmtAddr({ name: m.fromName, email: m.fromEmail }) || m.fromEmail}{multiAccount && <span className="acct">{accounts.find(a => a.id === m.accountId)?.email?.split('@')[0]}</span>}</span>
                  <span className="subj" title={m.snippet}>{m.starred && <span className="star"><Icon name="star" size={12} fill /></span>}{m.subject || '(no subject)'}{m.hasAttachment && <span className="clip"><Icon name="clip" size={12} /></span>}{labs.map(l => <span key={l} className="lab">{l}</span>)}</span>
                  <span className="when">{fmtTime(m.date)}</span>
                  <span className="size">{fmtSize(m.size)}</span>
                </div>
              );
            })}
          </React.Fragment>
        ))}
        {hasMore && <div className="loadmore"><button onClick={onLoadMore} disabled={loading}>{loading ? 'Loading…' : 'Load more'}</button></div>}
      </div>
    </>
  );
}

export function viewTitle(view, labelsById, accounts) {
  switch (view.kind) {
    case 'all-inboxes': return 'All Inboxes';
    case 'unread': return 'Unread';
    case 'starred': return 'Flagged';
    case 'snoozed': return 'Snoozed';
    case 'all': return 'All Mail';
    case 'search': return `Search: ${view.q}`;
    case 'ids': return `Deep search: ${view.q}`;
    case 'label': {
      const sys = { INBOX: 'Inbox', SENT: 'Sent', TRASH: 'Trash', DRAFT: 'Drafts', SPAM: 'Junk Email' };
      return sys[view.labelId] || labelsById[view.accountId]?.[view.labelId]?.name || view.labelId;
    }
    default: return '';
  }
}
