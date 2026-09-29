import type { Locator, Page } from 'playwright';
import { savePageScreenshot } from '../browser/session.js';
import type { Logger } from '../logger.js';
import { screenshotPath } from '../utils/screenshot.js';
import { selectors } from './selectors.js';

/**
 * 按好友昵称打开会话。找不到时输出可见样本，降低发错人的风险。
 */
export async function openTargetConversation(page: Page, targetFriendName: string, logger: Logger): Promise<void> {
  logger.info('Locating target conversation', { targetFriendName, url: page.url() });
  const target = await findConversationByName(page, targetFriendName);
  if (!target) {
    const samples = await visibleConversationSamples(page);
    const shot = screenshotPath('target-conversation-not-found');
    await savePageScreenshot(page, shot, logger);
    throw new Error(`Target friend "${targetFriendName}" not found. Visible samples: ${samples.join(' | ')}. Screenshot: ${shot}`);
  }

  await target.click();
  await page.waitForTimeout(1_000);
  logger.info('Opened target conversation', { targetFriendName, url: page.url() });
}

export async function findConversationByName(page: Page, targetFriendName: string): Promise<Locator | null> {
  const exactText = page.getByText(targetFriendName, { exact: true }).first();
  if (await exactText.isVisible({ timeout: 5_000 }).catch(() => false)) {
    return exactText;
  }

  for (const selector of selectors.conversationListItems) {
    const candidates = page.locator(selector);
    const count = await candidates.count().catch(() => 0);
    for (let index = 0; index < Math.min(count, 80); index += 1) {
      const item = candidates.nth(index);
      const text = normalizeText(await item.innerText().catch(() => ''));
      if (text.includes(targetFriendName)) return item;
    }
  }

  return null;
}

export async function visibleConversationSamples(page: Page): Promise<string[]> {
  const samples: string[] = [];
  for (const selector of selectors.conversationListItems) {
    const candidates = page.locator(selector);
    const count = await candidates.count().catch(() => 0);
    for (let index = 0; index < Math.min(count, 10); index += 1) {
      const text = normalizeText(await candidates.nth(index).innerText().catch(() => ''));
      if (text && !samples.includes(text)) samples.push(text.slice(0, 80));
    }
    if (samples.length > 0) break;
  }
  return samples;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
