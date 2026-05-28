import { useState, useEffect, useRef, useCallback } from "react";
import { Trash2, Clock, CheckCircle2, XCircle, Loader2, Copy, Terminal } from "lucide-react";
import {
  onShellCommandStart,
  onShellCommandOutput,
  onShellCommandEnd,
  terminalHistory,
  type TerminalHistoryEntry,
} from "../services/shellEventBus";
import { logger } from "./LogPanel";

// ============================================
// 终端面板组件
// ============================================

function TerminalPanel() {
  const [entries, setEntries] = useState<TerminalHistoryEntry[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 初始化时加载历史记录
  useEffect(() => {
    setEntries(terminalHistory.getHistory());
  }, []);

  // 订阅 shell 命令事件
  useEffect(() => {
    const unsub1 = onShellCommandStart(() => {
      // 通过 history 订阅来更新
    });

    const unsub2 = onShellCommandOutput(() => {
      // 通过 history 订阅来更新
    });

    const unsub3 = onShellCommandEnd(() => {
      // 通过 history 订阅来更新
    });

    // 订阅历史记录更新
    const historyUnsub = terminalHistory.subscribe((updatedEntry) => {
      setEntries((prev) => {
        const idx = prev.findIndex((e) => e.toolCallId === updatedEntry.toolCallId);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = updatedEntry;
          return next;
        }
        return [...prev, updatedEntry];
      });
    });

    return () => {
      unsub1();
      unsub2();
      unsub3();
      historyUnsub();
    };
  }, []);

  // 自动滚动到底部
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, autoScroll]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAutoScroll(distance < 40);
  }, []);

  const handleClear = () => {
    terminalHistory.clear();
    setEntries([]);
  };

  const handleCopyAll = () => {
    const text = entries
      .map((entry) => {
        const status = entry.status === "success" ? "✓" : entry.status === "error" ? "✕" : "●";
        const time = new Date(entry.startTime).toLocaleTimeString("zh-CN", { hour12: false });
        const cmdLine = entry.toolName === "shell" 
          ? `$ ${entry.command}` 
          : `tool:${entry.toolName} → ${entry.command}`;
        const outputLines = entry.output ? `\n${entry.output}` : "";
        const errorLines = entry.stderr ? `\n${entry.stderr}` : "";
        return `[${time}] ${status} ${cmdLine}${outputLines}${errorLines}`;
      })
      .join("\n\n");
    navigator.clipboard.writeText(text).then(
      () => logger.success("终端日志已复制到剪贴板"),
      () => logger.error("复制失败")
    );
  };

  const handleCopyEntry = (entry: TerminalHistoryEntry) => {
    const status = entry.status === "success" ? "✓" : entry.status === "error" ? "✕" : "●";
    const time = new Date(entry.startTime).toLocaleTimeString("zh-CN", { hour12: false });
    const cmdLine = entry.toolName === "shell" 
      ? `$ ${entry.command}` 
      : `tool:${entry.toolName} → ${entry.command}`;
    const outputLines = entry.output ? `\n${entry.output}` : "";
    const errorLines = entry.stderr ? `\n${entry.stderr}` : "";
    const text = `[${time}] ${status} ${cmdLine}${outputLines}${errorLines}`;
    navigator.clipboard.writeText(text).then(
      () => logger.success("命令输出已复制到剪贴板"),
      () => logger.error("复制失败")
    );
  };

  const isEmpty = entries.length === 0;

  const formatDuration = (start: number, end?: number): string => {
    const ms = (end ?? Date.now()) - start;
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60000)}m ${((ms % 60000) / 1000).toFixed(0)}s`;
  };

  const formatTime = (timestamp: number): string => {
    return new Date(timestamp).toLocaleTimeString("zh-CN", { 
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  };

  return (
    <div className="relative">
      {/* 工具栏 */}
      {!isEmpty && (
        <div className="absolute top-0 right-0 z-10 flex items-center gap-1 p-1">
          <button
            onClick={handleCopyAll}
            className="p-1 rounded-md text-content-tertiary hover:text-accent hover:bg-accent/10 transition-all"
            title="复制全部终端日志"
          >
            <Copy size={12} />
          </button>
          <button
            onClick={handleClear}
            className="p-1 rounded-md text-content-tertiary hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-all"
            title="清空终端"
          >
            <Trash2 size={12} />
          </button>
        </div>
      )}

      {/* 终端内容 */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="h-48 overflow-y-auto bg-black/[0.02] dark:bg-white/[0.02] font-mono text-[12px] leading-relaxed px-3 py-2 select-text"
        style={{ fontFamily: '"JetBrains Mono", "Fira Code", "Consolas", monospace' }}
      >
        {isEmpty ? (
          <div className="text-content-tertiary/50">
            <span className="text-emerald-500">ripple@dev</span>
            <span className="text-content-tertiary/40">:</span>
            <span className="text-blue-500">~</span>
            <span className="text-content-tertiary/40">$</span>
            <span className="animate-pulse ml-1">_</span>
          </div>
        ) : (
          <div className="space-y-3">
            {entries.map((entry) => (
              <div key={entry.toolCallId} className="group">
                {/* 命令行 */}
                <div className="flex items-start gap-2">
                  {/* 时间戳 */}
                  <span className="text-gray-500 text-[10px] shrink-0 mt-0.5 select-none">
                    [{formatTime(entry.startTime)}]
                  </span>
                  {/* 状态图标 */}
                  <span className="shrink-0 mt-0.5">
                    {entry.status === "running" ? (
                      <Loader2 size={12} className="text-blue-400 animate-spin" />
                    ) : entry.status === "success" ? (
                      <CheckCircle2 size={12} className="text-green-400" />
                    ) : (
                      <XCircle size={12} className="text-red-400" />
                    )}
                  </span>
                  {/* 命令内容 */}
                  <code className="text-content-secondary dark:text-content-secondary-dark break-all flex-1">
                    {entry.toolName === "shell" ? (
                      <>
                        <span className="text-content-tertiary/50">ripple@dev:</span>
                        <span className="text-blue-500">{entry.cwd || "~"}</span>
                        <span className="text-content-tertiary/50">$</span>
                        <span className="ml-1">{entry.command}</span>
                      </>
                    ) : (
                      <>
                        <span className="text-violet-500">tool:</span>
                        <span className="text-cyan-500 ml-1">{entry.toolName}</span>
                        <span className="text-content-tertiary/50 ml-1">→</span>
                        <span className="ml-1 text-content-secondary dark:text-content-secondary-dark">{entry.command}</span>
                      </>
                    )}
                  </code>
                  {/* 耗时和复制按钮 */}
                  <div className="flex items-center gap-1 shrink-0">
                    <span className="text-gray-600 text-[10px] flex items-center gap-1">
                      <Clock size={9} />
                      {formatDuration(entry.startTime, entry.endTime)}
                    </span>
                    <button
                      onClick={() => handleCopyEntry(entry)}
                      className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-gray-600 hover:text-gray-400 transition-opacity"
                      title="复制此命令"
                    >
                      <Copy size={10} />
                    </button>
                  </div>
                </div>

                {/* 工作目录（非shell工具显示） */}
                {entry.cwd && entry.toolName !== "shell" && (
                  <div className="text-gray-600 text-[10px] ml-10 mt-0.5">
                    <span className="text-gray-500">cwd:</span> {entry.cwd}
                  </div>
                )}

                {/* 标准输出 */}
                {entry.output && (
                  <pre className="ml-10 text-content-secondary/80 dark:text-content-secondary-dark/80 whitespace-pre-wrap break-all leading-relaxed text-[11px]">
                    {entry.output}
                  </pre>
                )}

                {/* 错误输出 */}
                {entry.stderr && (
                  <pre className="ml-10 text-rose-500 whitespace-pre-wrap break-all leading-relaxed text-[11px]">
                    {entry.stderr}
                  </pre>
                )}

                {/* 完成状态 */}
                {entry.status !== "running" && (
                  <div className="ml-10 mt-0.5">
                    <span
                      className={`text-[10px] ${
                        entry.status === "success"
                          ? "text-emerald-500"
                          : "text-rose-500"
                      }`}
                    >
                      {entry.status === "success"
                        ? "✓ 执行完成"
                        : "✕ 执行失败"}
                    </span>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default TerminalPanel;
