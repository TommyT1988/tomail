'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MailDb, toFtsQuery } = require('../electron/db');
const { parsePayload, parseAddresses, buildRaw, b64urlDecode, htmlToText } = require('../electron/gmail/mime');
const { parseBatchResponse } = require('../electron/gmail/api');
const { AccountSync, normaliseMessage } = require('../electron/gmail/sync');
const { Actions } = require('../electron/actions');
const { GmailProvider } = require('../electron/providers/gmail');
const { normaliseImap, flagsToLabels } = require('../electron/providers/imap');
const { parseIcs, buildReply } = require('../electron/calendar');

const b64u = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const msg = (id, labels, extra = {}) => ({ id, threadId: 't' + id, historyId: '10', internalDate: String(1_700_000_000_000 + Number(id.replace(/\D/g, '') || 0) * 1000), sizeEstimate: 1234, snippet: 'snip &amp; ' + id,
  labelIds: labels, payload: { headers: [{ name: 'From', value: 'Ann Example <ann@example.com>' }, { name: 'To', value: 'alex@example.com' }, { name: 'Subject', value: 'Hello ' + id }, { name: 'Message-ID', value: `<${id}@x>` }, { name: 'Content-Type', value: extra.ct || 'text/plain' }] } });

test('db: upsert, list views, counts, fts search, label change', () => {
  const db = new MailDb(':memory:');
  const a = db.addAccount({ email: 'a@x.com', tokenEnc: Buffer.from('plain:{}') });
  db.upsertMessages(a.id, [msg('m1', ['INBOX', 'UNREAD']), msg('m2', ['INBOX', 'CATEGORY_PROMOTIONS']), msg('m3', ['TRASH']), msg('m4', ['SENT'])].map(normaliseMessage));
  assert.equal(db.countMessages({ kind: 'label', accountId: a.id, labelId: 'INBOX' }), 2);
  assert.equal(db.countMessages({ kind: 'label', accountId: a.id, labelId: 'INBOX', category: 'primary' }), 1);
  assert.equal(db.countMessages({ kind: 'label', accountId: a.id, labelId: 'INBOX', category: 'CATEGORY_PROMOTIONS' }), 1);
  assert.equal(db.countMessages({ kind: 'all-inboxes' }), 2);
  assert.equal(db.countMessages({ kind: 'unread' }), 1);
  assert.equal(db.countMessages({ kind: 'all', accountId: a.id }), 3, 'all mail excludes trash');
  assert.equal(db.countMessages({ kind: 'label', accountId: a.id, labelId: 'TRASH' }), 1);
  const c = db.counts();
  assert.equal(c.favourites.inboxUnread, 1); assert.equal(c.labels[a.id].INBOX.total, 2);
  assert.equal(db.listMessages({ kind: 'search', q: 'hello m2' }).length, 1);
  assert.equal(db.listMessages({ kind: 'search', q: 'ann@example' }).length, 3, 'from address searchable, trash excluded');
  assert.equal(db.listMessages({ kind: 'search', q: 'hel' }).length, 3, 'prefix match');
  db.applyLabelChange(a.id, ['m1'], { remove: ['UNREAD'], add: ['STARRED'] });
  const m1 = db.getMessage(a.id, 'm1');
  assert.equal(m1.unread, false); assert.equal(m1.starred, true); assert.deepEqual(m1.labels.sort(), ['INBOX', 'STARRED']);
  assert.equal(db.countMessages({ kind: 'starred' }), 1);
  db.setBody(a.id, 'm1', { text: 'the quick brown fox', html: '<p>x</p>', attachments: [{ filename: 'a.pdf', attachmentId: 'z' }] });
  assert.equal(db.listMessages({ kind: 'search', q: 'brown fox' }).length, 1, 'body indexed');
  assert.equal(db.getMessage(a.id, 'm1').hasAttachment, true);
  db.setSnooze(a.id, ['m2'], Date.now() - 1);
  assert.equal(db.countMessages({ kind: 'label', accountId: a.id, labelId: 'INBOX' }), 1, 'snoozed hidden from inbox');
  assert.equal(db.dueSnoozes(Date.now()).length, 1);
  db.deleteMessages(a.id, ['m1']);
  assert.equal(db.listMessages({ kind: 'search', q: 'brown' }).length, 0, 'fts row removed with message');
  assert.equal(toFtsQuery('foo "bar baz" qux-1'), '"foo"* AND "bar baz" AND "qux-1"*');
  assert.equal(toFtsQuery('(x)'), '"x"*');
});

