import React, { useMemo, useState } from 'react';
import { addrList, fmtAddrFull, fmtFull, fmtSize } from '../util.js';
import Icon from './Icons.jsx';

/** Sanitised, sandboxed HTML view. Remote images blocked unless allowed. */
export function buildDoc(html, { allowRemote }) {
  let h = html || '';
  h = h.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<meta[^>]+http-equiv[^>]*>/gi, '').replace(/\son\w+="[^"]*"/gi, '').replace(/\son\w+='[^']*'/gi, '');
  if (!allowRemote) h = h.replace(/(<img\b[^>]*?\s)src=(["'])(https?:)?\/\//gi, '$1data-blocked-src=$2$3//').replace(/url\((["']?)https?:\/\//gi, 'url($1about:blank#');
  return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank">
<style>body{margin:12px 16px;font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif;font-size:14px;color:#222;line-height:1.45;word-wrap:break-word}img{max-width:100%;height:auto}blockquote{border-left:2px solid #ccc;margin:0;padding-left:1ex;color:#555}pre{white-space:pre-wrap}a{color:#2f6fcb}</style>
</head><body>${h}</body></html>`;
}

export default function ReadingPane({ message, loading, prefs, onReply, error }) {
  const [allow, setAllow] = useState({});
  const allowRemote = !!(prefs?.loadRemoteImages || (message && allow[message.id]));
  const doc = useMemo(() => message?.bodyHtml ? buildDoc(message.bodyHtml, { allowRemote }) : null, [message?.bodyHtml, allowRemote]);
  if (!message) return <div className="read"><div className="empty"><div className="big"><Icon name="mail" size={56} style={{ strokeWidth: 1 }} /></div><div>{loading ? 'Loading…' : 'Select a message to read'}</div></div></div>;
  const hasRemote = /(<img\b[^>]*?\ssrc=["'](https?:)?\/\/)|url\(["']?https?:\/\//i.test(message.bodyHtml || '');
  const from = { name: message.fromName, email: message.fromEmail };
  return (
    <div className="read">
      <div className="hdr">
        <h2>{message.subject || '(no subject)'}</h2>
        <div className="line"><span><b>{fmtAddrFull(from)}</b></span><span className="when">{fmtFull(message.date)}</span></div>
        <div className="line"><span>to {addrList(message.to) || '—'}</span>{message.cc?.length > 0 && <span>· cc {addrList(message.cc)}</span>}</div>
        {message.labels?.length > 0 && <div className="labs">{message.labels.filter(l => !['UNREAD', 'CATEGORY_PERSONAL'].includes(l)).map(l => <span key={l}>{l.replace(/^CATEGORY_/, '').toLowerCase()}</span>)}</div>}
      </div>
      {message.attachments?.length > 0 && (
        <div className="atts">
          {message.attachments.map((a, i) => (
            <span className="att" key={i} title={a.mimeType}><Icon name="clip" size={12} /> {a.filename} <span className="sz">{fmtSize(a.size)}</span>
              <button onClick={() => window.mail.attachments.open(message.accountId, message.id, a).catch(e => alert(e.message))}>Open</button>
              <button onClick={() => window.mail.attachments.save(message.accountId, message.id, a).catch(e => alert(e.message))}>Save</button>
            </span>
          ))}
        </div>
      )}
      {error && <div className="imgbar" style={{ background: '#fde8e6', borderColor: '#f3b5ae' }}>⚠ {error}</div>}
      {hasRemote && !allowRemote && <div className="imgbar"><Icon name="image" size={13} /> Remote images are blocked in this message. <button onClick={() => setAllow(a => ({ ...a, [message.id]: true }))}>Load images</button></div>}
      {!message.bodyFetched && loading && <div className="plain muted">Downloading message…</div>}
      {doc ? <iframe title="message" sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={doc} />
        : <div className="plain">{message.bodyText || (message.bodyFetched ? '' : message.snippet)}</div>}
    </div>
  );
}
