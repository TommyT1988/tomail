import { useEffect, useRef, useState } from 'react';
let seq = 0;
/** Streams tokens from an AI IPC call into state. run(fn) where fn(reqId) starts the call. */
export function useAiStream() {
  const [text, setText] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState(null);
  const reqRef = useRef(null);
  useEffect(() => window.mail.on('ai:token', ({ reqId, text: t }) => { if (reqId === reqRef.current) setText(x => x + t); }), []);
  const run = async (fn) => {
    const id = 'ai' + (++seq); reqRef.current = id; setText(''); setError(null); setBusy(true);
    try { const full = await fn(id); if (typeof full === 'string') setText(full); return full; }
    catch (e) { if (!/abort/i.test(e.message)) setError(e.message); return null; }
    finally { if (reqRef.current === id) setBusy(false); }
  };
  const cancel = () => { if (reqRef.current) window.mail.ai.cancel(reqRef.current); setBusy(false); };
  return { text, busy, error, run, cancel, setText };
}
