'use strict';
// Seeds an in-memory mailbox so the UI can be exercised without Google (MAIL_DEMO=1).
const { textToHtml } = require('./gmail/mime');

function seedDemo(db) {
  const a1 = db.addAccount({ email: 'alex@example.com', displayName: 'Alex', tokenEnc: Buffer.from('plain:{}') });
  const a2 = db.addAccount({ email: 'shop@example.com', displayName: 'Shop', tokenEnc: Buffer.from('plain:{}') });
  const sys = ['INBOX', 'SENT', 'DRAFT', 'TRASH', 'SPAM', 'STARRED', 'UNREAD', 'IMPORTANT', 'CATEGORY_PERSONAL', 'CATEGORY_SOCIAL', 'CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS']
    .map(id => ({ id, name: id, type: 'system' }));
  const user = ['Customers', 'Customers/Amazon', 'Customers/eBay', 'Couriers', 'Family', 'Family/Sam', 'Finance', 'Finance/Invoices', 'Finance/PayPal',
    'Newsletters', 'Projects', 'Projects/House', 'Projects/Website', 'Receipts', 'Returns', 'Travel']
    .map((name, i) => ({ id: 'Label_' + (i + 1), name, type: 'user' }));
  db.replaceLabels(a1.id, [...sys, ...user]);
  db.replaceLabels(a2.id, sys);
  const L = Object.fromEntries(user.map(l => [l.name, l.id]));

  const today = new Date(); today.setHours(12, 18, 0, 0);
  const t = (h, m, daysAgo = 0) => { const d = new Date(today); d.setDate(d.getDate() - daysAgo); d.setHours(h, m, 0, 0); return d.getTime(); };
  const rows = [
    ['Northwind Supplies', 'orders@northwind.example', 'New stock: desk lamps, cable tidies and monitor arms', t(10, 1), 316000, false, ['INBOX', 'CATEGORY_PROMOTIONS'], true],
    ["'PayFast' via Shop", 'shop@example.com', 'Tools built for business', t(10, 9), 66000, false, ['INBOX', 'CATEGORY_PROMOTIONS']],
    ['Auction Central', 'noreply@auctioncentral.example', 'Europe auctions are closing soon – place your bids now!', t(10, 22), 145000, false, ['INBOX', 'CATEGORY_PROMOTIONS']],
    ['Orbit Mobile', 'hello@orbitmobile.example', 'Your new rewards have landed, Alex', t(10, 41), 69000, true, ['INBOX', 'UNREAD', 'CATEGORY_PROMOTIONS']],
    ["'PayPal' via Shop", 'service@paypal.example', 'Receipt for your payment to Harbour Distribution', t(10, 41), 55000, false, ['INBOX', L['Finance/PayPal']]],
    ['Brightside Wholesale', 'offers@brightside.example', 'Stocklist 16-06: power supplies, docking stations and cables', t(10, 44), 78000, true, ['INBOX', 'UNREAD'], true],
    ["'Marina Kit' via Shop", 'news@marinakit.example', 'Popular marine and camping accessories', t(10, 47), 28000, true, ['INBOX', 'UNREAD', 'CATEGORY_PROMOTIONS']],
    ['Retail Weekly', 'news@retailweekly.example', 'High street chain narrows losses as turnaround takes hold', t(10, 49), 63000, true, ['INBOX', 'UNREAD']],
    ['Priya Nair', 'priya@recycletech.example', 'Refurbished laptops – Standard, Plus & Pro grades available', t(10, 52), 17000, true, ['INBOX', 'UNREAD']],
    ['info@softdeals.example', 'info@softdeals.example', 'Antivirus licence clearance – special pricing this week', t(11, 7), 28000, false, ['INBOX', 'CATEGORY_PROMOTIONS']],
    ["'eBay' via Shop", 'ebay@ebay.example', 'We sent your payout', t(11, 10), 30000, true, ['INBOX', 'UNREAD', L['Customers/eBay']]],
    ['Sunny Parks', 'hello@sunnyparks.example', 'Grab these holiday parks before they sell out!', t(11, 11), 129000, true, ['INBOX', 'UNREAD', 'CATEGORY_PROMOTIONS']],
    ["'eBay' via Shop", 'ebay@ebay.example', "Hang tight, we're processing your refund request", t(11, 15), 49000, true, ['INBOX', 'UNREAD', L['Returns']]],
    ["'support@dealflow.example' via Shop", 'support@dealflow.example', 'Daily deals', t(11, 15), 84000, false, ['INBOX', 'CATEGORY_PROMOTIONS']],
    ["'eBay' via Shop", 'ebay@ebay.example', 'Order 12-34567-89012 has been refunded', t(11, 16), 49000, true, ['INBOX', 'UNREAD', L['Returns']]],
    ['lee@gardenwarm.example', 'lee@gardenwarm.example', 'Assorted patio heaters', t(12, 4), 15000, false, ['INBOX']],
    ['FlightFinder', 'noreply@flightfinder.example', 'Your cheapest return flights from Lisbon', t(12, 6), 154000, true, ['INBOX', 'UNREAD', 'CATEGORY_PROMOTIONS']],
    ['Tomasz Nowak', 'tomasz@foldstand.example', 'Brand partnership offer', t(12, 18), 1300000, false, ['INBOX', 'STARRED'], true],
    ['Marketplace Support', 'support@marketplace.example', 'Your case 1234567 has been updated', t(16, 30, 1), 42000, false, ['INBOX', L['Customers/Amazon']]],
    ['Parcelio', 'noreply@parcelio.example', 'Collection confirmed for tomorrow', t(15, 2, 1), 22000, false, ['INBOX', L['Couriers']]],
    ['Sam Wood', 'sam@example.com', 'Rota for next week', t(9, 15, 1), 18000, true, ['INBOX', 'UNREAD', L['Family/Sam']]],
    ['Westgate Components', 'invoices@westgate.example', 'Invoice 100234', t(8, 5, 2), 210000, false, ['INBOX', L['Finance/Invoices']], true],
    ['Alex', 'alex@example.com', 'Re: Rota for next week', t(9, 40, 1), 4000, false, ['SENT']],
    ['Prize Committee', 'prince@example.ru', 'URGENT business proposal', t(3, 0, 2), 9000, true, ['SPAM', 'UNREAD']],
    ['Old Newsletter', 'news@old.example', 'Weekly digest', t(7, 0, 5), 50000, false, ['TRASH']],
  ];
  const msgs = rows.map((r, i) => {
    const [fromName, fromEmail, subject, date, size, unread, labels, att] = r;
    return {
      id: 'demo' + (i + 1), threadId: 'th' + (i + 1), historyId: '1', internalDate: date, size, snippet: subject + ' — this is a demo message body preview…',
      subject, fromName, fromEmail, to: [{ name: 'Alex', email: 'alex@example.com' }], cc: [], hasAttachment: !!att,
      labels: [...labels, ...(unread && !labels.includes('UNREAD') ? ['UNREAD'] : [])], messageIdHdr: `<demo${i + 1}@example>`,
    };
  });
  msgs.push({ id: 'demoinv', threadId: 'thinv', historyId: '1', internalDate: t(9, 5), size: 8000, snippet: 'Invitation: Supplier review @ Thu 10:00', subject: 'Invitation: Supplier review',
    fromName: 'Sam Wood', fromEmail: 'sam@example.com', to: [{ name: 'Alex', email: 'alex@example.com' }], cc: [], hasAttachment: false, labels: ['INBOX', 'UNREAD'], messageIdHdr: '<inv@example>' });
  for (let i = 0; i < 3; i++) msgs.push({ id: 'demothr' + i, threadId: 'ththr', historyId: '1', internalDate: t(14 + i, 10, 2 - i), size: 3000 + i, snippet: 'Re: Quote for 20 laptops', subject: (i ? 'Re: ' : '') + 'Quote for 20 laptops',
    fromName: i % 2 ? 'Alex' : 'Jordan Lee', fromEmail: i % 2 ? 'alex@example.com' : 'jordan@example.org', to: [{ name: '', email: i % 2 ? 'jordan@example.org' : 'alex@example.com' }], cc: [], hasAttachment: false,
    labels: i % 2 ? ['SENT'] : ['INBOX'], messageIdHdr: `<thr${i}@example>`, inReplyTo: i ? `<thr${i - 1}@example>` : null });
  db.upsertMessages(a1.id, msgs);
  const inv = new Date(); inv.setDate(inv.getDate() + 3); inv.setHours(10, 0, 0, 0);
  db.setCalendar(a1.id, 'demoinv', { uid: 'inv-1', summary: 'Supplier review', location: 'Meeting room 2', start: { ts: inv.getTime(), allDay: false }, end: { ts: inv.getTime() + 3600000, allDay: false },
    organizer: { name: 'Sam Wood', email: 'sam@example.com' }, attendees: [{ name: 'Alex', email: 'alex@example.com', partstat: 'NEEDS-ACTION' }], method: 'REQUEST', sequence: 0 });
  for (const m of msgs) {
    const text = `Hello Alex,\n\nThis is the body of "${m.subject}".\n\nThis mailbox is running in demo mode — nothing here touches Google.\n\nKind regards,\n${m.fromName}`;
    db.setBody(a1.id, m.id, { text, html: textToHtml(text) + '<p><a href="https://example.com">example.com</a></p>' + (m.id === 'demo3' ? '<img src="https://example.com/banner.png" alt="banner">' : ''),
      attachments: m.hasAttachment ? [{ filename: 'stocklist.pdf', mimeType: 'application/pdf', size: 245000, attachmentId: 'x' }] : [] });
  }
  const m2 = [{ id: 's1', threadId: 's1', internalDate: t(9, 30), size: 12000, snippet: 'Order enquiry', subject: 'Do you have the 14-inch laptop in stock?', fromName: 'A Customer', fromEmail: 'cust@example.com', to: [{ name: '', email: 'shop@example.com' }], cc: [], labels: ['INBOX', 'UNREAD'] }];
  db.upsertMessages(a2.id, m2);
  db.setBody(a2.id, 's1', { text: 'Hi, is the 14-inch model still available? Thanks', html: textToHtml('Hi, is the 14-inch model still available? Thanks'), attachments: [] });
  db.saveRule({ name: 'File courier updates', enabled: true, accountId: a1.id, match: 'any', conditions: [{ field: 'from', op: 'contains', value: 'parcelio.example' }, { field: 'subject', op: 'contains', value: 'collection' }], actions: [{ type: 'moveTo', labelId: L['Couriers'] }, { type: 'markRead' }] });
  db.updateAccount(a1.id, { initial_done: 1, history_id: '1', last_sync_at: Date.now() - 5 * 60000 });
  db.updateAccount(a2.id, { initial_done: 1, history_id: '1', last_sync_at: Date.now() - 5 * 60000 });
}

