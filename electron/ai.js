'use strict';
// Local language model client. Primary target is Ollama (http://localhost:11434); any
// OpenAI-compatible server (LM Studio, llama.cpp, Jan) works via kind:'openai'.
const DEFAULTS = { enabled: false, kind: 'ollama', endpoint: 'http://localhost:11434', model: 'llama3.2:3b', apiKey: '', styleLearning: true };
const RECOMMENDED = [
  { model: 'llama3.2:3b', size: '2.0 GB', note: 'Fast on any modern CPU. Good summaries, decent drafts.' },
  { model: 'qwen2.5:7b', size: '4.7 GB', note: 'Better writing and reasoning; wants 8 GB RAM or a GPU.' },
  { model: 'gemma3:4b', size: '3.3 GB', note: 'Strong for its size; multilingual.' },
];
const cfgOf = (settings) => ({ ...DEFAULTS, ...(settings.get().prefs.ai || {}) });

async function status(settings) {
  const c = cfgOf(settings);
  try {
    if (c.kind === 'ollama') {
      const r = await fetch(c.endpoint.replace(/\/$/, '') + '/api/tags', { signal: AbortSignal.timeout(2500) });
      if (!r.ok) return { reachable: false, error: `HTTP ${r.status}` };
      const j = await r.json();
      const models = (j.models || []).map(m => ({ name: m.name, size: m.size }));
      return { reachable: true, models, hasModel: models.some(m => m.name === c.model || m.name.split(':')[0] === c.model.split(':')[0] && c.model.indexOf(':') < 0), config: c };
    }
    const r = await fetch(c.endpoint.replace(/\/$/, '') + '/v1/models', { headers: c.apiKey ? { Authorization: 'Bearer ' + c.apiKey } : {}, signal: AbortSignal.timeout(2500) });
    if (!r.ok) return { reachable: false, error: `HTTP ${r.status}` };
    const j = await r.json();
    const models = (j.data || []).map(m => ({ name: m.id }));
    return { reachable: true, models, hasModel: !models.length || models.some(m => m.name === c.model), config: c };
  } catch (e) { return { reachable: false, error: e.name === 'TimeoutError' ? 'No response' : e.message, config: c }; }
}

/** Ollama model download with progress. */
async function pull(settings, model, onProgress, signal) {
  const c = cfgOf(settings);
  const r = await fetch(c.endpoint.replace(/\/$/, '') + '/api/pull', { method: 'POST', body: JSON.stringify({ name: model, stream: true }), signal });
  if (!r.ok || !r.body) throw new Error(`Pull failed: HTTP ${r.status}`);
  const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue; try { const j = JSON.parse(line); if (j.error) throw new Error(j.error); onProgress({ status: j.status, completed: j.completed, total: j.total }); } catch (e) { if (e.message && !/JSON/.test(e.message)) throw e; } }
  }
  return true;
}

/**
 * Chat completion. messages: [{role, content}]. onToken(text) streams; resolves with the full text.
 * opts.json → ask the model for a JSON object (Ollama format:'json').
 */
async function chat(settings, messages, { onToken, json = false, signal, temperature = 0.3, maxTokens = 700 } = {}) {
  const c = cfgOf(settings);
  const base = c.endpoint.replace(/\/$/, '');
  let text = '';
  if (c.kind === 'ollama') {
    const r = await fetch(base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
      body: JSON.stringify({ model: c.model, messages, stream: !!onToken, ...(json ? { format: 'json' } : {}), options: { temperature, num_predict: maxTokens } }) });
    if (!r.ok) { const t = await r.text(); throw new Error(/not found/i.test(t) ? `Model "${c.model}" isn't downloaded — open Settings → AI` : `AI request failed: HTTP ${r.status}`); }
    if (!onToken) { const j = await r.json(); return j.message?.content || ''; }
    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue; try { const j = JSON.parse(line); const t = j.message?.content || ''; if (t) { text += t; onToken(t); } if (j.error) throw new Error(j.error); } catch (e) { if (!/JSON/.test(e.message)) throw e; } }
    }
    return text;
  }
  const r = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(c.apiKey ? { Authorization: 'Bearer ' + c.apiKey } : {}) }, signal,
    body: JSON.stringify({ model: c.model, messages, stream: !!onToken, temperature, max_tokens: maxTokens, ...(json ? { response_format: { type: 'json_object' } } : {}) }) });
  if (!r.ok) throw new Error(`AI request failed: HTTP ${r.status}`);
  if (!onToken) { const j = await r.json(); return j.choices?.[0]?.message?.content || ''; }
  const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line.startsWith('data:')) continue; const d = line.slice(5).trim(); if (d === '[DONE]') break; try { const t = JSON.parse(d).choices?.[0]?.delta?.content || ''; if (t) { text += t; onToken(t); } } catch {} }
  }
  return text;
}

