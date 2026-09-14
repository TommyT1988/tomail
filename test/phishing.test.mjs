import { test } from 'node:test';
import assert from 'node:assert/strict';
const { analyse } = await import('../src/phishing.js');
test('phishing: clean mail is clean', () => {
  assert.equal(analyse({ fromName: 'Ann', fromEmail: 'ann@example.com', bodyHtml: '<p>hi <a href="https://example.com/x">example.com</a></p>', bodyText: 'hi', auth: { spf: 'pass', dkim: 'pass' } }).level, 'none');
});
test('phishing: brand display name with foreign address, look-alike link, auth failure, mismatched link text', () => {
  const r = analyse({ fromName: 'PayPal', fromEmail: 'security@mail-verify.ru', bodyHtml: '<a href="http://paypa1-secure.ru/login">https://www.paypal.com/signin</a>', bodyText: 'Verify your account within 24 hours', auth: { spf: 'fail' }, senderFirstContact: true });
  assert.equal(r.level, 'danger');
  assert.ok(r.reasons.some(x => /authentication failed/i.test(x)));
  assert.ok(r.reasons.some(x => /Display name says/.test(x)));
  assert.ok(r.reasons.some(x => /go somewhere else|looks like|points at/.test(x)));
  assert.ok(r.reasons.some(x => /Urgent/.test(x)));
});
test('phishing: reply-to elsewhere is only a warning', () => {
  const r = analyse({ fromName: 'Sam', fromEmail: 'sam@acme.co.uk', replyTo: 'sam.acme@gmail.com', bodyHtml: '', bodyText: 'see attached' });
  assert.equal(r.level, 'warn');
});
