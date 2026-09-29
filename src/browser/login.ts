import type { Page } from 'playwright';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { runtimePath } from '../utils/paths.js';
import { screenshotPath } from '../utils/screenshot.js';
import { sleep } from '../utils/sleep.js';
import { savePageScreenshot } from './session.js';

/**
 * 通过页面可见文本和 URL 保守判断登录态；不尝试绕过任何登录/验证码流程。
 */
export async function isLoggedIn(page: Page): Promise<boolean> {
  const bodyText = await readBodyText(page, 3_000);
  if (bodyText) {
    // 登录弹窗优先级必须高于公共导航。未登录页面也会显示“私信”等导航入口，不能据此判定已登录。
    if (/登录|扫码|验证码/.test(bodyText)) return false;
    if (/私信|消息|聊天/.test(bodyText)) return true;
  }

  const loginHints = page.locator('text=/登录|扫码|验证码/').first();
  const messageHints = page.locator('text=/私信|消息|聊天/').first();
  try {
    if (await loginHints.isVisible({ timeout: 1_000 })) return false;
    if (await messageHints.isVisible({ timeout: 3_000 })) return true;
  } catch {
    return !page.url().includes('login');
  }
  return !page.url().includes('login');
}

async function readBodyText(page: Page, timeoutMs: number): Promise<string | null> {
  if (typeof page.evaluate !== 'function') return null;
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      page.evaluate(() => document.body?.innerText ?? ''),
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function openLoginDialogIfPresent(page: Page, logger: Logger): Promise<void> {
  const loginButton = page.locator('text="登录"').first();
  if (await loginButton.isVisible({ timeout: 2_000 }).catch(() => false)) {
    logger.info('Opening Douyin login dialog before screenshot', { url: page.url() });
    await loginButton.click();
    // 抖音二维码在 VPS headless 环境里约 15 秒可渲染；等待过久会让用户拿到接近过期的二维码。
    await page.waitForTimeout(15_000);
  }
}

export async function ensureLoggedIn(page: Page, config: AppConfig, logger: Logger): Promise<void> {
  if (await isLoggedIn(page)) {
    logger.info('Douyin session appears logged in', { url: page.url() });
    return;
  }

  const loginPng = runtimePath('login.png');
  await openLoginDialogIfPresent(page, logger);
  await savePageScreenshot(page, loginPng, logger);
  logger.warn('Douyin login required. Scan the QR code from runtime/login.png', {
    loginPng,
    timeoutSeconds: config.loginWaitTimeoutSeconds,
  });

  const deadline = Date.now() + config.loginWaitTimeoutSeconds * 1000;
  while (Date.now() < deadline) {
    await sleep(5_000);
    if (await isLoggedIn(page)) {
      logger.info('Douyin login detected after QR wait');
      return;
    }
  }

  const timeoutScreenshot = screenshotPath('login-timeout');
  await savePageScreenshot(page, timeoutScreenshot, logger);
  throw new Error(`Login timed out after ${config.loginWaitTimeoutSeconds}s. Screenshot: ${timeoutScreenshot}`);
}
