import React, { useEffect, useState } from 'react';
import Icon from './Icons.jsx';

const FIELDS = [['from', 'From'], ['to', 'To / Cc'], ['subject', 'Subject'], ['body', 'Body'], ['any', 'Anywhere'], ['hasAttachment', 'Has attachment']];
const OPS = [['contains', 'contains'], ['notContains', "doesn't contain"], ['equals', 'is'], ['startsWith', 'starts with'], ['endsWith', 'ends with'], ['regex', 'matches regex']];
const ACTIONS = [['moveTo', 'Move to folder'], ['addLabel', 'Add label (keep in Inbox)'], ['archive', 'Archive'], ['markRead', 'Mark as read'], ['star', 'Flag'], ['trash', 'Move to Trash'], ['spam', 'Mark as junk'], ['stop', 'Stop processing more rules']];
const blank = (accountId, seed) => ({ name: seed?.name || 'New rule', enabled: true, accountId: accountId || null, match: 'all', conditions: seed?.conditions || [{ field: 'from', op: 'contains', value: '' }], actions: seed?.actions || [{ type: 'moveTo', labelId: '' }] });

export default function RulesTab({ accounts, labels, toast, seed }) {
  const [rules, setRules] = useState([]);
  const [edit, setEdit] = useState(seed ? blank(seed.accountId, seed) : null);
  const [running, setRunning] = useState(false);
  const load = () => window.mail.rules.list().then(setRules);
  useEffect(() => { load(); }, []);
  const save = async () => {
    if (!edit.name.trim()) { toast('Give the rule a name', true); return; }
    if (!edit.conditions.some(c => c.value || c.field === 'hasAttachment')) { toast('Add at least one condition', true); return; }
    if (edit.actions.some(a => (a.type === 'moveTo' || a.type === 'addLabel') && !a.labelId)) { toast('Pick a folder for the move/label action', true); return; }
    await window.mail.rules.save(edit); setEdit(null); load(); toast('Rule saved');
  };
  const del = async (r) => { if (confirm(`Delete rule "${r.name}"?`)) { await window.mail.rules.remove(r.id); load(); } };
  const toggle = async (r) => { await window.mail.rules.save({ ...r, enabled: !r.enabled }); load(); };
  const runNow = async () => {
    setRunning(true);
    try { let tot = 0, ap = 0; for (const a of accounts) { const r = await window.mail.rules.run(a.id, 'INBOX'); tot += r.scanned; ap += r.applied; } toast(`Checked ${tot} inbox messages, ${ap} filed`); }
    catch (e) { toast(e.message, true); } finally { setRunning(false); }
  };
  const labelsFor = (accountId) => { const ids = accountId ? [accountId] : accounts.map(a => a.id); const seen = new Map(); for (const id of ids) for (const l of labels[id] || []) if (l.type === 'user' || l.id === 'ARCHIVE') seen.set(l.id, l); return [...seen.values()]; };
  const describe = (r) => r.conditions.map(c => `${FIELDS.find(f => f[0] === c.field)?.[1] || c.field} ${OPS.find(o => o[0] === c.op)?.[1] || ''} "${c.value}"`).join(r.match === 'any' ? ' or ' : ' and ')
    + ' → ' + r.actions.map(a => ACTIONS.find(x => x[0] === a.type)?.[1] + ((a.type === 'moveTo' || a.type === 'addLabel') && a.labelId ? ` "${labelsFor(r.accountId).find(l => l.id === a.labelId)?.name || a.labelId}"` : '')).join(', ');
  return (
    <div className="rules">
      <p className="muted">Rules run on every new message as it arrives (not on Sent, Trash or Junk). Order matters: the first matching rule with "Stop processing" ends the run.</p>
      {rules.map(r => (
        <div className="rule" key={r.id}>
          <div className="rh"><input type="checkbox" checked={r.enabled} onChange={() => toggle(r)} title="Enabled" /><span className="nm" style={{ opacity: r.enabled ? 1 : .5 }}>{r.name}</span>
            <span className="sub">{r.accountId ? accounts.find(a => a.id === r.accountId)?.email : 'all accounts'}</span>
            <button onClick={() => setEdit({ ...r })}>Edit</button><button onClick={() => del(r)}>Delete</button></div>
          <div className="sub">{describe(r)}</div>
        </div>
      ))}
      {!rules.length && !edit && <p className="muted">No rules yet.</p>}
      {edit && (
        <div className="rule" style={{ borderColor: 'var(--accent)' }}>
          <div className="rh"><input type="text" value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })} style={{ flex: 1 }} placeholder="Rule name" />
            <select value={edit.accountId || ''} onChange={e => setEdit({ ...edit, accountId: e.target.value ? Number(e.target.value) : null, actions: edit.actions.map(a => ({ ...a, labelId: '' })) })}><option value="">All accounts</option>{accounts.map(a => <option key={a.id} value={a.id}>{a.email}</option>)}</select></div>
          <div className="cond"><span>If</span><select value={edit.match} onChange={e => setEdit({ ...edit, match: e.target.value })}><option value="all">all</option><option value="any">any</option></select><span>of these match:</span></div>
          {edit.conditions.map((c, i) => (
            <div className="cond" key={i}>
              <select value={c.field} onChange={e => setEdit({ ...edit, conditions: edit.conditions.map((x, j) => j === i ? { ...x, field: e.target.value } : x) })}>{FIELDS.map(([v, n]) => <option key={v} value={v}>{n}</option>)}</select>
              {c.field === 'hasAttachment' ? <select value={c.value || 'yes'} onChange={e => setEdit({ ...edit, conditions: edit.conditions.map((x, j) => j === i ? { ...x, value: e.target.value } : x) })}><option value="yes">yes</option><option value="no">no</option></select> : <>
                <select value={c.op} onChange={e => setEdit({ ...edit, conditions: edit.conditions.map((x, j) => j === i ? { ...x, op: e.target.value } : x) })}>{OPS.map(([v, n]) => <option key={v} value={v}>{n}</option>)}</select>
                <input type="text" value={c.value || ''} onChange={e => setEdit({ ...edit, conditions: edit.conditions.map((x, j) => j === i ? { ...x, value: e.target.value } : x) })} placeholder="text" /></>}
              <button onClick={() => setEdit({ ...edit, conditions: edit.conditions.filter((_, j) => j !== i) })} disabled={edit.conditions.length === 1}>✕</button>
            </div>
          ))}
          <div className="cond"><button onClick={() => setEdit({ ...edit, conditions: [...edit.conditions, { field: 'subject', op: 'contains', value: '' }] })}><Icon name="plus" size={12} /> condition</button></div>
          <div className="act" style={{ marginTop: 8 }}><span>Then:</span></div>
          {edit.actions.map((a, i) => (
            <div className="act" key={i}>
              <select value={a.type} onChange={e => setEdit({ ...edit, actions: edit.actions.map((x, j) => j === i ? { type: e.target.value, labelId: '' } : x) })}>{ACTIONS.map(([v, n]) => <option key={v} value={v}>{n}</option>)}</select>
              {(a.type === 'moveTo' || a.type === 'addLabel') && <select value={a.labelId || ''} onChange={e => setEdit({ ...edit, actions: edit.actions.map((x, j) => j === i ? { ...x, labelId: e.target.value } : x) })}><option value="">choose folder…</option>{labelsFor(edit.accountId).map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select>}
              <button onClick={() => setEdit({ ...edit, actions: edit.actions.filter((_, j) => j !== i) })} disabled={edit.actions.length === 1}>✕</button>
            </div>
          ))}
          <div className="act"><button onClick={() => setEdit({ ...edit, actions: [...edit.actions, { type: 'markRead' }] })}><Icon name="plus" size={12} /> action</button></div>
          <div className="act" style={{ marginTop: 8 }}><button className="primary" onClick={save}>Save rule</button><button onClick={() => setEdit(null)}>Cancel</button></div>
        </div>
      )}
      {!edit && <div style={{ display: 'flex', gap: 8 }}><button className="primary" onClick={() => setEdit(blank(accounts.length === 1 ? accounts[0].id : null))}><Icon name="plus" size={12} /> New rule</button>
        <button onClick={runNow} disabled={running || !rules.length}>{running ? 'Running…' : 'Run rules on Inbox now'}</button></div>}
    </div>
  );
}
