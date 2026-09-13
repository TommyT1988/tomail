'use strict';
const { contextBridge, ipcRenderer } = require('electron');

async function call(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (r && r.__err) { const e = new Error(r.__err.message); e.code = r.__err.code; throw e; }
  return r;
}
const api = {
  accounts: {
    list: () => call('accounts:list'), add: () => call('accounts:add'), remove: (id) => call('accounts:remove', id),
    resync: (id) => call('accounts:resync', id), rename: (id, name) => call('accounts:rename', id, name),
  },
  settings: { get: () => call('settings:get'), set: (patch) => call('settings:set', patch) },
  labels: { list: (accountId) => call('labels:list', accountId), create: (accountId, name) => call('labels:create', accountId, name) },
  messages: {
    list: (view, page) => call('messages:list', view, page), count: (view) => call('messages:count', view),
    get: (accountId, id) => call('messages:get', accountId, id), counts: () => call('messages:counts'),
    deepSearch: (q, accountId) => call('messages:deepSearch', q, accountId), thread: (accountId, threadId) => call('messages:thread', accountId, threadId),
  },
  actions: {
    markRead: (t, read) => call('actions:markRead', t, read), star: (t, on) => call('actions:star', t, on),
    archive: (t) => call('actions:archive', t), trash: (t) => call('actions:trash', t), untrash: (t) => call('actions:untrash', t),
    spam: (t, on) => call('actions:spam', t, on), move: (t, to, from) => call('actions:move', t, to, from),
    snooze: (t, until) => call('actions:snooze', t, until), unsnooze: (t) => call('actions:unsnooze', t),
    send: (opts) => call('actions:send', opts),
  },
  attachments: { save: (a, m, att) => call('attachments:save', a, m, att), open: (a, m, att) => call('attachments:open', a, m, att) },
  compose: { pickFiles: () => call('compose:pickFiles') },
  sync: { now: (accountId) => call('sync:now', accountId), status: () => call('sync:status') },
  shell: { openExternal: (url) => call('shell:openExternal', url) },
  app: { info: () => call('app:info') },
  on: (event, cb) => { const h = (_e, payload) => cb(payload); ipcRenderer.on(event, h); return () => ipcRenderer.removeListener(event, h); },
};
contextBridge.exposeInMainWorld('mail', api);
