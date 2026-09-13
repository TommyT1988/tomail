import React, { useEffect, useState } from 'react';
import Compose from './components/Compose.jsx';

function applyTheme(t) {
  const root = document.documentElement;
  root.dataset.theme = !t || t === 'system' ? '' : t;
  root.classList.toggle('dark', t === 'dark' || ((!t || t === 'system') && window.matchMedia('(prefers-color-scheme: dark)').matches));
}

/** Standalone compose page shown in its own BrowserWindow (#compose/<id>). */
export default function ComposeWindow({ id }) {
  const [state, setState] = useState(null);
  const [toastMsg, setToastMsg] = useState(null);
  const toast = (m, err) => { setToastMsg({ m, err }); setTimeout(() => setToastMsg(t => (t?.m === m ? null : t)), err ? 6000 : 2500); };
  useEffect(() => {
    (async () => {
      const [payload, accounts, s] = await Promise.all([window.mail.compose.payload(id), window.mail.accounts.list(), window.mail.settings.get()]);
      applyTheme(s.prefs.theme);
      if (!payload) { setState({ error: 'This compose window has expired.' }); return; }
      let original = null;
      if (payload.originalId) { try { original = await window.mail.messages.get(payload.accountId, payload.originalId); } catch (e) { toast(e.message, true); } }
      setState({ draft: { ...payload, original }, accounts, prefs: s.prefs });
    })();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onMq = () => window.mail.settings.get().then(s => applyTheme(s.prefs.theme));
    mq.addEventListener('change', onMq);
    return () => mq.removeEventListener('change', onMq);
  }, [id]);
  const close = () => window.mail.compose.closeNow(id);
  if (!state) return <div className="compose-window"><div className="empty">Loading…</div></div>;
  if (state.error) return <div className="compose-window"><div className="empty">{state.error} <button onClick={close}>Close</button></div></div>;
  return (
    <div className="compose-window">
      <Compose key={id} draft={state.draft} accounts={state.accounts} prefs={state.prefs} onClose={close} toast={toast} standalone />
      {toastMsg && <div className={'toast' + (toastMsg.err ? ' err' : '')}>{toastMsg.m}</div>}
    </div>
  );
}
