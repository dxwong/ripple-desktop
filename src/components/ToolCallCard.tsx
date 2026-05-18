import { useState } from 'react';
import {
  FileText, Folder, Terminal, Trash2, Check, X,
  ChevronDown, ChevronRight, AlertTriangle, Loader2, CheckCircle2, XCircle, Clock
} from 'lucide-react';
import type { ToolCallResult } from '../types';

/** 工具图标映射 */
const TOOL_ICONS: Record<string, React.ElementType> = {
  write_file: FileText,
  read_file: FileText,
  list_dir: Folder,
  shell: Terminal,
  remove: Trash2,
  create_dir: Folder,
  glob: FileText,
  search_files: FileText,
  Grep: Terminal,
};

/** 工具名称中文映射 */
const TOOL_NAMES: Record<string, string> = {
  write_file: '写入文件',
  read_file: '读取文件',
  list_dir: '列出目录',
  shell: '执行命令',
  remove: '删除',
  create_dir: '创建目录',
  glob: '文件搜索',
  search_files: '搜索文件',
  Grep: '文本搜索',
};

/** 状态图标和颜色 */
const STATUS_CONFIG: Record<ToolCallResult['status'], {
  icon: React.ElementType;
  label: string;
  iconClass: string;
  borderClass: string;
  bgClass: string;
}> = {
  pending: {
    icon: Clock,
    label: '等待中',
    iconClass: 'text-yellow-500',
    borderClass: 'border-yellow-500/30',
    bgClass: 'bg-yellow-500/5',
  },
  approved: {
    icon: Check,
    label: '已批准',
    iconClass: 'text-blue-500',
    borderClass: 'border-blue-500/30',
    bgClass: 'bg-blue-500/5',
  },
  denied: {
    icon: X,
    label: '已拒绝',
    iconClass: 'text-red-500',
    borderClass: 'border-red-500/30',
    bgClass: 'bg-red-500/5',
  },
  success: {
    icon: CheckCircle2,
    label: '成功',
    iconClass: 'text-green-500',
    borderClass: 'border-green-500/30',
    bgClass: 'bg-green-500/5',
  },
  error: {
    icon: XCircle,
    label: '失败',
    iconClass: 'text-red-500',
    borderClass: 'border-red-500/30',
    bgClass: 'bg-red-500/5',
  },
};

/** 截取路径显示（太长时省略中间） */
function truncatePath(path: string, maxLen = 60): string {
  if (!path || path.length <= maxLen) return path;
  const half = Math.floor((maxLen - 3) / 2);
  return `${path.slice(0, half)}...${path.slice(-half)}`;
}

/** 预览内容（过长省略） */
function truncateOutput(output: string, maxLen = 300): string {
  if (!output) return '';
  if (output.length <= maxLen) return output;
  return output.slice(0, maxLen) + '\n... (已截断)';
}

interface ToolCallCardProps {
  toolCall: ToolCallResult;
  /** 默认展开状态（工具正在执行时自动展开） */
  defaultExpanded?: boolean;
}

