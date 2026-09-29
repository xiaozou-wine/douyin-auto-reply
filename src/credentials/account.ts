import { CredentialRefreshError } from './errors.js';

export interface LocalStorageSnapshot {
  xmst: string | null;
  logTrace: string | null;
  teaTokens: string | null;
}

export interface AccountSnapshot {
  userId: string;
  xmst: string;
}

const DECIMAL_ID = /^\d+$/;

export function parseAccountSnapshot(input: LocalStorageSnapshot): AccountSnapshot {
  const xmst = requireString(input.xmst, 'REQUIRED_FIELD_MISSING', 'Required credential field is missing');
  const fromTrace = parseTraceUserId(input.logTrace);
  const fromTea = parseTeaUserId(input.teaTokens);

  if (!fromTrace && !fromTea) {
    throw new CredentialRefreshError('ACCOUNT_SOURCE_MISSING', 'Account source is missing');
  }
  if (fromTrace && fromTea && fromTrace !== fromTea) {
    throw new CredentialRefreshError('ACCOUNT_SOURCE_CONFLICT', 'Account sources conflict');
  }

  return { userId: fromTrace ?? fromTea!, xmst };
}

function parseTraceUserId(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error();
    }
    const userId = readDecimalString(parsed.at(-1), 'uid');
    if (userId === null) throw new Error();
    return userId;
  } catch {
    throw new CredentialRefreshError('ACCOUNT_SOURCE_MISSING', 'Account source is missing');
  }
}

function parseTeaUserId(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const userId = readDecimalString(parsed, 'user_unique_id');
    if (userId === null) throw new Error();
    return userId;
  } catch {
    throw new CredentialRefreshError('ACCOUNT_SOURCE_MISSING', 'Account source is missing');
  }
}

function readDecimalString(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = (value as Record<string, unknown>)[key];
  if (candidate === undefined || candidate === null) return null;
  if (typeof candidate !== 'string' || !DECIMAL_ID.test(candidate)) {
    throw new CredentialRefreshError('ACCOUNT_SOURCE_MISSING', 'Account source is missing');
  }
  return candidate;
}

function requireString(
  value: string | null,
  code: 'REQUIRED_FIELD_MISSING',
  message: string,
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CredentialRefreshError(code, message);
  }
  return value;
}
