import { useState, useRef, useEffect } from "react";
import { Terminal, ChevronUp, ChevronDown, Trash2, Copy } from "lucide-react";

export interface LogEntry {
  id: number;
  timestamp: string;
  level: "info" | "warn" | "error" | "success";
  message: string;
}

let logIdCounter = 0;

/** 全局日志收集器（单例） */
class Logger {
  private listeners = new Set<(entry: LogEntry) => void>();
  private history: LogEntry[] = [];
  private maxHistory = 500;

  add(level: LogEntry["level"], message: string) {
    const entry: LogEntry = {
      id: ++logIdCounter,
      timestamp: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
      level,
      message,
    };
    this.history.push(entry);
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory);
    }
    this.listeners.forEach((fn) => fn(entry));
  }

  info(message: string) { this.add("info", message); }
  warn(message: string) { this.add("warn", message); }
  error(message: string) { this.add("error", message); }
  success(message: string) { this.add("success", message); }

  subscribe(fn: (entry: LogEntry) => void) {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  getHistory(): LogEntry[] {
    return [...this.history];
  }

  clear() {
    this.history = [];
    logIdCounter = 0;
  }
}

export const logger = new Logger();

/** 底部日志面板 — 参考 Claude Desktop */
function LogPanel() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const unreadRef = useRef(0);
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    const unsubscribe = logger.subscribe((entry) => {
      setLogs((prev) => {
        const next = [...prev, entry];
        if (next.length > 500) next.splice(0, next.length - 500);
        return next;
      });
      if (!expanded) {
        unreadRef.current++;
        setUnread(unreadRef.current);
      }
    });
    return unsubscribe;
  }, [expanded]);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, autoScroll, expanded]);

  const handleToggle = () => {
    if (expanded) {
      setExpanded(false);
    } else {
      unreadRef.current = 0;
      setUnread(0);
      setExpanded(true);
    }
  };

  const handleClear = () => {
    logger.clear();
    setLogs([]);
  };

  const handleCopyAll = () => {
    const text = logs
      .map((e) => `[${e.timestamp}] ${e.level.toUpperCase()} ${e.message}`)
      .join("\n");
    navigator.clipboard.writeText(text).then(
      () => logger.success("日志已复制到剪贴板"),
      () => logger.error("复制失败")
    );
  };

  const levelColor: Record<string, string> = {
    info: "text-content-tertiary dark:text-content-tertiary-dark",
    warn: "text-amber-500 dark:text-amber-400",
    error: "text-red-500 dark:text-red-400",
    success: "text-emerald-500 dark:text-emerald-400",
  };

  const levelIcon: Record<string, string> = {
    info: "·",
    warn: "⚠",
    error: "✕",
    success: "✓",
  };

  return (
    <div className="border-t border-border dark:border-border-dark">
      {/* 折叠状态栏 */}
      <button
        onClick={handleToggle}
        className="w-full flex items-center gap-2 px-3 py-1.5
                   hover:bg-black/[0.02] dark:hover:bg-white/[0.02]
                   transition-colors text-xs"
      >
        <Terminal size={13} className="text-content-tertiary dark:text-content-tertiary-dark shrink-0" />
        <span className="font-medium text-content-secondary dark:text-content-secondary-dark">
          日志
        </span>
        {unread > 0 && (
          <span className="px-1.5 py-0.5 rounded-full bg-accent/20 text-accent text-[10px] font-medium">
            {unread}
          </span>
        )}
        {/* 最后一条日志预览 */}
        {logs.length > 0 && !expanded && (
          <span className="flex-1 text-left truncate text-content-tertiary dark:text-content-tertiary-dark">
            {logs[logs.length - 1].message}
          </span>
        )}
        <div className="flex-1" />
        {expanded ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
      </button>

      {/* 展开日志列表 */}
      {expanded && (
        <div className="relative">
          {/* 工具栏 */}
          <div className="absolute top-0 right-0 z-10 flex items-center gap-1 p-1">
            <button
              onClick={handleCopyAll}
              className="p-1 rounded-md text-content-tertiary hover:text-accent hover:bg-accent/10 transition-all"
              title="复制全部日志"
            >
              <Copy size={12} />
            </button>
            <button
              onClick={handleClear}
              className="p-1 rounded-md text-content-tertiary hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-all"
              title="清空日志"
            >
              <Trash2 size={12} />
            </button>
          </div>

          {/* 日志内容 */}
          <div
            ref={scrollRef}
            className="h-48 overflow-y-auto bg-black/[0.02] dark:bg-white/[0.02] font-mono text-[11px] leading-relaxed px-3 py-2 select-text"
          >
            {logs.length === 0 ? (
              <div className="text-center py-6 text-content-tertiary dark:text-content-tertiary-dark">
                暂无日志
              </div>
            ) : (
              logs.map((entry) => (
                <div key={entry.id} className="hover:bg-black/[0.02] dark:hover:bg-white/[0.02] px-1 rounded">
                  <span className="text-content-tertiary dark:text-content-tertiary-dark mr-2 select-none">
                    {entry.timestamp}
                  </span>
                  <span className={`mr-1.5 select-none ${levelColor[entry.level]}`}>
                    {levelIcon[entry.level]}
                  </span>
                  <span className={levelColor[entry.level]}>{entry.message}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default LogPanel;