export function ToolCallCard({ toolCall, defaultExpanded = false }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const Icon = TOOL_ICONS[toolCall.toolName] || FileText;
  const toolLabel = TOOL_NAMES[toolCall.toolName] || toolCall.toolName;
  const statusCfg = STATUS_CONFIG[toolCall.status] || STATUS_CONFIG.pending;
  const StatusIcon = statusCfg.icon;

  // 从 args 中提取关键参数显示
  const displayPath = (toolCall.args.path as string) || (toolCall.args.file_path as string);
  const displayCommand = toolCall.args.command as string | undefined;
  const displayGlob = toolCall.args.pattern as string || toolCall.args.glob as string;

  const hasOutput = !!(toolCall.output || toolCall.error);
  const showExpandToggle = hasOutput || toolCall.status === 'pending';

  return (
    <div
      className={`rounded-xl border ${statusCfg.borderClass} ${statusCfg.bgClass} overflow-hidden animate-slide-down mt-2`}
    >
      {/* 标题栏 */}
      <div className="flex items-center gap-2.5 px-3 py-2 cursor-pointer select-none" onClick={() => setExpanded(!expanded)}>
        <Icon size={14} className={statusCfg.iconClass} />

        {/* 工具名 */}
        <span className="text-xs font-medium text-content dark:text-content-dark flex-shrink-0">
          {toolLabel}
        </span>

        {/* 关键参数 */}
        {displayPath && (
          <span className="text-xs text-content-tertiary dark:text-content-tertiary-dark truncate font-mono flex-1 min-w-0" title={displayPath}>
            {truncatePath(displayPath)}
          </span>
        )}
        {displayCommand && !displayPath && (
          <span className="text-xs text-content-tertiary dark:text-content-tertiary-dark truncate font-mono flex-1 min-w-0" title={displayCommand}>
            {displayCommand.slice(0, 40)}{displayCommand.length > 40 ? '...' : ''}
          </span>
        )}
        {displayGlob && !displayPath && !displayCommand && (
          <span className="text-xs text-content-tertiary dark:text-content-tertiary-dark truncate font-mono flex-1 min-w-0">
            glob: {displayGlob}
          </span>
        )}

        {/* 展开/折叠按钮 */}
        {showExpandToggle && (
          <button
            className="p-0.5 rounded hover:bg-black/5 dark:hover:bg-white/5 transition-colors shrink-0"
            onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
            title={expanded ? '收起' : '展开'}
          >
            {expanded ? (
              <ChevronDown size={13} className="text-content-tertiary" />
            ) : (
              <ChevronRight size={13} className="text-content-tertiary" />
            )}
          </button>
        )}

        {/* 状态标签 */}
        <div className={`flex items-center gap-1 shrink-0 ${statusCfg.iconClass}`}>
          {toolCall.status === 'pending' ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <StatusIcon size={12} />
          )}
          <span className="text-[11px] font-medium">{statusCfg.label}</span>
        </div>
      </div>

      {/* 展开详情 */}
      {expanded && (
        <div className="px-3 pb-3 border-t border-border/30 dark:border-border-dark/30">
          {/* 参数详情 */}
          <div className="mt-2 space-y-1">
            {displayPath && (
              <div className="flex items-start gap-2">
                <span className="text-[11px] text-content-tertiary shrink-0 mt-0.5">路径:</span>
                <code className="text-[11px] font-mono text-content-secondary dark:text-content-secondary-dark break-all">
                  {toolCall.args.path as string || toolCall.args.file_path as string}
                </code>
              </div>
            )}
            {displayCommand && (
              <div className="flex items-start gap-2">
                <span className="text-[11px] text-content-tertiary shrink-0 mt-0.5">命令:</span>
                <code className="text-[11px] font-mono text-content-secondary dark:text-content-secondary-dark break-all">
                  {displayCommand}
                </code>
              </div>
            )}
            {displayGlob && !displayPath && !displayCommand && (
              <div className="flex items-start gap-2">
                <span className="text-[11px] text-content-tertiary shrink-0 mt-0.5">模式:</span>
                <code className="text-[11px] font-mono text-content-secondary dark:text-content-secondary-dark">
                  {displayGlob}
                </code>
              </div>
            )}
          </div>

          {/* 输出结果 */}
          {toolCall.output && (
            <div className="mt-2">
              <div className="text-[11px] text-content-tertiary mb-1">输出:</div>
              <pre className="text-[11px] font-mono bg-black/5 dark:bg-white/5 rounded-lg p-2 max-h-40 overflow-auto whitespace-pre-wrap break-all text-green-600 dark:text-green-400 leading-relaxed">
                {truncateOutput(toolCall.output)}
              </pre>
            </div>
          )}

          {/* 错误信息 */}
          {toolCall.error && (
            <div className="mt-2">
              <div className="flex items-center gap-1 text-[11px] text-red-500 mb-1">
                <AlertTriangle size={11} />
                错误
              </div>
              <pre className="text-[11px] font-mono bg-red-500/5 rounded-lg p-2 max-h-40 overflow-auto whitespace-pre-wrap break-all text-red-600 dark:text-red-400 leading-relaxed">
                {truncateOutput(toolCall.error)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default ToolCallCard;
