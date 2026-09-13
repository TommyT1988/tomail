import React, { useEffect, useState } from 'react';
import ReadingPane from './components/ReadingPane.jsx';
import Icon from './components/Icons.jsx';

function applyTheme(t) { const r = document.documentElement; r.dataset.theme = !t || t === 'system' ? '' : t; r.classList.toggle('dark', t === 'dark' || ((!t || t === 'system') && window.matchMedia('(prefers-color-scheme: dark)').matches)); }

/** A single message in its own window (#message/<accountId>/<id>). */
export default function MessageWindow({ accountId, id }) {
  const [message, setMessage] = useState(null);
  const [thread, setThread] = useState(null);
  const [prefs, setPrefs] = useState(null);
  const [error, setError] = useState(null);
  const [toastMsg, setToastMsg] = useState(null);
  const toast = (m, err) => { setToastMsg({ m, err }); setTimeout(() => setToastMsg(t => (t?.m === m ? null : t)), err ? 6000 : 2500); };
  const load = async () => {
    try {
      const [s, m] = await Promise.all([window.mail.settings.get(), window.mail.messages.get(accountId, id)]);
      setPrefs(s.prefs); applyTheme(s.prefs.theme);
      if (!m) { setError('Message not found'); return; }
      setMessage(m); document.title = `${m.subject || '(no subject)'} — Tomail`;
      if (m.threadId) { const th = await window.mail.messages.thread(accountId, m.threadId, {}); if (th.length > 1) setThread(th); }
      if (m.unread) setTimeout(() => window.mail.actions.markRead([{ accountId, id }], true).catch(() => {}), s.prefs.markReadDelayMs ?? 1500);
    } catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); return window.mail.on('mail:changed', () => window.mail.messages.get(accountId, id).then(m => m && setMessage(m)).catch(() => {})); }, [accountId, id]); // eslint-disable-line
  const t = [{ accountId, id }];
  const act = (fn, msg) => fn().then(() => { toast(msg); if (/Archived|Deleted/.test(msg)) window.close(); }).catch(e => toast(e.message, true));
  const reply = (mode) => window.mail.compose.open({ mode, accountId, originalId: id });
  return (
    <div className="app" style={{ gridTemplateRows: '38px 1fr' }}>
      <div className="toolbar">
        <button onClick={() => reply('reply')}><span className="ico"><Icon name="reply" /></span>Reply</button>
        <button onClick={() => reply('replyAll')}><span className="ico"><Icon name="replyAll" /></span>Reply All</button>
        <button onClick={() => reply('forward')}><span className="ico"><Icon name="forward" /></span>Forward</button>
        <span className="sep" />
        <button onClick={() => act(() => window.mail.actions.archive(t), 'Archived')}><span className="ico"><Icon name="archive" /></span>Archive</button>
        <button onClick={() => act(() => window.mail.actions.trash(t), 'Deleted')}><span className="ico"><Icon name="trash" /></span>Delete</button>
        <button onClick={() => act(() => window.mail.actions.star(t, !message?.starred), message?.starred ? 'Unflagged' : 'Flagged')}><span className="ico"><Icon name="flag" /></span>{message?.starred ? 'Unflag' : 'Flag'}</button>
        <span className="spacer" />
        <button onClick={() => window.mail.messages.print(accountId, id)}><span className="ico"><Icon name="external" /></span>Print</button>
      </div>
      <div className="main" style={{ minHeight: 0 }}>
        {error ? <div className="empty">{error}</div> : <ReadingPane message={message} thread={thread} loading={!message} prefs={prefs} error={null}
          onRespond={async (m, p) => { try { await window.mail.actions.respondInvite(m.accountId, m.id, p); toast('Reply sent to the organiser'); load(); } catch (e) { toast(e.message, true); } }}
          toast={toast} onPrint={(m) => window.mail.messages.print(m.accountId, m.id)} onReplyTo={(m, mode) => window.mail.compose.open({ mode, accountId: m.accountId, originalId: m.id })} />}
      </div>
      {toastMsg && <div className={'toast' + (toastMsg.err ? ' err' : '')}>{toastMsg.m}</div>}
    </div>
  );
}
