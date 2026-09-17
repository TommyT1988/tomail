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
    async get(path, query = {}, opts) {
      calls.push(['GET', path, query, opts]);
      if (path === '/profile') return { emailAddress: 'a@x.com', historyId: String(hid), messagesTotal: store.size };
      if (path === '/labels') return { labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }, { id: 'Label_1', name: 'Customers', type: 'user' }] };
      if (path === '/messages') { const ids = [...store.keys()].reverse(); const page = Number(query.pageToken || 0); const slice = ids.slice(page * 2, page * 2 + 2); return { messages: slice.map(id => ({ id })), nextPageToken: ids.length > (page + 1) * 2 ? String(page + 1) : undefined }; }
      if (path === '/history') { const since = Number(query.startHistoryId); const h = history.filter(x => Number(x.id) > since); if (since < 90) { const e = new Error('nf'); e.status = 404; throw e; } return { history: h, historyId: String(hid) }; }
      const m = /^\/messages\/([^/?]+)$/.exec(path); if (m) { const x = store.get(m[1]); if (!x) { const e = new Error('404'); e.status = 404; throw e; } return x; }
      throw new Error('unhandled ' + path);
    },
    async batchGet(paths, opts) { calls.push(['BATCH', paths.length, opts]); return paths.map(p => { const id = /\/messages\/([^/?]+)/.exec(p)[1]; const x = store.get(id); return x ? { ok: true, status: 200, body: x } : { ok: false, status: 404, body: null }; }); },
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
  assert.deepEqual(r, { added: 1, deleted: 1, labelOps: 2, newInbox: ['m4'] });
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

test('sort orders: date asc, size desc, subject ignores Re:/Fwd:', () => {
  const db = new MailDb(':memory:');
  const a = db.addAccount({ email: 'a@x.com', tokenEnc: Buffer.from('plain:{}') });
  const mk = (id, date, size, subject) => ({ id, threadId: id, internalDate: date, size, snippet: '', subject, fromName: '', fromEmail: 'x@y', to: [], cc: [], labels: ['INBOX'] });
  db.upsertMessages(a.id, [mk('a', 3, 10, 'Zebra'), mk('b', 1, 30, 'Re: apple'), mk('c', 2, 20, 'Mango')]);
  const ids = (v) => db.listMessages({ kind: 'all-inboxes', ...v }).map(m => m.id);
  assert.deepEqual(ids({}), ['a', 'c', 'b']);
  assert.deepEqual(ids({ sort: { col: 'date', dir: 'asc' } }), ['b', 'c', 'a']);
  assert.deepEqual(ids({ sort: { col: 'size', dir: 'desc' } }), ['b', 'c', 'a']);
  assert.deepEqual(ids({ sort: { col: 'subject', dir: 'asc' } }), ['b', 'c', 'a']);
  db.reorderAccounts([a.id]); assert.equal(db.getAccount(a.id).position, 1);
});

test('list query uses the (account, date) index', () => {
  const db = new MailDb(':memory:');
  const a = db.addAccount({ email: 'a@x.com', tokenEnc: Buffer.from('plain:{}') });
  const plan = db.db.prepare(`EXPLAIN QUERY PLAN SELECT m.rid FROM messages m WHERE m.account_id = ? AND m.snooze_until IS NULL ORDER BY m.internal_date DESC LIMIT 100`).all(a.id).map(r => r.detail).join(' | ');
  assert.match(plan, /messages_acct_date/);
  db.analyze(); assert.ok(db.kvGet('lastAnalyze'));
});