// ── prompts ──
const clip = (s, n) => { s = String(s || '').replace(/\s+\n/g, '\n').trim(); return s.length > n ? s.slice(0, n) + '\n[…]' : s; };
const describe = (m) => `From: ${m.fromName ? `${m.fromName} <${m.fromEmail}>` : m.fromEmail}\nDate: ${new Date(m.date).toLocaleString('en-GB')}\nSubject: ${m.subject || ''}\n\n${clip(m.bodyText || m.snippet, 6000)}`;

function summarisePrompt(messages, me) {
  const body = messages.map((m, i) => `--- Message ${i + 1} ---\n${describe(m)}`).join('\n\n');
  return [
    { role: 'system', content: `You summarise email for the reader (${me}). Be concrete and brief. Output plain text with these sections, omitting any that don't apply:\nSummary: 1–3 sentences.\nAction items: bullet list of things the reader must do, with deadlines if any.\nKey details: bullet list (amounts, dates, references, decisions).\nNever invent facts. Do not include greetings or sign-offs.` },
    { role: 'user', content: clip(body, 14000) },
  ];
}
function suggestPrompt(m, me) {
  return [
    { role: 'system', content: `Suggest three short, distinct replies the reader (${me}) might send to this email. Each must be a complete, natural reply of one or two sentences in plain British English, no subject line, no greeting, no sign-off. Return JSON: {"replies":["…","…","…"]}.` },
    { role: 'user', content: describe(m) },
  ];
}
function draftPrompt({ original, instruction, styleSamples, me, mode }) {
  const style = styleSamples?.length ? `\n\nHere are examples of how ${me} writes (match this tone, length and phrasing; do not copy their content):\n${styleSamples.map((s, i) => `<example ${i + 1}>\n${clip(s, 700)}\n</example>`).join('\n')}` : '';
  const task = mode === 'new' ? `Write an email from ${me}. Instruction: ${instruction}` : `Write a reply from ${me} to the email below. ${instruction ? 'Instruction: ' + instruction : 'Respond appropriately to everything they asked.'}`;
  return [
    { role: 'system', content: `You draft emails in plain British English. Output only the body of the email: no subject line, no quoted original, no explanations. Start with a greeting using the recipient's first name if known and end with a sign-off using the name "${me.split(' ')[0]}". Keep it natural and concise.${style}` },
    { role: 'user', content: task + (original ? `\n\nThe email to reply to:\n${describe(original)}` : '') },
  ];
}
function rewritePrompt(text, mode) {
  const modes = { shorter: 'Make it shorter and tighter without losing any information.', formal: 'Make it more formal and professional.', friendly: 'Make it warmer and friendlier while staying professional.', grammar: 'Fix spelling, grammar and punctuation only; keep the wording otherwise unchanged.', english: 'Translate it into natural British English.', bullets: 'Restructure it as short bullet points.' };
  return [
    { role: 'system', content: `You edit email text. ${modes[mode] || modes.grammar} Output only the edited text, keeping any greeting and sign-off, with the same paragraph structure. No commentary.` },
    { role: 'user', content: clip(text, 8000) },
  ];
}
function rulePrompt(text, labels) {
  return [
    { role: 'system', content: `Turn the user's sentence into an email filing rule as JSON: {"name": string, "match": "all"|"any", "conditions":[{"field":"from"|"to"|"subject"|"body"|"any"|"hasAttachment","op":"contains"|"equals"|"startsWith"|"endsWith"|"regex","value":string}], "actions":[{"type":"moveTo"|"addLabel"|"archive"|"markRead"|"star"|"trash"|"spam","labelId"?:string}]}.\nAvailable folders (use the id in labelId): ${labels.map(l => `${l.name} = ${l.id}`).join('; ') || 'none'}. If the user names a folder that doesn't exist, use labelId "NEW:<name>". Return only JSON.` },
    { role: 'user', content: text },
  ];
}
module.exports = { DEFAULTS, RECOMMENDED, status, pull, chat, summarisePrompt, suggestPrompt, draftPrompt, rewritePrompt, rulePrompt };
