import type { Page } from 'playwright';
import type { Logger } from '../logger.js';
import { DOUYIN_MESSAGES_URL } from './selectors.js';

/**
 * 打开抖音私信页。抖音页面有长连接/慢请求，导航超时也继续交给后续登录和 DOM 检测处理。
 */
export async function openMessagesPage(page: Page, logger: Logger): Promise<void> {
  logger.info('Opening Douyin messages page', { url: DOUYIN_MESSAGES_URL });
  let navigationTimedOut = false;
  await page.goto(DOUYIN_MESSAGES_URL, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(async (error) => {
    navigationTimedOut = true;
    logger.warn('Initial Douyin navigation timed out; continuing with DOM-based checks', {
      url: page.url(),
      error: error instanceof Error ? error.message : String(error),
    });
    await stopPageLoading(page, logger);
  });
  if (!navigationTimedOut) {
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {
      logger.warn('Network idle wait timed out; continuing with DOM-based checks', { url: page.url() });
    });
  }
}

async function stopPageLoading(page: Page, logger: Logger): Promise<void> {
  try {
    const session = await page.context().newCDPSession(page);
    try {
      await Promise.race([
        session.send('Page.stopLoading'),
        page.waitForTimeout(1_000),
      ]);
      logger.info('Stopped pending Douyin page load after navigation timeout', { url: page.url() });
    } finally {
      void session.detach().catch(() => undefined);
    }
  } catch (error) {
    logger.warn('Failed to stop pending Douyin page load; continuing anyway', {
      url: page.url(),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
