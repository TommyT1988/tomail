// Writes electron/gmail/oauthClient.generated.js from env vars (CI secrets or a local .env-style export).
import { writeFileSync } from 'node:fs';
const id = process.env.TOMAIL_GOOGLE_CLIENT_ID || '', secret = process.env.TOMAIL_GOOGLE_CLIENT_SECRET || '';
if (!id || !secret) { console.error('TOMAIL_GOOGLE_CLIENT_ID / TOMAIL_GOOGLE_CLIENT_SECRET not set — build will have no built-in Google sign-in'); process.exit(process.env.CI ? 1 : 0); }
writeFileSync(new URL('../electron/gmail/oauthClient.generated.js', import.meta.url), `module.exports = ${JSON.stringify({ clientId: id, clientSecret: secret })};\n`);
console.log('oauthClient.generated.js written');
