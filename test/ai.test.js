'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const ai = require('../electron/ai');

/** A stand-in Ollama that streams NDJSON and answers /api/tags + /api/pull. */
function fakeOllama() {
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
      if (req.url === '/api/tags') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ models: [{ name: 'llama3.2:3b', size: 2e9 }] })); }
      if (req.url === '/api/pull') { for (const p of [{ status: 'pulling', completed: 1, total: 4 }, { status: 'pulling', completed: 4, total: 4 }, { status: 'success' }]) res.write(JSON.stringify(p) + '\n'); return res.end(); }
      if (req.url === '/api/chat') {
        const j = JSON.parse(body); srv.last = j;
        if (j.format === 'json') return res.end(JSON.stringify({ message: { content: JSON.stringify({ replies: ['Yes, that works.', 'Can we do Friday?', 'Thanks, received.'] }) } }));
        for (const t of ['Summary: ', 'they want ', 'the quote.']) res.write(JSON.stringify({ message: { content: t } }) + '\n');
        return res.end(JSON.stringify({ done: true }) + '\n');
      }
      res.statusCode = 404; res.end();
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
}
const settingsFor = (port, extra = {}) => ({ get: () => ({ prefs: { ai: { enabled: true, kind: 'ollama', endpoint: `http://127.0.0.1:${port}`, model: 'llama3.2:3b', ...extra } } }) });

test('ai: status, streaming chat, json mode, pull progress', async () => {
  const srv = await fakeOllama(); const port = srv.address().port; const s = settingsFor(port);
  const st = await ai.status(s); assert.equal(st.reachable, true); assert.equal(st.hasModel, true);
  const tokens = []; const full = await ai.chat(s, [{ role: 'user', content: 'hi' }], { onToken: (t) => tokens.push(t) });
  assert.equal(full, 'Summary: they want the quote.'); assert.equal(tokens.length, 3);
  assert.equal(srv.last.stream, true); assert.equal(srv.last.model, 'llama3.2:3b');
  const j = JSON.parse(await ai.chat(s, [{ role: 'user', content: 'x' }], { json: true })); assert.equal(j.replies.length, 3);
  const prog = []; await ai.pull(s, 'llama3.2:3b', (p) => prog.push(p)); assert.equal(prog.at(-1).status, 'success');
  const off = await ai.status(settingsFor(1)); assert.equal(off.reachable, false);
  srv.close();
});

test('ai: prompts carry the essentials', () => {
  const m = { fromName: 'Ann', fromEmail: 'ann@x.com', date: Date.now(), subject: 'Quote', bodyText: 'Please confirm the price by Friday.' };
  const sum = ai.summarisePrompt([m], 'Alex'); assert.match(sum[1].content, /Quote/); assert.match(sum[0].content, /Action items/);
  const d = ai.draftPrompt({ original: m, instruction: 'say yes', styleSamples: ['Cheers,\nAlex'], me: 'Alex Smith', mode: 'reply' });
  assert.match(d[0].content, /<example 1>/); assert.match(d[1].content, /say yes/); assert.match(d[0].content, /"Alex"/);
  assert.match(ai.rewritePrompt('x', 'shorter')[0].content, /shorter/);
  assert.match(ai.rulePrompt('file receipts', [{ id: 'L1', name: 'Finance' }])[0].content, /Finance = L1/);
});
