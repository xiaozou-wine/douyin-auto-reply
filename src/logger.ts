export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface LogContext {
  [key: string]: string | number | boolean | null | undefined;
}

export interface Logger {
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  debug(message: string, context?: LogContext): void;
}

/**
 * 输出结构化 JSON 日志，方便 Docker logs、grep 和后续告警系统解析。
 */
export function createLogger(namespace = 'douyin-auto-reply'): Logger {
  const write = (level: LogLevel, message: string, context: LogContext = {}) => {
    const payload = {
      ts: new Date().toISOString(),
      level,
      namespace,
      message,
      ...compactContext(context),
    };
    const line = JSON.stringify(payload);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  };

  return {
    info: (message, context) => write('info', message, context),
    warn: (message, context) => write('warn', message, context),
    error: (message, context) => write('error', message, context),
    debug: (message, context) => write('debug', message, context),
  };
}

function compactContext(context: LogContext): LogContext {
  return Object.fromEntries(Object.entries(context).filter(([, value]) => value !== undefined));
}
