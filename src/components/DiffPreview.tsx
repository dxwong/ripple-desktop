/**
 * DiffPreview 组件
 * 
 * 显示 EditBlock 修改预览，提供 Apply/Cancel 操作按钮
 */

import { useState } from 'react';
import { 
  FileText, CheckCircle2, XCircle, AlertTriangle, 
  GitCompare, ChevronDown, ChevronRight, Loader2
} from 'lucide-react';
import type { EditBlock } from '../services/api';

interface DiffPreviewProps {
  /** 原始文件路径 */
  filePath: string;
  /** 原始文件内容 */
  originalContent: string;
  /** EditBlock */
  block: EditBlock;
  /** 预览结果（可选，如果传入了则直接显示） */
  previewResult?: {
    success: boolean;
    diff?: string;
    similarity: number;
    error?: string;
  };
  /** 匹配类型 */
  matchType?: 'exact' | 'fuzzy';
  /** 相似度分数 */
  similarity?: number;
  /** 快照 ID（用于回滚） */
  checkpointId?: string;
  /** 加载状态 */
  loading?: boolean;
  /** Apply 回调 */
  onApply?: () => void;
  /** Cancel 回调 */
  onCancel?: () => void;
}

/** 解析 unified diff 格式的行 */
interface DiffLine {
  type: 'added' | 'removed' | 'unchanged' | 'header';
  content: string;
  lineNum?: number;
  newLineNum?: number;
}

/** 解析 unified diff 文本 */
function parseUnifiedDiff(diffText: string): DiffLine[] {
  const lines: DiffLine[] = [];
  const diffLines = diffText.split('\n');
  
  let oldLine = 0;
  let newLine = 0;
  
  for (const line of diffLines) {
    if (line.startsWith('@@')) {
      // @@ -start,count +start,count @@ 格式
      const match = line.match(/@@ -(\d+),?\d* \+(\d+),?\d* @@/);
      if (match) {
        oldLine = parseInt(match[1]) - 1;
        newLine = parseInt(match[2]) - 1;
      }
      lines.push({ type: 'header', content: line });
    } else if (line.startsWith('+++') || line.startsWith('---')) {
      lines.push({ type: 'header', content: line });
    } else if (line.startsWith('+')) {
      lines.push({ 
        type: 'added', 
        content: line.slice(1), 
        newLineNum: ++newLine 
      });
    } else if (line.startsWith('-')) {
      lines.push({ 
        type: 'removed', 
        content: line.slice(1), 
        lineNum: ++oldLine 
      });
    } else if (line.startsWith(' ')) {
      lines.push({ 
        type: 'unchanged', 
        content: line.slice(1) || '', 
        lineNum: ++oldLine, 
        newLineNum: ++newLine 
      });
    } else if (line.length > 0) {
      // 没有前缀的行（diff 内容本身）
      if (line.match(/^[^+-\s]/)) {
        lines.push({ type: 'unchanged', content: line });
      }
    }
  }
  
  return lines;
}

/** 计算 diff 统计 */
function computeDiffStats(lines: DiffLine[]): { added: number; removed: number; unchanged: number } {
  return lines.reduce(
    (stats, line) => {
      if (line.type === 'added') stats.added++;
      else if (line.type === 'removed') stats.removed++;
      else if (line.type === 'unchanged') stats.unchanged++;
      return stats;
    },
    { added: 0, removed: 0, unchanged: 0 }
  );
}

