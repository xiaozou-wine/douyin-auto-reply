// Probe the douyin upload-config endpoint from INSIDE the attached browser page.
//
// Same cookie jar, same TLS fingerprint, real a_bogus-free browser fetch — this
// isolates "is this session actually logged in?" from Python-side header/signature
// differences. Never prints credential values.
//
// Usage: node runtime/dy-probe-inbrowser.mjs [--cdp http://127.0.0.1:9333]

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
await page.waitForTimeout(4000);

const result = await page.evaluate(async () => {
  const qs = new URLSearchParams({
    device_platform: 'webapp',
    aid: '6383',
    msToken: localStorage.getItem('xmst') ?? '',
  });
  const url = `https://www.douyin.com/aweme/v1/web/im/upload/config/v2?${qs}`;
  try {
    const res = await fetch(url, { credentials: 'include' });
    const text = await res.text();
    return { ok: true, status: res.status, body: text.slice(0, 900) };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200) };
  }
});

console.log('in_browser_fetch:', JSON.stringify(result, null, 2));

// Who does the site think we are?
const self = await page.evaluate(async () => {
  try {
    const res = await fetch('https://www.douyin.com/aweme/v1/web/im/user/info/?aid=6383', {
      credentials: 'include',
    });
    const text = await res.text();
    return { status: res.status, body: text.slice(0, 400) };
  } catch (e) {
    return { error: String(e).slice(0, 200) };
  }
});
console.log('user_info:', JSON.stringify(self, null, 2));

const ck = await ctx.cookies();
const byName = {};
for (const c of ck) if (c.domain.includes('douyin')) byName[c.name] = c.value;
console.log('sessionid sha8=' + (byName.sessionid ? sha(byName.sessionid) : 'NONE'));

await browser.close().catch(() => {});
