// Read douyin localStorage values needed to complete the COOKIES_ header.
//
// ms_token is NOT a cookie: it lives in localStorage under "xmst" and the
// production config validator requires it. Values are written only to the
// output file, never printed.
//
// Usage: node runtime/dy-ls-read.mjs --out <file> [--cdp http://127.0.0.1:9333]

import fs from 'node:fs';
import crypto from 'node:crypto';
import { chromium } from 'playwright';

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

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 8);

const browser = await chromium.connectOverCDP(cdp);
const context = browser.contexts()[0];
const page = context.pages()[0] ?? (await context.newPage());

await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
await page.waitForTimeout(4000);

const values = await page.evaluate(() => ({
  xmst: localStorage.getItem('xmst') ?? '',
  logTrace: localStorage.getItem('LOG_TRACE') ?? '',
  teaTokens: localStorage.getItem('__tea_cache_tokens_2562') ?? '',
  keys: Object.keys(localStorage).filter((k) => /token|xmst|ms_/i.test(k)),
}));

const fd = fs.openSync(out, 'w', 0o600);
fs.writeSync(fd, JSON.stringify(values, null, 2));
fs.closeSync(fd);

console.log('wrote', out);
console.log('xmst: len=%d sha=%s', values.xmst.length, values.xmst ? sha(values.xmst) : '-');
console.log('logTrace: len=%d', values.logTrace.length);
console.log('teaTokens: len=%d', values.teaTokens.length);
console.log('token-ish localStorage keys:', values.keys.join(', ') || '(none)');

await browser.close().catch(() => {});
