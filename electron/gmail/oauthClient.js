'use strict';
// The Google OAuth client Tomail ships with. Google classes Desktop-app client
// secrets as non-confidential (the flow is protected by PKCE + loopback), so
// embedding them in the build is the documented approach for installed apps.
// The values are written into oauthClient.generated.js by scripts/write-oauth-client.mjs
// (from TOMAIL_GOOGLE_CLIENT_ID / _SECRET env vars, e.g. GitHub Actions secrets).
let generated = null;
try { generated = require('./oauthClient.generated.js'); } catch {}
const BUILTIN = {
  clientId: generated?.clientId || process.env.TOMAIL_GOOGLE_CLIENT_ID || '',
  clientSecret: generated?.clientSecret || process.env.TOMAIL_GOOGLE_CLIENT_SECRET || '',
};
function hasBuiltin() { return !!(BUILTIN.clientId && BUILTIN.clientSecret); }
module.exports = { BUILTIN, hasBuiltin };