test('list: oldest-first pages from the newest end (today is on page 1)', () => {
  const { isDateAsc, mergePage } = require('../src/util.js');
  const { MailDb } = require('../electron/db');
  assert.equal(isDateAsc({ kind: 'all' }), false);                               // default = newest first
  assert.equal(isDateAsc({ kind: 'all', sort: { col: 'date', dir: 'asc' } }), true);
  assert.equal(isDateAsc({ kind: 'all', sort: { col: 'size', dir: 'asc' } }), false);

  // 250 messages, one per day; the newest is "today".
  const db = new MailDb(':memory:');
  const a = db.addAccount({ email: 'a@x.com', tokenEnc: Buffer.from('plain:{}') });
  const day = 86400000, today = 1_700_000_000_000;
  db.upsertMessages(a.id, Array.from({ length: 250 }, (_, i) => normaliseMessage(
    msg('d' + i, ['INBOX'], {})
  )).map((m, i) => ({ ...m, internalDate: today - (249 - i) * day })));

  const view = { kind: 'all', sort: { col: 'date', dir: 'asc' } };
  const asc = isDateAsc(view);
  const query = { ...view, sort: asc ? { col: 'date', dir: 'desc' } : view.sort };

  let items = mergePage([], db.listMessages(query, { offset: 0, limit: 100 }), { asc });
  assert.equal(items.length, 100);
  assert.equal(items[items.length - 1].date, today);            // newest sits at the BOTTOM
  assert.equal(items[0].date, today - 99 * day);                // 100 newest only — no 2019 scroll
  assert.ok(items.every((m, i) => i === 0 || m.date >= items[i - 1].date)); // displayed oldest → newest

  // "Load older" prepends the page above what's loaded, keeping the run ascending.
  items = mergePage(items, db.listMessages(query, { offset: 100, limit: 100 }), { asc, append: true });
  assert.equal(items.length, 200);
  assert.equal(items[items.length - 1].date, today);            // today never moves off the bottom
  assert.equal(items[0].date, today - 199 * day);
  assert.ok(items.every((m, i) => i === 0 || m.date >= items[i - 1].date));

  // Newest-first is untouched: page 1 is the newest, appended below.
  const desc = mergePage([], db.listMessages({ kind: 'all' }, { offset: 0, limit: 100 }), { asc: false });
  assert.equal(desc[0].date, today);
  const desc2 = mergePage(desc, db.listMessages({ kind: 'all' }, { offset: 100, limit: 100 }), { asc: false, append: true });
  assert.equal(desc2.length, 200);
  assert.equal(desc2[199].date, today - 199 * day);
});

