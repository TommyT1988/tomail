'use strict';
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  oauth: { clientId: '', clientSecret: '' },
  prefs: { syncIntervalSec: 60, fastPollSec: 20, loadRemoteImages: false, signature: '', markReadDelayMs: 1500, sendDelaySec: 5, bodyRetentionDays: 0 },
};

class Settings {
  constructor(file) { this.file = file; this.data = this.load(); }
  load() {
    try { const j = JSON.parse(fs.readFileSync(this.file, 'utf8')); return { oauth: { ...DEFAULTS.oauth, ...j.oauth }, prefs: { ...DEFAULTS.prefs, ...j.prefs } }; }
    catch { return JSON.parse(JSON.stringify(DEFAULTS)); }
  }
  save() { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2)); }
  get() { return JSON.parse(JSON.stringify(this.data)); }
  set(patch) {
    if (patch.oauth) this.data.oauth = { ...this.data.oauth, ...patch.oauth };
    if (patch.prefs) this.data.prefs = { ...this.data.prefs, ...patch.prefs };
    this.save();
    return this.get();
  }
}
module.exports = { Settings, DEFAULTS };
