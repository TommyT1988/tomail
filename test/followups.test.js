'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MailDb } = require('../electron/db');
const { parseAuthResults } = require('../electron/authResults');
const { Actions } = require('../electron/actions');

const mk = (id, date, fromEmail, labels, extra = {}) => ({ id, threadId: extra.threadId || id, internalDate: date, size: 1, snippet: '', subject: 's', fromName: '', fromEmail, to: extra.to || [], cc: [], labels, messageIdHdr: `<${id}@x>`, inReplyTo: extra.inReplyTo || null, references: extra.references || null, hasAttachment: !!extra.att, auth: extra.auth });

test('follow-ups: resolved by a reply from someone else, due when overdue, ignored own replies', () => {
  const db = new MailDb(':memory:');
  const a = db.addAccount({ email: 'me@x.com', tokenEnc: Buffer.from('plain:{}') });
  const now = Date.now();
  db.upsertMessages(a.id, [mk('s1', now - 5000, 'me@x.com', ['SENT'], { threadId: 'T' })]);
  const act = new Actions({ db, providers: () => ({}), onChange: () => {} });
  const f1 = act.addFollowup(a.id, 's1', now - 1);       // already overdue
  const f2 = db.addFollowup({ accountId: a.id, threadId: 'U', messageIdHdr: '<s2@x>', subject: 'other', to: 'b@y', dueAt: Date.now() + 86400000 });
  // our own follow-up in the thread must not count as a reply
  db.upsertMessages(a.id, [mk('s1b', now + 1000, 'me@x.com', ['SENT'], { threadId: 'T' })]);
  let due = act.checkFollowups();
  assert.equal(due.length, 1); assert.equal(db.getFollowup(f1.id).status, 'due');
  db.upsertMessages(a.id, [mk('r1', now + 3000, 'them@z.com', ['INBOX'], { threadId: 'T' })]);
  act.checkFollowups();
  assert.equal(db.getFollowup(f1.id).status, 'replied'); assert.equal(db.getFollowup(f1.id).repliedBy, 'them@z.com');
  // IMAP-style: no shared thread id, reply references our Message-ID
  db.upsertMessages(a.id, [mk('r2', Date.now() + 1, 'c@w.com', ['INBOX'], { threadId: 'zzz', references: '<s2@x>' })]);
  act.checkFollowups();
  assert.equal(db.getFollowup(f2).status, 'replied');
  assert.equal(db.listFollowups().length, 0, 'resolved ones leave the list');
});

test('sender info: counts, reply time, first contact, spam history', () => {
  const db = new MailDb(':memory:');
  const a = db.addAccount({ email: 'me@x.com', tokenEnc: Buffer.from('plain:{}') });
  const H = 3600000;
  db.upsertMessages(a.id, [
    mk('a1', 10 * H, 'ann@z.com', ['INBOX'], { threadId: 'T1', att: true }),
    mk('me1', 12 * H, 'me@x.com', ['SENT'], { threadId: 'T1', to: [{ name: 'Ann', email: 'ann@z.com' }] }),
    mk('a2', 20 * H, 'ann@z.com', ['INBOX'], { threadId: 'T2' }),
    mk('me2', 26 * H, 'me@x.com', ['SENT'], { threadId: 'T2', to: [{ email: 'ann@z.com' }] }),
    mk('junk', 30 * H, 'ann@z.com', ['SPAM'], { threadId: 'T3' }),
    mk('n1', 40 * H, 'new@q.com', ['INBOX'], { threadId: 'T4' }),
  ]);
  const ann = db.senderInfo('Ann@Z.com', ['me@x.com']);
  assert.equal(ann.received, 3); assert.equal(ann.sentTo, 2); assert.equal(ann.repliedCount, 2); assert.equal(ann.avgReplyMs, 4 * H); assert.equal(ann.attachments, 1); assert.equal(ann.spam, 1); assert.equal(ann.firstSeen, 10 * H);
  const nu = db.senderInfo('new@q.com', ['me@x.com']);
  assert.equal(nu.received, 1); assert.equal(nu.sentTo, 0); assert.equal(nu.avgReplyMs, null);
  assert.equal(db.senderInfo('me@x.com', ['me@x.com']).isOwn, true);
});

test('authentication-results parsing', () => {
  assert.deepEqual(parseAuthResults('mx.google.com; dkim=pass header.i=@x.com; spf=pass (google.com: domain of a@x.com designates 1.2.3.4 as permitted sender) smtp.mailfrom=a@x.com; dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=x.com'), { dkim: 'pass', spf: 'pass', dmarc: 'pass' });
  assert.deepEqual(parseAuthResults('mx; spf=softfail smtp.mailfrom=z; dkim=fail'), { dkim: 'fail', spf: 'softfail', dmarc: null });
  assert.equal(parseAuthResults(''), null);
});
