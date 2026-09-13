'use strict';
/** Parse an Authentication-Results header into { dkim, spf, dmarc } (pass|fail|none|...) */
function parseAuthResults(h) {
  if (!h) return null;
  const s = String(h).toLowerCase();
  const pick = (k) => { const m = new RegExp(`(?:^|[;\\s])${k}=([a-z]+)`).exec(s); return m ? m[1] : null; };
  const out = { dkim: pick('dkim'), spf: pick('spf'), dmarc: pick('dmarc') };
  return out.dkim || out.spf || out.dmarc ? out : null;
}
module.exports = { parseAuthResults };
