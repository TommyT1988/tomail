'use strict';
// Gmail payload → {text, html, attachments}; outgoing message → RFC 2822 raw.
const addressparser = require('nodemailer/lib/addressparser');
const MailComposer = require('nodemailer/lib/mail-composer');

function b64urlDecode(s) { return Buffer.from((s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }
function b64urlEncode(buf) { return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

function headersToObj(headers = []) {
  const o = {};
  for (const h of headers) { const k = h.name.toLowerCase(); if (!(k in o)) o[k] = h.value; }
  return o;
}

/** "Name <a@b>, c@d" → [{name, email}] */
function parseAddresses(str) {
  if (!str) return [];
  const out = [];
  for (const a of addressparser(str, { flatten: true })) {
    if (a.address) out.push({ name: a.name || '', email: a.address.toLowerCase() });
  }
  return out;
}

function decodeMimeWords(s) {
  // RFC 2047 encoded words occasionally survive in Gmail's decoded headers; MailComposer's libmime handles them.
  try { return require('nodemailer/lib/mime-funcs').decodeWords ? require('nodemailer/lib/mime-funcs').decodeWords(s) : s; } catch { return s; }
}

/**
 * Walk a Gmail `payload` tree. Returns { text, html, attachments: [{partId, filename, mimeType, size, attachmentId, contentId, inline, data?}] }.
 * Small inline bodies come with `data` (base64url) inline; real attachments have attachmentId for attachments.get.
 */
function parsePayload(payload) {
  const res = { text: '', html: '', attachments: [], calendar: null };
  const texts = [], htmls = [];
  walk(payload, false);
  res.text = texts.join('\n');
  res.html = htmls.join('\n');
  return res;

  function walk(part, insideAlternative) {
    if (!part) return;
    const mime = (part.mimeType || '').toLowerCase();
    const hdr = headersToObj(part.headers);
    const filename = part.filename || '';
    const disp = (hdr['content-disposition'] || '').toLowerCase();
    const cid = (hdr['content-id'] || '').replace(/^<|>$/g, '');
    if (mime.startsWith('multipart/')) {
      const alt = mime === 'multipart/alternative';
      for (const p of part.parts || []) walk(p, insideAlternative || alt);
      return;
    }
    const isAttachment = filename || disp.startsWith('attachment') || (part.body?.attachmentId && !mime.startsWith('text/'));
    if (isAttachment) {
      res.attachments.push({
        partId: part.partId, filename: filename || (cid ? `inline-${cid}` : 'attachment'), mimeType: mime || 'application/octet-stream',
        size: part.body?.size || 0, attachmentId: part.body?.attachmentId || null, contentId: cid || null,
        inline: !!cid && disp.startsWith('inline') || (!!cid && mime.startsWith('image/')),
        data: part.body?.data || null,
      });
      return;
    }
    const body = part.body?.data ? b64urlDecode(part.body.data).toString('utf8') : '';
    if (mime === 'text/calendar') { res.calendar = body; return; }
    if (mime === 'text/plain') texts.push(body);
    else if (mime === 'text/html') htmls.push(body);
    else if (mime.startsWith('text/')) texts.push(body);
  }
}

/** Plain text → minimal HTML, escaping and preserving line breaks. */
function textToHtml(text) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;white-space:pre-wrap">${esc(text || '')}</div>`;
}

/** HTML → rough plain text (for the text/plain alternative and for FTS indexing). */
function htmlToText(html) {
  if (!html) return '';
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Build a raw (base64url) message for messages.send.
 * opts: { from, to, cc, bcc, subject, text, html, attachments:[{filename, path|content, contentType}], inReplyTo, references }
 */
async function buildRaw(opts) {
  const mail = {
    from: opts.from, to: opts.to, cc: opts.cc || undefined, bcc: opts.bcc || undefined, subject: opts.subject || '',
    text: opts.text || '', html: opts.html || undefined, attachments: opts.attachments || [],
    inReplyTo: opts.inReplyTo || undefined, references: opts.references || undefined, icalEvent: opts.icalEvent || undefined,
  };
  const buf = await new MailComposer(mail).compile().build();
  return b64urlEncode(buf);
}

module.exports = { parsePayload, headersToObj, parseAddresses, textToHtml, htmlToText, buildRaw, b64urlDecode, b64urlEncode, decodeMimeWords };
