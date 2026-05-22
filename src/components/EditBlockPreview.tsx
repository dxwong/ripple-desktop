/**
 * EditBlockPreview - 聊天消息中的 EditBlock 预览组件
 *
 * 集成到 ChatMessage 中，自动检测并渲染 EditBlock 预览
 */

import { useState, useEffect, useCallback } from 'react';
import { useEditBlockDetector, DetectedEditBlock } from '../hooks/useEditBlockDetector';
import DiffPreview from './DiffPreview';
import { FileText, Loader2 } from 'lucide-react';

interface EditBlockPreviewProps {
  /** 消息内容 */
  content: string;
  /** 消息 ID */
  messageId: string;
  /** 是否正在流式传输 */
  isStreaming?: boolean;
  /** 应用成功回调 */
  onApply?: (cleanContent: string, appliedCount: number) => void;
  /** 内容更新回调（当 EditBlock 被应用后） */
  onContentChange?: (newContent: string) => void;
}

/**
 * 检测消息中是否包含 EditBlock 格式
 */
function hasEditBlockPattern(content: string): boolean {
  return content.includes('<<<<<<< SEARCH') && content.includes('=======') && content.includes('>>>>>>> REPLACE');
}

/**
 * 从 EditBlock 文本中提取文件路径
 * 格式: // file: path/to/file
 *       <<<<<<< SEARCH
 *       ...
 *       >>>>>>> REPLACE
 */
function extractFilePathFromContext(blockText: string, contextBefore: string): string | undefined {
  // 查找上下文中的文件路径提示
  // 常见格式:
  // - ```typescript:src/file.ts
  // - // file: path/to/file
  // - /** @file path/to/file */

  const lines = contextBefore.split('\n');
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 10; i--) {
    const line = lines[i].trim();

    // 匹配代码块语言标识: ```typescript:src/file.ts 或 ```:src/file.ts
    const codeBlockMatch = line.match(/^```[\w]*:([^\s`]+)/);
    if (codeBlockMatch) {
      return codeBlockMatch[1];
    }

    // 匹配注释格式: // file: path 或 /* @file path */
    const commentMatch = line.match(/(?:file:|#|@file)\s*([^\s]+)/);
    if (commentMatch) {
      return commentMatch[1];
    }
  }

  return undefined;
}

export default function EditBlockPreview({
  content,
  messageId,
  isStreaming = false,
  onApply,
  onContentChange,
}: EditBlockPreviewProps) {
  const [appliedBlocks, setAppliedBlocks] = useState<Set<number>>(new Set());

  const {
    detectedBlocks,
    hasPendingBlocks,
    loadFileContent,
    previewBlock,
    applyBlock,
    dismissBlock,
    getCleanContent,
  } = useEditBlockDetector(content, onApply);

  // 检测是否有 EditBlock
  if (!hasPendingBlocks || isStreaming) {
    return null;
  }

  return (
    <div className="mt-3 space-y-3">
      <div className="flex items-center gap-2 text-sm text-content-secondary dark:text-content-secondary-dark">
        <FileText size={14} />
        <span>检测到 {detectedBlocks.length} 个代码编辑块</span>
      </div>

      {detectedBlocks.map((blockData, index) => (
        <EditBlockItem
          key={blockData.id}
          blockData={blockData}
          index={index}
          isApplied={appliedBlocks.has(index)}
          loadFileContent={loadFileContent}
          previewBlock={previewBlock}
          applyBlock={async () => {
            const success = await applyBlock(index);
            if (success) {
              setAppliedBlocks(prev => new Set([...prev, index]));
              // 通知文件树刷新
              window.dispatchEvent(new CustomEvent('file-tree-refresh', { detail: {} }));
              // 通知内容更新
              if (onContentChange) {
                onContentChange(getCleanContent());
              }
            }
            return success;
          }}
          dismissBlock={() => dismissBlock(index)}
        />
      ))}
    </div>
  );
}

