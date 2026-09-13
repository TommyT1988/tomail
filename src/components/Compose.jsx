import React, { useCallback, useEffect, useRef, useState } from 'react';
import { addrList, escapeHtml, fmtAddrFull, fmtFull, htmlToText, textToQuoted } from '../util.js';
import { buildDoc } from './ReadingPane.jsx';
import RichEditor from './RichEditor.jsx';
import Icon from './Icons.jsx';
import AddressInput from './AddressInput.jsx';

/** draft: { mode:'new'|'reply'|'replyAll'|'forward', accountId, original?, draftId?, to?, subject? } */
export default function Compose({ draft, accounts, prefs, onClose, toast, standalone = false }) {
  const orig = draft.original;
  const me = new Set(accounts.map(a => a.email.toLowerCase()));
  const initAcct = accounts.find(a => a.id === draft.accountId) || accounts[0];
  const sigFor = (a) => (a?.signature ?? prefs?.signature ?? '').trim();
  const sigHtml = (a) => { const s = sigFor(a); return s ? `<br><br><div class="sig">${s.startsWith('<') ? s : escapeHtml(s).replace(/\n/g, '<br>')}</div>` : ''; };
  const init = () => {
    const base = { to: '', cc: '', bcc: '', subject: '', html: sigHtml(initAcct), attachments: [], includeOrigAtts: draft.mode === 'forward', quotedHtml: '', quotedText: '' };
    if (!orig || draft.mode === 'new') return { ...base, to: draft.to || '', subject: draft.subject || '' };
    const subj = (p, s) => (new RegExp('^' + p, 'i').test(s || '') ? s : `${p} ${s || ''}`);
    const from = { name: orig.fromName, email: orig.fromEmail };
    const replyTo = orig.replyTo ? orig.replyTo : fmtAddrFull(from);
    const quoted = { quotedHtml: quoteHtml(orig, draft.mode), quotedText: quoteText(orig, draft.mode) };
    if (draft.mode === 'reply') return { ...base, ...quoted, to: replyTo, subject: subj('Re:', orig.subject) };
    if (draft.mode === 'replyAll') { const others = [...(orig.to || []), ...(orig.cc || [])].filter(a => !me.has(a.email)); return { ...base, ...quoted, to: replyTo, cc: addrList(others), subject: subj('Re:', orig.subject), showCc: !!others.length }; }
    return { ...base, ...quoted, subject: subj('Fwd:', orig.subject) };
  };
  const [f, setF] = useState(init);
  const [accountId, setAccountId] = useState(initAcct?.id);
  const [draftId, setDraftId] = useState(draft.draftId || null);
  const [loaded, setLoaded] = useState(!draft.draftId);
  const [sending, setSending] = useState(false);
  const [showCc, setShowCc] = useState(!!f.showCc);
  const [saveState, setSaveState] = useState('');
  const dirty = useRef(false);
  const saveTimer = useRef(null);
  const latest = useRef({ f, accountId, draftId }); latest.current = { f, accountId, draftId };
  const set = (k) => (e) => { setF(x => ({ ...x, [k]: e.target.value })); dirty.current = true; scheduleSave(); };

  useEffect(() => {
    if (!draft.draftId) return;
    window.mail.drafts.get(draft.draftId).then(d => {
      if (!d) { setLoaded(true); return; }
      setF({ to: d.to, cc: d.cc, bcc: d.bcc, subject: d.subject, html: d.bodyHtml, attachments: d.attachments || [], includeOrigAtts: d.includeOrigAtts, quotedHtml: d.quotedHtml || '', quotedText: d.quotedText || '' });
      setAccountId(d.accountId); setShowCc(!!(d.cc || d.bcc)); setLoaded(true);
    }).catch(e => { toast(e.message, true); setLoaded(true); });
  }, [draft.draftId]); // eslint-disable-line

  const payload = () => { const { f, accountId, draftId } = latest.current; return { id: draftId || undefined, accountId, mode: draft.mode, replyTo: orig ? { accountId: orig.accountId, id: orig.id } : (draft.replyTo || null),
    to: f.to, cc: f.cc, bcc: f.bcc, subject: f.subject, bodyHtml: f.html, bodyText: htmlToText(f.html), attachments: f.attachments, quotedHtml: f.quotedHtml, quotedText: f.quotedText, includeOrigAtts: f.includeOrigAtts }; };
  const isEmpty = () => { const { f } = latest.current; return !f.to && !f.cc && !f.bcc && !f.subject && !htmlToText(f.html).replace(sigFor(accounts.find(a => a.id === latest.current.accountId)), '').trim() && !f.attachments.length; };
  const save = useCallback(async () => {
    if (!dirty.current || isEmpty()) return;
    setSaveState('Saving…');
    try { const d = await window.mail.drafts.save(payload()); if (!latest.current.draftId) setDraftId(d.id); dirty.current = false; setSaveState('Draft saved ' + new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })); }
    catch (e) { setSaveState('Draft not saved: ' + e.message); }
  }, []); // eslint-disable-line
  const scheduleSave = () => { clearTimeout(saveTimer.current); saveTimer.current = setTimeout(save, 2500); };
  useEffect(() => () => clearTimeout(saveTimer.current), []);
  useEffect(() => { const k = (e) => { if (e.key === 'Escape' && !sending) close(); }; document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k); }); // eslint-disable-line
  // OS window close button → save the draft, then let the window go
  useEffect(() => { if (!standalone) return; return window.mail.on('compose:request-close', () => close()); }); // eslint-disable-line
  useEffect(() => { if (standalone) document.title = (f.subject?.trim() || ({ new: 'New message', reply: 'Reply', replyAll: 'Reply all', forward: 'Forward' })[draft.mode]) + ' — Tomail'; }, [f.subject, standalone, draft.mode]);

  const close = async () => { clearTimeout(saveTimer.current); if (dirty.current && !isEmpty()) await save(); else if (latest.current.draftId && isEmpty()) await window.mail.drafts.remove(latest.current.draftId).catch(() => {}); onClose(); };
  const discard = async () => { clearTimeout(saveTimer.current); if (latest.current.draftId) await window.mail.drafts.remove(latest.current.draftId).catch(() => {}); onClose(); };
  const send = async () => {
    if (!f.to.trim()) { toast('Add at least one recipient', true); return; }
    setSending(true); clearTimeout(saveTimer.current);
    try {
      const { html, attachments } = extractInlineImages(f.html);
      const payload = { accountId, to: f.to, cc: f.cc, bcc: f.bcc, subject: f.subject, html, text: htmlToText(html), quotedHtml: f.quotedHtml, quotedText: f.quotedText,
        attachments: [...f.attachments, ...attachments], replyTo: orig ? { accountId: orig.accountId, id: orig.id } : draft.replyTo, mode: draft.mode, forwardAttachments: draft.mode === 'forward' && f.includeOrigAtts, draftId };
      if (standalone && (prefs?.sendDelaySec ?? 5) > 0) {
        // keep the draft so Undo in the main window can reopen it; the main process sends after the delay
        dirty.current = true; await save(); payload.draftId = latest.current.draftId;
        await window.mail.send.queue(payload); onClose(); return;
      }
      await window.mail.actions.send(payload);
      toast('Message sent'); onClose();
    } catch (e) { if (e.code === 'OUTBOX') { toast(e.message); onClose(); } else toast('Send failed: ' + e.message, true); }
    finally { setSending(false); }
  };
  const pick = async () => { const files = await window.mail.compose.pickFiles(); if (files.length) { setF(x => ({ ...x, attachments: [...x.attachments, ...files] })); dirty.current = true; scheduleSave(); } };
  const acct = accounts.find(a => a.id === accountId);
  if (!loaded) return null;
  return (
    <ComposeFrame standalone={standalone} onBackdrop={() => { if (!sending) close(); }}>
        <div className="mh">
          {standalone ? <>
            <button className="primary" onClick={send} disabled={sending}>{sending ? 'Sending…' : <><Icon name="send" /> Send</>}</button>
            <button onClick={pick} disabled={sending}><Icon name="clip" /> Attach</button>
            <button onClick={save} disabled={sending}>Save draft</button>
            <span className="draftstate">{saveState}</span>
            <span className="spacer" />
            <button onClick={discard} disabled={sending} title="Delete this draft and close"><Icon name="trash" /> Discard</button>
          </> : <>{({ new: 'New message', reply: 'Reply', replyAll: 'Reply all', forward: 'Forward' })[draft.mode]}<span className="draftstate">{saveState}</span><button className="x" onClick={close} disabled={sending}>✕</button></>}
        </div>
        <div className="mb">
          <div className="field"><label>From</label>
            {accounts.length > 1 ? <select value={accountId} onChange={e => { const id = Number(e.target.value); const old = sigHtml(acct), nu = sigHtml(accounts.find(a => a.id === id)); setAccountId(id); setF(x => ({ ...x, html: old && x.html.endsWith(old) ? x.html.slice(0, -old.length) + nu : x.html })); dirty.current = true; scheduleSave(); }}>{accounts.map(a => <option key={a.id} value={a.id}>{a.display_name && a.display_name !== a.email ? `${a.display_name} <${a.email}>` : a.email}</option>)}</select>
              : <span>{acct?.email}</span>}
          </div>
          <div className="field"><label>To</label><div style={{ display: 'flex', gap: 6 }}><AddressInput value={f.to} onChange={v => set('to')({ target: { value: v } })} placeholder="name@example.com, …" autoFocus={draft.mode === 'new' || draft.mode === 'forward'} />
            {!showCc && <button className="ccbcc" onClick={() => setShowCc(true)}>Cc/Bcc</button>}</div></div>
          {showCc && <><div className="field"><label>Cc</label><AddressInput value={f.cc} onChange={v => set('cc')({ target: { value: v } })} /></div><div className="field"><label>Bcc</label><AddressInput value={f.bcc} onChange={v => set('bcc')({ target: { value: v } })} /></div></>}
          <div className="field"><label>Subject</label><input type="text" value={f.subject} onChange={set('subject')} /></div>
          <RichEditor value={f.html} onChange={(h) => { setF(x => ({ ...x, html: h })); dirty.current = true; scheduleSave(); }} autoFocus={draft.mode === 'reply' || draft.mode === 'replyAll'} />
          {(f.attachments.length > 0 || (draft.mode === 'forward' && orig?.attachments?.length > 0)) && (
            <div className="atts">
              {f.attachments.map((a, i) => <span key={i}><Icon name="clip" size={12} /> {a.filename} <button style={{ padding: '0 4px' }} onClick={() => { setF(x => ({ ...x, attachments: x.attachments.filter((_, j) => j !== i) })); dirty.current = true; scheduleSave(); }}>✕</button></span>)}
              {draft.mode === 'forward' && orig?.attachments?.length > 0 && <label style={{ fontSize: 12 }}><input type="checkbox" checked={!!f.includeOrigAtts} onChange={e => { setF(x => ({ ...x, includeOrigAtts: e.target.checked })); dirty.current = true; scheduleSave(); }} /> include {orig.attachments.length} original attachment{orig.attachments.length > 1 ? 's' : ''}</label>}
            </div>
          )}
          {f.quotedHtml && <div className="quote"><div className="muted" style={{ marginBottom: 4 }}>Quoted message (sent below your text)</div><iframe title="quoted" sandbox="" srcDoc={buildDoc(f.quotedHtml, { allowRemote: false })} /></div>}
        </div>
        {!standalone && <div className="mf">
          <button className="primary" onClick={send} disabled={sending}>{sending ? 'Sending…' : <><Icon name="send" /> Send</>}</button>
          <button onClick={pick} disabled={sending}><Icon name="clip" /> Attach</button>
          <button onClick={save} disabled={sending}>Save draft</button>
          <span className="spacer" />
          <button onClick={discard} disabled={sending}>Discard</button>
        </div>}
    </ComposeFrame>
  );
}