export default function DiffPreview({
  filePath,
  originalContent,
  block,
  previewResult,
  matchType = 'exact',
  similarity = 1,
  checkpointId,
  loading = false,
  onApply,
  onCancel,
}: DiffPreviewProps) {
  const [expanded, setExpanded] = useState(true);
  const [showDetails, setShowDetails] = useState(false);

  // 简单生成 diff（使用行级 diff 算法）
  const generateSimpleDiff = (original: string, edited: string): DiffLine[] => {
    const originalLines = original.split('\n');
    const editedLines = edited.split('\n');
    const result: DiffLine[] = [];
    
    // 简单的 LCS-based diff
    const lcs: number[][] = [];
    for (let i = 0; i <= originalLines.length; i++) {
      lcs[i] = [];
      for (let j = 0; j <= editedLines.length; j++) {
        if (i === 0 || j === 0) {
          lcs[i][j] = 0;
        } else if (originalLines[i - 1] === editedLines[j - 1]) {
          lcs[i][j] = lcs[i - 1][j - 1] + 1;
        } else {
          lcs[i][j] = Math.max(lcs[i - 1][j], lcs[i][j - 1]);
        }
      }
    }
    
    // 回溯构建 diff
    let i = originalLines.length;
    let j = editedLines.length;
    const ops: Array<{ type: 'add' | 'remove' | 'same'; originalIdx?: number; editedIdx?: number }> = [];
    
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && originalLines[i - 1] === editedLines[j - 1]) {
        ops.unshift({ type: 'same', originalIdx: i - 1, editedIdx: j - 1 });
        i--;
        j--;
      } else if (j > 0 && (i === 0 || lcs[i][j - 1] >= lcs[i - 1][j])) {
        ops.unshift({ type: 'add', editedIdx: j - 1 });
        j--;
      } else {
        ops.unshift({ type: 'remove', originalIdx: i - 1 });
        i--;
      }
    }
    
    // 转换为 DiffLine
    let oldLineNum = 1;
    let newLineNum = 1;
    for (const op of ops) {
      if (op.type === 'same' && op.originalIdx !== undefined) {
        result.push({
          type: 'unchanged',
          content: originalLines[op.originalIdx],
          lineNum: oldLineNum++,
          newLineNum: newLineNum++,
        });
      } else if (op.type === 'remove' && op.originalIdx !== undefined) {
        result.push({
          type: 'removed',
          content: originalLines[op.originalIdx],
          lineNum: oldLineNum++,
        });
      } else if (op.type === 'add' && op.editedIdx !== undefined) {
        result.push({
          type: 'added',
          content: editedLines[op.editedIdx],
          newLineNum: newLineNum++,
        });
      }
    }
    
    return result;
  };

  // 使用 API 返回的 diff 或者生成简单的 diff
  const diffLines = previewResult?.diff 
    ? parseUnifiedDiff(previewResult.diff)
    : generateSimpleDiff(block.search, block.replace);

  const stats = computeDiffStats(diffLines);
  const fileName = filePath.split(/[/\\]/).pop() || filePath;

  return (
    <div className="bg-[#1e1e1e] rounded-lg border border-[#3c3c3c] overflow-hidden">
      {/* Header */}
      <div 
        className="flex items-center gap-3 px-4 py-3 bg-[#252526] cursor-pointer hover:bg-[#2a2d2e] transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? (
          <ChevronDown className="w-4 h-4 text-[#808080]" />
        ) : (
          <ChevronRight className="w-4 h-4 text-[#808080]" />
        )}
        <GitCompare className="w-4 h-4 text-[#569cd6]" />
        <span className="text-[#cccccc] text-sm font-medium flex-1 truncate">
          {fileName}
        </span>
        
        {/* Stats badges */}
        <div className="flex items-center gap-2">
          {stats.added > 0 && (
            <span className="px-2 py-0.5 text-xs rounded bg-[#2ea04333] text-[#4ec169]">
              +{stats.added}
            </span>
          )}
          {stats.removed > 0 && (
            <span className="px-2 py-0.5 text-xs rounded bg-[#f8514933] text-[#f85149]">
              -{stats.removed}
            </span>
          )}
        </div>

        {/* Match type badge */}
        {matchType === 'fuzzy' && (
          <span className="flex items-center gap-1 px-2 py-0.5 text-xs rounded bg-[#d2992233] text-[#dcdcaa]">
            <AlertTriangle className="w-3 h-3" />
            模糊匹配 ({(similarity * 100).toFixed(0)}%)
          </span>
        )}
      </div>

      {/* Content */}
      {expanded && (
        <div className="flex flex-col">
          {/* Diff content */}
          <div className="max-h-80 overflow-auto font-mono text-xs">
            {diffLines.map((line, idx) => (
              <div
                key={idx}
                className={`flex ${
                  line.type === 'added'
                    ? 'bg-[#2ea04322] text-[#4ec169]'
                    : line.type === 'removed'
                    ? 'bg-[#f8514922] text-[#f85149]'
                    : line.type === 'header'
                    ? 'bg-[#3c3c3c] text-[#808080]'
                    : 'text-[#cccccc]'
                }`}
              >
                {/* Line number */}
                <span className="w-12 px-2 py-0.5 text-right text-[#606060] bg-[#1e1e1e] border-r border-[#3c3c3c] shrink-0 select-none">
                  {line.lineNum || ''}
                </span>
                <span className="w-12 px-2 py-0.5 text-right text-[#606060] bg-[#1e1e1e] border-r border-[#3c3c3c] shrink-0 select-none">
                  {line.newLineNum || ''}
                </span>
                {/* Line prefix */}
                <span className="w-4 px-1 py-0.5 text-center shrink-0">
                  {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
                </span>
                {/* Line content */}
                <span className="flex-1 px-2 py-0.5 whitespace-pre-wrap break-all">
                  {line.content}
                </span>
              </div>
            ))}
          </div>

          {/* Actions */}
          <div className="flex items-center justify-between gap-4 px-4 py-3 bg-[#252526] border-t border-[#3c3c3c]">
            <div className="flex items-center gap-2">
              {loading ? (
                <button
                  disabled
                  className="flex items-center gap-2 px-4 py-1.5 text-sm rounded bg-[#0e639c] text-white opacity-50 cursor-not-allowed"
                >
                  <Loader2 className="w-4 h-4 animate-spin" />
                  应用中...
                </button>
              ) : (
                <>
                  <button
                    onClick={onApply}
                    className="flex items-center gap-2 px-4 py-1.5 text-sm rounded bg-[#0e639c] text-white hover:bg-[#1177bb] transition-colors"
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    应用修改
                  </button>
                  <button
                    onClick={onCancel}
                    className="flex items-center gap-2 px-4 py-1.5 text-sm rounded bg-[#3c3c3c] text-[#cccccc] hover:bg-[#4c4c4c] transition-colors"
                  >
                    <XCircle className="w-4 h-4" />
                    取消
                  </button>
                </>
              )}
            </div>

            {/* Extra info */}
            <div className="flex items-center gap-4 text-xs text-[#808080]">
              {checkpointId && (
                <span className="flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3 text-[#4ec169]" />
                  快照已创建
                </span>
              )}
              <button
                onClick={() => setShowDetails(!showDetails)}
                className="flex items-center gap-1 hover:text-[#cccccc] transition-colors"
              >
                详细信息
                {showDetails ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              </button>
            </div>
          </div>

          {/* Details panel */}
          {showDetails && (
            <div className="px-4 py-3 bg-[#1e1e1e] border-t border-[#3c3c3c] text-xs">
              <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-[#808080]">
                <div>
                  <span className="text-[#606060]">文件:</span>{' '}
                  <span className="text-[#cccccc]">{filePath}</span>
                </div>
                <div>
                  <span className="text-[#606060]">匹配类型:</span>{' '}
                  <span className={matchType === 'fuzzy' ? 'text-[#dcdcaa]' : 'text-[#4ec169]'}>
                    {matchType === 'fuzzy' ? '模糊匹配' : '精确匹配'}
                  </span>
                </div>
                <div>
                  <span className="text-[#606060]">相似度:</span>{' '}
                  <span className={similarity < 0.9 ? 'text-[#dcdcaa]' : 'text-[#4ec169]'}>
                    {(similarity * 100).toFixed(1)}%
                  </span>
                </div>
                <div>
                  <span className="text-[#606060]">变更行数:</span>{' '}
                  <span className="text-[#cccccc]">
                    +{stats.added} -{stats.removed}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
