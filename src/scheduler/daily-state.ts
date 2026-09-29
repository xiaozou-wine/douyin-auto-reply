import fs from 'node:fs';
import path from 'node:path';

export type TriggerType = 'passive' | 'fallback';

export interface DailyState {
  date: string;
  fallbackSendAt: string;
  sent: boolean;
  sentAt: string | null;
  triggerType: TriggerType | null;
  targetFriendName: string;
  imagePath: string;
  lastError: string | null;
}

export interface LoadOrCreateDailyStateInput {
  stateFile: string;
  today: string;
  fallbackSendAt: string;
  targetFriendName: string;
  imagePath: string;
  backupTimestamp?: string;
}

/**
 * 读取当天状态；跨天时重建，损坏时先备份再重建，避免状态文件导致进程无法启动。
 */
export function loadOrCreateDailyState(input: LoadOrCreateDailyStateInput): DailyState {
  if (!fs.existsSync(input.stateFile)) {
    const state = createFreshState(input);
    saveDailyState(input.stateFile, state);
    return state;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(input.stateFile, 'utf8')) as Partial<DailyState>;
    if (parsed.date === input.today && typeof parsed.fallbackSendAt === 'string') {
      return normalizeExistingState(parsed, input);
    }

    const state = createFreshState(input);
    saveDailyState(input.stateFile, state);
    return state;
  } catch (error) {
    backupCorruptState(input.stateFile, input.backupTimestamp ?? timestampForFile(new Date()));
    const state = createFreshState(input);
    state.lastError = `State file was corrupt and has been regenerated: ${String(error)}`;
    saveDailyState(input.stateFile, state);
    return state;
  }
}

export function saveDailyState(stateFile: string, state: DailyState): void {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const tempFile = `${stateFile}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tempFile, stateFile);
}

export function markStateSent(state: DailyState, triggerType: TriggerType, sentAt: string): DailyState {
  return {
    ...state,
    sent: true,
    sentAt,
    triggerType,
    lastError: null,
  };
}

export function markStateError(state: DailyState, message: string): DailyState {
  return {
    ...state,
    lastError: message,
  };
}

function createFreshState(input: LoadOrCreateDailyStateInput): DailyState {
  return {
    date: input.today,
    fallbackSendAt: input.fallbackSendAt,
    sent: false,
    sentAt: null,
    triggerType: null,
    targetFriendName: input.targetFriendName,
    imagePath: input.imagePath,
    lastError: null,
  };
}

function normalizeExistingState(parsed: Partial<DailyState>, input: LoadOrCreateDailyStateInput): DailyState {
  return {
    date: input.today,
    fallbackSendAt: parsed.fallbackSendAt as string,
    sent: parsed.sent === true,
    sentAt: typeof parsed.sentAt === 'string' ? parsed.sentAt : null,
    triggerType: parsed.triggerType === 'passive' || parsed.triggerType === 'fallback' ? parsed.triggerType : null,
    targetFriendName: input.targetFriendName,
    imagePath: input.imagePath,
    lastError: typeof parsed.lastError === 'string' ? parsed.lastError : null,
  };
}

function backupCorruptState(stateFile: string, timestamp: string): void {
  const backupFile = path.join(path.dirname(stateFile), `state.corrupt.${timestamp}.json`);
  fs.renameSync(stateFile, backupFile);
}

function timestampForFile(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}