/** 单个 EditBlock 预览项 */
interface EditBlockItemProps {
  blockData: DetectedEditBlock;
  index: number;
  isApplied: boolean;
  loadFileContent: (filePath: string) => Promise<string | null>;
  previewBlock: (index: number) => Promise<void>;
  applyBlock: () => Promise<boolean>;
  dismissBlock: () => void;
}

function EditBlockItem({
  blockData,
  index,
  isApplied,
  loadFileContent,
  previewBlock,
  applyBlock,
  dismissBlock,
}: EditBlockItemProps) {
  const [contentLoaded, setContentLoaded] = useState(false);
  const [loadingContent, setLoadingContent] = useState(false);

  // 自动加载文件内容
  useEffect(() => {
    const filePath = blockData.block.filePath;
    if (!filePath || blockData.originalContent) return;

    const load = async () => {
      setLoadingContent(true);
      const content = await loadFileContent(filePath);
      setLoadingContent(false);
      if (content !== null) {
        setContentLoaded(true);
        // 触发预览
        previewBlock(index);
      }
    };

    load();
  }, [blockData.block.filePath, blockData.originalContent, loadFileContent, previewBlock, index]);

  // 加载中状态
  if (loadingContent || blockData.loading) {
    return (
      <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-[#252526] border border-[#3c3c3c]">
        <Loader2 size={16} className="animate-spin text-[#808080]" />
        <span className="text-sm text-[#808080]">
          {loadingContent ? '加载文件中...' : '处理中...'}
        </span>
      </div>
    );
  }

  // 没有文件路径，显示简化预览
  if (!blockData.block.filePath) {
    return (
      <div className="rounded-lg bg-[#1e1e1e] border border-[#3c3c3c] overflow-hidden">
        <div className="px-4 py-2 bg-[#252526] border-b border-[#3c3c3c]">
          <span className="text-sm text-[#dcdcaa]">
            缺少文件路径，请确保 EditBlock 格式正确
          </span>
        </div>
        <div className="p-4 space-y-4">
          <div>
            <div className="text-xs text-[#808080] mb-1">待删除 (SEARCH):</div>
            <pre className="p-3 rounded bg-[#f8514922] text-[#f85149] text-xs font-mono overflow-auto max-h-32">
              {blockData.block.search || '(空)'}
            </pre>
          </div>
          <div>
            <div className="text-xs text-[#808080] mb-1">待添加 (REPLACE):</div>
            <pre className="p-3 rounded bg-[#2ea04322] text-[#4ec169] text-xs font-mono overflow-auto max-h-32">
              {blockData.block.replace || '(空)'}
            </pre>
          </div>
        </div>
        <div className="flex justify-end gap-2 px-4 py-3 bg-[#252526] border-t border-[#3c3c3c]">
          <button
            onClick={dismissBlock}
            className="px-3 py-1.5 text-sm rounded bg-[#3c3c3c] text-[#cccccc] hover:bg-[#4c4c4c] transition-colors"
          >
            忽略
          </button>
        </div>
      </div>
    );
  }

  // 已应用状态
  if (isApplied) {
    return (
      <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-[#2ea04322] border border-[#2ea043]">
        <span className="text-sm text-[#4ec169]">✓ 已应用修改</span>
        <button
          onClick={dismissBlock}
          className="text-xs text-[#808080] hover:text-[#cccccc] transition-colors"
        >
          从消息中移除
        </button>
      </div>
    );
  }

  // 正常 DiffPreview
  return (
    <DiffPreview
      filePath={blockData.block.filePath}
      originalContent={blockData.originalContent || blockData.block.search}
      block={blockData.block}
      previewResult={blockData.previewResult}
      matchType={blockData.matchType}
      similarity={blockData.previewResult?.similarity || 1}
      checkpointId={blockData.checkpointId}
      loading={blockData.loading}
      onApply={applyBlock}
      onCancel={dismissBlock}
    />
  );
}
