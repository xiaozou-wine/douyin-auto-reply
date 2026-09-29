// Probe whether douyin renews the session during normal browsing.
//
// Attaches to a CDP browser that already holds a valid douyin login, browses
// a few public pages, and records every Set-Cookie touching the auth family.
// Also reports whether the sessionid value itself changes.
//
// Read-only: visits public pages only. Never opens 私信 or sends anything.
//
// Usage: node runtime/dy-renew-probe.mjs [--cdp http://127.0.0.1:9333]

import { chromium } from 'playwright';
import crypto from 'node:crypto';

let cdp = 'http://127.0.0.1:9333';
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) if (argv[i] === '--cdp') cdp = argv[++i];

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 8);
const AUTH = new Set([
  'sessionid', 'sessionid_ss', 'sid_guard', 'sid_tt', 'uid_tt', 'uid_tt_ss',
  'session_tlb_tag', 'sid_ucp_v1', 'ssid_ucp_v1', 'passport_assist_user', 'd_ticket',
]);

const browser = await chromium.connectOverCDP(cdp);
const context = browser.contexts()[0];
const page = context.pages()[0] ?? (await context.newPage());

const before = Object.fromEntries((await context.cookies()).map((c) => [c.name, c.value]));
console.log('sessionid BEFORE sha=%s', sha(before.sessionid ?? ''));

const seen = [];
const requests = [];
page.on('response', async (resp) => {
  const url = resp.url();
  if (!/douyin|bytedance|snssdk/.test(url)) return;
  requests.push({ url, status: resp.status() });
  try {
    const headers = await resp.allHeaders();
    const sc = headers['set-cookie'];
    if (!sc) return;
    for (const line of sc.split('\n')) {
      const name = line.split('=')[0]?.trim();
      if (AUTH.has(name)) {
        seen.push({ url, name, raw: line.slice(0, 200) });
      }
    }
  } catch { /* response gone */ }
});

const pages = [
  'https://www.douyin.com/',
  'https://www.douyin.com/jingxuan',
  'https://www.douyin.com/user/self',
];

for (const url of pages) {
  console.log('\n=== navigating', url, '===');
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch((e) => console.log('nav err', String(e).slice(0, 80)));
  await page.waitForTimeout(8000);
  console.log('  landed:', page.url());
}

console.log('\n--- total douyin requests observed:', requests.length);
const interesting = requests.filter((r) => /renew|refresh|sso|passport|token|login/i.test(r.url));
console.log('--- auth-related requests:');
for (const r of interesting.slice(0, 40)) console.log('   %s %s', r.status, r.url.slice(0, 160));

console.log('\n--- Set-Cookie on auth cookies:', seen.length);
for (const s of seen.slice(0, 40)) {
  console.log('   [%s] from %s', s.name, s.url.slice(0, 120));
  console.log('        %s', s.raw);
}

const after = Object.fromEntries((await context.cookies()).map((c) => [c.name, c.value]));
console.log('\n--- comparison ---');
for (const n of AUTH) {
  const b = before[n], a = after[n];
  if (b === undefined && a === undefined) continue;
  const status = b === a ? 'unchanged' : 'CHANGED';
  console.log('   %-22s %s  before=%s after=%s', n, status, b ? sha(b) : '-', a ? sha(a) : '-');
}

await browser.close().catch(() => {});
