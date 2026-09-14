'use strict';
// Strip tracking parameters and unwrap common redirectors before a link reaches the browser.
const TRACKING = /^(utm_\w+|fbclid|gclid|gclsrc|dclid|msclkid|mc_cid|mc_eid|_hsenc|_hsmi|hsCtaTracking|mkt_tok|igshid|yclid|vero_id|vero_conv|oly_anon_id|oly_enc_id|_ga|_gl|ref_src|ref_url|s_cid|trk|trkCampaign|sc_campaign|sc_channel|sc_content|sc_medium|sc_outcome|sc_geo|sc_country|ncid|nr_email_referer|wickedid|elqTrackId|elq|elqaid|elqat|rb_clickid|spm|cmpid|cid|ttclid|twclid|li_fat_id|_branch_match_id|srsltid)$/i;
const UNWRAP = [
  (u) => (u.hostname === 'www.google.com' || u.hostname === 'google.com') && u.pathname === '/url' ? (u.searchParams.get('q') || u.searchParams.get('url')) : null,
  (u) => /\.safelinks\.protection\.outlook\.com$/i.test(u.hostname) ? u.searchParams.get('url') : null,
  (u) => /^urldefense\.(proofpoint\.)?com$/i.test(u.hostname) && /__(https?:.+?)__/.test(u.pathname + u.search) ? decodeURIComponent(/__(https?:.+?)__/.exec(u.pathname + u.search)[1].replace(/-/g, '%')) : null,
  (u) => u.hostname === 'l.facebook.com' || u.hostname === 'lm.facebook.com' ? u.searchParams.get('u') : null,
  (u) => u.hostname === 'href.li' ? u.search.slice(1) : null,
  (u) => (u.hostname === 'exit.sc' || u.hostname === 'out.reddit.com') ? u.searchParams.get('url') : null,
];
function cleanUrl(input, { stripTracking = true, unwrap = true } = {}) {
  let url;
  try { url = new URL(String(input)); } catch { return String(input); }
  if (!/^https?:$/.test(url.protocol)) return String(input);
  for (let i = 0; i < 3 && unwrap; i++) {
    let target = null;
    for (const f of UNWRAP) { try { target = f(url); } catch {} if (target) break; }
    if (!target) break;
    try { const t = new URL(target); if (/^https?:$/.test(t.protocol)) url = t; else break; } catch { break; }
  }
  if (stripTracking) { for (const k of [...url.searchParams.keys()]) if (TRACKING.test(k)) url.searchParams.delete(k); if (!url.searchParams.toString()) url.search = ''; }
  return url.toString();
}
module.exports = { cleanUrl };
