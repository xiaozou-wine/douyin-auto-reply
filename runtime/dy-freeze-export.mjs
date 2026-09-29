// Freeze the douyin sessionid before exporting it.
//
// Observed 2026-09-25: every page load on douyin.com rotates sessionid, so a
// value exported while the tab stays on douyin.com can be dead before it is
// deployed. This script:
//   1. records sessionid before navigation
//   2. navigates the tab AWAY from douyin.com (about:blank) to stop site JS
//   3. re-reads sessionid and reports whether it stabilised
//   4. writes the frozen credential set to a mode-600 file
//
// Credential values never reach stdout.
//
// Usage: node runtime/dy-freeze-export.mjs --out <file> [--cdp http://127.0.0.1:9333]

import fs from 'node:fs';
import crypto from 'node:crypto';
import { chromium } from 'playwright';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 8);

let cdp = 'http://127.0.0.1:9333';
let out = null;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--cdp') cdp = argv[++i];
  else if (argv[i] === '--out') out = argv[++i];
}
if (!out) {
  console.error('--out is required');
  process.exit(2);
}

const browser = await chromium.connectOverCDP(cdp);
const ctx = browser.contexts()[0];
const page = ctx.pages()[0] ?? (await ctx.newPage());

const readSid = async () => {
  const all = await ctx.cookies();
  const hit = all.find((c) => c.domain.includes('douyin') && c.name === 'sessionid');
  return hit ? hit.value : '';
};

const before = await readSid();
console.log(`sid_before_nav sha8=${before ? sha(before) : 'NONE'}`);

// Stop the douyin tab from running its JS, which is what rotates the session.
await page.goto('about:blank').catch(() => {});
await page.waitForTimeout(6000);

const afterNav = await readSid();
console.log(`sid_after_nav  sha8=${afterNav ? sha(afterNav) : 'NONE'}`);
console.log(`stable_after_nav=${before === afterNav}`);

await page.waitForTimeout(8000);
const settled = await readSid();
console.log(`sid_settled    sha8=${settled ? sha(settled) : 'NONE'}`);
console.log(`stable_after_14s=${afterNav === settled}`);

const all = await ctx.cookies();
const byName = {};
for (const c of all) if (c.domain.includes('douyin')) byName[c.name] = c;
const sessionid = byName.sessionid?.value ?? '';
if (!sessionid) {
  console.error('FATAL: no sessionid after freeze');
  await browser.close().catch(() => {});
  process.exit(1);
}

// ms_token lives in localStorage under "xmst"; capture it from any douyin page.
let msToken = '';
try {
  const p2 = await ctx.newPage();
  await p2.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded' });
  await p2.waitForTimeout(2500);
  msToken = await p2.evaluate(() => localStorage.getItem('xmst') ?? '');
  await p2.close();
} catch {
  msToken = '';
}
console.log(`ms_token len=${msToken.length} sha8=${msToken ? sha(msToken) : '-'}`);

const pairs = Object.entries(byName)
  .filter(([k, c]) => k && typeof c.value === 'string' && c.value.length > 0)
  .map(([k, c]) => `${k}=${c.value}`)
  .filter((p) => !p.startsWith('ms_token='));
// ms_token is a localStorage value ("xmst"), not a cookie. Append the
// authoritative one so COOKIES_ passes utils/config.py validation.
if (msToken) {
  pairs.push(`ms_token=${msToken}`);
}
const cookieStr = pairs.join('; ');

for (const k of ['ms_token', 's_v_web_id', 'UIFID']) {
  if (!cookieStr.includes(`${k}=`)) {
    console.error(`FATAL: cookies missing required field ${k}`);
    await browser.close().catch(() => {});
    process.exit(1);
  }
}

// Match dy-cdp-export.mjs's shape: cookies is a name -> metadata map, so
// dy-push-env.mjs can consume it directly.
const cookies = Object.fromEntries(
  Object.entries(byName)
    .filter(([k, c]) => k && typeof c.value === 'string' && c.value.length > 0)
    .map(([k, c]) => [k, { value: c.value, domain: c.domain, path: c.path, httpOnly: c.httpOnly, expires: c.expires }]),
);

const payload = { sessionid, msToken, cookies, frozenAt: null };
const fd = fs.openSync(out, 'w', 0o600);
fs.writeSync(fd, JSON.stringify(payload));
fs.closeSync(fd);

const guard = decodeURIComponent(byName.sid_guard?.value ?? '');
const parts = guard.split('|');
let ttlDesc = '(unparsable)';
if (parts.length >= 3) {
  ttlDesc = `issued=${new Date(Number(parts[1]) * 1000).toISOString().slice(0, 16)}Z ttl=${Number(parts[2]) / 86400}d`;
}
console.log(`wrote ${out} cookies=${Object.keys(byName).length}`);
console.log(`sessionid sha8=${sha(sessionid)} len=${sessionid.length}`);
console.log(`sid_guard: ${ttlDesc}`);

await browser.close().catch(() => {});
