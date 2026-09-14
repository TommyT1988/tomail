'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cleanUrl } = require('../electron/links');
const { evaluate, LIST } = require('../electron/achievements');
const { MailDb } = require('../electron/db');

test('links: tracking params stripped, redirectors unwrapped, non-http untouched', () => {
  assert.equal(cleanUrl('https://shop.example/p?id=5&utm_source=nl&utm_campaign=x&fbclid=abc'), 'https://shop.example/p?id=5');
  assert.equal(cleanUrl('https://www.google.com/url?q=https%3A%2F%2Fexample.org%2Fa%3Futm_medium%3Dmail%26x%3D1&sa=D'), 'https://example.org/a?x=1');
  assert.equal(cleanUrl('https://eur01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fexample.com%2Fdoc&data=05'), 'https://example.com/doc');
  assert.equal(cleanUrl('mailto:a@b.com?subject=hi'), 'mailto:a@b.com?subject=hi');
  assert.equal(cleanUrl('https://x.example/path'), 'https://x.example/path');
});

test('achievements: evaluate against activity, never re-award', () => {
  const a = { sentWeek: 12, sentTotal: 100, inboxUnread: 0, inboxTotal: 40, rules: 5, earliestSentHour: 6, latestSentHour: 20, archivedTotal: 150, snoozedTotal: 0, followupsDone: 0 };
  const ids = evaluate(a, {}).map(x => x.id);
  assert.deepEqual(ids.sort(), ['archived-100', 'early-bird', 'inbox-zero', 'replies-10', 'rules-5']);
  assert.deepEqual(evaluate(a, Object.fromEntries(ids.map(i => [i, 1]))), []);
  assert.ok(LIST.every(x => x.id && x.title && x.body));
});

test('scheduled + snippets tables', () => {
  const db = new MailDb(':memory:');
  const a = db.addAccount({ email: 'a@x.com', tokenEnc: Buffer.from('plain:{}') });
  const id = db.addScheduled(a.id, { accountId: a.id, to: 'b@y', subject: 'later' }, Date.now() + 60000);
  assert.equal(db.dueScheduled(Date.now()).length, 0); assert.equal(db.dueScheduled(Date.now() + 120000).length, 1);
  db.updateScheduled(id, Date.now() - 1); assert.equal(db.dueScheduled(Date.now())[0].payload.subject, 'later');
  db.removeScheduled(id); assert.equal(db.listScheduled().length, 0);
  const sid = db.saveSnippet({ trigger: ';thanks', name: 'Thanks', bodyHtml: 'Hi {{firstName}}' });
  assert.equal(db.listSnippets()[0].trigger, 'thanks');
  assert.throws(() => db.saveSnippet({ trigger: 'thanks', name: 'dup', bodyHtml: '' }), /UNIQUE/);
  db.deleteSnippet(sid); assert.equal(db.listSnippets().length, 0);
});
