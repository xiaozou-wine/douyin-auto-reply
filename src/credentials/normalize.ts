import type { Cookie } from 'playwright';
import type { AccountSnapshot } from './account.js';
import { CredentialRefreshError } from './errors.js';

export interface NormalizedCredentials {
  userId: string;
  cookieHeader: string;
  sessionId: string;
  msToken: string;
  verifyFp: string;
  uifid: string;
}

export interface NormalizeCredentialsInput {
  account: AccountSnapshot;
  cookies: Cookie[];
  nowSeconds: number;
}

const TARGET_HOST = 'www.douyin.com';
const TARGET_PATH = '/';
const ALLOWED_DOMAINS = new Set(['douyin.com', TARGET_HOST]);
const SAFE_COOKIE_NAME = /^[!#$%&*+.^_`|~0-9A-Za-z-]+$/;
const SAFE_COOKIE_VALUE = /^[\x21-\x7e]+$/;

export function normalizeCredentials(input: NormalizeCredentialsInput): NormalizedCredentials {
  assertSafeValue(input.account.xmst);

  const applicable = input.cookies
    .filter((cookie) => isApplicable(cookie, input.nowSeconds))
    .filter((cookie) => cookie.name !== 'ms_token');

  const session = requireCookie(applicable, 'sessionid', true);
  const verifyFp = requireCookie(applicable, 's_v_web_id', false);
  const uifid = requireCookie(applicable, 'UIFID', false);

  const selected = selectCookies(applicable);
  selected.push(createMsToken(input.account.xmst));
  selected.sort(compareCookieOrder);

  return {
    userId: input.account.userId,
    cookieHeader: selected.map(renderCookie).join('; '),
    sessionId: session.value,
    msToken: input.account.xmst,
    verifyFp: verifyFp.value,
    uifid: uifid.value,
  };
}

function isApplicable(cookie: Cookie, nowSeconds: number): boolean {
  if (cookie.expires !== -1 && cookie.expires <= nowSeconds) return false;
  const domain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
  return ALLOWED_DOMAINS.has(domain) && TARGET_PATH.startsWith(cookie.path);
}

function requireCookie(cookies: Cookie[], name: string, requireHttpOnly: boolean): Cookie {
  const namedCandidates = cookies.filter((cookie) => cookie.name === name);
  if (namedCandidates.length === 0) {
    throw new CredentialRefreshError('REQUIRED_FIELD_MISSING', 'Required credential field is missing');
  }
  if (new Set(namedCandidates.map((cookie) => cookie.value)).size !== 1) {
    throw new CredentialRefreshError('COOKIE_CONFLICT', 'Cookie values conflict');
  }

  const candidates = requireHttpOnly
    ? namedCandidates.filter((cookie) => cookie.httpOnly)
    : namedCandidates;
  if (candidates.length === 0) {
    throw new CredentialRefreshError('REQUIRED_FIELD_MISSING', 'Required credential field is missing');
  }
  return [...candidates].sort(compareSpecificity)[0]!;
}

function selectCookies(cookies: Cookie[]): Cookie[] {
  const groups = new Map<string, Cookie[]>();
  for (const cookie of cookies) {
    const group = groups.get(cookie.name) ?? [];
    group.push(cookie);
    groups.set(cookie.name, group);
  }
  return [...groups.values()].map((group) => [...group].sort(compareSpecificity)[0]!);
}

function compareSpecificity(left: Cookie, right: Cookie): number {
  const exactHostDifference = Number(right.domain === TARGET_HOST) - Number(left.domain === TARGET_HOST);
  return exactHostDifference || right.path.length - left.path.length || left.domain.localeCompare(right.domain) || left.path.localeCompare(right.path);
}

function createMsToken(value: string): Cookie {
  return {
    name: 'ms_token',
    value,
    domain: '.douyin.com',
    path: TARGET_PATH,
    expires: -1,
    httpOnly: false,
    secure: true,
    sameSite: 'Lax',
  };
}

function compareCookieOrder(left: Cookie, right: Cookie): number {
  return left.name.localeCompare(right.name) || left.domain.localeCompare(right.domain) || left.path.localeCompare(right.path);
}

function renderCookie(cookie: Cookie): string {
  if (!SAFE_COOKIE_NAME.test(cookie.name)) {
    throw new CredentialRefreshError('TEMPLATE_INVALID', 'Cookie name is unsafe');
  }
  assertSafeValue(cookie.value);
  return `${cookie.name}=${cookie.value}`;
}

function assertSafeValue(value: string): void {
  if (!SAFE_COOKIE_VALUE.test(value) || /['"\\$;]/.test(value)) {
    throw new CredentialRefreshError('TEMPLATE_INVALID', 'Cookie value is unsafe');
  }
}