test('mime: payload walk (alternative + attachment + inline cid), addresses, html→text', () => {
  const payload = { mimeType: 'multipart/mixed', parts: [
    { mimeType: 'multipart/alternative', parts: [
      { mimeType: 'text/plain', body: { data: b64u('plain body') } },
      { mimeType: 'text/html', body: { data: b64u('<p>html <img src="cid:img1"></p>') } }] },
    { mimeType: 'image/png', filename: 'logo.png', headers: [{ name: 'Content-ID', value: '<img1>' }, { name: 'Content-Disposition', value: 'inline' }], body: { attachmentId: 'att1', size: 100 } },
    { mimeType: 'application/pdf', filename: 'invoice.pdf', body: { attachmentId: 'att2', size: 5000 } },
  ] };
  const r = parsePayload(payload);
  assert.equal(r.text, 'plain body'); assert.match(r.html, /html/);
  assert.equal(r.attachments.length, 2);
  assert.equal(r.attachments.find(a => a.filename === 'logo.png').inline, true);
  assert.equal(r.attachments.find(a => a.filename === 'invoice.pdf').inline, false);
  assert.deepEqual(parseAddresses('"Smith, J" <j@x.com>, bob@Y.co.uk'), [{ name: 'Smith, J', email: 'j@x.com' }, { name: '', email: 'bob@y.co.uk' }]);
  assert.equal(htmlToText('<p>Hi<br>there &amp; you</p><style>x{}</style>'), 'Hi\nthere & you');
});

test('mime: buildRaw produces a parseable RFC822 with threading headers + attachment', async () => {
  const raw = await buildRaw({ from: 'me@x.com', to: 'you@y.com', subject: 'Re: hi', text: 'hello', html: '<p>hello</p>', inReplyTo: '<abc@x>', references: '<abc@x>',
    attachments: [{ filename: 'a.txt', content: Buffer.from('data'), contentType: 'text/plain' }] });
  const s = b64urlDecode(raw).toString();
  assert.match(s, /^From: me@x\.com/m); assert.match(s, /^In-Reply-To: <abc@x>/m); assert.match(s, /^References: <abc@x>/m);
  assert.match(s, /multipart\/mixed/); assert.match(s, /filename=a\.txt/); assert.match(s, /Content-Type: text\/html/);
});

test('api: batch response parser maps Content-ID back to request order + tolerates failures', () => {
  const b = 'batch_xyz';
  const part = (i, status, body) => `--${b}\r\nContent-Type: application/http\r\nContent-ID: <response-item${i}>\r\n\r\nHTTP/1.1 ${status} OK\r\nContent-Type: application/json\r\n\r\n${body}\r\n`;
  const text = part(1, 200, '{"id":"b"}') + part(0, 200, '{"id":"a"}') + part(2, 404, '{"error":{"code":404}}') + `--${b}--\r\n`;
  const r = parseBatchResponse(text, b, 3);
  assert.equal(r[0].body.id, 'a'); assert.equal(r[1].body.id, 'b'); assert.equal(r[2].ok, false); assert.equal(r[2].status, 404);
});

