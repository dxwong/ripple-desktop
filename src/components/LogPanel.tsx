import { useState, useRef, useEffect } from "react";
import { Terminal, ChevronUp, ChevronDown, Trash2, Copy, FileText } from "lucide-react";
import TerminalPanel from "./TerminalPanel";

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

/** 底部面板 — 日志 + 终端（选项卡切换） */
function LogPanel() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const unreadRef = useRef(0);
  const [unread, setUnread] = useState(0);
  /** 当前选项卡：'log' 或 'terminal' */
  const [activeTab, setActiveTab] = useState<"log" | "terminal">("log");
  /** 终端有新完成命令时未读数 */
  const [terminalUnread, setTerminalUnread] = useState(0);
  const terminalUnreadRef = useRef(0);

  // 订阅日志事件
  useEffect(() => {
    const unsubscribe = logger.subscribe((entry) => {
      setLogs((prev) => {
        const next = [...prev, entry];
        if (next.length > 500) next.splice(0, next.length - 500);
        return next;
      });
      if (!expanded || activeTab !== "log") {
        unreadRef.current++;
        setUnread(unreadRef.current);
      }
    });
    return unsubscribe;
  }, [expanded, activeTab]);

  // 监听终端命令完成事件（新增未读提示）
  useEffect(() => {
    const handler = () => {
      if (!expanded || activeTab !== "terminal") {
        terminalUnreadRef.current++;
        setTerminalUnread(terminalUnreadRef.current);
      }
    };
    window.addEventListener("shell-cmd-end", handler);
    return () => window.removeEventListener("shell-cmd-end", handler);
  }, [expanded, activeTab]);

  // 自动滚动（日志）
  useEffect(() => {
    if (autoScroll && scrollRef.current && activeTab === "log") {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, autoScroll, activeTab]);

  const handleToggle = () => {
    if (expanded) {
      setExpanded(false);
    } else {
      unreadRef.current = 0;
      setUnread(0);
      terminalUnreadRef.current = 0;
      setTerminalUnread(0);
      setExpanded(true);
    }
  };

  // 切换选项卡时清空未读
  const switchTab = (tab: "log" | "terminal") => {
    setActiveTab(tab);
    if (tab === "log") {
      unreadRef.current = 0;
      setUnread(0);
    } else {
      terminalUnreadRef.current = 0;
      setTerminalUnread(0);
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
    warn: "text-amber-500/70 dark:text-amber-400/70",
    error: "text-rose-500/70 dark:text-rose-400/70",
    success: "text-accent/80 dark:text-accent/80",
  };

  const levelIcon: Record<string, string> = {
    info: "·",
    warn: "▲",
    error: "✕",
    success: "✓",
  };

  const totalUnread = unread + terminalUnread;

  return (
    <div className="border-t border-border dark:border-border-dark">
      {/* ===== 折叠状态栏 ===== */}
      {!expanded && (
        <button
          onClick={handleToggle}
          className="w-full flex items-center justify-between px-3 py-1.5
                     hover:bg-black/[0.02] dark:hover:bg-white/[0.02]
                     transition-colors text-xs"
        >
          <div className="flex items-center gap-2">
            <Terminal size={13} className="text-content-tertiary dark:text-content-tertiary-dark shrink-0" />
            <span className="font-medium text-content-tertiary dark:text-content-tertiary-dark">
              日志与终端
            </span>
          </div>
          <ChevronUp size={13} className="text-content-tertiary dark:text-content-tertiary-dark" />
        </button>
      )}

      {/* ===== 展开面板 ===== */}
      {expanded && (
        <div>
          {/* ---- 选项卡 ---- */}
          <div className="flex items-center justify-between border-b border-border dark:border-border-dark px-2">
            <div className="flex items-center">
              <button
                onClick={() => switchTab("log")}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium transition-colors border-b-2 ${
                  activeTab === "log"
                    ? "border-accent text-accent"
                    : "border-transparent text-content-tertiary dark:text-content-tertiary-dark hover:text-content-secondary"
                }`}
              >
                <FileText size={12} />
                <span>日志</span>
                {unread > 0 && (
                  <span className="px-1 rounded-full bg-accent/20 text-accent text-[9px]">{unread}</span>
                )}
              </button>
              <button
                onClick={() => switchTab("terminal")}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium transition-colors border-b-2 ${
                  activeTab === "terminal"
                    ? "border-emerald-500 text-emerald-500"
                    : "border-transparent text-content-tertiary dark:text-content-tertiary-dark hover:text-content-secondary"
                }`}
              >
                <Terminal size={12} />
                <span>终端</span>
                {terminalUnread > 0 && (
                  <span className="px-1 rounded-full bg-emerald-500/20 text-emerald-500 text-[9px]">{terminalUnread}</span>
                )}
              </button>
            </div>
            <button
              onClick={handleToggle}
              className="p-1.5 text-content-tertiary hover:text-content-secondary hover:bg-black/[0.02] dark:hover:bg-white/[0.02] rounded-md transition-colors"
              title="折叠面板"
            >
              <ChevronDown size={14} />
            </button>
          </div>

          {/* ---- 日志内容 ---- */}
          {activeTab === "log" && (
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

              <div
                ref={scrollRef}
                onScroll={() => {
                  const el = scrollRef.current;
                  if (!el) return;
                  const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
                  setAutoScroll(distance < 40);
                }}
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

          {/* ---- 终端内容 ---- */}
          {activeTab === "terminal" && <TerminalPanel />}
        </div>
      )}
    </div>
  );
}

export default LogPanel;