/** A provider that accepts every write and serves no reads (bodies are pre-seeded). */
class DemoProvider {
  constructor() { this.kind = 'gmail'; this.canDeleteForever = true; }
  cancel() {}
  async syncLabels() { return []; }
  async sync() { return { newInbox: [] }; }
  async modify() {}
  async fetchFull() { throw new Error('Demo mode: no network'); }
  async getAttachment() { return Buffer.from('demo attachment'); }
  async send() { return { id: 'sent_' + Date.now() }; }
  async search() { return []; }
  async createLabel(name) { return { id: 'Label_demo_' + Date.now(), name, type: 'user' }; }
  async saveDraft() { return { id: 'demo-draft', messageId: null }; }
  async deleteDraft() {}
  async draftIdForMessage() { return null; }
  async deleteForever() {}
  async emptyFolder() { return 0; }
}
/** A client that accepts every write and serves no reads. */
class DemoClient {
  async get(path) { if (path === '/profile') return { emailAddress: 'demo@example.com', historyId: '1' }; if (path === '/labels') return { labels: [] }; if (path === '/history') return { history: [], historyId: '1' }; if (path === '/messages') return { messages: [] }; throw new Error('Demo mode: no network'); }
  async post(path, body) { return { id: 'sent_' + Date.now(), threadId: 'demo', ...(path === '/labels' ? { id: 'Label_demo_' + Date.now(), name: body.name, type: 'user' } : {}) }; }
  async batchGet() { return []; }
  async request() { return null; }
}
module.exports = { seedDemo, DemoClient, DemoProvider };
