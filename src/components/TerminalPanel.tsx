import { useState, useEffect, useRef, useCallback } from "react";
import { Trash2, Terminal, Clock, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import {
  onShellCommandStart,
  onShellCommandOutput,
  onShellCommandEnd,
  type ShellCommandStartDetail,
  type ShellCommandOutputDetail,
  type ShellCommandEndDetail,
} from "../services/shellEventBus";

// ============================================
// 类型定义
// ============================================

interface TerminalEntry {
  toolCallId: string;
  command: string;
  cwd?: string;
  startTime: number;
  /** 累计的输出内容 */
  output: string;
  stderr: string;
  status: "running" | "success" | "error";
  endTime?: number;
}

// ============================================
// 终端面板组件
// ============================================

function TerminalPanel() {
  const [entries, setEntries] = useState<TerminalEntry[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const outputTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // 订阅 shell 命令事件
  useEffect(() => {
    const unsub1 = onShellCommandStart((detail: ShellCommandStartDetail) => {
      setEntries((prev) => {
        // 检查是否已有同 toolCallId 的条目（幂等）
        if (prev.some((e) => e.toolCallId === detail.toolCallId)) return prev;
        return [
          ...prev,
          {
            toolCallId: detail.toolCallId,
            command: detail.command,
            cwd: detail.cwd,
            startTime: detail.timestamp,
            output: "",
            stderr: "",
            status: "running",
          },
        ];
      });
    });

    const unsub2 = onShellCommandOutput((detail: ShellCommandOutputDetail) => {
      setEntries((prev) =>
        prev.map((entry) =>
          entry.toolCallId === detail.toolCallId
            ? { ...entry, output: entry.output + detail.output }
            : entry,
        ),
      );
    });

    const unsub3 = onShellCommandEnd((detail: ShellCommandEndDetail) => {
      setEntries((prev) =>
        prev.map((entry) =>
          entry.toolCallId === detail.toolCallId
            ? {
                ...entry,
                output: detail.stdout || entry.output,
                stderr: detail.stderr || entry.stderr,
                status: detail.error ? "error" : "success",
                endTime: Date.now(),
              }
            : entry,
        ),
      );
    });

    return () => {
      unsub1();
      unsub2();
      unsub3();
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
    setEntries([]);
  };

  const isEmpty = entries.length === 0;

  const formatDuration = (start: number, end?: number): string => {
    const ms = (end ?? Date.now()) - start;
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  return (
    <div className="relative">
      {/* 工具栏 */}
      {!isEmpty && (
        <div className="absolute top-0 right-0 z-10 flex items-center gap-1 p-1">
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
        className="h-48 overflow-y-auto bg-[#0d1117] font-mono text-[12px] leading-relaxed px-3 py-2 select-text"
      >
        {isEmpty ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <Terminal size={20} className="text-gray-600 mb-2" />
            <div className="text-gray-500 text-[11px]">
              AI 执行的命令将显示在这里
            </div>
            <div className="text-gray-600 text-[10px] mt-1">
              替代闪烁的 cmd 窗口
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {entries.map((entry) => (
              <div key={entry.toolCallId} className="border-b border-gray-800 last:border-b-0 pb-2">
                {/* 命令行 */}
                <div className="flex items-start gap-2 mb-1">
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
                  <code className="text-gray-100 break-all flex-1">
                    <span className="text-green-400">$ </span>
                    {entry.command}
                  </code>
                  {/* 耗时 */}
                  <span className="text-gray-500 text-[10px] shrink-0 mt-0.5 flex items-center gap-1">
                    <Clock size={10} />
                    {formatDuration(entry.startTime, entry.endTime)}
                  </span>
                </div>

                {/* 工作目录 */}
                {entry.cwd && (
                  <div className="text-gray-600 text-[10px] ml-5 mb-1">
                    {entry.cwd}
                  </div>
                )}

                {/* 标准输出 */}
                {entry.output && (
                  <pre className="ml-5 text-gray-300 whitespace-pre-wrap break-all leading-relaxed">
                    {entry.output}
                  </pre>
                )}

                {/* 错误输出 */}
                {entry.stderr && (
                  <pre className="ml-5 text-red-400 whitespace-pre-wrap break-all leading-relaxed">
                    {entry.stderr}
                  </pre>
                )}

                {/* 完成状态 */}
                {entry.status !== "running" && (
                  <div className="ml-5 mt-0.5">
                    <span
                      className={`text-[10px] ${
                        entry.status === "success"
                          ? "text-green-500"
                          : "text-red-400"
                      }`}
                    >
                      {entry.status === "success"
                        ? "✓ 命令执行完成"
                        : "✕ 命令执行失败"}
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
