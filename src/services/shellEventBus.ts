/**
 * 工具执行事件总线
 *
 * 用于将 AI 执行的工具命令实时推送到终端面板。
 * 采用 CustomEvent 机制（与现有 file-tree-refresh / checkpoint-created 同模式），
 * 不引入任何外部依赖，对现有模块零侵入。
 */

// ============================================
// 终端历史记录（单例）
// ============================================

export interface TerminalHistoryEntry {
  toolCallId: string;
  toolName: string;
  command: string;
  cwd?: string;
  startTime: number;
  output: string;
  stderr: string;
  status: "running" | "success" | "error";
  endTime?: number;
}

class TerminalHistory {
  private listeners = new Set<(entry: TerminalHistoryEntry) => void>();
  private history: TerminalHistoryEntry[] = [];
  private maxHistory = 100;

  addEntry(entry: Omit<TerminalHistoryEntry, 'output' | 'stderr' | 'status' | 'endTime'>) {
    const newEntry: TerminalHistoryEntry = {
      ...entry,
      output: "",
      stderr: "",
      status: "running",
    };
    this.history.push(newEntry);
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory);
    }
    this.listeners.forEach((fn) => fn(newEntry));
  }

  updateOutput(toolCallId: string, output: string) {
    const entry = this.history.find((e) => e.toolCallId === toolCallId);
    if (entry) {
      entry.output += output;
      this.listeners.forEach((fn) => fn(entry));
    }
  }

  endEntry(toolCallId: string, stdout: string, stderr: string, error?: string) {
    const entry = this.history.find((e) => e.toolCallId === toolCallId);
    if (entry) {
      entry.output = stdout || entry.output;
      entry.stderr = stderr || entry.stderr;
      entry.status = error ? "error" : "success";
      entry.endTime = Date.now();
      this.listeners.forEach((fn) => fn(entry));
    }
  }

  subscribe(fn: (entry: TerminalHistoryEntry) => void) {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  getHistory(): TerminalHistoryEntry[] {
    return [...this.history];
  }

  clear() {
    this.history = [];
  }
}

export const terminalHistory = new TerminalHistory();

// ============================================
// 事件类型定义
// ============================================

/** 工具执行开始 */
export interface ToolExecutionStartDetail {
  toolCallId: string;
  /** 工具名称 */
  toolName: string;
  /** 执行的命令内容（shell命令）或工具参数的字符串表示 */
  command: string;
  /** 工作目录 */
  cwd?: string;
  /** 开始时间戳 */
  timestamp: number;
}

/** 工具执行增量输出 */
export interface ToolExecutionOutputDetail {
  toolCallId: string;
  /** 增量输出文本 */
  output: string;
}

/** 工具执行结束 */
export interface ToolExecutionEndDetail {
  toolCallId: string;
  /** 工具名称 */
  toolName: string;
  /** 完整输出 */
  stdout: string;
  /** 错误输出 */
  stderr: string;
  /** 错误信息（如有） */
  error?: string;
}

// ============================================
// 事件名称常量
// ============================================

export const TOOL_EXEC_START = "tool-exec-start";
export const TOOL_EXEC_OUTPUT = "tool-exec-output";
export const TOOL_EXEC_END = "tool-exec-end";

// ============================================
// 发射函数（供 useStreamingChat 调用）
// ============================================

export function emitToolExecutionStart(detail: ToolExecutionStartDetail): void {
  window.dispatchEvent(
    new CustomEvent(TOOL_EXEC_START, { detail }),
  );
}

export function emitToolExecutionOutput(detail: ToolExecutionOutputDetail): void {
  window.dispatchEvent(
    new CustomEvent(TOOL_EXEC_OUTPUT, { detail }),
  );
}

export function emitToolExecutionEnd(detail: ToolExecutionEndDetail): void {
  window.dispatchEvent(
    new CustomEvent(TOOL_EXEC_END, { detail }),
  );
}

// ============================================
// 监听函数（供 TerminalPanel 使用）
// ============================================

export function onToolExecutionStart(
  handler: (detail: ToolExecutionStartDetail) => void,
): () => void {
  const listener = (e: Event) => {
    handler((e as CustomEvent<ToolExecutionStartDetail>).detail);
  };
  window.addEventListener(TOOL_EXEC_START, listener);
  return () => window.removeEventListener(TOOL_EXEC_START, listener);
}

export function onToolExecutionOutput(
  handler: (detail: ToolExecutionOutputDetail) => void,
): () => void {
  const listener = (e: Event) => {
    handler((e as CustomEvent<ToolExecutionOutputDetail>).detail);
  };
  window.addEventListener(TOOL_EXEC_OUTPUT, listener);
  return () => window.removeEventListener(TOOL_EXEC_OUTPUT, listener);
}

export function onToolExecutionEnd(
  handler: (detail: ToolExecutionEndDetail) => void,
): () => void {
  const listener = (e: Event) => {
    handler((e as CustomEvent<ToolExecutionEndDetail>).detail);
  };
  window.addEventListener(TOOL_EXEC_END, listener);
  return () => window.removeEventListener(TOOL_EXEC_END, listener);
}

// ============================================
// 兼容旧版 API（保持向后兼容）
// ============================================

export const SHELL_CMD_START = TOOL_EXEC_START;
export const SHELL_CMD_OUTPUT = TOOL_EXEC_OUTPUT;
export const SHELL_CMD_END = TOOL_EXEC_END;

export type ShellCommandStartDetail = ToolExecutionStartDetail;
export type ShellCommandOutputDetail = ToolExecutionOutputDetail;
export type ShellCommandEndDetail = ToolExecutionEndDetail;

export function emitShellCommandStart(detail: ShellCommandStartDetail): void {
  emitToolExecutionStart(detail);
}

export function emitShellCommandOutput(detail: ShellCommandOutputDetail): void {
  emitToolExecutionOutput(detail);
}

export function emitShellCommandEnd(detail: ShellCommandEndDetail): void {
  emitToolExecutionEnd(detail);
}

export function onShellCommandStart(
  handler: (detail: ShellCommandStartDetail) => void,
): () => void {
  return onToolExecutionStart(handler);
}

export function onShellCommandOutput(
  handler: (detail: ShellCommandOutputDetail) => void,
): () => void {
  return onToolExecutionOutput(handler);
}

export function onShellCommandEnd(
  handler: (detail: ShellCommandEndDetail) => void,
): () => void {
  return onToolExecutionEnd(handler);
}
