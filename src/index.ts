import { pathToFileURL } from 'node:url';
import { ensureLoggedIn } from './browser/login.js';
import { createBrowserSession } from './browser/session.js';
import { type AppConfig, loadConfig } from './config.js';
import { openTargetConversation } from './douyin/conversation.js';
import { captureMessageBaseline, hasNewMessageFromTarget, sendImageToCurrentConversation } from './douyin/message.js';
import { openMessagesPage } from './douyin/page.js';
import { createLogger } from './logger.js';
import { type DailyState, loadOrCreateDailyState } from './scheduler/daily-state.js';
import { generateFallbackSendAt } from './scheduler/fallback-time.js';
import { runSchedulerLoop, type DouyinClient } from './scheduler/loop.js';
import { runtimePath } from './utils/paths.js';
import { formatLocalDate } from './utils/time.js';

const logger = createLogger();

export interface CreateInitialDailyStateInput {
  config: AppConfig;
  stateFile: string;
  now: Date;
  random?: () => number;
}

/**
 * 根据当前时区日期加载或创建当天状态；重启时复用已有兜底时间。
 */
export function createInitialDailyState(input: CreateInitialDailyStateInput): DailyState {
  const today = formatLocalDate(input.now, input.config.timeZone);
  const fallbackSendAt = generateFallbackSendAt({
    date: today,
    after: input.config.fallbackAfter,
    before: input.config.fallbackBefore,
    timeZone: input.config.timeZone,
    random: input.random,
  });

  return loadOrCreateDailyState({
    stateFile: input.stateFile,
    today,
    fallbackSendAt,
    targetFriendName: input.config.targetFriendName,
    imagePath: input.config.imagePath,
  });
}

export async function main(): Promise<void> {
  const config = loadConfig();
  logger.info('Configuration loaded', {
    targetFriendName: config.targetFriendName,
    imagePath: config.imagePath,
    timeZone: config.timeZone,
    fallbackAfter: config.fallbackAfter,
    fallbackBefore: config.fallbackBefore,
    headless: config.headless,
  });

  const stateFile = runtimePath('state.json');
  const state = createInitialDailyState({
    config,
    stateFile,
    now: new Date(),
  });

  logger.info('Daily state loaded', {
    stateFile,
    date: state.date,
    sent: state.sent,
    fallbackSendAt: state.fallbackSendAt,
  });

  const session = await createBrowserSession(config, logger);
  const shutdown = async () => {
    logger.warn('Shutdown requested');
    await session.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await openMessagesPage(session.page, logger);
  await ensureLoggedIn(session.page, config, logger);
  await openMessagesPage(session.page, logger);
  await openTargetConversation(session.page, config.targetFriendName, logger);

  const baseline = await captureMessageBaseline(session.page);
  logger.info('Captured startup message baseline', {
    capturedAt: baseline.capturedAt,
    latestMessageText: baseline.latestMessageText,
  });

  const client: DouyinClient = {
    hasNewMessageFromTarget: () => hasNewMessageFromTarget(session.page, baseline, logger),
    sendImageToCurrentConversation: (imagePath) => sendImageToCurrentConversation(session.page, imagePath, logger),
  };

  await runSchedulerLoop({
    config,
    initialState: state,
    stateFile,
    client,
    logger,
  });
}

function isDirectRun(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectRun()) {
  main().catch((error) => {
    logger.error('Fatal startup failure', {
      error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error),
    });
    process.exit(1);
  });
}