/** In-memory Gmail double: enough of list/get/history/batch/batchModify to drive sync + actions. */
function fakeGmail(seed) {
  const store = new Map(seed.map(m => [m.id, m]));
  const history = []; let hid = 100;
  const calls = [];
  const api = {
    store, history, calls,
    bump(type, id, labelIds) { history.push({ id: String(++hid), [type]: [{ message: { id, ...(labelIds ? {} : {}) }, ...(labelIds ? { labelIds } : {}) }] }); return String(hid); },
    async get(path, query = {}) {
      calls.push(['GET', path, query]);
      if (path === '/profile') return { emailAddress: 'a@x.com', historyId: String(hid), messagesTotal: store.size };
      if (path === '/labels') return { labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }, { id: 'Label_1', name: 'Customers', type: 'user' }] };
      if (path === '/messages') { const ids = [...store.keys()].reverse(); const page = Number(query.pageToken || 0); const slice = ids.slice(page * 2, page * 2 + 2); return { messages: slice.map(id => ({ id })), nextPageToken: ids.length > (page + 1) * 2 ? String(page + 1) : undefined }; }
      if (path === '/history') { const since = Number(query.startHistoryId); const h = history.filter(x => Number(x.id) > since); if (since < 90) { const e = new Error('nf'); e.status = 404; throw e; } return { history: h, historyId: String(hid) }; }
      const m = /^\/messages\/([^/?]+)$/.exec(path); if (m) { const x = store.get(m[1]); if (!x) { const e = new Error('404'); e.status = 404; throw e; } return x; }
      throw new Error('unhandled ' + path);
    },
    async batchGet(paths) { calls.push(['BATCH', paths.length]); return paths.map(p => { const id = /\/messages\/([^/?]+)/.exec(p)[1]; const x = store.get(id); return x ? { ok: true, status: 200, body: x } : { ok: false, status: 404, body: null }; }); },
    async post(path, body) {
      calls.push(['POST', path, body]);
      if (path === '/messages/batchModify') { for (const id of body.ids) { const x = store.get(id); if (!x) continue; x.labelIds = [...new Set([...x.labelIds.filter(l => !body.removeLabelIds.includes(l)), ...body.addLabelIds])]; } return null; }
      if (path === '/labels') return { id: 'Label_new', name: body.name, type: 'user' };
      if (path === '/messages/send') { const id = 'sent1'; store.set(id, msg(id, ['SENT'])); return { id, threadId: body.threadId || 'tsent' }; }
      throw new Error('unhandled ' + path);
    },
  };
  return api;
}
// give the fake sync's GmailError check something to match
require('../electron/gmail/api').GmailError.prototype.constructor;

test('sync: initial (paged) → incremental applies adds/deletes/label ops, 404 history → resync', async () => {
  const { GmailError } = require('../electron/gmail/api');
  const db = new MailDb(':memory:');
  const a = db.addAccount({ email: 'a@x.com', tokenEnc: Buffer.from('plain:{}') });
  const g = fakeGmail([msg('m1', ['INBOX', 'UNREAD']), msg('m2', ['INBOX']), msg('m3', ['SENT'])]);
  // make the fake's thrown errors look like GmailError 404s
  const origGet = g.get.bind(g); g.get = async (p, q) => { try { return await origGet(p, q); } catch (e) { if (e.status === 404) throw new GmailError(404, 'not found'); throw e; } };
  const progress = [];
  const s = new AccountSync({ db, client: g, account: { id: a.id }, onProgress: (p) => progress.push(p.phase) });
  await s.run();
  assert.equal(db.countMessages({ kind: 'all', accountId: a.id }), 3);
  assert.equal(db.getAccount(a.id).initial_done, 1);
  assert.ok(progress.includes('initial') && progress.includes('incremental') && progress.at(-1) === 'idle');
  // changes on the server
  g.store.set('m4', msg('m4', ['INBOX', 'UNREAD'])); g.bump('messagesAdded', 'm4');
  g.store.delete('m2'); g.bump('messagesDeleted', 'm2');
  g.store.get('m1').labelIds = ['INBOX']; g.bump('labelsRemoved', 'm1', ['UNREAD']);
  g.bump('labelsAdded', 'm1', ['STARRED']); g.store.get('m1').labelIds.push('STARRED');
  const r = await s.incremental();
  assert.deepEqual(r, { added: 1, deleted: 1, labelOps: 2 });
  assert.equal(db.getMessage(a.id, 'm2'), null);
  assert.equal(db.getMessage(a.id, 'm4').unread, true);
  const m1 = db.getMessage(a.id, 'm1'); assert.equal(m1.unread, false); assert.equal(m1.starred, true);
  // expired history → resync from scratch without losing the account
  db.updateAccount(a.id, { history_id: '1' });
  await s.run();
  assert.equal(db.getAccount(a.id).initial_done, 1);
  assert.equal(db.countMessages({ kind: 'all', accountId: a.id }), 3);
});

