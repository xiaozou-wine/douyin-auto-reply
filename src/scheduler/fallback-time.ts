import { clockTimeToMinutes, pad2, parseClockTime } from '../utils/time.js';

export interface GenerateFallbackSendAtInput {
  date: string;
  after: string;
  before: string;
  timeZone: string;
  random?: () => number;
}

/**
 * 为当天生成一次兜底发送时间；上界不包含，避免生成到 before 之后。
 */
export function generateFallbackSendAt(input: GenerateFallbackSendAtInput): string {
  const afterMinutes = clockTimeToMinutes(parseClockTime(input.after));
  const beforeMinutes = clockTimeToMinutes(parseClockTime(input.before));
  if (afterMinutes >= beforeMinutes) {
    throw new Error('Fallback range must have after earlier than before');
  }

  const random = input.random ?? Math.random;
  const availableMinutes = beforeMinutes - afterMinutes;
  const offset = Math.min(availableMinutes - 1, Math.floor(random() * availableMinutes));
  const selectedMinutes = afterMinutes + offset;
  const hour = Math.floor(selectedMinutes / 60);
  const minute = selectedMinutes % 60;

  return `${input.date}T${pad2(hour)}:${pad2(minute)}:00[${input.timeZone}]`;
}

/**
 * 比较当前时间是否到达状态文件中记录的本地兜底时间。
 */
export function isNowAtOrAfterScheduledLocalTime(now: Date, scheduled: string, timeZone: string): boolean {
  const match = scheduled.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):00\[(.+)]$/);
  if (!match) throw new Error(`Invalid scheduled fallback time: ${scheduled}`);

  const [, scheduledDate, hourRaw, minuteRaw, scheduledZone] = match;
  if (!scheduledDate || !hourRaw || !minuteRaw || !scheduledZone) {
    throw new Error(`Invalid scheduled fallback time: ${scheduled}`);
  }
  if (scheduledZone !== timeZone) {
    throw new Error(`Scheduled timezone ${scheduledZone} does not match configured timezone ${timeZone}`);
  }

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = new Map(formatter.formatToParts(now).map((part) => [part.type, part.value]));
  const nowDate = `${parts.get('year')}-${parts.get('month')}-${parts.get('day')}`;
  const nowMinutes = Number(parts.get('hour')) * 60 + Number(parts.get('minute'));
  const scheduledMinutes = Number(hourRaw) * 60 + Number(minuteRaw);

  return nowDate > scheduledDate || (nowDate === scheduledDate && nowMinutes >= scheduledMinutes);
}
