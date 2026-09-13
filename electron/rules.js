'use strict';
// Rules: conditions over a message's headers/snippet → actions, run once per new message.
const FIELDS = ['from', 'to', 'subject', 'body', 'any', 'hasAttachment', 'listId'];
const OPS = ['contains', 'notContains', 'equals', 'startsWith', 'endsWith', 'regex'];
const ACTIONS = ['moveTo', 'addLabel', 'archive', 'markRead', 'star', 'trash', 'spam', 'stop'];

function fieldValue(m, field) {
  switch (field) {
    case 'from': return `${m.fromName || ''} <${m.fromEmail || ''}>`;
    case 'to': return [...(m.to || []), ...(m.cc || [])].map(a => `${a.name || ''} <${a.email}>`).join(', ');
    case 'subject': return m.subject || '';
    case 'body': return m.bodyText || m.snippet || '';
    case 'any': return `${m.fromName || ''} <${m.fromEmail || ''}> ${m.subject || ''} ${m.snippet || ''}`;
    case 'hasAttachment': return m.hasAttachment ? 'yes' : 'no';
    default: return '';
  }
}
function test(cond, m) {
  const v = fieldValue(m, cond.field).toLowerCase();
  const x = String(cond.value || '').toLowerCase();
  if (cond.field === 'hasAttachment') return (v === 'yes') === (x !== 'no' && x !== 'false');
  switch (cond.op) {
    case 'contains': return v.includes(x);
    case 'notContains': return !v.includes(x);
    case 'equals': return v.trim() === x.trim();
    case 'startsWith': return v.startsWith(x);
    case 'endsWith': return v.endsWith(x);
    case 'regex': try { return new RegExp(cond.value, 'i').test(fieldValue(m, cond.field)); } catch { return false; }
    default: return false;
  }
}
function matches(rule, m) {
  const cs = (rule.conditions || []).filter(c => c.field && (c.value !== undefined || c.field === 'hasAttachment'));
  if (!cs.length) return false;
  return rule.match === 'any' ? cs.some(c => test(c, m)) : cs.every(c => test(c, m));
}
/** Plan the label change for a message from a list of matching rules (stop halts later rules). */
function plan(rules, m) {
  const out = { add: new Set(), remove: new Set(), matched: [] };
  for (const r of rules) {
    if (!r.enabled || (r.accountId && r.accountId !== m.accountId) || !matches(r, m)) continue;
    out.matched.push(r.id);
    let stop = false;
    for (const a of r.actions || []) {
      switch (a.type) {
        case 'moveTo': if (a.labelId) { out.add.add(a.labelId); out.remove.add('INBOX'); } break;
        case 'addLabel': if (a.labelId) out.add.add(a.labelId); break;
        case 'archive': out.remove.add('INBOX'); break;
        case 'markRead': out.remove.add('UNREAD'); break;
        case 'star': out.add.add('STARRED'); break;
        case 'trash': out.add.add('TRASH'); out.remove.add('INBOX'); break;
        case 'spam': out.add.add('SPAM'); out.remove.add('INBOX'); break;
        case 'stop': stop = true; break;
      }
    }
    if (stop) break;
  }
  for (const l of out.add) out.remove.delete(l);
  return out;
}
/** Apply rules to the given messages through Actions.modify (grouped by identical change sets). */
async function runRules({ db, actions, accountId, ids, log = () => {} }) {
  const rules = db.listRules().filter(r => r.enabled);
  if (!rules.length || !ids.length) return { applied: 0 };
  const groups = new Map();
  for (const id of ids) {
    const m = db.getMessage(accountId, id);
    if (!m) continue;
    const p = plan(rules, m);
    if (!p.matched.length || (!p.add.size && !p.remove.size)) continue;
    const key = [...p.add].sort().join(',') + '|' + [...p.remove].sort().join(',');
    if (!groups.has(key)) groups.set(key, { add: [...p.add], remove: [...p.remove], ids: [] });
    groups.get(key).ids.push(id);
  }
  let applied = 0;
  for (const g of groups.values()) {
    try { await actions.modify(g.ids.map(id => ({ accountId, id })), { add: g.add, remove: g.remove }); applied += g.ids.length; }
    catch (e) { log('rule apply failed: ' + e.message); }
  }
  return { applied };
}
module.exports = { FIELDS, OPS, ACTIONS, matches, plan, runRules };
