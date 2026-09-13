import React, { useEffect, useRef, useState } from 'react';
import { snoozePresets } from '../util.js';
import Icon from './Icons.jsx';

/** Generic click-toggled dropdown. children = menu contents; label = trigger content. */
export function Dropdown({ label, className = '', btnClass = '', disabled, right, children, onOpen }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const k = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', h); document.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k); };
  }, [open]);
  return (
    <div className={'dd ' + className} ref={ref}>
      <button className={btnClass} disabled={disabled} onClick={() => { setOpen(o => !o); if (!open) onOpen?.(); }}>{label}<span className="caret">▼</span></button>
      {open && <div className={'menu' + (right ? ' right' : '')} onClick={(e) => { if (e.target.closest('.mi')) setOpen(false); }}>{children}</div>}
    </div>
  );
}
export const MI = ({ onClick, children, sub, disabled, danger }) => (
  <button className={'mi' + (danger ? ' danger' : '')} onClick={onClick} disabled={disabled}>{children}{sub && <span className="sub">{sub}</span>}</button>
);

export function SnoozeMenu({ disabled, onSnooze }) {
  const [custom, setCustom] = useState('');
  return (
    <Dropdown label={<><span className="ico"><Icon name="clock" /></span>Snooze</>} disabled={disabled}>
      {snoozePresets().map(p => <MI key={p.label} sub={p.sub} onClick={() => onSnooze(p.at)}>{p.label}</MI>)}
      <div className="msep" />
      <div className="mhead">Pick a time</div>
      <div className="mform" onClick={e => e.stopPropagation()}>
        <input type="datetime-local" value={custom} onChange={e => setCustom(e.target.value)} />
        <button className="primary mi" style={{ width: 'auto' }} disabled={!custom} onClick={() => onSnooze(new Date(custom).getTime())}>Set</button>
      </div>
    </Dropdown>
  );
}

export function MarkMenu({ disabled, onMark }) {
  return (
    <Dropdown label={<><span className="ico"><Icon name="mark" /></span>Mark</>} disabled={disabled}>
      <MI onClick={() => onMark('read')}><Icon name="mark" /> Mark as read</MI>
      <MI onClick={() => onMark('unread')}><Icon name="dot" fill /> Mark as unread</MI>
      <div className="msep" />
      <MI onClick={() => onMark('flag')}><Icon name="flag" /> Flag</MI>
      <MI onClick={() => onMark('unflag')}><Icon name="flag" style={{ opacity: .4 }} /> Unflag</MI>
      <div className="msep" />
      <MI onClick={() => onMark('spam')}><Icon name="slash" /> Mark as junk</MI>
      <MI onClick={() => onMark('notspam')}><Icon name="inbox" /> Not junk</MI>
    </Dropdown>
  );
}

export function QuickActionsMenu({ disabled, labels, onMove, onUnsnooze, canUnsnooze, onNewLabel }) {
  const [filter, setFilter] = useState('');
  const user = labels.filter(l => l.type === 'user' && l.name.toLowerCase().includes(filter.toLowerCase()));
  return (
    <Dropdown label={<><span className="ico"><Icon name="zap" /></span>Quick Actions</>} disabled={disabled}>
      {canUnsnooze && <><MI onClick={onUnsnooze}><Icon name="clock" /> Unsnooze (back to inbox)</MI><div className="msep" /></>}
      <div className="mhead">Move to folder</div>
      <div className="mform" onClick={e => e.stopPropagation()}><input type="text" placeholder="Filter folders…" value={filter} onChange={e => setFilter(e.target.value)} autoFocus /></div>
      <div className="scroll">
        <MI onClick={() => onMove('INBOX')}><Icon name="inbox" /> Inbox</MI>
        {user.map(l => <MI key={l.id} onClick={() => onMove(l.id)}><Icon name="folder" /> {l.name}</MI>)}
      </div>
      <div className="msep" />
      <MI onClick={() => { const n = prompt('New folder name (use / for nesting):'); if (n) onNewLabel(n); }}><Icon name="plus" /> New folder…</MI>
    </Dropdown>
  );
}
