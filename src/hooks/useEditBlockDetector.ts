/**
 * EditBlock 检测与预览 Hook
 *
 * 检测 LLM 消息中的 EditBlock 格式，自动解析并提供预览/应用功能
 */

import { useState, useEffect, useCallback } from 'react';
import { parseEditBlocks, previewEditBlock, applyEditBlocks, EditBlock as EditBlockApi, ApplyBlocksResult } from '../services/api';
import { readFile } from '../services/api';

/** 检测到的单个 EditBlock */
export interface DetectedEditBlock {
  id: string;
  block: EditBlockApi;
  /** 原始文件内容 */
  originalContent: string;
  /** 预览结果 */
  previewResult?: {
    success: boolean;
    diff?: string;
    similarity: number;
    error?: string;
  };
  /** 匹配类型 */
  matchType: 'exact' | 'fuzzy';
  /** 快照 ID */
  checkpointId?: string;
  /** 加载状态 */
  loading: boolean;
  /** 错误信息 */
  error?: string;
}

/** Hook 返回类型 */
export interface UseEditBlockDetectorReturn {
  /** 检测到的 EditBlock 列表 */
  detectedBlocks: DetectedEditBlock[];
  /** 是否正在加载 */
  isLoading: boolean;
  /** 是否有 EditBlock 待处理 */
  hasPendingBlocks: boolean;
  /** 加载文件内容（用于预览） */
  loadFileContent: (filePath: string) => Promise<string | null>;
  /** 预览单个 EditBlock */
  previewBlock: (index: number) => Promise<void>;
  /** 应用单个 EditBlock */
  applyBlock: (index: number) => Promise<boolean>;
  /** 应用所有 EditBlock */
  applyAllBlocks: () => Promise<number>;
  /** 取消/移除单个 EditBlock */
  dismissBlock: (index: number) => void;
  /** 移除所有已应用的 EditBlock（清理消息内容） */
  getCleanContent: () => string;
}

/** EditBlock 标记正则 */
const EDIT_BLOCK_REGEX = /<<<<<<<\s*SEARCH\s*([\s\S]*?)=======\s*([\s\S]*?)>>>>>>>\s*REPLACE/g;

/** 从消息内容中提取 EditBlock 文本片段 */
function extractEditBlockText(content: string): Array<{ full: string; search: string; replace: string }> {
  const results: Array<{ full: string; search: string; replace: string }> = [];
  let match;

  // 重置正则状态
  EDIT_BLOCK_REGEX.lastIndex = 0;

  while ((match = EDIT_BLOCK_REGEX.exec(content)) !== null) {
    results.push({
      full: match[0],
      search: match[1],
      replace: match[2],
    });
  }

  return results;
}

/**
 * 检测并管理消息中的 EditBlock
 *
 * @param messageContent LLM 消息内容
 * @param onApply - 可选的外部回调，当应用成功时触发
 */
