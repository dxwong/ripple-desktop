/**
 * 前端日志模块
 * 每个操作同时输出到浏览器控制台，并通过 HTTP 发送到后端保存到磁盘 logs 文件夹
 */

const LOG_API = 'http://localhost:3002/api/client-log';

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

interface LogEntry {
  level: LogLevel;
  category: string;
  message: string;
  data?: any;
  timestamp: string;
}

class FrontendLogger {
  private logs: LogEntry[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly FLUSH_INTERVAL = 1000;

  constructor() {
    window.addEventListener('beforeunload', () => this.flush());
  }

  private async sendToBackend(entry: LogEntry) {
    try {
      await fetch(LOG_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry),
      });
    } catch (err) {
      // 后端未启动时静默失败
    }
  }

  private flush() {
    if (this.logs.length === 0) return;
    const logsToSend = [...this.logs];
    this.logs = [];
    logsToSend.forEach(entry => this.sendToBackend(entry));
  }

  private push(level: LogLevel, category: string, message: string, data?: any) {
    const entry: LogEntry = {
      level,
      category,
      message,
      data,
      timestamp: new Date().toISOString(),
    };

    const tag = `[${entry.timestamp}] [${level}] [FRONTEND:${category}]`;
    const dataStr = data !== undefined ? ` | ${JSON.stringify(data)}` : '';
    console.log(`${tag} ${message}${dataStr}`);

    this.logs.push(entry);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush();
      }, this.FLUSH_INTERVAL);
    }
  }

  debug(category: string, message: string, data?: any) { this.push('DEBUG', category, message, data); }
  info(category: string, message: string, data?: any) { this.push('INFO', category, message, data); }
  warn(category: string, message: string, data?: any) { this.push('WARN', category, message, data); }
  error(category: string, message: string, data?: any) { this.push('ERROR', category, message, data); }
}

export const frontendLogger = new FrontendLogger();

export const flog = {
  debug: (category: string, message: string, data?: any) => frontendLogger.debug(category, message, data),
  info: (category: string, message: string, data?: any) => frontendLogger.info(category, message, data),
  warn: (category: string, message: string, data?: any) => frontendLogger.warn(category, message, data),
  error: (category: string, message: string, data?: any) => frontendLogger.error(category, message, data),
};