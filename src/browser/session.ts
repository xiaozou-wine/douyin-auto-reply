import fs from 'node:fs';
import { chromium, type BrowserContext, type Page } from 'playwright';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { runtimePath } from '../utils/paths.js';

export interface BrowserSession {
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

type StorageCookie = Parameters<BrowserContext['addCookies']>[0][number];

interface StorageStateFile {
  cookies?: StorageCookie[];
}

export function loadStorageStateCookies(storageStateFile = runtimePath('storage-state.json')): StorageCookie[] {
  if (!fs.existsSync(storageStateFile)) return [];
  const parsed = JSON.parse(fs.readFileSync(storageStateFile, 'utf8')) as StorageStateFile;
  return Array.isArray(parsed.cookies) ? parsed.cookies : [];
}

/**
 * 使用持久化 profile 启动 Chromium，保证容器重建后网页登录态仍可复用。
 */
export async function createBrowserSession(config: AppConfig, logger: Logger): Promise<BrowserSession> {
  const profileDir = runtimePath('browser-profile');
  fs.mkdirSync(profileDir, { recursive: true });

  logger.info('Launching Chromium with persistent profile', {
    profileDir,
    headless: config.headless,
  });

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: config.headless,
    viewport: { width: 1365, height: 900 },
    locale: 'zh-CN',
    timezoneId: config.timeZone,
    args: ['--disable-dev-shm-usage', '--no-sandbox'],
  });

  const storageStateCookies = loadStorageStateCookies();
  if (storageStateCookies.length > 0) {
    await context.addCookies(storageStateCookies);
    logger.info('Imported cookies from runtime/storage-state.json', { cookieCount: storageStateCookies.length });
  }

  const page = context.pages()[0] ?? await context.newPage();
  page.setDefaultTimeout(30_000);

  return {
    context,
    page,
    close: async () => {
      logger.info('Closing Chromium context');
      await context.close();
    },
  };
}

export async function savePageScreenshot(page: Page, filePath: string, logger: Logger): Promise<void> {
  await page.screenshot({ path: filePath, fullPage: true });
  logger.info('Saved page screenshot', { filePath, url: page.url() });
}
