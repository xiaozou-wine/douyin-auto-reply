import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { sleep } from '../utils/sleep.js';
import { formatLocalDate, toIsoWithTimezoneLabel } from '../utils/time.js';
import { type DailyState, markStateError, markStateSent, saveDailyState } from './daily-state.js';
import { isNowAtOrAfterScheduledLocalTime } from './fallback-time.js';

export interface DouyinClient {
  hasNewMessageFromTarget(): Promise<boolean>;
  sendImageToCurrentConversation(imagePath: string): Promise<boolean>;
}

export type SchedulerAction =
  | 'already-sent'
  | 'sent-passive'
  | 'sent-fallback'
  | 'send-not-confirmed'
  | 'waiting';

export interface SchedulerTickInput {
  state: DailyState;
  client: DouyinClient;
  now: Date;
  timeZone: string;
}

export interface SchedulerTickResult {
  state: DailyState;
  action: SchedulerAction;
}

/**
 * 单次调度决策：先防重复，再看被动触发，最后判断兜底时间。
 */
export async function runSchedulerTick(input: SchedulerTickInput): Promise<SchedulerTickResult> {
  if (input.state.sent) {
    return { state: input.state, action: 'already-sent' };
  }

  const hasNewMessage = await input.client.hasNewMessageFromTarget();
  if (hasNewMessage) {
    return sendAndMark(input, 'passive', 'sent-passive');
  }

  if (isNowAtOrAfterScheduledLocalTime(input.now, input.state.fallbackSendAt, input.timeZone)) {
    return sendAndMark(input, 'fallback', 'sent-fallback');
  }

  return { state: input.state, action: 'waiting' };
}

/**
 * 长驻主循环；错误写回状态后按重试间隔继续，避免单次页面异常直接丢服务。
 */
export async function runSchedulerLoop(input: {
  config: AppConfig;
  initialState: DailyState;
  stateFile: string;
  client: DouyinClient;
  logger: Logger;
}): Promise<never> {
  let state = input.initialState;

  for (;;) {
    try {
      const today = formatLocalDate(new Date(), input.config.timeZone);
      if (today !== state.date) {
        input.logger.warn('Date changed while process is running; restart the service to create a new daily state', {
          previousDate: state.date,
          today,
        });
      }

      const result = await runSchedulerTick({
        state,
        client: input.client,
        now: new Date(),
        timeZone: input.config.timeZone,
      });
      state = result.state;
      saveDailyState(input.stateFile, state);
      input.logger.info('Scheduler tick completed', {
        action: result.action,
        date: state.date,
        sent: state.sent,
        fallbackSendAt: state.fallbackSendAt,
      });

      const intervalSeconds = state.sent && input.config.keepAliveAfterSent
        ? Math.max(input.config.checkIntervalSeconds, 300)
        : input.config.checkIntervalSeconds;
      await sleep(intervalSeconds * 1000);
    } catch (error) {
      const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
      state = markStateError(state, message);
      saveDailyState(input.stateFile, state);
      input.logger.error('Scheduler tick failed', {
        error: message,
        targetFriendName: input.config.targetFriendName,
        imagePath: input.config.imagePath,
      });
      await sleep(input.config.retryIntervalSeconds * 1000);
    }
  }
}

async function sendAndMark(
  input: SchedulerTickInput,
  triggerType: 'passive' | 'fallback',
  action: SchedulerAction,
): Promise<SchedulerTickResult> {
  const confirmed = await input.client.sendImageToCurrentConversation(input.state.imagePath);
  if (!confirmed) {
    return {
      state: markStateError(input.state, `Image send was not confirmed for trigger ${triggerType}`),
      action: 'send-not-confirmed',
    };
  }

  return {
    state: markStateSent(input.state, triggerType, toIsoWithTimezoneLabel(input.now, input.timeZone)),
    action,
  };
}
