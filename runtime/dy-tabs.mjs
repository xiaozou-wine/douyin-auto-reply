// List the attached browser's tabs and flag any sitting on douyin.com.
//
// Why this matters: a douyin tab keeps running site JS, which rotates
// sessionid. If such a tab is left open after exporting credentials, the
// exported value is invalidated. This script is read-only — it never
// navigates, so it cannot itself trigger a rotation.
//
// Usage: node runtime/dy-tabs.mjs [--cdp http://127.0.0.1:9333]

import { chromium } from 'playwright';

let cdp = 'http://127.0.0.1:9333';
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--cdp') cdp = argv[++i];
}

const browser = await chromium.connectOverCDP(cdp);
const ctx = browser.contexts()[0];
const pages = ctx.pages();

console.log(`tab_count=${pages.length}`);
for (const [i, p] of pages.entries()) {
  const url = p.url();
  const marker = /douyin\.com/.test(url) ? '  <== DOUYIN' : '';
  console.log(`  [${i}] ${url.slice(0, 120)}${marker}`);
}

const onDouyin = pages.filter((p) => /douyin\.com/.test(p.url()));
console.log(`tabs_on_douyin=${onDouyin.length}`);

await browser.close().catch(() => {});
