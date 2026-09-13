'use strict';
// Minimal iCalendar: parse a VEVENT out of an invite and build a METHOD:REPLY.
function unfold(t) { return String(t || '').replace(/\r?\n[ \t]/g, ''); }
function unescapeText(s) { return String(s || '').replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\;/g, ';').replace(/\\\\/g, '\\'); }
function parseDate(v, params = {}) {
  if (!v) return null;
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  const allDay = !h || params.VALUE === 'DATE';
  const dt = z ? Date.UTC(+y, mo - 1, +d, +(h || 0), +(mi || 0), +(s || 0)) : new Date(+y, mo - 1, +d, +(h || 0), +(mi || 0), +(s || 0)).getTime();
  return { ts: dt, allDay, tzid: params.TZID || (z ? 'UTC' : null) };
}
function mailto(v) { return String(v || '').replace(/^mailto:/i, '').toLowerCase(); }

/** Returns null when no VEVENT is present. */
function parseIcs(text) {
  const lines = unfold(text).split(/\r?\n/);
  let method = null, inEvent = false;
  const ev = { attendees: [] };
  for (const line of lines) {
    const i = line.indexOf(':'); if (i < 0) continue;
    const left = line.slice(0, i), value = line.slice(i + 1);
    const [name, ...pp] = left.split(';');
    const params = Object.fromEntries(pp.map(p => { const j = p.indexOf('='); return j < 0 ? [p, ''] : [p.slice(0, j).toUpperCase(), p.slice(j + 1).replace(/^"|"$/g, '')]; }));
    const N = name.toUpperCase();
    if (N === 'METHOD') method = value.trim().toUpperCase();
    if (N === 'BEGIN' && value.trim().toUpperCase() === 'VEVENT') { inEvent = true; continue; }
    if (N === 'END' && value.trim().toUpperCase() === 'VEVENT') break;
    if (!inEvent) continue;
    switch (N) {
      case 'UID': ev.uid = value.trim(); break;
      case 'SUMMARY': ev.summary = unescapeText(value); break;
      case 'DESCRIPTION': ev.description = unescapeText(value); break;
      case 'LOCATION': ev.location = unescapeText(value); break;
      case 'DTSTART': ev.start = parseDate(value, params); break;
      case 'DTEND': ev.end = parseDate(value, params); break;
      case 'SEQUENCE': ev.sequence = Number(value) || 0; break;
      case 'STATUS': ev.status = value.trim(); break;
      case 'ORGANIZER': ev.organizer = { email: mailto(value), name: params.CN || '' }; break;
      case 'ATTENDEE': ev.attendees.push({ email: mailto(value), name: params.CN || '', partstat: params.PARTSTAT || 'NEEDS-ACTION', role: params.ROLE || '' }); break;
      case 'RRULE': ev.rrule = value.trim(); break;
    }
  }
  if (!ev.uid && !ev.summary) return null;
  ev.method = method || 'PUBLISH';
  return ev;
}

function icsDate(ts, allDay) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  if (allDay) return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}
function esc(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\n/g, '\\n'); }
function fold(line) { const out = []; while (line.length > 73) { out.push(line.slice(0, 73)); line = ' ' + line.slice(73); } out.push(line); return out.join('\r\n'); }

/** partstat: ACCEPTED | TENTATIVE | DECLINED */
function buildReply(ev, { email, name, partstat }) {
  const lines = ['BEGIN:VCALENDAR', 'PRODID:-//Tomail//EN', 'VERSION:2.0', 'METHOD:REPLY', 'BEGIN:VEVENT',
    `UID:${ev.uid}`, `DTSTAMP:${icsDate(Date.now())}`,
    ...(ev.start ? [`DTSTART${ev.start.allDay ? ';VALUE=DATE' : ''}:${icsDate(ev.start.ts, ev.start.allDay)}`] : []),
    ...(ev.end ? [`DTEND${ev.end.allDay ? ';VALUE=DATE' : ''}:${icsDate(ev.end.ts, ev.end.allDay)}`] : []),
    `SUMMARY:${esc(ev.summary || '')}`, `SEQUENCE:${ev.sequence || 0}`,
    ...(ev.organizer ? [`ORGANIZER${ev.organizer.name ? ';CN=' + esc(ev.organizer.name) : ''}:mailto:${ev.organizer.email}`] : []),
    `ATTENDEE;PARTSTAT=${partstat}${name ? ';CN=' + esc(name) : ''}:mailto:${email}`,
    'END:VEVENT', 'END:VCALENDAR'];
  return lines.map(fold).join('\r\n') + '\r\n';
}
module.exports = { parseIcs, buildReply };
