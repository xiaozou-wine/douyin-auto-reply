// Read-only check: is the CDP-attached browser currently logged in to douyin?
// Navigates to douyin.com and inspects the visible page state. Sends no messages.
//
// Usage: node runtime/dy-login-check.mjs [--cdp http://127.0.0.1:9222]

import { chromium } from 'playwright';

let cdp = 'http://127.0.0.1:9222';
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) if (argv[i] === '--cdp') cdp = argv[++i];

const browser = await chromium.connectOverCDP(cdp);
const context = browser.contexts()[0];
if (!context) {
  console.error('no context');
  process.exit(1);
}
const page = context.pages()[0] ?? (await context.newPage());

await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);

const info = await page.evaluate(() => {
  const text = (document.body?.innerText ?? '').slice(0, 1500);
  const hasLoginCta = /登录|立即登录|扫码登录/.test(text);
  const hasUserNav = /私信|消息|我的|创作中心|发布/.test(text);
  const avatar = Array.from(document.querySelectorAll('img')).some(
    (img) => /avatar|user/i.test(String(img.className) + img.src) && img.naturalWidth > 20,
  );
  return { url: location.href, title: document.title, textSample: text.slice(0, 300), hasLoginCta, hasUserNav, avatar };
});

console.log('url:', info.url);
console.log('title:', info.title);
console.log('hasLoginCTA:', info.hasLoginCta);
console.log('hasUserNav:', info.hasUserNav);
console.log('avatar:', info.avatar);
console.log('--- text sample ---');
console.log(info.textSample.replace(/\n{2,}/g, '\n'));

// Independent probe: does the server still accept this session?
const probe = await page.evaluate(async () => {
  try {
    const r = await fetch('/aweme/v1/web/im/upload/config/v2?device_platform=webapp&aid=6383', {
      credentials: 'include',
    });
    const body = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { /* not json */ }
    return {
      status: r.status,
      statusCode: parsed?.status_code ?? null,
      statusMsg: parsed?.status_msg ?? null,
      hasAccessKey: Boolean(parsed?.public_image_config?.access_key_id),
    };
  } catch (e) {
    return { error: String(e).slice(0, 200) };
  }
});
console.log('--- upload-auth probe (from browser, uses its own cookies) ---');
console.log(JSON.stringify(probe, null, 2));

await browser.close().catch(() => {});