/** Stable wrapper component (defining it inside Compose would remount the editor on every render). */
function ComposeFrame({ standalone, onBackdrop, children }) {
  if (standalone) return <div className="compose standalone">{children}</div>;
  return <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onBackdrop(); }}><div className="modal compose" style={{ width: 860 }}>{children}</div></div>;
}

/** data: images pasted into the editor become cid: attachments (email clients don't render huge data URLs). */
function extractInlineImages(html) {
  const attachments = [];
  let i = 0;
  const out = html.replace(/<img\b([^>]*?)\ssrc="data:(image\/[a-z+]+);base64,([^"]+)"/gi, (_m, pre, type, b64) => {
    const cid = `img${++i}-${Date.now()}@tomail`;
    attachments.push({ filename: `image${i}.${type.split('/')[1].replace('jpeg', 'jpg')}`, contentType: type, content: b64, cid });
    return `<img${pre} src="cid:${cid}"`;
  });
  return { html: out, attachments };
}
function headerBlock(orig) { return { from: fmtAddrFull({ name: orig.fromName, email: orig.fromEmail }), date: fmtFull(orig.date), to: addrList(orig.to), cc: addrList(orig.cc), subject: orig.subject || '' }; }
function quoteHtml(orig, mode) {
  const h = headerBlock(orig);
  const body = orig.bodyHtml || `<div style="white-space:pre-wrap">${escapeHtml(orig.bodyText || '')}</div>`;
  if (mode === 'forward') return `<div>---------- Forwarded message ---------<br>From: ${escapeHtml(h.from)}<br>Date: ${escapeHtml(h.date)}<br>Subject: ${escapeHtml(h.subject)}<br>To: ${escapeHtml(h.to)}${h.cc ? '<br>Cc: ' + escapeHtml(h.cc) : ''}</div><br>${body}`;
  return `<div>On ${escapeHtml(h.date)}, ${escapeHtml(h.from)} wrote:</div><blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${body}</blockquote>`;
}
function quoteText(orig, mode) {
  const h = headerBlock(orig); const t = orig.bodyText || '';
  if (mode === 'forward') return `---------- Forwarded message ---------\nFrom: ${h.from}\nDate: ${h.date}\nSubject: ${h.subject}\nTo: ${h.to}\n\n${t}`;
  return `On ${h.date}, ${h.from} wrote:\n${textToQuoted(t)}`;
}
