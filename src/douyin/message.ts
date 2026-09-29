import type { Page } from 'playwright';
import { savePageScreenshot } from '../browser/session.js';
import type { Logger } from '../logger.js';
import { screenshotPath } from '../utils/screenshot.js';
import { selectors } from './selectors.js';

export interface MessageBaseline {
  latestMessageText: string | null;
  capturedAt: string;
}

/**
 * 启动时记录当前最新消息，避免把历史消息误判为当天新消息。
 */
export async function captureMessageBaseline(page: Page): Promise<MessageBaseline> {
  return {
    latestMessageText: await latestVisibleMessageText(page),
    capturedAt: new Date().toISOString(),
  };
}

/**
 * MVP 只做提前触发：未读徽标或启动后最新消息变化才返回 true，无法确认时保持 false。
 */
export async function hasNewMessageFromTarget(page: Page, baseline: MessageBaseline, logger: Logger): Promise<boolean> {
  for (const selector of selectors.unreadBadge) {
    const badge = page.locator(selector).first();
    if (await badge.isVisible({ timeout: 1_000 }).catch(() => false)) {
      logger.info('Unread badge detected for current conversation', { selector });
      return true;
    }
  }

  const latest = await latestVisibleMessageText(page);
  const changed = latest !== null && latest !== baseline.latestMessageText;
  logger.debug('Compared message baseline', {
    baseline: baseline.latestMessageText,
    latest,
    changed,
  });
  return changed;
}

/**
 * 保守发送图片：只有能看到图片消息出现才确认成功，否则返回 false，不更新 sent 状态。
 */
export async function sendImageToCurrentConversation(page: Page, imagePath: string, logger: Logger): Promise<boolean> {
  logger.info('Attempting to send image', { imagePath, url: page.url() });

  try {
    const fileInput = page.locator(selectors.fileInput).first();
    if (await fileInput.count() > 0) {
      await fileInput.setInputFiles(imagePath);
    } else {
      await uploadViaFileChooser(page, imagePath);
    }

    const clicked = await clickSendButton(page);
    if (!clicked) {
      const shot = screenshotPath('send-button-not-found');
      await savePageScreenshot(page, shot, logger);
      logger.error('Send button not found or not clickable', { imagePath, screenshot: shot, url: page.url() });
      return false;
    }

    const confirmed = await confirmImageAppeared(page);
    if (!confirmed) {
      const shot = screenshotPath('send-not-confirmed');
      await savePageScreenshot(page, shot, logger);
      logger.error('Image send could not be confirmed', { imagePath, screenshot: shot, url: page.url() });
      return false;
    }

    logger.info('Image send confirmed', { imagePath, url: page.url() });
    return true;
  } catch (error) {
    const shot = screenshotPath('image-send-failed');
    await savePageScreenshot(page, shot, logger).catch(() => undefined);
    logger.error('Image send failed', {
      imagePath,
      screenshot: shot,
      url: page.url(),
      error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error),
    });
    return false;
  }
}

async function uploadViaFileChooser(page: Page, imagePath: string): Promise<void> {
  for (const selector of selectors.attachmentButton) {
    const button = page.locator(selector).first();
    if (!(await button.isVisible({ timeout: 1_000 }).catch(() => false))) continue;
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 5_000 }),
      button.click(),
    ]);
    await chooser.setFiles(imagePath);
    return;
  }
  throw new Error(`No attachment button or ${selectors.fileInput} found for image upload`);
}

async function clickSendButton(page: Page): Promise<boolean> {
  for (const selector of selectors.sendButton) {
    const button = page.locator(selector).first();
    if (await button.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await button.click();
      return true;
    }
  }

  await page.keyboard.press('Enter').catch(() => undefined);
  return true;
}

async function confirmImageAppeared(page: Page): Promise<boolean> {
  for (const selector of selectors.outgoingMessage) {
    const locator = page.locator(selector).last();
    if (await locator.isVisible({ timeout: 10_000 }).catch(() => false)) {
      return true;
    }
  }
  return false;
}

async function latestVisibleMessageText(page: Page): Promise<string | null> {
  const messages = page.locator('[class*="message"], [class*="Message"], [data-e2e*="message"]');
  const count = await messages.count().catch(() => 0);
  for (let index = Math.min(count, 50) - 1; index >= 0; index -= 1) {
    const text = (await messages.nth(index).innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (text) return text;
  }
  return null;
}
