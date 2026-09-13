import React, { useState } from 'react';
import { SYSTEM_FOLDERS, labelTree } from '../util.js';
import Icon from './Icons.jsx';

function Item({ active, onClick, icon, name, count, unread, indent = 0, tw, cls = '' }) {
  return (
    <div className={`item indent${indent} ${active ? 'active' : ''} ${cls}`} onClick={onClick}>
      {tw !== undefined ? <span className="tw">{tw}</span> : null}
      {icon !== undefined && <span className="ico"><Icon name={icon} size={13} /></span>}
      <span className="name" title={name}>{name}</span>
      {count > 0 && <span className={'cnt' + (unread ? ' unread' : '')}>{count.toLocaleString()}</span>}
    </div>
  );
}

export default function Sidebar({ accounts, labels, counts, view, setView, status }) {
  const [collapsed, setCollapsed] = useState({});
  const toggle = (k) => setCollapsed(c => ({ ...c, [k]: !c[k] }));
  const isView = (v) => JSON.stringify({ ...view, category: undefined }) === JSON.stringify({ ...v, category: undefined });
  const fav = counts?.favourites || {};
  const lc = (aid, lid) => counts?.labels?.[aid]?.[lid] || { total: 0, unread: 0 };

  const renderTree = (nodes, aid, depth) => nodes.map(n => {
    const key = `${aid}:${n.name}:${depth}`;
    const open = !collapsed[key];
    const l = n.label;
    const c = l ? lc(aid, l.id) : { total: 0, unread: 0 };
    return (
      <React.Fragment key={key}>
        <Item indent={Math.min(3, depth)} tw={n.children.length ? (open ? '▾' : '▸') : ''} icon="folder" name={n.name}
          count={c.unread} unread active={l && isView({ kind: 'label', accountId: aid, labelId: l.id })}
          onClick={(e) => { if (e.target.classList.contains('tw') && n.children.length) { toggle(key); return; } if (l) setView({ kind: 'label', accountId: aid, labelId: l.id }); else toggle(key); }} />
        {open && n.children.length > 0 && renderTree(n.children, aid, depth + 1)}
      </React.Fragment>
    );
  });

  return (
    <div className="sidebar">
      <h1>Tomail</h1>
      <div className="tree">
        <div className="sect" onClick={() => toggle('fav')}><span className="tw">{collapsed.fav ? '▸' : '▾'}</span><Icon name="star" size={11} fill /> Favorites</div>
        {!collapsed.fav && <>
          <Item indent={1} icon="inbox" name="All Inboxes" count={fav.inboxTotal} unread={fav.inboxUnread > 0} active={isView({ kind: 'all-inboxes' })} onClick={() => setView({ kind: 'all-inboxes', category: 'primary' })} />
          <Item indent={1} icon="dot" name="Unread" count={fav.unread} unread active={isView({ kind: 'unread' })} onClick={() => setView({ kind: 'unread' })} />
          <Item indent={1} icon="flag" name="Flagged" count={fav.starred} active={isView({ kind: 'starred' })} onClick={() => setView({ kind: 'starred' })} />
          <Item indent={1} icon="clock" name="Snoozed" count={fav.snoozed} active={isView({ kind: 'snoozed' })} onClick={() => setView({ kind: 'snoozed' })} />
        </>}
        {accounts.map(a => {
          const st = status?.accounts?.[a.id];
          const busy = st && (st.phase === 'initial' || st.phase === 'incremental');
          const key = 'acct' + a.id;
          const userLabels = (labels[a.id] || []);
          const tree = labelTree(userLabels);
          return (
            <React.Fragment key={a.id}>
              <div className="sect" onClick={() => toggle(key)} title={a.email}>
                <span className="tw">{collapsed[key] ? '▸' : '▾'}</span><Icon name="mail" size={12} /> <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.email}</span>
                {busy && <span className="spin" title={st.phase === 'initial' ? `Initial sync ${st.synced?.toLocaleString() || 0}${st.total ? ' / ' + st.total.toLocaleString() : ''}` : 'Checking…'} />}
                {st?.phase === 'error' && <span title={st.error} style={{ color: '#c0392b' }}>⚠</span>}
              </div>
              {!collapsed[key] && <>
                {SYSTEM_FOLDERS.map(f => {
                  const v = f.id === 'ALL' ? { kind: 'all', accountId: a.id } : { kind: 'label', accountId: a.id, labelId: f.id };
                  const c = f.id === 'ALL' ? { total: (lc(a.id, 'INBOX').total || 0) } : lc(a.id, f.id);
                  const showUnread = f.id === 'INBOX';
                  return <Item key={f.id} indent={1} icon={f.icon} name={f.name} count={showUnread ? c.unread : c.total} unread={showUnread}
                    active={isView(v)} onClick={() => setView(f.id === 'INBOX' ? { ...v, category: 'primary' } : v)} />;
                })}
                {tree.length > 0 && <>
                  <div className="sect" onClick={() => toggle(key + 'more')}><span className="tw">{collapsed[key + 'more'] ? '▸' : '▾'}</span>More</div>
                  {!collapsed[key + 'more'] && renderTree(tree, a.id, 1)}
                </>}
              </>}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}
