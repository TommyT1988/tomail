'use strict';
// Writes cached messages of an account as an mbox file (reconstructed from stored headers + bodies).
const fs = require('node:fs');
const MailComposer = require('nodemailer/lib/mail-composer');
async function exportMbox(db, accountId, file, onProgress = () => {}) {
  const out = fs.createWriteStream(file);
  let n = 0, withBody = 0;
  const write = (s) => new Promise((res, rej) => out.write(s, (e) => (e ? rej(e) : res())));
  for (const m of db.iterateForExport(accountId)) {
    const addr = (l) => (l || []).map(a => (a.name ? `"${a.name.replace(/"/g, '')}" <${a.email}>` : a.email)).join(', ');
    const mail = { from: m.fromName ? `"${m.fromName.replace(/"/g, '')}" <${m.fromEmail}>` : m.fromEmail, to: addr(m.to) || undefined, cc: addr(m.cc) || undefined, subject: m.subject || '', date: new Date(m.date),
      messageId: m.messageIdHdr || undefined, inReplyTo: m.inReplyTo || undefined, references: m.references || undefined,
      text: m.bodyText || m.snippet || '', html: m.bodyHtml || undefined, headers: { 'X-Tomail-Labels': (m.labels || []).join(','), 'X-Tomail-Body': m.bodyFetched ? 'full' : 'headers-only' } };
    if (m.bodyFetched) withBody++;
    const buf = await new MailComposer(mail).compile().build();
    const body = buf.toString('utf8').replace(/\r\n/g, '\n').replace(/^(>*From )/gm, '>$1');
    await write(`From ${m.fromEmail || 'MAILER-DAEMON'} ${new Date(m.date).toUTCString()}\n${body}\n\n`);
    if (++n % 200 === 0) onProgress(n);
  }
  await new Promise((res) => out.end(res));
  return { messages: n, withBody };
}
module.exports = { exportMbox };
