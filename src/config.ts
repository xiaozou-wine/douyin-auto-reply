import fs from 'node:fs';
import dotenv from 'dotenv';
import { clockTimeToMinutes, parseClockTime } from './utils/time.js';
import { resolveFromRoot } from './utils/paths.js';

export interface AppConfig {
  targetFriendName: string;
  imagePath: string;
  timeZone: string;
  checkIntervalSeconds: number;
  fallbackAfter: string;
  fallbackBefore: string;
  loginWaitTimeoutSeconds: number;
  headless: boolean;
  retryIntervalSeconds: number;
  keepAliveAfterSent: boolean;
}

/**
 * 从 .env 读取配置并立刻校验，启动阶段尽早暴露错误路径和错误参数。
 */
export function loadConfig(envFilePath = resolveFromRoot('.env')): AppConfig {
  dotenv.config({ path: envFilePath });
  return loadConfigFromEnv(process.env);
}

export function loadConfigFromEnv(env: NodeJS.ProcessEnv): AppConfig {
  const targetFriendName = requireNonEmpty(env.TARGET_FRIEND_NAME, 'TARGET_FRIEND_NAME');
  const imagePathRaw = requireNonEmpty(env.IMAGE_PATH, 'IMAGE_PATH');
  const imagePath = resolveFromRoot(imagePathRaw);
  if (!fs.existsSync(imagePath) || !fs.statSync(imagePath).isFile()) {
    throw new Error(`IMAGE_PATH must exist and be a file. Resolved path: ${imagePath}`);
  }

  const fallbackAfter = env.FALLBACK_AFTER || '22:00';
  const fallbackBefore = env.FALLBACK_BEFORE || '23:30';
  const after = parseClockTime(fallbackAfter);
  const before = parseClockTime(fallbackBefore);
  if (clockTimeToMinutes(after) >= clockTimeToMinutes(before)) {
    throw new Error('FALLBACK_AFTER must be earlier than FALLBACK_BEFORE');
  }

  return {
    targetFriendName,
    imagePath,
    timeZone: env.TIMEZONE || 'Asia/Shanghai',
    checkIntervalSeconds: parsePositiveInteger(env.CHECK_INTERVAL_SECONDS, 30, 'CHECK_INTERVAL_SECONDS'),
    fallbackAfter,
    fallbackBefore,
    loginWaitTimeoutSeconds: parsePositiveInteger(env.LOGIN_WAIT_TIMEOUT_SECONDS, 300, 'LOGIN_WAIT_TIMEOUT_SECONDS'),
    headless: parseBoolean(env.HEADLESS, true),
    retryIntervalSeconds: parsePositiveInteger(env.RETRY_INTERVAL_SECONDS, 60, 'RETRY_INTERVAL_SECONDS'),
    keepAliveAfterSent: parseBoolean(env.KEEP_ALIVE_AFTER_SENT, true),
  };
}

function requireNonEmpty(value: string | undefined, name: string): string {
  if (!value || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  if (value.toLowerCase() === 'true') return true;
  if (value.toLowerCase() === 'false') return false;
  throw new Error(`Boolean value must be true or false, got "${value}"`);
}
