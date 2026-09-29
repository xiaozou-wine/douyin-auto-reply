// Export douyin cookies from a CDP-attached browser into a private JSON file.
//
// Credential values are written ONLY to the output file (mode 600). Stdout
// carries metadata exclusively: names, lengths, hashes, expiry.
//
// Usage:
//   node runtime/dy-cdp-export.mjs --out <file> [--cdp http://127.0.0.1:9222]

import fs from 'node:fs';
import crypto from 'node:crypto';
import { chromium } from 'playwright';

function parseArgs(argv) {
  const out = { cdp: 'http://127.0.0.1:9222', out: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') out.out = argv[++i];
    else if (argv[i] === '--cdp') out.cdp = argv[++i];
  }
  if (!out.out) {
    console.error('--out is required');
    process.exit(2);
  }
  return out;
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 8);

function describeSidGuard(raw) {
  const parts = decodeURIComponent(raw ?? '').split('|');
  if (parts.length < 3) return '(no timestamp)';
  const issued = new Date(Number(parts[1]) * 1000);
  const age = Number(parts[2]);
  const expires = new Date((Number(parts[1]) + age) * 1000);
  const fmt = (d) => d.toISOString().replace('T', ' ').slice(0, 16);
  return `issued=${fmt(issued)}Z max_age=${age / 86400}d expires=${fmt(expires)}Z`;
}

const args = parseArgs(process.argv.slice(2));

const browser = await chromium.connectOverCDP(args.cdp);
const contexts = browser.contexts();
if (contexts.length === 0) {
  console.error('no browser context available');
  process.exit(1);
}
const context = contexts[0];
const page = context.pages()[0] ?? (await context.newPage());

// Navigating to douyin loads the site's cookie jar into this context.
await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
await page.waitForTimeout(3000);

const all = await context.cookies();
const douyin = all.filter((c) => /(^|\.)douyin\.com$/.test(c.domain.replace(/^\./, '').length ? c.domain : c.domain));
const kept = all.filter((c) => c.domain.includes('douyin'));

const byName = {};
for (const c of kept) byName[c.name] = c;

const sessionid = byName.sessionid?.value ?? '';
if (!sessionid) {
  console.error('sessionid not present in the attached browser context');
  console.error('present douyin cookies:', Object.keys(byName).sort().join(', '));
  await browser.close().catch(() => {});
  process.exit(1);
}

// ms_token is NOT a cookie: it lives in localStorage under "xmst", but the
// production COOKIES_ header must contain it or utils/config.py drops the account.
const msToken = await page.evaluate(() => localStorage.getItem('xmst') ?? '').catch(() => '');
if (!msToken) {
  console.error('warn: localStorage "xmst" (ms_token) is empty; COOKIES_ will be rejected by config validation');
}

const payload = {
  source: 'cdp-export',
  cdp: args.cdp,
  sessionid,
  msToken,
  cookies: Object.fromEntries(
    Object.entries(byName)
      .filter(([, c]) => typeof c.value === 'string' && c.value.length > 0)
      .map(([name, c]) => [name, { value: c.value, domain: c.domain, path: c.path, httpOnly: c.httpOnly, expires: c.expires }]),
  ),
};

const fd = fs.openSync(args.out, 'w', 0o600);
fs.writeSync(fd, JSON.stringify(payload, null, 2));
fs.closeSync(fd);

console.log(`wrote ${args.out} (${Object.keys(payload.cookies).length} cookies)`);
console.log(`sessionid len=${sessionid.length} sha256=${sha(sessionid)} httpOnly=${byName.sessionid.httpOnly}`);
console.log(`sessionid_ss === sessionid: ${byName.sessionid_ss?.value === sessionid}`);
console.log(`sid_guard: ${describeSidGuard(byName.sid_guard?.value)}`);
console.log(`cookie expires (browser view): ${byName.sessionid.expires > 0 ? new Date(byName.sessionid.expires * 1000).toISOString() : 'session'}`);
console.log(`ms_token (localStorage xmst): len=${msToken.length} sha256=${msToken ? sha(msToken) : '-'}`);
console.log(`present: ${Object.keys(byName).sort().join(', ')}`);

await browser.close().catch(() => {});