test('aliases: identities, validation, and sending as one', async () => {
  const db = new MailDb(':memory:');
  const a = db.addAccount({ email: 'alex@example.com', displayName: 'Alex', tokenEnc: Buffer.from('plain:{}') });
  assert.deepEqual(db.identities(a.id), [{ email: 'alex@example.com', name: 'Alex' }]);

  // stored lower-cased, de-duped against the account's own address, junk dropped
  db.setAliases(a.id, [{ email: 'Sales@Example.com', name: 'Sales' }, { email: 'sales@example.com' }, { email: 'nope' }, { email: 'alex@example.com' }]);
  assert.deepEqual(db.identities(a.id), [
    { email: 'alex@example.com', name: 'Alex' },
    { email: 'sales@example.com', name: 'Sales', alias: true },
  ]);
  assert.equal(db.listAccounts()[0].identities.length, 2);

  let sentRaw = null;
  const actions = new Actions({ db, providers: () => ({ send: async ({ raw }) => { sentRaw = raw; return { id: 'x1' }; }, saveDraft: async () => ({ id: 'd1' }) }), onChange: () => {}, log: () => {} });
  const decode = () => Buffer.from(sentRaw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();

  await actions.send({ accountId: a.id, to: 'b@x.com', subject: 'Hi', text: 'hi' });
  assert.match(decode(), /^From: Alex <alex@example.com>$/m);         // default identity unchanged

  await actions.send({ accountId: a.id, from: 'sales@example.com', to: 'b@x.com', subject: 'Hi', text: 'hi' });
  assert.match(decode(), /^From: Sales <sales@example.com>$/m);       // sent as the alias

  await assert.rejects(() => actions.send({ accountId: a.id, from: 'someone@else.com', to: 'b@x.com', subject: 'Hi', text: 'hi' }),
    /not one of alex@example.com's addresses/);                          // never send as an address we don't own

  // a draft remembers which identity it was written as
  const d = await actions.saveDraft({ accountId: a.id, from: 'sales@example.com', to: 'b@x.com', subject: 'Later', bodyHtml: '<p>x</p>', bodyText: 'x' }, { syncRemote: false });
  assert.equal(db.getDraft(d.id).from, 'sales@example.com');

  // and an alias counts as "us" when deciding whether a thread got a reply
  assert.ok(actions.ownEmails().includes('sales@example.com'));
});

test('sync: new mail arrives DURING a long backfill, not after it', async () => {
  const { GmailError } = require('../electron/gmail/api');
  const db = new MailDb(':memory:');
  const a = db.addAccount({ email: 'a@x.com', tokenEnc: Buffer.from('plain:{}') });
  // a mailbox big enough to take several batches (BATCH = 40)
  const backlog = Array.from({ length: 60 }, (_, i) => msg('old' + i, ['INBOX']));   // the fake pages 2 at a time, so this is many passes
  const g = fakeGmail(backlog);
  const origGet = g.get.bind(g); g.get = async (p, q) => { try { return await origGet(p, q); } catch (e) { if (e.status === 404) throw new GmailError(404, 'not found'); throw e; } };

  const notified = [];
  let injected = false, storedWhenNotified = null;
  const s = new AccountSync({
    db, client: g, account: { id: a.id }, newMailCheckMs: 0,   // check on every batch
    onProgress: (p) => {
      // the buyer sends something once the backfill is under way but nowhere near done
      if (p.phase === 'initial' && p.synced >= 10 && !injected) {
        injected = true;
        g.store.set('fresh1', msg('fresh1', ['INBOX', 'UNREAD']));
        g.bump('messagesAdded', 'fresh1');
      }
    },
  });
  s.onNewMail = (ids) => { notified.push(...ids); storedWhenNotified = db.countMessages({ kind: 'all', accountId: a.id }); };

  await s.run();

  assert.deepEqual(notified, ['fresh1'], 'the new message was reported while the backfill was still running');
  assert.ok(storedWhenNotified > 0 && storedWhenNotified < 61, `it landed mid-backfill (${storedWhenNotified} of 61 stored at the time)`);
  assert.equal(db.getMessage(a.id, 'fresh1').unread, true);
  assert.equal(db.countMessages({ kind: 'all', accountId: a.id }), 61, 'and the backfill still completed');
  assert.equal(db.getAccount(a.id).initial_done, 1);

  // the finished backfill must not be reported as 141 new messages
  const p = new GmailProvider({ db: new MailDb(':memory:'), accountId: a.id, client: g });
  const db2 = p.db; db2.addAccount({ email: 'a@x.com', tokenEnc: Buffer.from('plain:{}') });
  let injected2 = false;
  const r = await p.sync((st) => {
    if (st.phase === 'initial' && st.synced >= 10 && !injected2) { injected2 = true; g.store.set('fresh2', msg('fresh2', ['INBOX', 'UNREAD'])); g.bump('messagesAdded', 'fresh2'); }
  }, { onNewMail: () => {} });
  p.syncer.newMailCheckMs = 0;
  assert.ok(!r.newInbox.includes('old7'), 'backfilled mail is not "new"');
  assert.ok(r.newInbox.length < 10, `only genuinely new mail is reported (${r.newInbox.length})`);
});

test('sync: the new-mail check keeps running while a backfill batch is stuck in a rate-limit back-off', async () => {
  const { GmailError, PRIORITY } = require('../electron/gmail/api');
  const db = new MailDb(':memory:');
  const a = db.addAccount({ email: 'a@x.com', tokenEnc: Buffer.from('plain:{}') });
  const g = fakeGmail(Array.from({ length: 12 }, (_, i) => msg('old' + i, ['INBOX'])));
  const origGet = g.get.bind(g); g.get = async (p, q, o) => { try { return await origGet(p, q, o); } catch (e) { if (e.status === 404) throw new GmailError(404, 'not found'); throw e; } };
  // the second backfill batch hits Gmail's per-minute limit and sits in the client's 15 s+ back-off (here: until we say so)
  let release; const stuck = new Promise(r => { release = r; });
  let batches = 0; const origBatch = g.batchGet.bind(g);
  g.batchGet = async (paths, o) => { if (paths.some(p => p.includes('/messages/old')) && ++batches === 2) await stuck; return origBatch(paths, o); };

  const notified = []; let notifiedWhileStuck = false, released = false;
  const s = new AccountSync({ db, client: g, account: { id: a.id }, newMailCheckMs: 20 });
  s.onNewMail = (ids) => { notified.push(...ids); if (!released) notifiedWhileStuck = true; };
  const run = s.run();
  setTimeout(() => { g.store.set('fresh1', msg('fresh1', ['INBOX', 'UNREAD'])); g.bump('messagesAdded', 'fresh1'); }, 30);   // arrives while batch 2 is stuck
  setTimeout(() => { released = true; release(); }, 250);
  await run;

  assert.deepEqual(notified, ['fresh1']);
  assert.ok(notifiedWhileStuck, 'the new message was reported while the backfill batch was still waiting');
  assert.equal(db.countMessages({ kind: 'all', accountId: a.id }), 13, 'and the backfill still completed');
  assert.equal(s.ticker, null, 'the timer stops with the backfill');
  const hist = g.calls.filter(c => c[0] === 'GET' && c[1] === '/history');
  assert.ok(hist.length >= 2 && hist.slice(0, -1).every(c => c[3]?.priority === PRIORITY.interactive), 'the mid-backfill checks do not queue behind the backfill');
  assert.equal(hist.at(-1)[3]?.priority, PRIORITY.background, 'the closing pass after the backfill is ordinary sync traffic');
  assert.ok(g.calls.filter(c => c[0] === 'BATCH').every(c => c[2]?.priority === PRIORITY.background || c[1] === 1), 'the backfill itself stays background');
});

test('sync: an expired history cursor mid-backfill re-pins and sweeps recent mail — no silence, no full resync after', async () => {
  const { GmailError } = require('../electron/gmail/api');
  const db = new MailDb(':memory:');
  const a = db.addAccount({ email: 'a@x.com', tokenEnc: Buffer.from('plain:{}') });
  const g = fakeGmail(Array.from({ length: 20 }, (_, i) => msg('old' + i, ['INBOX'])));
  let pinned = null, expired = false;
  const origGet = g.get.bind(g);
  g.get = async (p, q, o) => {
    if (p === '/profile' && !pinned) { const r = await origGet(p, q, o); pinned = r.historyId; return r; }
    if (p === '/history' && expired && q.startHistoryId === pinned) throw new GmailError(404, 'history expired');
    try { return await origGet(p, q, o); } catch (e) { if (e.status === 404) throw new GmailError(404, 'not found'); throw e; }
  };
  const notified = [], logs = []; let injected = false;
  const s = new AccountSync({
    db, client: g, account: { id: a.id }, newMailCheckMs: 0, log: (m) => logs.push(m),
    onProgress: (p) => { if (p.phase === 'initial' && p.synced >= 4 && !injected) { injected = true; expired = true; g.store.set('fresh1', msg('fresh1', ['INBOX', 'UNREAD'])); g.bump('messagesAdded', 'fresh1'); } },
  });
  s.onNewMail = (ids) => notified.push(...ids);
  await s.run();

  assert.deepEqual(notified, ['fresh1'], 'mail that arrived after the cursor died still showed up during the backfill');
  assert.ok(logs.some(l => /re-pinned/.test(l)), logs.join('\n'));
  assert.notEqual(db.getAccount(a.id).history_id, pinned, 'the cursor moved on');
  assert.equal(db.getAccount(a.id).initial_done, 1);
  assert.equal(db.countMessages({ kind: 'all', accountId: a.id }), 21);
  assert.equal(g.calls.filter(c => c[0] === 'GET' && c[1] === '/profile').length, 2, 'one re-pin, no full resync');
  assert.equal(db.getAccount(a.id).synced_count > 0, true);
});

test('quota budget: what the person is waiting for goes before the backfill', async () => {
  const { budget, PRIORITY } = require('../electron/gmail/api');
  budget.tokens = 0;                       // bucket empty, as it is mid-backfill
  budget.at = Date.now();
  const order = [];
  const bg1 = budget.take(200, PRIORITY.background).then(() => order.push('backfill-1'));
  const bg2 = budget.take(200, PRIORITY.background).then(() => order.push('backfill-2'));
  await new Promise(r => setTimeout(r, 30));
  const click = budget.take(5, PRIORITY.interactive).then(() => order.push('click'));
  await Promise.all([bg1, bg2, click]);
  assert.equal(order[0], 'click', 'the click is served first even though it arrived last');
  assert.deepEqual(order, ['click', 'backfill-1', 'backfill-2'], 'and the backfill keeps its own order');
});

test('counts: totals, unread, snoozed and trashed all land in the right place', () => {
  const db = new MailDb(':memory:');
  const a = db.addAccount({ email: 'a@x.com', tokenEnc: Buffer.from('plain:{}') });
  db.upsertMessages(a.id, [
    msg('c1', ['INBOX', 'UNREAD']),
    msg('c2', ['INBOX']),
    msg('c3', ['INBOX', 'UNREAD', 'STARRED']),
    msg('c4', ['TRASH', 'UNREAD']),          // trash doesn't count towards unread
    msg('c5', ['SENT']),
    msg('c6', ['INBOX', 'UNREAD']),          // about to be snoozed away
  ].map(normaliseMessage));
  db.applyLabelChange(a.id, ['c3'], { add: ['STARRED'] });
  db.setSnooze(a.id, ['c6'], Date.now() + 3600000);

  const c = db.counts();
  assert.equal(c.labels[a.id].INBOX.total, 3, 'inbox holds c1, c2, c3 — the snoozed one is hidden');
  assert.equal(c.labels[a.id].INBOX.unread, 2, 'c1 and c3; c6 is snoozed');
  assert.equal(c.favourites.inboxTotal, 3);
  assert.equal(c.favourites.inboxUnread, 2);
  assert.equal(c.favourites.unread, 2, 'the trashed unread one is not counted');
  assert.equal(c.favourites.starred, 1);
  assert.equal(c.favourites.snoozed, 1);
  assert.equal(c.labels[a.id].SENT.total, 1);

  // reading one, and waking the snoozed one, move the numbers
  db.applyLabelChange(a.id, ['c1'], { remove: ['UNREAD'] });
  db.setSnooze(a.id, ['c6'], null);        // it wakes
  const d = db.counts();
  assert.equal(d.favourites.inboxUnread, 2, 'c3 plus the woken c6');
  assert.equal(d.labels[a.id].INBOX.total, 4);
});

test('folder listing: the date carried on the label row stays true, and the index is used', () => {
  const db = new MailDb(':memory:');
  const a = db.addAccount({ email: 'a@x.com', tokenEnc: Buffer.from('plain:{}') });
  const at = (id, ts, labels) => ({ ...normaliseMessage(msg(id, labels)), internalDate: ts });
  db.upsertMessages(a.id, [at('f1', 3000, ['INBOX']), at('f2', 1000, ['INBOX']), at('f3', 2000, ['INBOX'])]);
  const dates = () => db.listMessages({ kind: 'label', accountId: a.id, labelId: 'INBOX' }, { limit: 10 }).map(m => m.date);
  assert.deepEqual(dates(), [3000, 2000, 1000], 'newest first');

  // a label added later carries that message's date, not the time it was filed
  db.upsertMessages(a.id, [at('f4', 2500, ['ARCHIVE'])]);
  db.applyLabelChange(a.id, ['f4'], { add: ['INBOX'] });
  assert.deepEqual(dates(), [3000, 2500, 2000, 1000], 'moved-in mail sorts by its own date');

  db.applyLabelChange(a.id, ['f1'], { remove: ['INBOX'] });
  assert.deepEqual(dates(), [2500, 2000, 1000], 'and leaves when the label goes');

  // re-syncing a message with a corrected date updates the label rows too
  db.upsertMessages(a.id, [at('f2', 9000, ['INBOX'])]);
  assert.deepEqual(dates(), [9000, 2500, 2000], 'a changed date re-sorts');
  assert.equal(db.prep('SELECT count(*) AS n FROM message_labels WHERE d IS NULL').get().n, 0, 'never left unset');

  const plan = db.prep('EXPLAIN QUERY PLAN ' +
    `SELECT m.rid FROM messages m JOIN message_labels ml ON ml.account_id = m.account_id AND ml.message_id = m.id AND ml.label_id = ?
     WHERE m.account_id = ? AND m.snooze_until IS NULL ORDER BY ml.d DESC LIMIT 100`).all('INBOX', a.id).map(r => r.detail).join(' | ');
  assert.match(plan, /message_labels_date/, 'walks the folder index');
  assert.doesNotMatch(plan, /TEMP B-TREE/, 'and never sorts the whole folder to take one page');
});

test('opening a message: slow inline images do not hold it up, they arrive after', async () => {
  const db = new MailDb(':memory:');
  const a = db.addAccount({ email: 'a@x.com', tokenEnc: Buffer.from('plain:{}') });
  db.upsertMessages(a.id, [normaliseMessage(msg('big', ['INBOX']))]);

  const slow = new Map();                       // contentId → resolve fn, for the ones we hold back
  let live = 0, peak = 0;
  const atts = Array.from({ length: 12 }, (_, i) => ({ contentId: 'img' + i, mimeType: 'image/png', size: 900, attachmentId: 'at' + i }));
  const html = '<p>hello</p>' + atts.map(x => `<img src="cid:${x.contentId}">`).join('');
  const provider = {
    fetchFull: async () => ({
      meta: null, html, text: 'hello', calendar: null, attachments: atts,
      inlineData: async (x) => {
        live++; peak = Math.max(peak, live);
        try {
          const n = Number(x.contentId.slice(3));
          if (n >= 9) await new Promise(r => slow.set(x.contentId, r));   // three that never finish in time
          return Buffer.from('png' + n);
        } finally { live--; }
      },
    }),
  };
  const updated = [];
  const actions = new Actions({ db, providers: () => provider, onChange: () => {}, onMessageUpdated: (acc, id) => updated.push(id), log: () => {} });

  const t0 = Date.now();
  const m = await actions.getMessage(a.id, 'big');
  const took = Date.now() - t0;

  assert.ok(took < 4000, `the message came back without waiting for the stuck images (${took}ms)`);
  assert.ok(peak <= 5, `no more than five images in flight at once (peak ${peak})`);
  assert.match(m.bodyHtml, /data:image\/png;base64/, 'the images that arrived are embedded');
  assert.match(m.bodyHtml, /cid:img9/, 'the stuck ones are still placeholders for now');
  assert.equal(m.attachments.filter(x => !x.inline).length, 0, 'inline images never show up as attachments');
  assert.deepEqual(updated, [], 'nothing announced yet');

  for (const [, r] of slow) r();                 // the slow ones finally answer
  await new Promise(r => setTimeout(r, 120));
  assert.deepEqual(updated, ['big'], 'the window is told once');
  const after = db.getMessage(a.id, 'big');
  assert.doesNotMatch(after.bodyHtml, /cid:img/, 'and every image is embedded in the stored copy');
});

test('read-ahead picks the right messages and stays quiet', async () => {
  const db = new MailDb(':memory:');
  const a = db.addAccount({ email: 'a@x.com', tokenEnc: Buffer.from('plain:{}') });
  const at = (id, ts, labels, size = 1000) => ({ ...normaliseMessage(msg(id, labels)), internalDate: ts, size });
  db.upsertMessages(a.id, [
    at('p1', 5000, ['INBOX']), at('p2', 4000, ['INBOX']), at('p3', 3000, ['INBOX']),
    at('huge', 4500, ['INBOX'], 9 * 1024 * 1024),     // too big to read ahead
    at('sent', 4800, ['SENT']),                        // not the inbox
    at('zzz', 4900, ['INBOX']),                        // snoozed away
  ]);
  db.setSnooze(a.id, ['zzz'], Date.now() + 3600000);
  assert.deepEqual(db.bodiesToPrefetch(a.id, 10), ['p1', 'p2', 'p3'], 'newest inbox first, nothing oversized or snoozed');
  assert.deepEqual(db.bodiesToPrefetch(a.id, 2), ['p1', 'p2'], 'and only as many as asked for');

  let changes = 0, askedPriority;
  const provider = { fetchFull: async (id, opts) => { askedPriority = opts?.priority; return { meta: null, html: '<p>body</p>', text: 'body', calendar: null, attachments: [], inlineData: async () => Buffer.alloc(0) }; } };
  const actions = new Actions({ db, providers: () => provider, onChange: () => { changes++; }, log: () => {} });

  const { PRIORITY } = require('../electron/gmail/api');
  await actions.getMessage(a.id, 'p1', { priority: PRIORITY.prefetch, quiet: true });
  assert.equal(askedPriority, PRIORITY.prefetch, 'read-ahead asks in the lowest lane');
  assert.equal(changes, 0, 'and does not churn the message list');
  assert.deepEqual(db.bodiesToPrefetch(a.id, 10), ['p2', 'p3'], 'a fetched body drops off the queue');

  await actions.getMessage(a.id, 'p2');              // a real click
  assert.equal(changes, 1, 'which does notify');
});

test('folder counters survive churn and match a real count', () => {
  const db = new MailDb(':memory:');
  const a = db.addAccount({ email: 'a@x.com', tokenEnc: Buffer.from('plain:{}') });
  const LAB = ['INBOX', 'SENT', 'TRASH', 'SPAM', 'UNREAD', 'STARRED', 'Work', 'Bills'];
  const mk = (i, labels) => normaliseMessage(msg('c' + i, labels));
  for (let i = 0; i < 400; i++) db.upsertMessages(a.id, [mk(i, [LAB[i % 8], 'INBOX'])]);
  assert.deepEqual(db.labelCountDrift(), [], 'correct from the start');

  // every kind of change that can move a count
  let seed = 3; const rnd = (n) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
  for (let i = 0; i < 3000; i++) {
    const id = 'c' + rnd(400);
    switch (rnd(6)) {
      case 0: db.upsertMessages(a.id, [mk(Number(id.slice(1)), [LAB[rnd(8)], LAB[rnd(8)]])]); break;
      case 1: db.applyLabelChange(a.id, [id], { add: [LAB[rnd(8)]] }); break;
      case 2: db.applyLabelChange(a.id, [id], { remove: [LAB[rnd(8)]] }); break;
      case 3: db.applyLabelChange(a.id, [id], rnd(2) ? { add: ['UNREAD'] } : { remove: ['UNREAD'] }); break;
      case 4: db.setSnooze(a.id, [id], rnd(2) ? Date.now() + 3600000 : null); break;
      case 5: db.deleteMessages(a.id, [id]); break;
    }
  }
  assert.deepEqual(db.labelCountDrift(), [], 'still correct after 3,000 random changes');

  // and the sidebar figures derived from them
  const c = db.counts();
  const real = db.prep(`SELECT
    (SELECT count(*) FROM messages m WHERE m.unread = 1 AND m.snooze_until IS NULL AND NOT EXISTS (SELECT 1 FROM message_labels x WHERE x.account_id=m.account_id AND x.message_id=m.id AND x.label_id IN ('TRASH','SPAM'))) AS unread,
    (SELECT count(*) FROM messages m WHERE m.starred = 1 AND NOT EXISTS (SELECT 1 FROM message_labels x WHERE x.account_id=m.account_id AND x.message_id=m.id AND x.label_id IN ('TRASH','SPAM'))) AS starred,
    (SELECT count(*) FROM messages m WHERE m.snooze_until IS NOT NULL) AS snoozed`).get();
  assert.equal(c.favourites.unread, real.unread, 'unread matches the slow way of counting it');
  assert.equal(c.favourites.starred, real.starred, 'flagged too');
  assert.equal(c.favourites.snoozed, real.snoozed);
  const inbox = db.prep(`SELECT count(*) AS n FROM message_labels ml JOIN messages m ON m.account_id=ml.account_id AND m.id=ml.message_id WHERE ml.label_id='INBOX' AND m.snooze_until IS NULL`).get().n;
  assert.equal(c.favourites.inboxTotal, inbox, 'and the inbox total');

  // a deliberately corrupted counter is spotted and repaired
  db.prep("UPDATE label_counts SET unread = unread + 7 WHERE label_id = 'INBOX'").run();
  assert.equal(db.labelCountDrift().length, 1, 'drift is detected');
  db.recountLabels();
  assert.deepEqual(db.labelCountDrift(), [], 'and repaired');
});

test('conversation view: walking the index agrees with grouping in SQL', () => {
  const db = new MailDb(':memory:');
  const a = db.addAccount({ email: 'a@x.com', tokenEnc: Buffer.from('plain:{}') });
  const b = db.addAccount({ email: 'b@x.com', tokenEnc: Buffer.from('plain:{}') });
  const at = (acc, id, ts, thread, labels) => db.upsertMessages(acc, [{ ...normaliseMessage(msg(id, labels)), internalDate: ts, threadId: thread }]);
  // a mix: lone messages, a long thread, a thread whose newest message is binned, one with no thread at all
  for (let i = 0; i < 60; i++) at(a.id, 'w' + i, 10000 + i, i % 5 === 0 ? 'long' : 'solo' + i, i % 7 === 0 ? ['INBOX', 'UNREAD'] : ['INBOX']);
  at(a.id, 'gone', 99000, 'long', ['TRASH']);
  at(a.id, 'nothread', 98000, null, ['INBOX']);
  at(b.id, 'other', 97000, 'bthread', ['INBOX', 'UNREAD']);

  for (const v of [{ kind: 'all-inboxes' }, { kind: 'label', accountId: a.id, labelId: 'INBOX' }, { kind: 'unread' }]) {
    for (const page of [{ offset: 0, limit: 10 }, { offset: 5, limit: 10 }, { offset: 0, limit: 100 }]) {
      const fast = db.listThreads(v, page);
      const slow = db._listThreadsGrouped(v, page);
      const shape = (rows) => rows.map(r => `${r.accountId}:${r.id}:${r.threadCount || 1}:${r.threadUnread || 0}`);
      assert.deepEqual(shape(fast), shape(slow), `${v.kind} ${JSON.stringify(page)}`);
    }
  }
  // the long thread is one row, counted over the view (its binned message doesn't count)
  const inbox = db.listThreads({ kind: 'label', accountId: a.id, labelId: 'INBOX' }, { limit: 100 });
  const long = inbox.find(r => r.threadId === 'long');
  assert.equal(long.threadCount, 12, 'twelve of the long thread are in the inbox');
  assert.equal(inbox.filter(r => r.threadId === 'long').length, 1, 'and it appears once');
  assert.ok(inbox.some(r => r.id === 'nothread'), 'a message with no thread still shows');
});

test('quota: Gmail pushing back slows everything down, and the speed comes back', async () => {
  const { GmailClient, budget, PRIORITY } = require('../electron/gmail/api');
  budget.rate = 200; budget.pushbackAt = 0; budget.recoverAt = 0; budget.tokens = 400; budget.at = Date.now(); budget.waiting = [];

  let calls = 0;
  const quota = { ok: false, status: 429, headers: { get: () => null }, text: async () => JSON.stringify({ error: { message: "Quota exceeded for quota metric 'Total Query Cost'", errors: [{ reason: 'rateLimitExceeded' }] } }) };
  const fine = { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ id: 'x' }), text: async () => '{}' };
  const c = new GmailClient({ getAccessToken: async () => 't', forceRefresh: async () => 't' },
    { fetchImpl: async () => (++calls === 1 ? quota : fine), log: () => {} });

  const before = budget.rate;
  await c.get('/messages/abc', { format: 'full' }, { priority: PRIORITY.interactive });
  assert.equal(budget.rate, before / 2, 'one knock-back halves the rate');
  assert.equal(budget.limited, true, 'and read-ahead knows to stand down');
  assert.equal(calls, 2, 'the request itself still succeeded on the retry');

  const afterOne = budget.rate;
  budget.penalise(); budget.penalise(); budget.penalise();
  assert.equal(budget.rate, afterOne, 'a burst of failures counts as one episode, not four');
  budget.pushbackAt = Date.now() - 5000;
  budget.penalise();
  assert.equal(budget.rate, Math.round(afterOne / 2), 'a later episode does slow it again');
  for (let i = 0; i < 10; i++) { budget.pushbackAt = Date.now() - 5000; budget.penalise(); }
  assert.ok(budget.rate >= 40, 'but it never slows below a floor');

  // a quiet minute earns speed back
  budget.pushbackAt = budget.recoverAt = Date.now() - 61000;
  const slow = budget.rate;
  budget.pump();
  assert.ok(budget.rate > slow, `climbs back up (${slow} → ${budget.rate})`);
  assert.equal(budget.limited, false, 'and read-ahead is allowed again');

  // what the person sees is never Google's raw sentence
  const always = new GmailClient({ getAccessToken: async () => 't', forceRefresh: async () => 't' },
    { fetchImpl: async () => quota, log: () => {} });
  budget.rate = 200; budget.tokens = 400; budget.at = Date.now();
  await assert.rejects(() => always.get('/messages/abc', null, { priority: PRIORITY.interactive, retries: 0 }),
    (e) => { assert.match(e.message, /limiting how fast/); assert.doesNotMatch(e.message, /quota metric/); return true; });
  budget.rate = 200; budget.pushbackAt = 0; budget.recoverAt = 0; budget.tokens = 400;
});

