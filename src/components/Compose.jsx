import React, { useEffect, useState } from 'react';
import { addrList, escapeHtml, fmtAddrFull, fmtFull, textToQuoted } from '../util.js';
import { buildDoc } from './ReadingPane.jsx';
import Icon from './Icons.jsx';

/** draft: { mode:'new'|'reply'|'replyAll'|'forward', accountId, original? } */
export default function Compose({ draft, accounts, prefs, onClose, onSent, toast }) {
  const orig = draft.original;
  const acct = accounts.find(a => a.id === draft.accountId) || accounts[0];
  const me = new Set(accounts.map(a => a.email.toLowerCase()));
  const init = () => {
    if (!orig || draft.mode === 'new') return { to: draft.to || '', cc: '', bcc: '', subject: draft.subject || '', text: '' };
    const from = { name: orig.fromName, email: orig.fromEmail };
    const replyTo = orig.replyTo ? orig.replyTo : fmtAddrFull(from);
    const subj = (p, s) => (new RegExp('^' + p, 'i').test(s || '') ? s : `${p} ${s || ''}`);
    if (draft.mode === 'reply') return { to: replyTo, cc: '', bcc: '', subject: subj('Re:', orig.subject), text: '' };
    if (draft.mode === 'replyAll') {
      const others = [...(orig.to || []), ...(orig.cc || [])].filter(a => !me.has(a.email));
      return { to: replyTo, cc: addrList(others), bcc: '', subject: subj('Re:', orig.subject), text: '', showCc: !!others.length };
    }
    return { to: '', cc: '', bcc: '', subject: subj('Fwd:', orig.subject), text: '', includeAtts: true };
  };
  const [f, setF] = useState(init);
  const [accountId, setAccountId] = useState(acct?.id);
  const [atts, setAtts] = useState([]);
  const [sending, setSending] = useState(false);
  const [showCc, setShowCc] = useState(!!f.showCc);
  const set = (k) => (e) => setF(x => ({ ...x, [k]: e.target.value }));
  useEffect(() => { const k = (e) => { if (e.key === 'Escape' && !sending) onClose(); }; document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k); }, [onClose, sending]);

  const quotedHtml = orig && draft.mode !== 'new' ? quoteHtml(orig, draft.mode) : '';
  const quotedText = orig && draft.mode !== 'new' ? quoteText(orig, draft.mode) : '';
  const signature = prefs?.signature ? `\n\n${prefs.signature}` : '';

  const send = async () => {
    if (!f.to.trim()) { toast('Add at least one recipient', true); return; }
    setSending(true);
    try {
      await window.mail.actions.send({
        accountId, to: f.to, cc: f.cc, bcc: f.bcc, subject: f.subject, text: f.text + signature, quotedHtml, quotedText,
        attachments: atts, replyTo: orig ? { accountId: orig.accountId, id: orig.id } : undefined, mode: draft.mode,
        forwardAttachments: draft.mode === 'forward' && f.includeAtts,
      });
      toast('Message sent'); onSent?.(); onClose();
    } catch (e) { toast('Send failed: ' + e.message, true); }
    finally { setSending(false); }
  };
  const pick = async () => { const files = await window.mail.compose.pickFiles(); if (files.length) setAtts(a => [...a, ...files]); };

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !sending) onClose(); }}>
      <div className="modal compose">
        <div className="mh">{({ new: 'New message', reply: 'Reply', replyAll: 'Reply all', forward: 'Forward' })[draft.mode]}<button className="x" onClick={onClose} disabled={sending}>✕</button></div>
        <div className="mb">
          <div className="field"><label>From</label>
            {accounts.length > 1 ? <select value={accountId} onChange={e => setAccountId(Number(e.target.value))}>{accounts.map(a => <option key={a.id} value={a.id}>{a.display_name && a.display_name !== a.email ? `${a.display_name} <${a.email}>` : a.email}</option>)}</select>
              : <span>{acct?.email}</span>}
          </div>
          <div className="field"><label>To</label><div style={{ display: 'flex', gap: 6 }}><input type="text" value={f.to} onChange={set('to')} placeholder="name@example.com, …" autoFocus={draft.mode !== 'reply'} />
            {!showCc && <button className="ccbcc" onClick={() => setShowCc(true)}>Cc/Bcc</button>}</div></div>
          {showCc && <><div className="field"><label>Cc</label><input type="text" value={f.cc} onChange={set('cc')} /></div>
            <div className="field"><label>Bcc</label><input type="text" value={f.bcc} onChange={set('bcc')} /></div></>}
          <div className="field"><label>Subject</label><input type="text" value={f.subject} onChange={set('subject')} /></div>
          <textarea value={f.text} onChange={set('text')} autoFocus={draft.mode === 'reply' || draft.mode === 'replyAll'} placeholder="Write your message…" />
          {(atts.length > 0 || draft.mode === 'forward') && (
            <div className="atts">
              {atts.map((a, i) => <span key={i}><Icon name="clip" size={12} /> {a.filename} <button style={{ padding: '0 4px' }} onClick={() => setAtts(x => x.filter((_, j) => j !== i))}>✕</button></span>)}
              {draft.mode === 'forward' && orig?.attachments?.length > 0 && <label style={{ fontSize: 12 }}><input type="checkbox" checked={!!f.includeAtts} onChange={e => setF(x => ({ ...x, includeAtts: e.target.checked }))} /> include {orig.attachments.length} original attachment{orig.attachments.length > 1 ? 's' : ''}</label>}
            </div>
          )}
          {quotedHtml && <div className="quote"><div className="muted" style={{ marginBottom: 4 }}>Quoted message (sent below your text)</div><iframe title="quoted" sandbox="" srcDoc={buildDoc(quotedHtml, { allowRemote: false })} /></div>}
        </div>
        <div className="mf">
          <button className="primary" onClick={send} disabled={sending}>{sending ? 'Sending…' : <><Icon name="send" /> Send</>}</button>
          <button onClick={pick} disabled={sending}><Icon name="clip" /> Attach</button>
          <span className="spacer" />
          <button onClick={onClose} disabled={sending}>Discard</button>
        </div>
      </div>
    </div>
  );
}

function headerBlock(orig) {
  const from = fmtAddrFull({ name: orig.fromName, email: orig.fromEmail });
  return { from, date: fmtFull(orig.date), to: addrList(orig.to), cc: addrList(orig.cc), subject: orig.subject || '' };
}
function quoteHtml(orig, mode) {
  const h = headerBlock(orig);
  const body = orig.bodyHtml || `<div style="white-space:pre-wrap">${escapeHtml(orig.bodyText || '')}</div>`;
  if (mode === 'forward') {
    return `<div>---------- Forwarded message ---------<br>From: ${escapeHtml(h.from)}<br>Date: ${escapeHtml(h.date)}<br>Subject: ${escapeHtml(h.subject)}<br>To: ${escapeHtml(h.to)}${h.cc ? '<br>Cc: ' + escapeHtml(h.cc) : ''}</div><br>${body}`;
  }
  return `<div>On ${escapeHtml(h.date)}, ${escapeHtml(h.from)} wrote:</div><blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${body}</blockquote>`;
}
function quoteText(orig, mode) {
  const h = headerBlock(orig);
  const t = orig.bodyText || '';
  if (mode === 'forward') return `---------- Forwarded message ---------\nFrom: ${h.from}\nDate: ${h.date}\nSubject: ${h.subject}\nTo: ${h.to}\n\n${t}`;
  return `On ${h.date}, ${h.from} wrote:\n${textToQuoted(t)}`;
}
