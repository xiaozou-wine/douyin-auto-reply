// Build the .env update payload for the VPS from a CDP export and push it.
//
// Writes a private JSON file containing the new SESSIONID_ and COOKIES_ values,
// then hands it to the VPS. Credential values never touch stdout.
//
// COOKIES_ must include ms_token (from localStorage "xmst") or the production
// config validator drops the account silently.
//
// Usage:
//   node runtime/dy-push-env.mjs --in <export.json> --out <payload.json>
//   node runtime/dy-push-env.mjs --in <export.json> --push root@host:/path

import fs from 'node:fs';
import crypto from 'node:crypto';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 8);

let input = null;
let output = null;
let push = null;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--in') input = argv[++i];
  else if (argv[i] === '--out') output = argv[++i];
  else if (argv[i] === '--push') push = argv[++i];
}
if (!input || !output) {
  console.error('usage: --in <export.json> --out <payload.json> [--push user@host:/path]');
  process.exit(2);
}

const exp = JSON.parse(fs.readFileSync(input, 'utf8'));
const sessionid = exp.sessionid;
const msToken = exp.msToken;

if (!sessionid) {
  console.error('FATAL: export has no sessionid');
  process.exit(1);
}
if (!msToken) {
  console.error('FATAL: export has no msToken; COOKIES_ would be rejected by config validation');
  process.exit(1);
}

// Required by utils/config.py::parse_cookies_str
const REQUIRED = ['ms_token', 's_v_web_id', 'UIFID'];

const pairs = [];
for (const [name, meta] of Object.entries(exp.cookies)) {
  if (meta && typeof meta.value === 'string' && meta.value.length > 0 && name.trim() !== '') {
    pairs.push(`${name}=${meta.value}`);
  }
}
// Remove any stale ms_token, then append the authoritative localStorage value.
const filtered = pairs.filter((p) => !p.startsWith('ms_token='));
filtered.push(`ms_token=${msToken}`);
const cookieStr = filtered.join('; ');

const missing = REQUIRED.filter((k) => !cookieStr.includes(`${k}=`));
if (missing.length > 0) {
  console.error('FATAL: COOKIES_ missing required field(s):', missing.join(', '));
  process.exit(1);
}

const payload = { sessionid, cookies: cookieStr };
const fd = fs.openSync(output, 'w', 0o600);
fs.writeSync(fd, JSON.stringify(payload));
fs.closeSync(fd);

console.log('wrote', output);
console.log('sessionid: len=%d sha=%s', sessionid.length, sha(sessionid));
console.log('ms_token:  len=%d sha=%s', msToken.length, sha(msToken));
console.log('cookie count: %d  (header length %d)', filtered.length, cookieStr.length);
for (const k of [...REQUIRED, 'sessionid', 'sid_guard', 'ttwid', 'odin_tt', 'n_mh', 'passport_assist_user']) {
  console.log(`  ${k.padEnd(22)} ${cookieStr.includes(`${k}=`) ? 'present' : 'MISSING'}`);
}

if (push) {
  const { spawnSync } = await import('node:child_process');
  const res = spawnSync('scp', ['-o', 'ConnectTimeout=20', '-o', 'BatchMode=yes', output, push], {
    stdio: 'inherit',
  });
  if (res.status !== 0) {
    console.error('scp failed with status', res.status);
    process.exit(res.status ?? 1);
  }
  console.log('pushed to', push);
}
