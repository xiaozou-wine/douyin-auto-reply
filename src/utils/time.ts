export interface ClockTime {
  hour: number;
  minute: number;
}

export interface ZonedDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * 解析严格的 HH:mm 时间，避免 7:30 这类非配置规范值悄悄通过。
 */
export function parseClockTime(value: string): ClockTime {
  if (!/^\d{2}:\d{2}$/.test(value)) {
    throw new Error(`Invalid clock time "${value}". Expected HH:mm.`);
  }

  const [hourRaw, minuteRaw] = value.split(':');
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`Invalid clock time "${value}". Expected HH:mm in 00:00-23:59.`);
  }

  return { hour, minute };
}

export function clockTimeToMinutes(value: ClockTime): number {
  return value.hour * 60 + value.minute;
}

/**
 * 按指定时区格式化本地日期，用于“每天最多一次”的状态分桶。
 */
export function formatLocalDate(date: Date, timeZone: string): string {
  const parts = zonedDateParts(date, timeZone);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

export function zonedDateParts(date: Date, timeZone: string): ZonedDateParts {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

  const values = new Map(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(values.get('year')),
    month: Number(values.get('month')),
    day: Number(values.get('day')),
    hour: Number(values.get('hour')),
    minute: Number(values.get('minute')),
    second: Number(values.get('second')),
  };
}

/**
 * 生成带时区标签的可读时间字符串，避免误把本地时间当 UTC。
 */
export function toIsoWithTimezoneLabel(date: Date, timeZone: string): string {
  const parts = zonedDateParts(date, timeZone);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}T${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}[${timeZone}]`;
}

export function pad2(value: number): string {
  return String(value).padStart(2, '0');
}
