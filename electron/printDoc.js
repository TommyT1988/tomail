'use strict';
// Printable rendering of a message (header block + sanitised body). Shared shape with the renderer's iframe doc.
const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const addr = (l) => (l || []).map(a => a.name ? `${a.name} <${a.email}>` : a.email).join(', ');
function sanitise(html) {
  return String(html || '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/\son\w+="[^"]*"/gi, '').replace(/\son\w+='[^']*'/gi, '');
}
function buildDoc(m) {
  const body = m.bodyHtml ? sanitise(m.bodyHtml) : `<pre style="white-space:pre-wrap;font-family:inherit">${esc(m.bodyText || '')}</pre>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(m.subject || '(no subject)')}</title>
<style>body{font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif;font-size:13px;color:#111;margin:24px}h1{font-size:18px;margin:0 0 8px}table.h td{padding:1px 8px 1px 0;vertical-align:top;color:#333}table.h td:first-child{color:#777;width:70px}hr{border:0;border-top:1px solid #ccc;margin:12px 0}img{max-width:100%}blockquote{border-left:2px solid #ccc;margin:0;padding-left:1ex}</style></head>
<body><h1>${esc(m.subject || '(no subject)')}</h1><table class="h">
<tr><td>From</td><td>${esc(m.fromName ? `${m.fromName} <${m.fromEmail}>` : m.fromEmail)}</td></tr>
<tr><td>To</td><td>${esc(addr(m.to))}</td></tr>${m.cc?.length ? `<tr><td>Cc</td><td>${esc(addr(m.cc))}</td></tr>` : ''}
<tr><td>Date</td><td>${esc(new Date(m.date).toLocaleString('en-GB'))}</td></tr>
${m.attachments?.length ? `<tr><td>Files</td><td>${esc(m.attachments.map(a => a.filename).join(', '))}</td></tr>` : ''}</table><hr>${body}</body></html>`;
}
module.exports = { buildDoc };