test('actions: optimistic modify + revert on failure, snooze/unsnooze, send threads a reply', async () => {
  const db = new MailDb(':memory:');
  const a = db.addAccount({ email: 'a@x.com', displayName: 'Alex', tokenEnc: Buffer.from('plain:{}') });
  const g = fakeGmail([msg('m1', ['INBOX', 'UNREAD']), msg('m2', ['INBOX'])]);
  db.replaceLabels(a.id, [{ id: 'INBOX', name: 'INBOX', type: 'system' }]);
  db.upsertMessages(a.id, [g.store.get('m1'), g.store.get('m2')].map(normaliseMessage));
  let changes = 0;
  const prov = new GmailProvider({ db, accountId: a.id, client: g });
  const act = new Actions({ db, providers: () => prov, onChange: () => changes++ });
  const t = [{ accountId: a.id, id: 'm1' }];
  await act.markRead(t, true);
  assert.equal(db.getMessage(a.id, 'm1').unread, false);
  assert.deepEqual(g.store.get('m1').labelIds, ['INBOX']);
  // failure → revert
  const okPost = g.post; g.post = async () => { throw new Error('boom'); };
  await assert.rejects(act.archive(t), /boom/);
  assert.ok(db.getMessage(a.id, 'm1').labels.includes('INBOX'), 'reverted');
  g.post = okPost;
  await act.snooze(t, Date.now() - 10);
  assert.equal(db.getMessage(a.id, 'm1').snoozeUntil < Date.now(), true);
  assert.ok(!db.getMessage(a.id, 'm1').labels.includes('INBOX'));
  assert.equal(await act.wakeDueSnoozes(), 1);
  const m1 = db.getMessage(a.id, 'm1');
  assert.ok(m1.labels.includes('INBOX') && m1.unread && m1.snoozeUntil == null);
  await act.move(t, 'Label_1', 'INBOX');
  assert.deepEqual(db.getMessage(a.id, 'm1').labels.filter(l => l !== 'UNREAD').sort(), ['Label_1', 'Label_new'].filter(l => l === 'Label_1'));
  const sent = await act.send({ accountId: a.id, to: 'x@y.com', subject: 'Re: Hello m1', text: 'thanks', replyTo: { accountId: a.id, id: 'm1' }, mode: 'reply' });
  const sendCall = g.calls.find(c => c[1] === '/messages/send');
  assert.equal(sendCall[2].threadId, 'tm1');
  assert.match(b64urlDecode(sendCall[2].raw).toString(), /In-Reply-To: <m1@x>/);
  assert.match(b64urlDecode(sendCall[2].raw).toString(), /From: "?Alex"? <a@x.com>/);
  assert.equal(sent.id, 'sent1');
  assert.equal(db.getMessage(a.id, 'sent1')?.labels[0], 'SENT', 'sent message pulled into local Sent');
});

test('threads: assignThreads links replies via In-Reply-To/References in either arrival order + listThreads groups', () => {
  const db = new MailDb(':memory:');
  const a = db.addAccount({ email: 'a@x.com', tokenEnc: Buffer.from('plain:{}') });
  const mk = (id, mid, inReplyTo, refs, date, labels = ['INBOX']) => ({ id, threadId: null, internalDate: date, size: 1, snippet: '', subject: 's', fromName: '', fromEmail: 'x@y', to: [], cc: [], labels, messageIdHdr: mid, inReplyTo, references: refs });
  // reply arrives FIRST (newest-first sync), then the original
  db.upsertMessages(a.id, [mk('r1', '<r1@x>', '<o@x>', '<o@x>', 2000)]); db.assignThreads(a.id, ['r1']);
  db.upsertMessages(a.id, [mk('o', '<o@x>', null, null, 1000)]); db.assignThreads(a.id, ['o']);
  db.upsertMessages(a.id, [mk('r2', '<r2@x>', '<r1@x>', '<o@x> <r1@x>', 3000, ['SENT'])]); db.assignThreads(a.id, ['r2']);
  const t = new Set(['r1', 'o', 'r2'].map(id => db.getMessage(a.id, id).threadId));
  assert.equal(t.size, 1, 'all three share one thread id');
  db.upsertMessages(a.id, [mk('solo', '<solo@x>', null, null, 4000)]); db.assignThreads(a.id, ['solo']);
  const rows = db.listThreads({ kind: 'all', accountId: a.id });
  assert.equal(rows.length, 2);
  assert.equal(rows[1].threadCount, 3); assert.equal(rows[1].id, 'r2', 'latest message represents the thread');
  assert.equal(db.countThreads({ kind: 'label', accountId: a.id, labelId: 'INBOX' }), 2);
  assert.equal(db.threadMessages(a.id, rows[1].threadId).length, 3);
});

