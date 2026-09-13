import { test } from 'node:test';
import assert from 'node:assert/strict';
// util.js is an ES module for the renderer; parseSearch has no DOM dependencies.
const { parseSearch } = await import('../src/util.js');
test('search operators parse into filters + free text', () => {
  const r = parseSearch('from:bob has:attachment is:unread after:2026-01-05 in:Invoices quarterly "exact phrase"', [{ id: 'L1', name: 'Invoices' }]);
  assert.equal(r.filters.from, 'bob'); assert.equal(r.filters.hasAttachment, true); assert.equal(r.filters.unread, true); assert.equal(r.filters.labelId, 'L1');
  assert.equal(new Date(r.filters.after).getDate(), 5);
  assert.equal(r.text, 'quarterly "exact phrase"');
  assert.equal(parseSearch('in:nowhere hello').text, 'in:nowhere hello', 'unknown folder stays as text');
});
