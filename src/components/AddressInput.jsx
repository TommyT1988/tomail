import React, { useEffect, useRef, useState } from 'react';

/** Split "A <a@x>, "Doe, J" <j@y>, c@z" into tokens, respecting quotes and angle brackets. */
export function splitAddresses(s) {
  const out = []; let cur = '', q = false, ang = false;
  for (const ch of String(s || '')) {
    if (ch === '"') q = !q; else if (ch === '<' && !q) ang = true; else if (ch === '>' && !q) ang = false;
    if (ch === ',' && !q && !ang) { if (cur.trim()) out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  return { tokens: out, rest: cur.trim() };
}
const emailOf = (t) => (/<([^>]+)>/.exec(t)?.[1] || t).trim();
const nameOf = (t) => { const m = /^"?([^"<]*?)"?\s*<[^>]+>$/.exec(t); return m ? m[1].trim() : ''; };
const valid = (t) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailOf(t));

/** Recipient field: chips for completed addresses + a text input with suggestions from your address book. */
/** From a stored string: every complete address becomes a chip; only an unfinished trailing fragment stays as text. */
function derive(value) {
  const { tokens, rest } = splitAddresses(value);
  if (rest && (/<[^>]+>\s*$/.test(rest) || valid(rest))) return { tokens: [...tokens, rest], text: '' };
  return { tokens, text: rest };
}
export default function AddressInput({ value, onChange, placeholder, autoFocus, style }) {
  const [{ tokens, text }, setState] = useState(() => derive(value));
  const [sel, setSel] = useState(-1);               // selected chip index
  const [sugs, setSugs] = useState([]); const [idx, setIdx] = useState(0); const [open, setOpen] = useState(false);
  const ref = useRef(null); const timer = useRef(null); const lastEmit = useRef(value);
  useEffect(() => { if (value !== lastEmit.current) { lastEmit.current = value; setState(derive(value)); } }, [value]);
  const setText = (t) => setState(s => ({ ...s, text: t }));
  const emit = (toks, t) => { const v = toks.join(', ') + (t ? (toks.length ? ', ' : '') + t : ''); lastEmit.current = v; setState({ tokens: toks, text: t }); onChange(v); };
  const commit = (t) => { const tt = (t ?? text).trim().replace(/,+$/, ''); if (!tt) return; emit([...tokens, tt], ''); setOpen(false); setSugs([]); };
  const removeAt = (i) => { emit(tokens.filter((_, j) => j !== i), text); setSel(-1); };
  const lookup = (t) => { clearTimeout(timer.current); if (t.trim().length < 2) { setSugs([]); setOpen(false); return; } timer.current = setTimeout(() => window.mail.contacts.search(t.trim()).then(r => { setSugs(r); setIdx(0); setOpen(r.length > 0); }).catch(() => {}), 120); };
  const pick = (c) => { commit(c.name ? `${c.name} <${c.email}>` : c.email); requestAnimationFrame(() => ref.current?.focus()); };
  const onKey = (e) => {
    if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); setIdx(i => e.key === 'ArrowDown' ? Math.min(sugs.length - 1, i + 1) : Math.max(0, i - 1)); return; }
    if (open && (e.key === 'Enter' || e.key === 'Tab')) { e.preventDefault(); pick(sugs[idx]); return; }
    if (e.key === 'Enter' || e.key === ',' || (e.key === 'Tab' && text.trim())) { if (text.trim()) { e.preventDefault(); commit(); } return; }
    if (e.key === 'Escape') { if (open) { setOpen(false); e.stopPropagation(); } else if (sel >= 0) { setSel(-1); e.stopPropagation(); } return; }
    if (!text) {
      if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); if (sel >= 0) removeAt(sel); else if (tokens.length && e.key === 'Backspace') setSel(tokens.length - 1); return; }
      if (e.key === 'ArrowLeft') { e.preventDefault(); setSel(s => s < 0 ? tokens.length - 1 : Math.max(0, s - 1)); return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); setSel(s => s < 0 || s >= tokens.length - 1 ? -1 : s + 1); return; }
    }
    if (sel >= 0) setSel(-1);
  };
  const editChip = (i) => { const t = tokens[i]; emit(tokens.filter((_, j) => j !== i), t); setSel(-1); requestAnimationFrame(() => { ref.current?.focus(); ref.current?.setSelectionRange(t.length, t.length); }); };
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <div className="addr chips-field" style={{ position: 'relative', flex: 1, ...style }} onMouseDown={(e) => { if (e.target === e.currentTarget) { ref.current?.focus(); setSel(-1); } }}>
      {tokens.map((t, i) => (
        <span key={i} className={'chip' + (sel === i ? ' sel' : '') + (valid(t) ? '' : ' bad')} title={valid(t) ? emailOf(t) : 'Not a valid address'}
          onMouseDown={(e) => { e.preventDefault(); setSel(i); ref.current?.focus(); }} onDoubleClick={() => editChip(i)}>
          {nameOf(t) || emailOf(t)}<button tabIndex={-1} onMouseDown={(e) => { e.preventDefault(); removeAt(i); }} title="Remove">✕</button>
        </span>
      ))}
      <input ref={ref} type="text" value={text} placeholder={tokens.length ? '' : placeholder} autoFocus={autoFocus} size={Math.max(8, text.length + 2)}
        onChange={e => { emit(tokens, e.target.value); lookup(e.target.value); }} onKeyDown={onKey}
        onBlur={() => { setTimeout(() => setOpen(false), 150); if (text.trim() && /@/.test(text)) commit(); }} />
      {open && (
        <div className="menu" style={{ left: 0, right: 0, minWidth: 0, top: '100%' }}>
          {sugs.map((c, i) => (
            <button key={c.email} className={'mi' + (i === idx ? ' hl' : '')} onMouseDown={e => { e.preventDefault(); pick(c); }}>
              <span style={{ fontWeight: 600 }}>{c.name || c.email}</span>{c.name && <span className="muted"> {c.email}</span>}
              <span className="sub">{c.source === 'google' ? 'Google' : c.sent_count ? `${c.sent_count} sent` : `${c.recv_count} received`}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
