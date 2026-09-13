'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MailDb } = require('../electron/db');
const { matches, plan, runRules } = require('../electron/rules');

const m = { accountId: 1, id: 'x', fromName: 'Parcelio', fromEmail: 'noreply@parcelio.example', to: [{ email: 'me@x' }], cc: [], subject: 'Collection confirmed', snippet: 'Your parcel', hasAttachment: false, labels: ['INBOX', 'UNREAD'] };

test('rules: matching (all/any, ops) and planning', () => {
  const r = { enabled: true, match: 'all', conditions: [{ field: 'from', op: 'contains', value: 'parcelio.example' }, { field: 'subject', op: 'startsWith', value: 'collection' }], actions: [{ type: 'moveTo', labelId: 'L1' }, { type: 'markRead' }] };
  assert.equal(matches(r, m), true);
  assert.equal(matches({ ...r, conditions: [...r.conditions, { field: 'hasAttachment', value: 'yes' }] }, m), false);
  assert.equal(matches({ ...r, match: 'any', conditions: [{ field: 'body', op: 'contains', value: 'nothing' }, { field: 'any', op: 'regex', value: 'parc.l' }] }, m), true);
  const p = plan([r, { enabled: true, match: 'all', conditions: [{ field: 'from', op: 'contains', value: 'parcelio' }], actions: [{ type: 'star' }] }], m);
  assert.deepEqual([...p.add].sort(), ['L1', 'STARRED']); assert.deepEqual([...p.remove].sort(), ['INBOX', 'UNREAD']); assert.equal(p.matched.length, 2);
  const stop = plan([{ ...r, actions: [{ type: 'archive' }, { type: 'stop' }] }, { enabled: true, match: 'all', conditions: [{ field: 'from', op: 'contains', value: 'parcelio' }], actions: [{ type: 'star' }] }], m);
  assert.equal(stop.matched.length, 1, 'stop halts later rules');
  assert.equal(plan([{ ...r, accountId: 2 }], m).matched.length, 0, 'account-scoped rule ignores other accounts');
});

test('rules: runRules groups identical changes and applies through actions.modify', async () => {
  const db = new MailDb(':memory:');
  const a = db.addAccount({ email: 'a@x.com', tokenEnc: Buffer.from('plain:{}') });
  db.saveRule({ name: 'dpd', enabled: true, match: 'all', conditions: [{ field: 'from', op: 'contains', value: 'parcelio' }], actions: [{ type: 'moveTo', labelId: 'L1' }] });
  const rows = ['m1', 'm2', 'm3'].map((id, i) => ({ id, threadId: id, internalDate: i, size: 1, snippet: '', subject: 's', fromName: '', fromEmail: i < 2 ? 'x@parcelio.example' : 'y@other', to: [], cc: [], labels: ['INBOX'] }));
  db.upsertMessages(a.id, rows);
  const calls = [];
  const actions = { modify: async (t, ch) => { calls.push({ ids: t.map(x => x.id).sort(), ch }); } };
  const r = await runRules({ db, actions, accountId: a.id, ids: ['m1', 'm2', 'm3'] });
  assert.equal(r.applied, 2); assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].ids, ['m1', 'm2']); assert.deepEqual(calls[0].ch, { add: ['L1'], remove: ['INBOX'] });
});

test('contacts: harvested from sent recipients + senders, searchable, ranked', () => {
  const db = new MailDb(':memory:');
  const a = db.addAccount({ email: 'a@x.com', tokenEnc: Buffer.from('plain:{}') });
  const mk = (id, labels, fromEmail, to) => ({ id, threadId: id, internalDate: 1, size: 1, snippet: '', subject: '', fromName: fromEmail === 'noreply@shop.com' ? 'Shop' : 'Ann Smith', fromEmail, to, cc: [], labels });
  db.upsertMessages(a.id, [mk('s1', ['SENT'], 'a@x.com', [{ name: 'Bob Jones', email: 'Bob@Y.com' }]), mk('s2', ['SENT'], 'a@x.com', [{ name: '', email: 'bob@y.com' }]), mk('r1', ['INBOX'], 'ann@z.com', []), mk('r2', ['INBOX'], 'noreply@shop.com', [])]);
  const bob = db.searchContacts('bo'); assert.equal(bob[0].email, 'bob@y.com'); assert.equal(bob[0].name, 'Bob Jones'); assert.equal(bob[0].sent_count, 2);
  assert.equal(db.searchContacts('smith')[0].email, 'ann@z.com');
  assert.equal(db.searchContacts('noreply').length, 0, 'no-reply addresses skipped');
});

test('outbox: enqueue, due, fail/backoff, remove', () => {
  const db = new MailDb(':memory:');
  const a = db.addAccount({ email: 'a@x.com', tokenEnc: Buffer.from('plain:{}') });
  const id = db.enqueueOutbox(a.id, { accountId: a.id, to: 'x@y', subject: 'hi', text: 'body' }, 'fetch failed');
  assert.equal(db.listOutbox().length, 1);
  assert.equal(db.dueOutbox(Date.now()).length, 0, 'first retry is a minute later');
  assert.equal(db.dueOutbox(Date.now() + 120000).length, 1);
  db.outboxFailed(id, 'still down'); assert.equal(db.getOutbox(id).attempts, 2);
  db.removeOutbox(id); assert.equal(db.listOutbox().length, 0);
});

test('housekeeping: pruneBodies keeps flagged/snoozed and recent bodies', () => {
  const db = new MailDb(':memory:');
  const a = db.addAccount({ email: 'a@x.com', tokenEnc: Buffer.from('plain:{}') });
  const old = Date.now() - 200 * 86400000;
  const mk = (id, date, labels) => ({ id, threadId: id, internalDate: date, size: 1, snippet: '', subject: 's', fromName: '', fromEmail: 'x@y', to: [], cc: [], labels });
  db.upsertMessages(a.id, [mk('old', old, ['INBOX']), mk('oldstar', old, ['INBOX', 'STARRED']), mk('new', Date.now(), ['INBOX'])]);
  const word = { old: 'quokka', oldstar: 'wombat', new: 'numbat' };
  for (const id of ['old', 'oldstar', 'new']) db.setBody(a.id, id, { text: 'x'.repeat(200) + ' ' + word[id], html: '<p>x</p>', attachments: [] });
  assert.equal(db.pruneBodies(90), 1);
  assert.equal(db.getMessage(a.id, 'old').bodyFetched, false); assert.equal(db.getMessage(a.id, 'oldstar').bodyFetched, true); assert.equal(db.getMessage(a.id, 'new').bodyFetched, true);
  assert.equal(db.listMessages({ kind: 'search', q: 'quokka' }).length, 0, 'pruned body leaves the index (snippet is kept)');
  assert.equal(db.listMessages({ kind: 'search', q: 'wombat' }).length, 1, 'flagged body still indexed');
  assert.equal(db.stats().bodies, 2);
});
