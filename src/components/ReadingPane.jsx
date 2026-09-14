import React, { useEffect, useMemo, useRef, useState } from 'react';
import { addrList, fmtAddr, fmtAddrFull, fmtFull, fmtRange, fmtSize, fmtTime, followUpPresets, fmtDuration, ago } from '../util.js';
import { Dropdown, MI } from './Menus.jsx';
import { analyse } from '../phishing.js';
import { useAiStream } from '../useAi.js';
import Icon from './Icons.jsx';

export function buildDoc(html, { allowRemote }) {
  let h = html || '';
  h = h.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<meta[^>]+http-equiv[^>]*>/gi, '').replace(/\son\w+="[^"]*"/gi, '').replace(/\son\w+='[^']*'/gi, '');
  if (!allowRemote) h = h.replace(/(<img\b[^>]*?\s)src=(["'])(https?:)?\/\//gi, '$1data-blocked-src=$2$3//').replace(/url\((["']?)https?:\/\//gi, 'url($1about:blank#');
  return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank">
<style>body{margin:12px 16px;font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif;font-size:14px;color:#222;line-height:1.45;word-wrap:break-word;background:#fff}img{max-width:100%;height:auto}blockquote{border-left:2px solid #ccc;margin:0;padding-left:1ex;color:#555}pre{white-space:pre-wrap}a{color:#2f6fcb}</style>
</head><body>${h}</body></html>`;
}
const hasRemoteImages = (html) => /(<img\b[^>]*?\ssrc=["'](https?:)?\/\/)|url\(["']?https?:\/\//i.test(html || '');

/** Auto-sizing sandboxed body frame. */
function BodyFrame({ html, allowRemote, autoHeight }) {
  const doc = useMemo(() => buildDoc(html, { allowRemote }), [html, allowRemote]);
  const [h, setH] = useState(140);
  const ref = useRef(null);
  // Body height (not documentElement: that one tracks the frame's own viewport and would loop with the observer).
  const measure = () => { try { const d = ref.current?.contentDocument; if (!d?.body) return; const hh = Math.ceil(d.body.getBoundingClientRect().height + 28); if (hh > 28) setH(cur => (Math.abs(cur - Math.min(2400, Math.max(60, hh))) > 2 ? Math.min(2400, Math.max(60, hh)) : cur)); } catch {} };
  useEffect(() => {
    if (!autoHeight) return;
    // Re-measure while the frame lays out and images arrive (no ResizeObserver: observing a same-origin
    // frame's body from the parent reports 'loop completed' errors when the frame itself is resized).
    const timers = [50, 150, 300, 600, 1000, 1500, 2500, 4000, 6000].map(ms => setTimeout(measure, ms));
    return () => timers.forEach(clearTimeout);
  }, [doc, autoHeight]);
  return <iframe ref={ref} title="message" sandbox={autoHeight ? 'allow-same-origin allow-popups allow-popups-to-escape-sandbox' : 'allow-popups allow-popups-to-escape-sandbox'} srcDoc={doc} onLoad={measure} style={autoHeight ? { height: h } : undefined} />;
}

const isImage = (a) => /^image\//i.test(a.mimeType || '') && (a.size || 0) < 12 * 1024 * 1024;
const canPreview = (a) => isImage(a) || /pdf$/i.test(a.mimeType || '') || /\.pdf$/i.test(a.filename || '') || /^text\//i.test(a.mimeType || '');
function Thumb({ m, a }) {
  const [src, setSrc] = useState(null);
  useEffect(() => { let on = true; window.mail.attachments.data(m.accountId, m.id, a).then(d => on && setSrc(d)).catch(() => {}); return () => { on = false; }; }, [m.accountId, m.id, a.attachmentId]);
  return src ? <img src={src} alt={a.filename} className="thumb" onClick={() => window.mail.attachments.preview(m.accountId, m.id, a).catch(e => alert(e.message))} title="Click to open full size" /> : <span className="thumb ph" />;
}
function Attachments({ m, cls = 'atts' }) {
  if (!m.attachments?.length) return null;
  const images = m.attachments.filter(isImage);
  return (
    <>
      <div className={cls}>
        {m.attachments.map((a, i) => (
          <span className="att" key={i} title={a.mimeType}><Icon name="clip" size={12} /> {a.filename} <span className="sz">{fmtSize(a.size)}</span>
            {canPreview(a) && <button onClick={() => window.mail.attachments.preview(m.accountId, m.id, a).catch(e => alert(e.message))}>Preview</button>}
            <button onClick={() => window.mail.attachments.open(m.accountId, m.id, a).catch(e => alert(e.message))}>Open</button>
            <button onClick={() => window.mail.attachments.save(m.accountId, m.id, a).catch(e => alert(e.message))}>Save</button>
          </span>
        ))}
      </div>
      {images.length > 0 && <div className="thumbs">{images.map((a, i) => <Thumb key={i} m={m} a={a} />)}</div>}
    </>
  );
}

function InviteCard({ m, onRespond }) {
  const ev = m.calendar; if (!ev) return null;
  const [busy, setBusy] = useState(null);
  const mine = ev.myResponse;
  const respond = async (p) => { setBusy(p); try { await onRespond(m, p); } finally { setBusy(null); } };
  const past = ev.end?.ts ? ev.end.ts < Date.now() : ev.start?.ts < Date.now() - 3600000;
  return (
    <div className="invite">
      <div>
        <div className="title"><Icon name="calendar" size={14} /> {ev.method === 'CANCEL' ? 'Cancelled: ' : ''}{ev.summary || 'Invitation'}</div>
        <div className="line">{fmtRange(ev)}{past ? ' · (past)' : ''}</div>
        {ev.location && <div className="line">📍 {ev.location}</div>}
        {ev.organizer && <div className="line">Organiser: {ev.organizer.name ? `${ev.organizer.name} <${ev.organizer.email}>` : ev.organizer.email}</div>}
        {ev.attendees?.length > 0 && <div className="line">{ev.attendees.length} invited</div>}
        {mine && <div className="resp">You replied: {({ ACCEPTED: 'Accepted', TENTATIVE: 'Tentative', DECLINED: 'Declined' })[mine]}</div>}
      </div>
      {ev.method !== 'CANCEL' && ev.method !== 'REPLY' && (
        <div className="btns">
          {['ACCEPTED', 'TENTATIVE', 'DECLINED'].map(p => <button key={p} className={mine === p ? 'on' : ''} disabled={!!busy} onClick={() => respond(p)}>{busy === p ? '…' : ({ ACCEPTED: 'Accept', TENTATIVE: 'Maybe', DECLINED: 'Decline' })[p]}</button>)}
        </div>
      )}
    </div>
  );
}

function AuthBadges({ auth }) {
  if (!auth) return null;
  const b = (k, label) => { const v = auth[k]; if (!v) return null; const ok = v === 'pass'; const bad = /fail|softfail|permerror/.test(v); return <span key={k} className={'auth ' + (ok ? 'ok' : bad ? 'bad' : 'meh')} title={`${label}: ${v}`}>{ok ? '✓' : bad ? '✗' : '·'} {label}</span>; };
  return <span className="auths">{b('spf', 'SPF')}{b('dkim', 'DKIM')}{b('dmarc', 'DMARC')}</span>;
}
/** Who is this sender, in numbers: history with them, how you deal with their mail, first-contact warning. */
function SenderCard({ message, onOpenMessage, onRuleFromSender, onInfo }) {
  const [info, setInfo] = useState(null);
  const [open, setOpen] = useState(() => localStorage.getItem('senderCard') !== '0');
  useEffect(() => { let on = true; setInfo(null); onInfo?.(null); if (message.fromEmail) window.mail.messages.senderInfo(message.fromEmail).then(i => { if (on) { setInfo(i); onInfo?.(i); } }).catch(() => {}); return () => { on = false; }; }, [message.fromEmail, message.id]); // eslint-disable-line
  if (!message.fromEmail || !info || info.isOwn) return null;
  const first = info.received <= 1 && info.sentTo === 0;
  const failed = message.auth && Object.values(message.auth).some(v => /fail/.test(v || ''));
  const toggle = () => { setOpen(o => { localStorage.setItem('senderCard', o ? '0' : '1'); return !o; }); };
  return (
    <div className={'sender' + (first ? ' first' : '') + (failed ? ' failed' : '')}>
      <div className="sh" onClick={toggle}>
        <span className="tw">{open ? '▾' : '▸'}</span>
        <span className="who">{message.fromName || message.fromEmail}</span>
        {first && <span className="flag">First message from this sender</span>}
        {failed && <span className="flag bad">Authentication failed — could be spoofed</span>}
        {info.spam > 0 && <span className="flag bad">{info.spam} in Junk before</span>}
        {info.inContacts && <span className="flag ok">{info.contactSource === 'google' ? 'In your Google Contacts' : 'Known contact'}</span>}
        <AuthBadges auth={message.auth} />
        <span className="spacer" />
        <span className="muted">{info.received} received · {info.sentTo} sent</span>
      </div>
      {open && (
        <div className="sb">
          <div className="stats">
            <div><b>{info.received}</b><span>received{info.unread ? ` (${info.unread} unread)` : ''}</span></div>
            <div><b>{info.sentTo}</b><span>sent to them</span></div>
            <div><b>{info.repliedCount}</b><span>replied by you</span></div>
            <div><b>{info.avgReplyMs != null ? fmtDuration(info.avgReplyMs) : '—'}</b><span>your typical reply time</span></div>
            <div><b>{info.attachments}</b><span>with attachments</span></div>
            <div><b>{info.firstSeen ? new Date(info.firstSeen).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }) : '—'}</b><span>first seen</span></div>
          </div>
          {info.recent.length > 1 && <div className="recent"><span className="muted">Recent from them:</span>{info.recent.filter(r => r.id !== message.id).slice(0, 4).map(r => <a key={r.id} href="#" onClick={e => { e.preventDefault(); onOpenMessage?.(r); }} className={r.unread ? 'unread' : ''}>{r.subject || '(no subject)'} <span className="muted">{fmtTime(r.date)}</span></a>)}</div>}
          <div className="sactions"><button onClick={() => onRuleFromSender?.(message)}>Create rule for this sender</button><button onClick={() => window.mail.shell.openExternal('https://www.google.com/search?q=' + encodeURIComponent(message.fromEmail.split('@')[1]))}>Look up domain</button></div>
        </div>
      )}
    </div>
  );
}
/** ✨ Summary panel (streams) + suggested one-line replies that drop into the quick reply box. */
function AiPanel({ message, thread, onSuggest }) {
  const sum = useAiStream();
  const [sugs, setSugs] = useState(null); const [sugBusy, setSugBusy] = useState(false);
  const [ai, setAi] = useState(null);
  useEffect(() => { window.mail.settings.get().then(s => setAi(s.prefs.ai || null)); }, []);
  useEffect(() => { sum.setText(message.aiSummary && !thread ? message.aiSummary : ''); setSugs(null); }, [message.id, thread?.length]); // eslint-disable-line
  if (!ai?.enabled) return null;
  const summarise = () => sum.run((id) => window.mail.ai.summarise(id, message.accountId, message.id, thread?.length > 1 ? message.threadId : null));
  const suggest = async () => { setSugBusy(true); try { const id = 'sug' + Date.now(); setSugs(await window.mail.ai.suggest(id, message.accountId, message.id)); } catch (e) { setSugs([]); } finally { setSugBusy(false); } };
  return (
    <div className="aipanel">
      <div className="aih">
        <button onClick={summarise} disabled={sum.busy}>✨ {sum.busy ? 'Summarising…' : sum.text ? 'Summarise again' : thread?.length > 1 ? 'Summarise conversation' : 'Summarise'}</button>
        {!message.labels?.includes('SENT') && <button onClick={suggest} disabled={sugBusy}>💬 {sugBusy ? 'Thinking…' : 'Suggest replies'}</button>}
        {sum.busy && <button onClick={sum.cancel}>Stop</button>}
        <span className="muted">runs on this computer</span>
      </div>
      {sum.error && <div className="aierr">{sum.error}</div>}
      {sum.text && <div className="aitext">{sum.text}</div>}
      {sugs && <div className="aisugs">{sugs.length ? sugs.map((s, i) => <button key={i} onClick={() => onSuggest?.(s)} title="Use this reply">{s}</button>) : <span className="muted">No suggestions.</span>}</div>}
    </div>
  );
}
function PhishingBanner({ message, senderInfo }) {
  const r = useMemo(() => analyse({ ...message, senderFirstContact: senderInfo ? senderInfo.received <= 1 && senderInfo.sentTo === 0 : false }), [message.id, message.bodyHtml, senderInfo]);
  if (r.level === 'none') return null;
  return (
    <div className={'phish ' + r.level}>
      <div className="ph"><b>{r.level === 'danger' ? 'This message looks like phishing.' : 'Be careful with this message.'}</b> Don't click links or reply with passwords or payment details unless you're sure.</div>
      <ul>{r.reasons.map((x, i) => <li key={i}>{x}</li>)}</ul>
    </div>
  );
}
/** Inline reply box under a message: plain text, sends with the original quoted. */
function QuickReply({ message, toast, autoFocus, seed }) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(!!autoFocus);
  useEffect(() => { if (seed) { setText(seed.text); setOpen(true); } }, [seed]);
  const [busy, setBusy] = useState(false);
  const [all, setAll] = useState(false);
  const ref = useRef(null);
  useEffect(() => { setText(''); setOpen(!!autoFocus); }, [message.id, autoFocus]);
  useEffect(() => { if (open) ref.current?.focus(); }, [open]);
  const sendIt = async () => {
    if (!text.trim()) return; setBusy(true);
    try { await window.mail.messages.quickReply(message.accountId, message.id, text, all); toast?.('Reply sent'); setText(''); setOpen(false); }
    catch (e) { toast?.(e.message, true); } finally { setBusy(false); }
  };
  if (!open) return <div className="qr-closed"><button onClick={() => setOpen(true)}><Icon name="reply" size={12} /> Quick reply</button><button onClick={() => window.mail.compose.open({ mode: 'reply', accountId: message.accountId, originalId: message.id })}>Reply in a window</button></div>;
  return (
    <div className="qr">
      <div className="qr-h"><span>Reply to <b>{message.fromName || message.fromEmail}</b>{(message.to?.length > 1 || message.cc?.length > 0) && <label style={{ marginLeft: 12 }}><input type="checkbox" checked={all} onChange={e => setAll(e.target.checked)} /> reply all</label>}</span><button onClick={() => window.mail.compose.open({ mode: all ? 'replyAll' : 'reply', accountId: message.accountId, originalId: message.id })}>Open in a window</button></div>
      <textarea ref={ref} value={text} onChange={e => setText(e.target.value)} placeholder="Type a reply… (Ctrl+Enter to send)" onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') sendIt(); if (e.key === 'Escape') { setOpen(false); e.stopPropagation(); } }} />
      <div className="qr-f"><button className="primary" onClick={sendIt} disabled={busy || !text.trim()}>{busy ? 'Sending…' : 'Send'}</button><button onClick={() => setOpen(false)}>Cancel</button><span className="muted">The original message is quoted below your reply.</span></div>
    </div>
  );
}
function FollowUpMenu({ message, toast }) {
  return (
    <Dropdown title="Remind me if nobody replies in this conversation" label={<><Icon name="clock" size={12} /> Follow up</>}>
      <div className="mhead">Remind me if no reply by</div>
      {followUpPresets().map(p => <MI key={p.label} sub={new Date(p.at).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} onClick={() => window.mail.followups.add(message.accountId, message.id, p.at).then(() => toast?.('Reminder set')).catch(e => toast?.(e.message, true))}>{p.label}</MI>)}
    </Dropdown>
  );
}
function Header({ message, onPrint, extra, onPopOut, toast }) {
  const from = { name: message.fromName, email: message.fromEmail };
  return (
    <div className="hdr">
      <h2>{message.subject || '(no subject)'}</h2>
      <div className="line first"><span><b>{fmtAddrFull(from)}</b></span><span className="when">{fmtFull(message.date)}</span>
        <span className="hbtns"><FollowUpMenu message={message} toast={toast} />{onPopOut && <button title="Open in a new window (o)" onClick={() => onPopOut(message)}><Icon name="external" size={12} /> Window</button>}<button title="Print" onClick={() => onPrint(message)}>Print</button>{extra}</span></div>
      <div className="line"><span>to {addrList(message.to) || '—'}</span>{message.cc?.length > 0 && <span>· cc {addrList(message.cc)}</span>}</div>
      {message.labels?.length > 0 && <div className="labs">{message.labels.filter(l => !['UNREAD', 'CATEGORY_PERSONAL'].includes(l) && !/^Label_\d+$/.test(l) && !/^\$Tomail/.test(l)).map(l => <span key={l}>{l.replace(/^CATEGORY_/, '').toLowerCase()}</span>)}</div>}
    </div>
  );
}

/** One message in a conversation stack. Fetches its body when first expanded. */
function ThreadCard({ m, open, onToggle, prefs, onRespond, onPrint, onReplyTo }) {
  const [full, setFull] = useState(m.bodyFetched ? m : null);
  const [allow, setAllow] = useState(false);
  useEffect(() => { if (open && (!full || !full.bodyFetched)) window.mail.messages.get(m.accountId, m.id).then(setFull).catch(() => {}); }, [open, m.accountId, m.id]); // eslint-disable-line
  useEffect(() => { if (m.bodyFetched) setFull(m); }, [m]);
  const body = full || m;
  const allowRemote = prefs?.loadRemoteImages || allow;
  const initials = (m.fromName || m.fromEmail || '?').split(/\s+/).map(s => s[0]).join('').slice(0, 2).toUpperCase();
  return (
    <div className={'card' + (open ? ' open' : '')}>
      <div className="ch" onClick={onToggle}>
        <span className="av">{initials}</span>
        <span className="who">{fmtAddr({ name: m.fromName, email: m.fromEmail })}</span>
        {!open && <span className="prev">{m.snippet}</span>}
        {open && <span className="prev">to {addrList(m.to)}{m.cc?.length ? ` · cc ${addrList(m.cc)}` : ''}</span>}
        {m.hasAttachment && <Icon name="clip" size={12} />}
        <span className="when">{fmtFull(m.date)}</span>
      </div>
      {open && (
        <div className="cb">
          {body.calendar && <InviteCard m={body} onRespond={onRespond} />}
          <Attachments m={body} />
          {hasRemoteImages(body.bodyHtml) && !allowRemote && <div className="imgbar"><Icon name="image" size={13} /> Remote images blocked. <button onClick={() => setAllow(true)}>Load images</button></div>}
          {body.bodyHtml ? <BodyFrame html={body.bodyHtml} allowRemote={allowRemote} autoHeight /> : <div className="plain">{body.bodyText || (body.bodyFetched ? '' : 'Loading…')}</div>}
          <div className="cactions">
            <button onClick={() => onReplyTo(body, 'reply')}><Icon name="reply" size={12} /> Reply</button>
            <button onClick={() => onReplyTo(body, 'replyAll')}><Icon name="replyAll" size={12} /> Reply all</button>
            <button onClick={() => onReplyTo(body, 'forward')}><Icon name="forward" size={12} /> Forward</button>
            <button onClick={() => onPrint(body)}>Print</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ReadingPane({ message, thread, loading, prefs, error, onRespond, onPrint, onReplyTo, onPopOut, onOpenMessage, onRuleFromSender, toast, quickReply }) {
  const [allow, setAllow] = useState({});
  const [senderInfo, setSenderInfo] = useState(null);
  const [seed, setSeed] = useState(null);
  const [openIds, setOpenIds] = useState(new Set());
  useEffect(() => { if (thread?.length) setOpenIds(new Set([thread[thread.length - 1].id, ...thread.filter(m => m.unread).map(m => m.id)])); }, [thread?.map(m => m.id).join(',')]); // eslint-disable-line
  const allowRemote = !!(prefs?.loadRemoteImages || (message && allow[message.id]));
  if (!message) return <div className="read"><div className="empty"><div className="big"><Icon name="mail" size={56} style={{ strokeWidth: 1 }} /></div><div>{loading ? 'Loading…' : 'Select a message to read'}</div></div></div>;

  if (thread && thread.length > 1) {
    const latest = thread[thread.length - 1];
    return (
      <div className="read">
        <div className="hdr"><h2>{latest.subject || message.subject || '(no subject)'}</h2><div className="line"><span className="muted">{thread.length} messages in this conversation</span>
          <span className="hbtns"><FollowUpMenu message={latest} toast={toast} />{onPopOut && <button onClick={() => onPopOut(latest)}><Icon name="external" size={12} /> Window</button>}<button onClick={() => setOpenIds(new Set(thread.map(m => m.id)))}>Expand all</button><button onClick={() => setOpenIds(new Set([latest.id]))}>Collapse</button></span></div></div>
        <SenderCard message={latest} onOpenMessage={onOpenMessage} onRuleFromSender={onRuleFromSender} onInfo={setSenderInfo} />
        {latest.bodyFetched && <PhishingBanner message={latest} senderInfo={senderInfo} />}
        {latest.bodyFetched && <AiPanel message={latest} thread={thread} onSuggest={(t) => setSeed({ text: t, at: Date.now() })} />}
        <div className="thread">
          {thread.map(m => <ThreadCard key={m.id} m={m.id === message.id ? message : m} open={openIds.has(m.id)} prefs={prefs} onRespond={onRespond} onPrint={onPrint} onReplyTo={onReplyTo}
            onToggle={() => setOpenIds(s => { const n = new Set(s); n.has(m.id) ? n.delete(m.id) : n.add(m.id); return n; })} />)}
          {!latest.labels?.includes('SENT') && <QuickReply message={latest} toast={toast} autoFocus={quickReply} seed={seed} />}
        </div>
      </div>
    );
  }
  return (
    <div className="read">
      <Header message={message} onPrint={onPrint} onPopOut={onPopOut} toast={toast} />
      <SenderCard message={message} onOpenMessage={onOpenMessage} onRuleFromSender={onRuleFromSender} onInfo={setSenderInfo} />
      {message.bodyFetched && <PhishingBanner message={message} senderInfo={senderInfo} />}
      {message.bodyFetched && <AiPanel message={message} onSuggest={(t) => setSeed({ text: t, at: Date.now() })} />}
      {message.calendar && <InviteCard m={message} onRespond={onRespond} />}
      <Attachments m={message} />
      {error && <div className="imgbar" style={{ background: '#fde8e6', borderColor: '#f3b5ae' }}>⚠ {error}</div>}
      {hasRemoteImages(message.bodyHtml) && !allowRemote && <div className="imgbar"><Icon name="image" size={13} /> Remote images are blocked in this message. <button onClick={() => setAllow(a => ({ ...a, [message.id]: true }))}>Load images</button></div>}
      {!message.bodyFetched && loading && <div className="plain muted">Downloading message…</div>}
      {message.bodyHtml ? <BodyFrame html={message.bodyHtml} allowRemote={allowRemote} /> : <div className="plain">{message.bodyText || (message.bodyFetched ? '' : message.snippet)}</div>}
      {message.bodyFetched && !message.labels?.includes('SENT') && <QuickReply message={message} toast={toast} autoFocus={quickReply} seed={seed} />}
    </div>
  );
}