test('editing the quoted original sends exactly what leaving it alone would', async () => {
  const db = new MailDb(':memory:');
  const a = db.addAccount({ email: 'a@x.com', displayName: 'Alex', tokenEnc: Buffer.from('plain:{}') });
  let raw = null;
  const actions = new Actions({ db, providers: () => ({ send: async (m) => { raw = m.raw; return { id: 's1' }; } }), onChange: () => {}, log: () => {} });
  const decode = () => Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
  const body = '<p>Yes, still in stock.</p>';
  const quote = '<div>On Tue, someone wrote:</div><blockquote>Is it available?</blockquote>';

  // as the compose window sends it when the quote is left in its box
  await actions.send({ accountId: a.id, to: 'b@x.com', subject: 'Re: stock', html: body, text: 'Yes, still in stock.', quotedHtml: quote, quotedText: '> Is it available?' });
  const untouched = decode();

  // and after "Edit it" folds the quote into the message, exactly as the button does
  await actions.send({ accountId: a.id, to: 'b@x.com', subject: 'Re: stock', html: `${body}<br><div class="tomail_quote">${quote}</div>`, text: 'Yes, still in stock.' });
  const edited = decode();

  // compare the html part itself; the MIME boundary is random per message
  const htmlPart = (s) => s.slice(s.indexOf('<p>Yes')).replace(/=\r?\n/g, '').replace(/\s+/g, ' ').split('----')[0].trim();
  assert.equal(htmlPart(edited), htmlPart(untouched), 'the html that goes out is the same either way');
  assert.match(edited, /tomail_quote/);
  assert.match(edited, /Is it available\?/);
});

