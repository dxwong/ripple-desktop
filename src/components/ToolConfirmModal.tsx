import { AlertTriangle, FileText, Terminal, Folder, Trash2, Check, X } from "lucide-react";
import type { ToolRequestData } from "../types";

interface ToolConfirmModalProps {
  request: ToolRequestData;
  onConfirm: (toolCallId: string, approved: boolean, reason?: string) => void;
}

/** 工具图标映射 */
const TOOL_ICONS: Record<string, React.ElementType> = {
  write_file: FileText,
  read_file: FileText,
  list_dir: Folder,
  shell: Terminal,
  remove: Trash2,
  create_dir: Folder,
};

/** 风险等级颜色 */
const RISK_COLORS: Record<string, string> = {
  low: "text-green-500",
  medium: "text-yellow-500",
  high: "text-red-500",
};

/** 风险等级标签 */
const RISK_LABELS: Record<string, string> = {
  low: "低风险",
  medium: "中风险",
  high: "高风险",
};

/** 工具名称中文映射 */
const TOOL_NAMES: Record<string, string> = {
  write_file: "写入文件",
  read_file: "读取文件",
  list_dir: "列出目录",
  shell: "执行命令",
  remove: "删除文件/目录",
  create_dir: "创建目录",
};

/**
 * 工具执行确认弹窗
 * 当 Agent 需要执行敏感操作时，弹出此弹窗等待用户确认
 */
export function ToolConfirmModal({ request, onConfirm }: ToolConfirmModalProps) {
  const { toolCallId, toolName, args, description, riskLevel } = request;
  
  // 类型安全的参数访问
  const argPath = args.path as string | undefined;
  const argContent = args.content as string | undefined;
  const argCommand = args.command as string | undefined;

  const Icon = TOOL_ICONS[toolName] || FileText;
  const toolLabel = TOOL_NAMES[toolName] || toolName;

  const handleApprove = () => {
    onConfirm(toolCallId, true);
  };

  const handleReject = () => {
    onConfirm(toolCallId, false, "用户拒绝");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-full max-w-md mx-4 bg-surface dark:bg-surface-dark rounded-xl shadow-2xl border border-border dark:border-border-dark overflow-hidden animate-fade-in">
        {/* 头部 */}
        <div className="flex items-center gap-3 px-4 py-3 bg-message-ai dark:bg-message-ai-dark border-b border-border dark:border-border-dark">
          <div className="p-2 rounded-lg bg-accent/10">
            <Icon size={20} className="text-accent" />
          </div>
          <div className="flex-1">
            <h3 className="font-medium text-content dark:text-content-dark">
              {toolLabel}
            </h3>
            <p className={`text-xs ${RISK_COLORS[riskLevel]}`}>
              {RISK_LABELS[riskLevel]}
            </p>
          </div>
          {riskLevel === "high" && (
            <AlertTriangle size={20} className="text-red-500" />
          )}
        </div>

        {/* 内容 */}
        <div className="px-4 py-3 space-y-3">
          {/* 描述 */}
          <p className="text-sm text-content-secondary dark:text-content-secondary-dark">
            {description || "AI 请求执行以下操作："}
          </p>

          {/* 参数详情 */}
          <div className="p-3 rounded-lg bg-message-user dark:bg-message-user-dark text-sm font-mono text-content dark:text-content-dark overflow-auto max-h-40">
            {toolName === "write_file" && argPath && (
              <div>
                <span className="text-content-tertiary">文件: </span>
                <span className="text-accent">{argPath}</span>
                {argContent && (
                  <pre className="mt-2 text-xs whitespace-pre-wrap">
                    {argContent.slice(0, 500)}
                    {argContent.length > 500 && "..."}
                  </pre>
                )}
              </div>
            )}
            {toolName === "shell" && argCommand && (
              <div>
                <span className="text-content-tertiary">命令: </span>
                <span className="text-accent">{argCommand}</span>
              </div>
            )}
            {toolName === "remove" && argPath && (
              <div>
                <span className="text-content-tertiary">目标: </span>
                <span className="text-red-400">{argPath}</span>
              </div>
            )}
            {toolName === "read_file" && argPath && (
              <div>
                <span className="text-content-tertiary">文件: </span>
                <span className="text-accent">{argPath}</span>
              </div>
            )}
            {toolName === "list_dir" && argPath && (
              <div>
                <span className="text-content-tertiary">目录: </span>
                <span className="text-accent">{argPath}</span>
              </div>
            )}
            {toolName === "create_dir" && argPath && (
              <div>
                <span className="text-content-tertiary">目录: </span>
                <span className="text-accent">{argPath}</span>
              </div>
            )}
            {/* 未知工具显示完整参数 */}
            {!["write_file", "shell", "remove", "read_file", "list_dir", "create_dir"].includes(toolName) && (
              <pre className="whitespace-pre-wrap">
                {JSON.stringify(args, null, 2)}
              </pre>
            )}
          </div>
        </div>

        {/* 操作按钮 */}
        <div className="flex gap-2 px-4 py-3 border-t border-border dark:border-border-dark">
          <button
            onClick={handleReject}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-message-ai dark:bg-message-ai-dark text-content dark:text-content-dark hover:bg-red-500/20 transition-colors"
          >
            <X size={16} />
            拒绝
          </button>
          <button
            onClick={handleApprove}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-accent text-white hover:bg-accent/80 transition-colors"
          >
            <Check size={16} />
            允许
          </button>
        </div>
      </div>
    </div>
  );
}
