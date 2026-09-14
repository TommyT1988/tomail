// Heuristic phishing checks over a message's headers + HTML. Returns { level: 'none'|'warn'|'danger', reasons: [] }.
const BRANDS = ['paypal', 'amazon', 'ebay', 'microsoft', 'office365', 'outlook', 'apple', 'icloud', 'google', 'gmail', 'netflix', 'dhl', 'ups', 'fedex', 'royalmail', 'hmrc', 'gov', 'barclays', 'hsbc', 'lloyds', 'natwest', 'santander', 'halifax', 'nationwide', 'monzo', 'revolut', 'dropbox', 'docusign', 'linkedin', 'facebook', 'instagram', 'whatsapp', 'evri', 'dpd', 'tesco', 'argos', 'bt', 'sky', 'virgin', 'o2', 'vodafone', 'ee'];
const URGENT = /\b(urgent|immediately|within 24 hours|account (will be )?(suspended|closed|locked|limited)|verify your (account|identity|details)|confirm your (password|account)|unusual (sign-?in|activity)|update your (payment|billing)|bank details|overdue|final (notice|warning)|click (here|below) to (verify|confirm|update)|security alert|your password has expired|wire transfer|gift ?cards?)\b/i;
const host = (u) => { try { return new URL(u, 'http://x').hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
const regDomain = (h) => { const p = h.split('.'); if (p.length <= 2) return h; const sld = /^(co|com|org|net|gov|ac|edu|ltd|plc)$/.test(p[p.length - 2]) && p[p.length - 1].length === 2; return p.slice(sld ? -3 : -2).join('.'); };
const brandIn = (h) => BRANDS.find(b => b.length > 2 && new RegExp(`(^|[.-])${b}([.-]|$)`).test(h));
const lookalike = (h) => { if (/^xn--/.test(h) || /\.xn--/.test(h)) return 'uses an internationalised (punycode) domain'; const flat = h.replace(/[^a-z0-9]/g, '').replace(/0/g, 'o').replace(/1/g, 'l').replace(/3/g, 'e').replace(/5/g, 's').replace(/rn/g, 'm').replace(/vv/g, 'w'); for (const b of BRANDS) { if (b.length > 3 && flat.includes(b) && !new RegExp(`(^|\\.)${b}\\.`).test(h) && !h.endsWith(b + '.com') && !h.endsWith(b + '.co.uk')) return `looks like ${b} but isn't`; } return null; };

export function analyse(m) {
  const reasons = [];
  let level = 0;
  const bump = (n, r) => { level = Math.max(level, n); reasons.push(r); };
  const from = (m.fromEmail || '').toLowerCase(), fromHost = from.split('@')[1] || '';
  const auth = m.auth || {};
  if (Object.values(auth).some(v => /fail/.test(v || ''))) bump(2, `Sender authentication failed (${Object.entries(auth).filter(([, v]) => /fail/.test(v || '')).map(([k]) => k.toUpperCase()).join(', ')}) — the address may be forged`);
  const dispBrand = brandIn((m.fromName || '').toLowerCase().replace(/\s+/g, '.'));
  if (dispBrand && !regDomain(fromHost).includes(dispBrand)) bump(2, `Display name says "${m.fromName}" but the address is ${from}`);
  const nameEmail = /[\w.+-]+@[\w-]+\.[\w.-]+/.exec(m.fromName || '');
  if (nameEmail && nameEmail[0].toLowerCase() !== from) bump(2, `Display name contains a different address (${nameEmail[0]})`);
  if (m.replyTo) { const rh = host('http://' + (m.replyTo.split('@')[1] || '').replace(/[>\s].*$/, '')); if (rh && fromHost && regDomain(rh) !== regDomain(fromHost)) bump(1, `Replies go to a different domain (${rh})`); }
  const la = lookalike(fromHost); if (la && fromHost) bump(2, `Sender domain ${fromHost} ${la}`);
  const html = m.bodyHtml || '';
  const links = [...html.matchAll(/<a\b[^>]*?href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].map(x => ({ href: x[1], text: x[2].replace(/<[^>]+>/g, '').trim() }));
  let mismatch = 0, brandLinks = 0;
  for (const l of links) {
    if (!/^https?:/i.test(l.href)) continue;
    const hh = host(l.href);
    const tm = /(?:https?:\/\/)?([a-z0-9.-]+\.[a-z]{2,})(\/|$|\s)/i.exec(l.text);
    if (tm && regDomain(tm[1].toLowerCase().replace(/^www\./, '')) !== regDomain(hh)) mismatch++;
    const lb = lookalike(hh); if (lb) { brandLinks++; if (brandLinks === 1) bump(2, `A link goes to ${hh}, which ${lb}`); }
    const b = brandIn(hh); if (b && !hh.endsWith(b + '.com') && !hh.endsWith(b + '.co.uk') && regDomain(hh).indexOf(b) < 0) { brandLinks++; if (brandLinks === 1) bump(2, `A link to "${b}" actually points at ${regDomain(hh)}`); }
  }
  if (mismatch) bump(2, `${mismatch} link${mismatch > 1 ? 's' : ''} show one address but go somewhere else`);
  const text = (m.bodyText || m.snippet || '') + ' ' + (m.subject || '');
  const urgent = URGENT.test(text);
  if (urgent && (m.senderFirstContact || level >= 1)) bump(Math.max(1, level), 'Urgent or payment/password wording' + (m.senderFirstContact ? ' from a sender you have never received mail from' : ''));
  else if (urgent && !m.senderFirstContact) bump(0, '');
  return { level: level >= 2 ? 'danger' : level === 1 ? 'warn' : 'none', reasons: reasons.filter(Boolean) };
}
