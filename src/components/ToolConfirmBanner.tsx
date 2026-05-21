import { AlertTriangle, FileText, Terminal, Folder, Trash2, Check, X, ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";
import type { ToolRequestData } from "../types";

interface ToolConfirmBannerProps {
  requests: ToolRequestData[];
  onConfirm: (toolCallId: string, approved: boolean, reason?: string) => void;
  readOnly?: boolean;
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

/** 风险等级颜色 — 与品牌暖色系统协调 */
const RISK_COLORS: Record<string, string> = {
  low: "bg-accent/8 text-accent/80 border-accent/15",
  medium: "bg-amber-500/10 text-amber-600/80 border-amber-500/20 dark:text-amber-400/80",
  high: "bg-rose-500/10 text-rose-600/80 border-rose-500/20 dark:text-rose-400/80",
};

/** 工具名称中文映射 */
const TOOL_NAMES: Record<string, string> = {
  write_file: "写入",
  read_file: "读取",
  list_dir: "列出",
  shell: "执行",
  remove: "删除",
  create_dir: "创建",
};

/**
 * 工具执行确认横幅（非侵入式）
 * 固定在聊天区域上方，不阻断用户操作
 */
export function ToolConfirmBanner({ requests, onConfirm, readOnly = false }: ToolConfirmBannerProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (requests.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 w-full max-w-md">
      {requests.map((req) => {
        const { toolCallId, toolName, args, riskLevel } = req;
        const Icon = TOOL_ICONS[toolName] || FileText;
        const toolLabel = TOOL_NAMES[toolName] || toolName;
        const isExpanded = expandedId === toolCallId;
        const argPath = args.path as string | undefined;
        const argCommand = args.command as string | undefined;

        return (
          <div
            key={toolCallId}
            className={`rounded-lg border shadow-lg backdrop-blur-sm animate-slide-down ${RISK_COLORS[riskLevel]} bg-surface/95 dark:bg-surface-dark/95`}
          >
            {/* 紧凑视图 */}
            <div className="flex items-center gap-3 px-4 py-2">
              <Icon size={16} />
              <span className="text-sm font-medium flex-1 truncate">
                AI 请求 <span className="font-semibold">{toolLabel}</span>
                {argPath && <span className="text-content-tertiary">: {argPath}</span>}
                {argCommand && <span className="text-content-tertiary">: {argCommand.slice(0, 30)}...</span>}
              </span>

              {/* 展开详情按钮 */}
              <button
                onClick={() => setExpandedId(isExpanded ? null : toolCallId)}
                className="p-1 rounded hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                title="查看详情"
              >
                {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </button>

              {/* 快速操作按钮 */}
              <div className="flex items-center gap-1">
                <button
                  onClick={() => onConfirm(toolCallId, false, "用户拒绝")}
                  className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-message-ai hover:bg-rose-500/15 text-content transition-colors"
                >
                  <X size={12} />
                  拒绝
                </button>
                <button
                  onClick={() => onConfirm(toolCallId, true)}
                  disabled={readOnly}
                  className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
                    readOnly
                      ? 'bg-message-ai text-content-tertiary cursor-not-allowed'
                      : 'bg-accent hover:bg-accent/80 text-white'
                  }`}
                  title={readOnly ? '只读模式下禁止写操作' : undefined}
                >
                  <Check size={12} />
                  允许
                </button>
              </div>
            </div>

            {/* 展开详情 */}
            {isExpanded && (
              <div className="px-4 pb-3 pt-1 border-t border-border/50 dark:border-border-dark/50">
                <div className="text-xs text-content-secondary dark:text-content-secondary-dark space-y-1">
                  <div>
                    <span className="text-content-tertiary">工具: </span>
                    <span className="font-mono">{toolName}</span>
                  </div>
                  {argPath && (
                    <div>
                      <span className="text-content-tertiary">路径: </span>
                      <span className="font-mono">{argPath}</span>
                    </div>
                  )}
                  {argCommand && (
                    <div>
                      <span className="text-content-tertiary">命令: </span>
                      <code className="font-mono bg-message-user dark:bg-message-user-dark px-1 rounded">{argCommand}</code>
                    </div>
                  )}
                  {(args.content as string | undefined) && (
                    <div>
                      <span className="text-content-tertiary">内容预览: </span>
                      <pre className="mt-1 p-2 rounded bg-message-user dark:bg-message-user-dark font-mono text-[10px] max-h-24 overflow-auto">
                        {String(args.content).slice(0, 500)}
                        {String(args.content).length > 500 && "..."}
                      </pre>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
