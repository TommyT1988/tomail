import React, { useEffect, useRef, useState } from 'react';
import { snoozePresets } from '../util.js';
import Icon from './Icons.jsx';

export function Dropdown({ label, className = '', btnClass = '', disabled, right, children, onOpen, title }) {
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
      <button className={btnClass} title={title} disabled={disabled} onClick={() => { setOpen(o => !o); if (!open) onOpen?.(); }}>{label}<span className="caret">▼</span></button>
      {open && <div className={'menu' + (right ? ' right' : '')} onClick={(e) => { if (e.target.closest('.mi')) setOpen(false); }}>{typeof children === 'function' ? children(() => setOpen(false)) : children}</div>}
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
      <div className="msep" /><div className="mhead">Pick a time</div>
      <div className="mform" onClick={e => e.stopPropagation()}>
        <input type="datetime-local" value={custom} onChange={e => setCustom(e.target.value)} />
        <button className="primary mi" style={{ width: 'auto' }} disabled={!custom} onClick={() => onSnooze(new Date(custom).getTime())}>Set</button>
      </div>
    </Dropdown>
  );
}
export function MarkMenu({ disabled, onMark, inSpam }) {
  return (
    <Dropdown label={<><span className="ico"><Icon name="mark" /></span>Mark</>} disabled={disabled}>
      <MI onClick={() => onMark('read')}><Icon name="mark" /> Mark as read</MI>
      <MI onClick={() => onMark('unread')}><Icon name="dot" fill /> Mark as unread</MI>
      <div className="msep" />
      <MI onClick={() => onMark('flag')}><Icon name="flag" /> Flag</MI>
      <MI onClick={() => onMark('unflag')}><Icon name="flag" style={{ opacity: .4 }} /> Unflag</MI>
      <div className="msep" />
      {inSpam ? <MI onClick={() => onMark('notspam')}><Icon name="inbox" /> Not junk</MI> : <MI onClick={() => onMark('spam')}><Icon name="slash" /> Mark as junk</MI>}
    </Dropdown>
  );
}
export function QuickActionsMenu({ disabled, labels, onMove, onUnsnooze, canUnsnooze, onNewLabel, inTrash, onRestore, onEmpty, folderName, onDeleteForever, canDeleteForever, onRuleFromSender }) {
  const [filter, setFilter] = useState('');
  const user = labels.filter(l => l.type === 'user' && l.name.toLowerCase().includes(filter.toLowerCase()));
  return (
    <Dropdown label={<><span className="ico"><Icon name="zap" /></span>Quick Actions</>} disabled={disabled && !inTrash}>
      {canUnsnooze && <><MI onClick={onUnsnooze}><Icon name="clock" /> Unsnooze (back to inbox)</MI><div className="msep" /></>}
      {inTrash && <>
        <MI onClick={onRestore} disabled={disabled}><Icon name="inbox" /> Restore to Inbox</MI>
        <MI onClick={onDeleteForever} disabled={disabled || !canDeleteForever} danger><Icon name="trash" /> Delete forever</MI>
        <MI onClick={onEmpty} disabled={!canDeleteForever} danger><Icon name="trash" /> Empty {folderName}…</MI>
        <div className="msep" />
      </>}
      <div className="mhead">Move to folder</div>
      <div className="mform" onClick={e => e.stopPropagation()}><input type="text" placeholder="Filter folders…" value={filter} onChange={e => setFilter(e.target.value)} autoFocus /></div>
      <div className="scroll">
        <MI onClick={() => onMove('INBOX')} disabled={disabled}><Icon name="inbox" /> Inbox</MI>
        {labels.some(l => l.id === 'ARCHIVE') && <MI onClick={() => onMove('ARCHIVE')} disabled={disabled}><Icon name="archive" /> Archive</MI>}
        {user.map(l => <MI key={l.id} onClick={() => onMove(l.id)} disabled={disabled}><Icon name="folder" /> {l.name}</MI>)}
      </div>
      <div className="msep" />
      <MI onClick={() => { const n = prompt('New folder name (use / for nesting):'); if (n) onNewLabel(n); }}><Icon name="plus" /> New folder…</MI>
      <MI onClick={onRuleFromSender} disabled={disabled}><Icon name="zap" /> Create rule from sender…</MI>
    </Dropdown>
  );
}
/** Search filters: applied to the current view (local) and folded into Gmail syntax for deep search. */
export function FilterMenu({ filters, setFilters, accounts, labels }) {
  const f = filters || {};
  const set = (k, v) => setFilters({ ...f, [k]: v || undefined });
  const n = Object.values(f).filter(v => v !== undefined && v !== '' && v !== false).length;
  const toDate = (ts) => ts ? new Date(Number(ts)).toISOString().slice(0, 10) : '';
  const fromDate = (s) => s ? new Date(s + 'T00:00:00').getTime() : undefined;
  return (
    <Dropdown className="fmenu" right label={<><Icon name="settings" size={12} /> Filters{n ? ` (${n})` : ''}</>}>
      <div className="mhead">Narrow the current view</div>
      <div className="frow"><label>From</label><input type="text" value={f.from || ''} onChange={e => set('from', e.target.value)} placeholder="name or address" /></div>
      <div className="frow"><label>To</label><input type="text" value={f.to || ''} onChange={e => set('to', e.target.value)} /></div>
      <div className="frow"><label>After</label><input type="date" value={toDate(f.after)} onChange={e => set('after', fromDate(e.target.value))} /></div>
      <div className="frow"><label>Before</label><input type="date" value={toDate(f.before)} onChange={e => set('before', fromDate(e.target.value))} /></div>
      {accounts.length > 1 && <div className="frow"><label>Account</label><select value={f.accountId || ''} onChange={e => set('accountId', e.target.value ? Number(e.target.value) : undefined)}><option value="">All accounts</option>{accounts.map(a => <option key={a.id} value={a.id}>{a.email}</option>)}</select></div>}
      <div className="frow"><label>Folder</label><select value={f.labelId || ''} onChange={e => set('labelId', e.target.value)}><option value="">Any</option>{[...new Map(labels.map(l => [l.name, l])).values()].map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>
      <div className="fchk">
        <label><input type="checkbox" checked={!!f.unread} onChange={e => set('unread', e.target.checked)} /> Unread</label>
        <label><input type="checkbox" checked={!!f.starred} onChange={e => set('starred', e.target.checked)} /> Flagged</label>
        <label><input type="checkbox" checked={!!f.hasAttachment} onChange={e => set('hasAttachment', e.target.checked)} /> Has attachment</label>
      </div>
      <div className="msep" />
      <MI onClick={() => setFilters({})}>Clear filters</MI>
    </Dropdown>
  );
}
