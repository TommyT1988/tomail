import React, { useState } from 'react';
import { SYSTEM_FOLDERS, labelTree } from '../util.js';
import Icon from './Icons.jsx';

function Item({ active, onClick, onContextMenu, icon, name, count, unread, indent = 0, tw, cls = '', color }) {
  return (
    <div className={`item indent${indent} ${active ? 'active' : ''} ${cls}`} onClick={onClick} onContextMenu={onContextMenu}>
      {tw !== undefined ? <span className="tw">{tw}</span> : null}
      {icon !== undefined && <span className="ico" style={color ? { color } : undefined}><Icon name={icon} size={13} fill={!!color} /></span>}
      <span className="name" title={name}>{name}</span>
      {count > 0 && <span className={'cnt' + (unread ? ' unread' : '')}>{count.toLocaleString()}</span>}
    </div>
  );
}

export default function Sidebar({ accounts, labels, counts, view, setView, status, draftCounts, onReorder, onLabelMenu, outboxCount, followups }) {
  const [collapsed, setCollapsed] = useState({});
  const [dragId, setDragId] = useState(null);
  const [overId, setOverId] = useState(null);
  const drop = (targetId) => { if (dragId == null || dragId === targetId) return; const ids = accounts.map(a => a.id); const from = ids.indexOf(dragId), to = ids.indexOf(targetId); ids.splice(from, 1); ids.splice(to, 0, dragId); onReorder?.(ids); setDragId(null); setOverId(null); };
  const toggle = (k) => setCollapsed(c => ({ ...c, [k]: !c[k] }));
  const strip = (v) => { const { category, filters, threaded, ...rest } = v || {}; return JSON.stringify(rest); };
  const isView = (v) => strip(view) === strip(v);
  const fav = counts?.favourites || {};
  const lc = (aid, lid) => counts?.labels?.[aid]?.[lid] || { total: 0, unread: 0 };

  const renderTree = (nodes, aid, depth) => nodes.map(n => {
    const key = `${aid}:${n.name}:${depth}`;
    const open = !collapsed[key];
    const l = n.label;
    const c = l ? lc(aid, l.id) : { total: 0, unread: 0 };
    return (
      <React.Fragment key={key}>
        <Item indent={Math.min(3, depth)} tw={n.children.length ? (open ? '▾' : '▸') : ''} icon="folder" name={n.name} color={l?.color_bg || undefined}
          count={c.unread} unread active={l && isView({ kind: 'label', accountId: aid, labelId: l.id })} onContextMenu={(e) => { if (l) { e.preventDefault(); onLabelMenu?.(e, aid, l); } }}
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
          <Item indent={1} icon="edit" name="Drafts" count={draftCounts?.all || 0} active={isView({ kind: 'drafts' })} onClick={() => setView({ kind: 'drafts' })} />
          {(followups?.total > 0) && <Item indent={1} icon="clock" name="Follow-ups" count={followups.due} unread active={isView({ kind: 'followups' })} onClick={() => setView({ kind: 'followups' })} />}
          {outboxCount > 0 && <Item indent={1} icon="send" name="Outbox" count={outboxCount} unread active={isView({ kind: 'outbox' })} onClick={() => setView({ kind: 'outbox' })} />}
        </>}
        {accounts.map(a => {
          const st = status?.accounts?.[a.id];
          const busy = st && (st.phase === 'initial' || st.phase === 'incremental');
          const key = 'acct' + a.id;
          const userLabels = (labels[a.id] || []);
          const tree = labelTree(userLabels);
          const hasArchive = userLabels.some(l => l.id === 'ARCHIVE');
          const folders = [...SYSTEM_FOLDERS.slice(0, 5), ...(hasArchive ? [{ id: 'ARCHIVE', name: 'Archive', icon: 'archive' }] : []), SYSTEM_FOLDERS[5]];
          return (
            <React.Fragment key={a.id}>
              <div className={'sect acct' + (overId === a.id ? ' over' : '')} onClick={() => toggle(key)} title={`${a.email} (${a.kind === 'imap' ? 'IMAP' : 'Google'}) — drag to reorder`} draggable
                onDragStart={(e) => { setDragId(a.id); e.dataTransfer.effectAllowed = 'move'; }} onDragOver={(e) => { e.preventDefault(); setOverId(a.id); }} onDragLeave={() => setOverId(null)} onDrop={(e) => { e.preventDefault(); drop(a.id); }} onDragEnd={() => { setDragId(null); setOverId(null); }}>
                <span className="tw">{collapsed[key] ? '▸' : '▾'}</span><Icon name="mail" size={12} /> <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.email}</span>
                {busy && <span className="spin" title={st.phase === 'initial' ? `Initial sync ${st.synced?.toLocaleString() || 0}${st.total ? ' / ' + st.total.toLocaleString() : ''}${st.folder ? ' · ' + st.folder : ''}` : 'Checking…'} />}
                {st?.phase === 'error' && <span title={st.error} style={{ color: '#c0392b' }}>⚠</span>}
              </div>
              {!collapsed[key] && <>
                {folders.map(f => {
                  if (f.id === 'DRAFT') return <Item key={f.id} indent={1} icon={f.icon} name={f.name} count={draftCounts?.[a.id] || 0} active={isView({ kind: 'drafts', accountId: a.id })} onClick={() => setView({ kind: 'drafts', accountId: a.id })} />;
                  const v = f.id === 'ALL' ? { kind: 'all', accountId: a.id } : { kind: 'label', accountId: a.id, labelId: f.id };
                  const c = f.id === 'ALL' ? { total: (lc(a.id, 'INBOX').total || 0) } : lc(a.id, f.id);
                  const showUnread = f.id === 'INBOX';
                  return <Item key={f.id} indent={1} icon={f.icon} name={f.name} count={showUnread ? c.unread : c.total} unread={showUnread}
                    active={isView(v)} onClick={() => setView(f.id === 'INBOX' && a.kind !== 'imap' ? { ...v, category: 'primary' } : v)} />;
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
