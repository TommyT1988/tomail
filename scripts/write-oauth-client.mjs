// Writes electron/gmail/oauthClient.generated.js from env vars (CI secrets or a local .env-style export).
import { writeFileSync } from 'node:fs';
const id = process.env.TOMAIL_GOOGLE_CLIENT_ID || '', secret = process.env.TOMAIL_GOOGLE_CLIENT_SECRET || '';
if (!id || !secret) { console.warn('::warning::TOMAIL_GOOGLE_CLIENT_ID / TOMAIL_GOOGLE_CLIENT_SECRET not set — this build has no built-in Google sign-in (users can add their own client under Settings → Advanced, or use IMAP)'); process.exit(0); }
writeFileSync(new URL('../electron/gmail/oauthClient.generated.js', import.meta.url), `module.exports = ${JSON.stringify({ clientId: id, clientSecret: secret })};\n`);
console.log('oauthClient.generated.js written');