test('proton: bridge settings, and the self-signed exception is loopback only', async () => {
  const { autoconfig, isLoopback, tlsFor } = require('../electron/providers/imap');

  for (const addr of ['me@proton.me', 'me@protonmail.com', 'me@pm.me', 'me@protonmail.ch']) {
    const c = await autoconfig(addr);
    assert.equal(c.host, '127.0.0.1', `${addr} points at Bridge, not at a Proton server`);
    assert.equal(c.port, 1143);
    assert.equal(c.secure, false, 'Bridge speaks STARTTLS on 1143');
    assert.equal(c.smtpHost, '127.0.0.1');
    assert.equal(c.smtpPort, 1025);
    assert.match(c.note, /Bridge/, 'and says what to install');
  }

  // Bridge serves a self-signed certificate; only a connection that never leaves the machine may accept one.
  for (const h of ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]']) {
    assert.equal(isLoopback(h), true, h);
    assert.equal(tlsFor(h).tls.rejectUnauthorized, false, h);
  }
  for (const h of ['imap.gmail.com', 'mail.proton.me', '127.0.0.1.evil.com', 'notlocalhost', 'localtest.me', '', null, '10.0.0.1']) {
    assert.equal(isLoopback(h), false, String(h));
    assert.equal(tlsFor(h).tls, undefined, `${h} must still be verified`);
  }
});