export function useEditBlockDetector(
  messageContent: string,
  onApply?: (cleanContent: string, appliedCount: number) => void
): UseEditBlockDetectorReturn {
  const [detectedBlocks, setDetectedBlocks] = useState<DetectedEditBlock[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  // 检测消息中的 EditBlock
  useEffect(() => {
    const extracted = extractEditBlockText(messageContent);

    if (extracted.length === 0) {
      setDetectedBlocks([]);
      return;
    }

    // 初始化检测到的 blocks
    const newBlocks: DetectedEditBlock[] = extracted.map((ext, index) => ({
      id: `edit-block-${Date.now()}-${index}`,
      block: {
        search: ext.search,
        replace: ext.replace,
      },
      originalContent: '',
      matchType: 'exact',
      loading: false,
    }));

    setDetectedBlocks(newBlocks);
  }, [messageContent]);

  // 加载文件内容
  const loadFileContent = useCallback(async (filePath: string): Promise<string | null> => {
    try {
      const result = await readFile(filePath);
      if (result.error || !result.data) {
        console.error('[EditBlock] Failed to read file:', result.error);
        return null;
      }
      return result.data.content;
    } catch (err) {
      console.error('[EditBlock] Error loading file:', err);
      return null;
    }
  }, []);

  // 预览单个 EditBlock
  const previewBlock = useCallback(async (index: number) => {
    const blockData = detectedBlocks[index];
    if (!blockData || !blockData.block.filePath || !blockData.originalContent) {
      return;
    }

    setDetectedBlocks(prev => prev.map((b, i) =>
      i === index ? { ...b, loading: true, error: undefined } : b
    ));

    try {
      const result = await previewEditBlock(
        blockData.originalContent,
        blockData.block,
        0.8
      );

      setDetectedBlocks(prev => prev.map((b, i) =>
        i === index ? {
          ...b,
          loading: false,
          previewResult: result.data ?? { success: false, similarity: 0, error: result.error },
          matchType: (result.data?.similarity ?? 0) < 0.95 ? 'fuzzy' : 'exact',
          error: result.error,
        } : b
      ));
    } catch (err: any) {
      setDetectedBlocks(prev => prev.map((b, i) =>
        i === index ? {
          ...b,
          loading: false,
          error: err.message || '预览失败',
        } : b
      ));
    }
  }, [detectedBlocks]);

  // 应用单个 EditBlock
  const applyBlock = useCallback(async (index: number): Promise<boolean> => {
    const blockData = detectedBlocks[index];
    if (!blockData || !blockData.block.filePath) {
      return false;
    }

    setDetectedBlocks(prev => prev.map((b, i) =>
      i === index ? { ...b, loading: true, error: undefined } : b
    ));

    try {
      const result = await applyEditBlocks(
        blockData.block.filePath,
        [blockData.block],
        true,  // useFuzzy
        0.8,   // minSimilarity
        true   // createCheckpoint
      );

      if (result.error || !result.data?.success) {
        setDetectedBlocks(prev => prev.map((b, i) =>
          i === index ? {
            ...b,
            loading: false,
            error: result.error || result.data?.results?.[0]?.error || '应用失败',
          } : b
        ));
        return false;
      }

      // 更新 block 状态
      setDetectedBlocks(prev => prev.map((b, i) =>
        i === index ? {
          ...b,
          loading: false,
          checkpointId: result.data?.checkpointId,
        } : b
      ));

      return true;
    } catch (err: any) {
      setDetectedBlocks(prev => prev.map((b, i) =>
        i === index ? {
          ...b,
          loading: false,
          error: err.message || '应用失败',
        } : b
      ));
      return false;
    }
  }, [detectedBlocks]);

  // 应用所有 EditBlock
  const applyAllBlocks = useCallback(async (): Promise<number> => {
    const fileGroups = new Map<string, EditBlockApi[]>();

    for (const block of detectedBlocks) {
      if (!block.block.filePath) continue;

      const existing = fileGroups.get(block.block.filePath) || [];
      existing.push(block.block);
      fileGroups.set(block.block.filePath, existing);
    }

    let successCount = 0;

    for (const [filePath, blocks] of fileGroups) {
      try {
        const result = await applyEditBlocks(
          filePath,
          blocks,
          true,
          0.8,
          true
        );

        if (!result.error && result.data?.success) {
          successCount += blocks.length;
        }
      } catch (err) {
        console.error('[EditBlock] Apply all failed:', err);
      }
    }

    // 触发外部回调
    if (successCount > 0 && onApply) {
      const cleanContent = getCleanContent();
      onApply(cleanContent, successCount);
    }

    return successCount;
  }, [detectedBlocks, onApply]);

  // 移除单个 EditBlock
  const dismissBlock = useCallback((index: number) => {
    setDetectedBlocks(prev => prev.filter((_, i) => i !== index));
  }, []);

  // 获取清理后的消息内容（移除 EditBlock 标记）
  const getCleanContent = useCallback((): string => {
    return messageContent.replace(EDIT_BLOCK_REGEX, '').trim();
  }, [messageContent]);

  return {
    detectedBlocks,
    isLoading,
    hasPendingBlocks: detectedBlocks.length > 0,
    loadFileContent,
    previewBlock,
    applyBlock,
    applyAllBlocks,
    dismissBlock,
    getCleanContent,
  };
}
