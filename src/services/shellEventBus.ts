/**
 * Shell 命令事件总线
 *
 * 用于将 AI 执行的 shell 命令实时推送到终端面板。
 * 采用 CustomEvent 机制（与现有 file-tree-refresh / checkpoint-created 同模式），
 * 不引入任何外部依赖，对现有模块零侵入。
 */

// ============================================
// 事件类型定义
// ============================================

/** shell 命令开始执行 */
export interface ShellCommandStartDetail {
  toolCallId: string;
  /** 执行的命令内容 */
  command: string;
  /** 工作目录 */
  cwd?: string;
  /** 开始时间戳 */
  timestamp: number;
}

/** shell 命令增量输出 */
export interface ShellCommandOutputDetail {
  toolCallId: string;
  /** 增量输出文本 */
  output: string;
}

/** shell 命令执行结束 */
export interface ShellCommandEndDetail {
  toolCallId: string;
  /** 完整 stdout */
  stdout: string;
  /** 完整 stderr */
  stderr: string;
  /** 错误信息（如有） */
  error?: string;
}

// ============================================
// 事件名称常量
// ============================================

export const SHELL_CMD_START = "shell-cmd-start";
export const SHELL_CMD_OUTPUT = "shell-cmd-output";
export const SHELL_CMD_END = "shell-cmd-end";

// ============================================
// 发射函数（供 useStreamingChat 调用）
// ============================================

export function emitShellCommandStart(detail: ShellCommandStartDetail): void {
  window.dispatchEvent(
    new CustomEvent(SHELL_CMD_START, { detail }),
  );
}

export function emitShellCommandOutput(detail: ShellCommandOutputDetail): void {
  window.dispatchEvent(
    new CustomEvent(SHELL_CMD_OUTPUT, { detail }),
  );
}

export function emitShellCommandEnd(detail: ShellCommandEndDetail): void {
  window.dispatchEvent(
    new CustomEvent(SHELL_CMD_END, { detail }),
  );
}

// ============================================
// 监听函数（供 TerminalPanel 使用）
// ============================================

export function onShellCommandStart(
  handler: (detail: ShellCommandStartDetail) => void,
): () => void {
  const listener = (e: Event) => {
    handler((e as CustomEvent<ShellCommandStartDetail>).detail);
  };
  window.addEventListener(SHELL_CMD_START, listener);
  return () => window.removeEventListener(SHELL_CMD_START, listener);
}

export function onShellCommandOutput(
  handler: (detail: ShellCommandOutputDetail) => void,
): () => void {
  const listener = (e: Event) => {
    handler((e as CustomEvent<ShellCommandOutputDetail>).detail);
  };
  window.addEventListener(SHELL_CMD_OUTPUT, listener);
  return () => window.removeEventListener(SHELL_CMD_OUTPUT, listener);
}

export function onShellCommandEnd(
  handler: (detail: ShellCommandEndDetail) => void,
): () => void {
  const listener = (e: Event) => {
    handler((e as CustomEvent<ShellCommandEndDetail>).detail);
  };
  window.addEventListener(SHELL_CMD_END, listener);
  return () => window.removeEventListener(SHELL_CMD_END, listener);
}
