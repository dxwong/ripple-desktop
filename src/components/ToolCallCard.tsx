import { useState, useEffect, useRef } from 'react';
import {
  FileText, Folder, Terminal, Trash2, Check, X,
  ChevronDown, ChevronRight, AlertTriangle, CheckCircle2, XCircle, Clock
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

/** 状态配置 */
const STATUS_CONFIG: Record<ToolCallResult['status'], {
  label: string;
  color: string;
}> = {
  pending: {
    label: '等待中',
    color: 'text-amber-600/55 dark:text-amber-400/55',
  },
  approved: {
    label: '已批准',
    color: 'text-accent/70 dark:text-accent/70',
  },
  denied: {
    label: '已拒绝',
    color: 'text-rose-500/50 dark:text-rose-400/50',
  },
  success: {
    label: '已完成',
    color: 'text-accent/75 dark:text-accent/75',
  },
  error: {
    label: '失败',
    color: 'text-rose-500/50 dark:text-rose-400/50',
  },
};

/** 状态对应的完成图标 */
const STATUS_ICONS: Record<ToolCallResult['status'], React.ElementType> = {
  pending: Check,
  approved: Check,
  denied: X,
  success: CheckCircle2,
  error: XCircle,
};

/** 格式化执行耗时 */
function formatDuration(start?: number, end?: number): string {
  if (!start) return '';
  const ms = (end ?? Date.now()) - start;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${((ms % 60000) / 1000).toFixed(0)}s`;
}

/** 截取路径显示（太长时省略中间） */
function truncatePath(path: string, maxLen = 60): string {
  if (!path || path.length <= maxLen) return path;
  const half = Math.floor((maxLen - 3) / 2);
  return `${path.slice(0, half)}...${path.slice(-half)}`;
}

/** 预览内容（过长省略） */
function truncateOutput(output: string, maxLen = 150): string {
  if (!output) return '';
  if (output.length <= maxLen) return output;
  return output.slice(0, maxLen) + '\n... (已截断，点击展开查看完整内容)';
}

interface ToolCallCardProps {
  toolCall: ToolCallResult;
}

export function ToolCallCard({ toolCall }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [liveDuration, setLiveDuration] = useState('');
  const timerRef = useRef<ReturnType<typeof setInterval>>();

  const Icon = TOOL_ICONS[toolCall.toolName] || FileText;
  const toolLabel = TOOL_NAMES[toolCall.toolName] || toolCall.toolName;
  const statusCfg = STATUS_CONFIG[toolCall.status] || STATUS_CONFIG.pending;
  const StatusIcon = STATUS_ICONS[toolCall.status] || Check;

  const isRunning = toolCall.status === 'approved';
  const isFinished = toolCall.status === 'success' || toolCall.status === 'error';

  const displayPath = (toolCall.args.path as string) || (toolCall.args.file_path as string);
  const displayCommand = toolCall.args.command as string | undefined;
  const displayGlob = toolCall.args.pattern as string || toolCall.args.glob as string;

  const hasOutput = !!(toolCall.output || toolCall.error);
  const showExpandToggle = hasOutput || toolCall.status === 'pending';

  // 正在执行时实时刷新耗时
  useEffect(() => {
    if (!isRunning || !toolCall.startTime) {
      setLiveDuration('');
      return;
    }
    const update = () => setLiveDuration(formatDuration(toolCall.startTime));
    update();
    timerRef.current = setInterval(update, 200);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [isRunning, toolCall.startTime]);

  // 执行结束后显示最终耗时
  const finalDuration = isFinished && toolCall.startTime
    ? formatDuration(toolCall.startTime, toolCall.endTime)
    : '';

  const durationText = isRunning ? liveDuration : finalDuration;

  return (
    <div className="rounded-lg border border-border/60 dark:border-border-dark/60 overflow-hidden mt-1.5">
      {/* 标题栏 */}
      <div className="flex items-center gap-2 px-2.5 py-1.5 cursor-pointer select-none" onClick={() => setExpanded(!expanded)}>
        <Icon size={13} className="text-content-tertiary/70" />

        {/* 工具名 */}
        <span className="text-xs text-content-secondary flex-shrink-0">
          {toolLabel}
        </span>

        {/* 关键参数 */}
        {displayPath && (
          <span className="text-xs text-content-tertiary/60 dark:text-content-tertiary-dark/60 truncate font-mono flex-1 min-w-0" title={displayPath}>
            {truncatePath(displayPath)}
          </span>
        )}
        {displayCommand && !displayPath && (
          <span className="text-xs text-content-tertiary/60 dark:text-content-tertiary-dark/60 truncate font-mono flex-1 min-w-0" title={displayCommand}>
            {displayCommand.slice(0, 40)}{displayCommand.length > 40 ? '...' : ''}
          </span>
        )}
        {displayGlob && !displayPath && !displayCommand && (
          <span className="text-xs text-content-tertiary/60 dark:text-content-tertiary-dark/60 truncate font-mono flex-1 min-w-0">
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
              <ChevronDown size={13} className="text-content-tertiary/50" />
            ) : (
              <ChevronRight size={13} className="text-content-tertiary/50" />
            )}
          </button>
        )}

        {/* 执行耗时（如果有） */}
        {durationText && (
          <span className="flex items-center gap-1 text-[10px] text-content-tertiary/40 shrink-0">
            <Clock size={9} />
            {durationText}
          </span>
        )}

        {/* 状态标签 */}
        <div className={`flex items-center gap-1.5 shrink-0 ${statusCfg.color}`}>
          {isRunning ? (
            <span className="inline-flex rounded-full h-2 w-2 bg-amber-400 animate-breath" />
          ) : toolCall.status === 'pending' ? (
            <span className="inline-flex rounded-full h-2 w-2 bg-amber-400 animate-pulse" />
          ) : (
            <StatusIcon size={11} />
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
                <span className="text-[11px] text-content-tertiary/60 shrink-0 mt-0.5">路径:</span>
                <code className="text-[11px] font-mono text-content-secondary/70 dark:text-content-secondary-dark/70 break-all">
                  {toolCall.args.path as string || toolCall.args.file_path as string}
                </code>
              </div>
            )}
            {displayCommand && (
              <div className="flex items-start gap-2">
                <span className="text-[11px] text-content-tertiary/60 shrink-0 mt-0.5">命令:</span>
                <code className="text-[11px] font-mono text-content-secondary/70 dark:text-content-secondary-dark/70 break-all">
                  {displayCommand}
                </code>
              </div>
            )}
            {displayGlob && !displayPath && !displayCommand && (
              <div className="flex items-start gap-2">
                <span className="text-[11px] text-content-tertiary/60 shrink-0 mt-0.5">模式:</span>
                <code className="text-[11px] font-mono text-content-secondary/70 dark:text-content-secondary-dark/70">
                  {displayGlob}
                </code>
              </div>
            )}
          </div>

          {/* 输出结果 */}
          {toolCall.output && (
            <div className="mt-2">
              <div className="text-[10px] text-content-tertiary/40 mb-0.5">输出:</div>
              <pre className="text-[11px] font-mono bg-black/[0.02] dark:bg-white/[0.02] rounded-lg p-2 max-h-32 overflow-auto whitespace-pre-wrap break-all text-content-tertiary/70 leading-relaxed">
                {truncateOutput(toolCall.output)}
              </pre>
            </div>
          )}

          {/* 错误信息 */}
          {toolCall.error && (
            <div className="mt-2">
              <div className="flex items-center gap-1 text-[10px] text-rose-500/50 dark:text-rose-400/50 mb-0.5">
                <AlertTriangle size={10} />
                错误
              </div>
              <pre className="text-[11px] font-mono bg-rose-500/[0.04] dark:bg-rose-400/[0.04] rounded-lg p-2 max-h-32 overflow-auto whitespace-pre-wrap break-all text-rose-500/55 dark:text-rose-400/55 leading-relaxed">
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
