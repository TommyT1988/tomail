'use strict';
const crypto = require('node:crypto');
function hash(pass, salt) { return crypto.scryptSync(String(pass), salt, 32).toString('hex'); }
function setPass(settings, pass) { const salt = crypto.randomBytes(16).toString('hex'); settings.set({ prefs: { lockHash: hash(pass, salt), lockSalt: salt } }); }
function clearPass(settings) { settings.set({ prefs: { lockHash: null, lockSalt: null } }); }
function verify(settings, pass) { const { lockHash, lockSalt } = settings.get().prefs; if (!lockHash) return true; return crypto.timingSafeEqual(Buffer.from(hash(pass, lockSalt)), Buffer.from(lockHash)); }
function enabled(settings) { return !!settings.get().prefs.lockHash; }
module.exports = { setPass, clearPass, verify, enabled };
