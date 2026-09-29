// Report the attached browser's douyin login state without printing credentials.
//
// Usage: node runtime/dy-login-state.mjs [--cdp http://127.0.0.1:9333]

import { chromium } from 'playwright';
import crypto from 'node:crypto';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 8);

let cdp = 'http://127.0.0.1:9333';
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--cdp') cdp = argv[++i];
}

const browser = await chromium.connectOverCDP(cdp);
const ctx = browser.contexts()[0];
const page = ctx.pages()[0] ?? (await ctx.newPage());

await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
await page.waitForTimeout(6000);

const info = await page.evaluate(() => {
  const ls = Object.keys(localStorage);
  const mst = localStorage.getItem('xmst') ?? '';
  const pick = (re) => ls.filter((k) => re.test(k));
  return {
    url: location.href,
    title: document.title,
    lsCount: ls.length,
    msTokenKeys: pick(/mst|token/i),
    xmstLen: mst.length,
    xmstSha: mst ? null : '-',
    hasLoginEntry: !!document.querySelector(
      '[data-e2e="login-button"], [class*="login-button"], [class*="loginEntry"]',
    ),
    avatarCount: document.querySelectorAll('[class*="avatar"]').length,
  };
});

const ck = await ctx.cookies();
const byName = {};
for (const c of ck) if (c.domain.includes('douyin')) byName[c.name] = c.value;

const sid = byName.sessionid ?? '';
const guard = decodeURIComponent(byName.sid_guard ?? '');
const parts = guard.split('|');
let guardDesc = '(unparsable)';
if (parts.length >= 3) {
  const issued = new Date(Number(parts[1]) * 1000);
  const ttl = Number(parts[2]);
  guardDesc = `issued=${issued.toISOString().slice(0, 16)}Z ttl=${ttl / 86400}d`;
}

console.log(JSON.stringify(info, null, 2));
console.log('--- cookies ---');
console.log(`sessionid sha8=${sid ? sha(sid) : 'NONE'} len=${sid.length}`);
console.log(`sid_guard: ${guardDesc}`);
console.log(`login_time present: ${!!byName.login_time}`);
console.log(`passport_assist_user present: ${!!byName.passport_assist_user}`);
console.log(`sid_tt present: ${!!byName.sid_tt}`);
console.log(`cookie count: ${Object.keys(byName).length}`);

await browser.close().catch(() => {});
