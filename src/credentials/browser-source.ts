import { chromium, type Browser, type BrowserContext, type Cookie, type Page } from 'playwright';
import {
  parseAccountSnapshot,
  type AccountSnapshot,
  type LocalStorageSnapshot,
} from './account.js';
import { CredentialRefreshError } from './errors.js';

export interface BrowserCredentialSource {
  account: AccountSnapshot;
  cookies: Cookie[];
}

export interface BrowserConnector {
  connectOverCDP(endpoint: string): Promise<Browser>;
}

const DOUYIN_ORIGIN = 'https://www.douyin.com';

export function validateCdpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CredentialRefreshError('INVALID_ARGUMENT', 'CDP URL is invalid');
  }

  const localHost = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    !localHost ||
    url.port === '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new CredentialRefreshError('INVALID_ARGUMENT', 'CDP URL is invalid');
  }
  return url;
}

function defaultBrowserConnector(): BrowserConnector {
  return {
    connectOverCDP: chromium.connectOverCDP.bind(chromium),
  };
}

export async function readBrowserCredentialSource(
  rawCdpUrl: string,
  connector: BrowserConnector = defaultBrowserConnector(),
): Promise<BrowserCredentialSource> {
  const endpoint = validateCdpUrl(rawCdpUrl).toString();
  let browser: Browser;
  try {
    browser = await connector.connectOverCDP(endpoint);
  } catch {
    throw new CredentialRefreshError('CDP_CONNECT_FAILED', 'Could not connect to local browser');
  }

  let primaryError: unknown;
  try {
    const { context, page } = selectDouyinContext(browser.contexts());
    const first = parseAccountSnapshot(await readLocalStorage(page));
    const cookies = await context.cookies([`${DOUYIN_ORIGIN}/`]);
    const second = parseAccountSnapshot(await readLocalStorage(page));

    if (first.userId !== second.userId || first.xmst !== second.xmst) {
      throw new CredentialRefreshError('SESSION_CHANGED', 'Browser session changed during credential read');
    }
    return { account: first, cookies };
  } catch (error) {
    primaryError = error;
    if (error instanceof CredentialRefreshError) throw error;
    throw new CredentialRefreshError('BROWSER_READ_FAILED', 'Could not read browser credential state');
  } finally {
    try {
      await browser.close();
    } catch {
      if (primaryError === undefined) {
        throw new CredentialRefreshError('CDP_DISCONNECT_FAILED', 'Could not disconnect from local browser');
      }
    }
  }
}

function selectDouyinContext(contexts: BrowserContext[]): { context: BrowserContext; page: Page } {
  const matches = contexts.flatMap((context) => {
    const pages = context.pages().filter((candidate) => isDouyinOrigin(candidate.url()));
    if (pages.length === 0) return [];
    return [{ context, page: pages.find((page) => page.url() === `${DOUYIN_ORIGIN}/`) ?? pages[0]! }];
  });

  if (matches.length === 0) {
    throw new CredentialRefreshError('DOUYIN_PAGE_NOT_FOUND', 'Douyin page is not open');
  }
  if (matches.length !== 1) {
    throw new CredentialRefreshError('AMBIGUOUS_CONTEXT', 'Multiple Douyin browser contexts are open');
  }
  return matches[0]!;
}

function isDouyinOrigin(rawUrl: string): boolean {
  try {
    return new URL(rawUrl).origin === DOUYIN_ORIGIN;
  } catch {
    return false;
  }
}

async function readLocalStorage(page: Page): Promise<LocalStorageSnapshot> {
  return page.evaluate(() => ({
    xmst: localStorage.getItem('xmst'),
    logTrace: localStorage.getItem('LOG_TRACE'),
    teaTokens: localStorage.getItem('__tea_cache_tokens_2562'),
  }));
}
