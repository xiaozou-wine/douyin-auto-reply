import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const outDir = '/app/runtime/diagnostics';
fs.mkdirSync(outDir, { recursive: true });
const failures = [];
const responses = [];

const context = await chromium.launchPersistentContext('/app/runtime/browser-profile', {
  headless: true,
  viewport: { width: 1365, height: 900 },
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  args: ['--disable-dev-shm-usage', '--no-sandbox'],
});
const page = context.pages()[0] ?? await context.newPage();
page.setDefaultTimeout(30000);
page.on('requestfailed', (req) => {
  failures.push({ url: req.url(), method: req.method(), failure: req.failure()?.errorText ?? null, resourceType: req.resourceType() });
});
page.on('response', (resp) => {
  const url = resp.url();
  if (/login|passport|sso|qr|qrcode|captcha|verify|douyin/i.test(url)) {
    responses.push({ url, status: resp.status(), resourceType: resp.request().resourceType() });
  }
});

await page.goto('https://www.douyin.com/user/self?showTab=message', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);
const loginButton = page.locator('text="登录"').first();
if (await loginButton.isVisible({ timeout: 3000 }).catch(() => false)) {
  await loginButton.click();
}

for (const seconds of [5, 15, 30, 45]) {
  await page.waitForTimeout(seconds === 5 ? 5000 : 10000);
  await page.screenshot({ path: path.join(outDir, 'login-' + seconds + 's.png'), fullPage: true });
}

const dom = await page.evaluate(() => {
  const visibleText = document.body.innerText.slice(0, 3000);
  const imgs = Array.from(document.images).map((img) => ({
    src: img.currentSrc || img.src,
    width: img.naturalWidth,
    height: img.naturalHeight,
    alt: img.alt,
    className: String(img.className),
  })).slice(0, 80);
  const canvases = Array.from(document.querySelectorAll('canvas')).map((canvas) => ({
    width: canvas.width,
    height: canvas.height,
    className: String(canvas.className),
  }));
  const svgs = Array.from(document.querySelectorAll('svg')).map((svg) => ({
    text: svg.textContent?.slice(0, 120) ?? '',
    className: svg.getAttribute('class'),
    width: svg.getAttribute('width'),
    height: svg.getAttribute('height'),
  })).slice(0, 50);
  const buttons = Array.from(document.querySelectorAll('button, [role=button], a')).map((el) => ({
    tag: el.tagName,
    text: (el.textContent || '').trim().slice(0, 100),
    aria: el.getAttribute('aria-label'),
    className: el.getAttribute('class'),
  })).filter((x) => x.text || x.aria).slice(0, 100);
  return { url: location.href, title: document.title, visibleText, imgs, canvases, svgs, buttons };
});

fs.writeFileSync(path.join(outDir, 'diagnostic.json'), JSON.stringify({ dom, failures, responses: responses.slice(-200) }, null, 2));
await context.close();
