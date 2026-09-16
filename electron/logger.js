'use strict';
// Console + rotating file log (userData/logs/tomail.log, 2 MB, keeps one previous file).
const fs = require('node:fs');
const path = require('node:path');
const MAX = 2 * 1024 * 1024;
function createLogger(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fmt = (a) => a.map(x => (x instanceof Error ? x.stack || x.message : typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(' ');
  const log = (...a) => {
    const line = `${new Date().toISOString()} ${fmt(a)}`;
    try { console.log(line.slice(11, 19), ...a); } catch {}   // stdout may be a dead pipe (desktop launcher) → EPIPE
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > MAX) { fs.renameSync(file, file + '.1'); }
      fs.appendFileSync(file, line + '\n');
    } catch {}
  };
  log.file = file;
  log.tail = (n = 80) => { try { return fs.readFileSync(file, 'utf8').trim().split('\n').slice(-n).join('\n'); } catch { return ''; } };
  return log;
}
module.exports = { createLogger };
