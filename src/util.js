export const SYSTEM_FOLDERS = [
  { id: 'INBOX', name: 'Inbox', icon: 'inbox' }, { id: 'SENT', name: 'Sent', icon: 'send' }, { id: 'TRASH', name: 'Trash', icon: 'trash' },
  { id: 'DRAFT', name: 'Drafts', icon: 'edit' }, { id: 'SPAM', name: 'Junk Email', icon: 'slash' }, { id: 'ALL', name: 'All Mail', icon: 'layers' },
];
export const CATEGORIES = [
  { id: 'primary', name: 'Primary' }, { id: 'CATEGORY_PROMOTIONS', name: 'Promotions' }, { id: 'CATEGORY_SOCIAL', name: 'Social' },
  { id: 'CATEGORY_UPDATES', name: 'Updates' }, { id: 'CATEGORY_FORUMS', name: 'Forums' },
];

export function fmtSize(n) {
  if (!n) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' kB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
const pad = (n) => String(n).padStart(2, '0');
export function fmtTime(ts) {
  const d = new Date(ts), now = new Date();
  if (sameDay(d, now)) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' });
}
export function fmtFull(ts) {
  return new Date(ts).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
export function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
export function dayGroup(ts) {
  const d = new Date(ts), now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.floor((start - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
  if (diffDays <= 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return d.toLocaleDateString('en-GB', { weekday: 'long' });
  if (diffDays < 14) return 'Last week';
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString('en-GB', { month: 'long' });
  return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}
export function ago(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ts).toLocaleString('en-GB');
}
export function fmtAddr(a) { return a?.name ? a.name : a?.email || ''; }
export function fmtAddrFull(a) { return a?.name ? `${a.name} <${a.email}>` : a?.email || ''; }
export function addrList(list) { return (list || []).map(fmtAddrFull).join(', '); }

/** Nest user labels by '/' into a tree, sorted by name. */
export function labelTree(labels) {
  const root = { children: new Map() };
  for (const l of labels.filter(l => l.type === 'user' && l.visible !== 0)) {
    const parts = l.name.split('/');
    let node = root;
    parts.forEach((p, i) => {
      if (!node.children.has(p)) node.children.set(p, { name: p, label: null, children: new Map() });
      node = node.children.get(p);
      if (i === parts.length - 1) node.label = l;
    });
  }
  const toArr = (n) => [...n.children.values()].sort((a, b) => a.name.localeCompare(b.name)).map(c => ({ name: c.name, label: c.label, children: toArr(c) }));
  return toArr(root);
}
export function keyOf(t) { return `${t.accountId}:${t.id}`; }
export function sameView(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
export function escapeHtml(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

/** Snooze presets → epoch ms */
export function snoozePresets() {
  const now = new Date();
  const at = (d, h) => { const x = new Date(d); x.setHours(h, 0, 0, 0); return x.getTime(); };
  const later = new Date(now.getTime() + 3 * 3600000);
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  const weekend = new Date(now); weekend.setDate(now.getDate() + ((6 - now.getDay() + 7) % 7 || 7));
  const nextWeek = new Date(now); nextWeek.setDate(now.getDate() + ((1 - now.getDay() + 7) % 7 || 7));
  return [
    { label: 'Later today', sub: later.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }), at: later.getTime() },
    { label: 'Tomorrow', sub: '08:00', at: at(tomorrow, 8) },
    { label: 'This weekend', sub: weekend.toLocaleDateString('en-GB', { weekday: 'short' }) + ' 08:00', at: at(weekend, 8) },
    { label: 'Next week', sub: nextWeek.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) + ' 08:00', at: at(nextWeek, 8) },
  ];
}
export function textToQuoted(t) { return String(t || '').split('\n').map(l => '> ' + l).join('\n'); }
export function htmlToText(html) {
  if (!html) return '';
  const d = document.createElement('div');
  d.innerHTML = html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, '$&\n');
  return (d.textContent || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
export function isDark() { const t = document.documentElement.dataset.theme; return t === 'dark' || (!t && window.matchMedia('(prefers-color-scheme: dark)').matches); }
export function fmtRange(ev) {
  if (!ev?.start) return '';
  const s = new Date(ev.start.ts), e = ev.end ? new Date(ev.end.ts) : null;
  if (ev.start.allDay) return s.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) + (e && e - s > 86400000 ? ' → ' + new Date(e - 86400000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' }) : '');
  const day = s.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const t = (d) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${day}, ${t(s)}${e ? (sameDay(s, e) ? ' – ' + t(e) : ' → ' + e.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })) : ''}`;
}
export function gmailQuery(q, f = {}) {
  const parts = [q || ''];
  if (f.from) parts.push(`from:${f.from}`); if (f.to) parts.push(`to:${f.to}`);
  if (f.unread) parts.push('is:unread'); if (f.starred) parts.push('is:starred'); if (f.hasAttachment) parts.push('has:attachment');
  const d = (ts) => { const x = new Date(Number(ts)); return `${x.getFullYear()}/${x.getMonth() + 1}/${x.getDate()}`; };
  if (f.after) parts.push(`after:${d(f.after)}`); if (f.before) parts.push(`before:${d(f.before)}`);
  return parts.filter(Boolean).join(' ');
}

/** "from:bob has:attachment is:unread after:2026-01-01 in:Invoices quarterly report" → { text, filters } */
export function parseSearch(q, labels = []) {
  const filters = {}; const rest = [];
  const re = /(\w+):(?:"([^"]+)"|(\S+))|(\S+)/g; let m;
  const day = (s) => { const t = Date.parse(s.replace(/\//g, '-')); return isNaN(t) ? undefined : t; };
  while ((m = re.exec(q || ''))) {
    if (!m[1]) { rest.push(m[4]); continue; }
    const k = m[1].toLowerCase(), v = m[2] ?? m[3];
    switch (k) {
      case 'from': filters.from = v; break;
      case 'to': filters.to = v; break;
      case 'after': case 'since': filters.after = day(v); break;
      case 'before': filters.before = day(v) ? day(v) + 86400000 : undefined; break;
      case 'is': if (v === 'unread') filters.unread = true; else if (v === 'starred' || v === 'flagged') filters.starred = true; break;
      case 'has': if (v === 'attachment') filters.hasAttachment = true; break;
      case 'in': case 'label': { const l = labels.find(x => x.name.toLowerCase() === v.toLowerCase() || x.id.toLowerCase() === v.toLowerCase()); if (l) filters.labelId = l.id; else rest.push(m[0]); break; }
      case 'subject': rest.push(v); break;
      default: rest.push(m[0]);
    }
  }
  return { text: rest.join(' ').trim(), filters };
}

export function followUpPresets() {
  const at = (days, h = 9) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(h, 0, 0, 0); return d.getTime(); };
  const nextWorking = () => { const d = new Date(); do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6); d.setHours(9, 0, 0, 0); return d.getTime(); };
  return [{ label: 'Tomorrow', at: at(1) }, { label: 'Next working day', at: nextWorking() }, { label: 'In 3 days', at: at(3) }, { label: 'In a week', at: at(7) }, { label: 'In 2 weeks', at: at(14) }];
}
export function fmtDuration(ms) { if (ms == null) return ''; const h = ms / 3600000; if (h < 1) return `${Math.max(1, Math.round(ms / 60000))} min`; if (h < 48) return `${Math.round(h)} h`; return `${Math.round(h / 24)} days`; }

export function sendLaterPresets() {
  const at = (days, h) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(h, 0, 0, 0); return d.getTime(); };
  const nextWorking = () => { const d = new Date(); do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6); d.setHours(9, 0, 0, 0); return d.getTime(); };
  const now = new Date(); const later = new Date(now); later.setHours(now.getHours() < 13 ? 17 : now.getHours() + 3, 0, 0, 0);
  const mon = new Date(now); mon.setDate(now.getDate() + ((1 - now.getDay() + 7) % 7 || 7)); mon.setHours(9, 0, 0, 0);
  return [{ label: now.getHours() < 13 ? 'This afternoon (17:00)' : 'In 3 hours', at: later.getTime() }, { label: 'Tomorrow 9:00', at: at(1, 9) }, { label: 'Next working morning 9:00', at: nextWorking() }, { label: 'Monday 9:00', at: mon.getTime() }];
}
