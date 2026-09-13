import React, { useEffect, useRef, useState } from 'react';

/** Comma-separated address field with suggestions for the token under the caret (from your mail history). */
export default function AddressInput({ value, onChange, placeholder, autoFocus, style }) {
  const [sugs, setSugs] = useState([]);
  const [idx, setIdx] = useState(0);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const timer = useRef(null);
  const tokenAt = (v, pos) => { const start = v.lastIndexOf(',', pos - 1) + 1; let end = v.indexOf(',', pos); if (end < 0) end = v.length; return { start, end, text: v.slice(start, end).trim() }; };
  const lookup = (v, pos) => {
    clearTimeout(timer.current);
    const t = tokenAt(v, pos);
    if (t.text.length < 2 || /<.*>/.test(t.text)) { setSugs([]); setOpen(false); return; }
    timer.current = setTimeout(() => window.mail.contacts.search(t.text).then(r => { setSugs(r); setIdx(0); setOpen(r.length > 0); }).catch(() => {}), 120);
  };
  const pick = (c) => {
    const el = ref.current; const v = value || '';
    const t = tokenAt(v, el.selectionStart ?? v.length);
    const text = c.name ? `${c.name} <${c.email}>` : c.email;
    const next = (v.slice(0, t.start) + (t.start ? ' ' : '') + text + ', ' + v.slice(t.end).replace(/^\s*,?\s*/, '')).replace(/^\s+/, '');
    onChange(next); setOpen(false); setSugs([]);
    requestAnimationFrame(() => { el.focus(); const p = next.length; el.setSelectionRange(p, p); });
  };
  const onKey = (e) => {
    if (!open) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => Math.min(sugs.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(i => Math.max(0, i - 1)); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(sugs[idx]); }
    else if (e.key === 'Escape') { setOpen(false); }
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <div className="addr" style={{ position: 'relative', flex: 1, ...style }}>
      <input ref={ref} type="text" value={value} placeholder={placeholder} autoFocus={autoFocus} style={{ width: '100%' }}
        onChange={e => { onChange(e.target.value); lookup(e.target.value, e.target.selectionStart); }} onKeyDown={onKey} onBlur={() => setTimeout(() => setOpen(false), 150)} />
      {open && (
        <div className="menu" style={{ left: 0, right: 0, minWidth: 0 }}>
          {sugs.map((c, i) => (
            <button key={c.email} className={'mi' + (i === idx ? ' hl' : '')} onMouseDown={e => { e.preventDefault(); pick(c); }}>
              <span style={{ fontWeight: 600 }}>{c.name || c.email}</span>{c.name && <span className="muted"> {c.email}</span>}
              <span className="sub">{c.sent_count ? `${c.sent_count} sent` : `${c.recv_count} received`}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