test('imap: envelope → row, flags → labels', () => {
  const m = { uid: 42, flags: new Set(['\\Seen', '\\Flagged']), size: 999, internalDate: new Date('2026-09-01T10:00:00Z'),
    envelope: { subject: 'Hi', from: [{ name: 'Ann', address: 'ANN@x.com' }], to: [{ address: 'b@y' }], messageId: '<m@x>', inReplyTo: '<p@x>', date: new Date() },
    bodyStructure: { type: 'multipart/mixed', childNodes: [{ type: 'text/plain' }, { type: 'application/pdf', disposition: 'attachment', dispositionParameters: { filename: 'a.pdf' } }] },
    headers: Buffer.from('References: <p@x>\r\nReply-To: r@x\r\n') };
  const r = normaliseImap(m, { path: 'INBOX', labelId: 'INBOX' });
  assert.equal(r.id, 'INBOX::42'); assert.equal(r.fromEmail, 'ann@x.com'); assert.equal(r.hasAttachment, true); assert.equal(r.references, '<p@x>'); assert.equal(r.replyTo, 'r@x');
  assert.deepEqual(r.labels, ['INBOX', 'STARRED']);
  assert.deepEqual(flagsToLabels(new Set(), 'Work'), ['Work', 'UNREAD']);
});

test('calendar: parse invite + build reply', () => {
  const ics = 'BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:abc\r\nSUMMARY:Team\\, sync\r\nDTSTART;TZID=Europe/London:20260920T100000\r\nDTEND;TZID=Europe/London:20260920T110000\r\nLOCATION:Room 1\r\nORGANIZER;CN=Sam:mailto:sam@x.com\r\nATTENDEE;CN=Alex;PARTSTAT=NEEDS-ACTION:mailto:alex@x.com\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  const ev = parseIcs(ics);
  assert.equal(ev.summary, 'Team, sync'); assert.equal(ev.method, 'REQUEST'); assert.equal(ev.organizer.email, 'sam@x.com'); assert.equal(ev.attendees[0].name, 'Alex');
  assert.equal(new Date(ev.start.ts).getHours(), 10);
  const reply = buildReply(ev, { email: 'alex@x.com', name: 'Alex', partstat: 'ACCEPTED' });
  assert.match(reply, /METHOD:REPLY/); assert.match(reply, /ATTENDEE;PARTSTAT=ACCEPTED;CN=Alex:mailto:alex@x.com/); assert.match(reply, /UID:abc/);
  assert.equal(parseIcs('nothing here'), null);
});

test('drafts: save/update/list/delete + remote message dedupe', () => {
  const db = new MailDb(':memory:');
  const a = db.addAccount({ email: 'a@x.com', tokenEnc: Buffer.from('plain:{}') });
  const d = db.saveDraft({ accountId: a.id, to: 'x@y', subject: 'hi', bodyHtml: '<p>hi</p>', bodyText: 'hi' });
  assert.ok(d.id); assert.equal(db.listDrafts().length, 1);
  const d2 = db.saveDraft({ ...d, subject: 'hello' });
  assert.equal(d2.id, d.id); assert.equal(db.getDraft(d.id).subject, 'hello');
  db.setDraftRemote(d.id, 'rd1', 'msg9');
  assert.ok(db.draftRemoteMessageIds(a.id).has('msg9'));
  db.deleteDraft(d.id); assert.equal(db.listDrafts().length, 0);
});

test('search filters narrow a view', () => {
  const db = new MailDb(':memory:');
  const a = db.addAccount({ email: 'a@x.com', tokenEnc: Buffer.from('plain:{}') });
  db.upsertMessages(a.id, [msg('m1', ['INBOX', 'UNREAD']), msg('m2', ['INBOX'], { ct: 'multipart/mixed' })].map(normaliseMessage));
  assert.equal(db.countMessages({ kind: 'all-inboxes', filters: { unread: true } }), 1);
  assert.equal(db.countMessages({ kind: 'all-inboxes', filters: { hasAttachment: true } }), 1);
  assert.equal(db.countMessages({ kind: 'all-inboxes', filters: { from: 'ann@example' } }), 2);
  assert.equal(db.countMessages({ kind: 'all-inboxes', filters: { from: 'nobody' } }), 0);
});
