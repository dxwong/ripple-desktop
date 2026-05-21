import { useState, useEffect, useCallback } from 'react';
import { ChevronRight, ChevronDown, Folder, FolderOpen, FileText, FileCode, FileImage, File, ChevronLeft, ChevronRight as ChevronRightIcon, Menu, GitBranch } from 'lucide-react';
import type { FileItem, FileTreeState } from '../types/file';

interface FileTreeProps {
  directory: string;
  onFileClick: (path: string) => void;
  onClose: () => void;
  isExpanded: boolean;
  onToggleExpand: () => void;
  showPanel: boolean;
  /** 切换到快照面板 */
  onToggleCheckpointPanel?: () => void;
  /** 快照面板是否激活 */
  isCheckpointPanelActive?: boolean;
  /** Agent 引擎网关地址 */
  agentGatewayUrl?: string;
}

/** 根据文件扩展名返回对应的图标 */
function getFileIcon(extension: string | undefined) {
  switch (extension?.toLowerCase()) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
    case 'py':
    case 'go':
    case 'rs':
    case 'java':
    case 'cpp':
    case 'c':
    case 'cs':
    case 'rb':
    case 'php':
    case 'vue':
    case 'svelte':
      return <FileCode size={14} className="text-blue-500" />;
    case 'md':
    case 'txt':
    case 'mdx':
      return <FileText size={14} className="text-gray-500" />;
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'svg':
    case 'webp':
    case 'bmp':
      return <FileImage size={14} className="text-green-500" />;
    case 'json':
      return <FileCode size={14} className="text-amber-500" />;
    case 'yml':
    case 'yaml':
      return <FileCode size={14} className="text-cyan-500" />;
    case 'css':
    case 'scss':
    case 'less':
      return <FileCode size={14} className="text-purple-500" />;
    case 'html':
      return <FileCode size={14} className="text-orange-500" />;
    default:
      return <File size={14} className="text-gray-400" />;
  }
}

/** 递归渲染文件树节点 */
function TreeNode({
  item,
  depth = 0,
  onFileClick,
}: {
  item: FileItem;
  depth?: number;
  onFileClick: (path: string) => void;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const hasChildren = item.type === 'directory' && item.children && item.children.length > 0;

  const handleClick = () => {
    if (hasChildren) {
      setIsExpanded(!isExpanded);
    }
  };

  const handleDoubleClick = () => {
    if (!hasChildren) {
      onFileClick(item.path);
    }
  };

  return (
    <div>
      <div
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        className={`flex items-center gap-1 py-1 text-sm cursor-pointer hover:bg-black/[0.03] dark:hover:bg-white/[0.03] rounded px-2 -mx-2 transition-colors ${
          depth > 0 ? `ml-${depth * 3}` : ''
        }`}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        {/* 展开/折叠图标 */}
        {hasChildren && (
          <span className="text-content-tertiary dark:text-content-tertiary-dark mr-0.5">
            {isExpanded ? (
              <ChevronDown size={14} />
            ) : (
              <ChevronRight size={14} />
            )}
          </span>
        )}
        {!hasChildren && <span className="w-4" />}

        {/* 文件/文件夹图标 */}
        {item.type === 'directory' ? (
          isExpanded ? (
            <FolderOpen size={14} className="text-amber-500 mr-1" />
          ) : (
            <Folder size={14} className="text-amber-500 mr-1" />
          )
        ) : (
          getFileIcon(item.extension)
        )}

        {/* 文件名 */}
        <span className="text-content dark:text-content-dark truncate flex-1">
          {item.name}
        </span>
      </div>

      {/* 子节点 */}
      {hasChildren && isExpanded && (
        <div>
          {item.children!.map((child) => (
            <TreeNode
              key={child.id}
              item={child}
              depth={depth + 1}
              onFileClick={onFileClick}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** 加载目录结构 */
async function loadDirectory(path: string, baseUrl: string = 'http://localhost:3002'): Promise<FileItem[]> {
  const response = await fetch(`${baseUrl}/api/files/tree?path=${encodeURIComponent(path)}&depth=2`);

  if (!response.ok) {
    throw new Error('Failed to load directory');
  }

  const data = await response.json();
  return data.children || [];
}

/** 文件树面板 */
export function FileTree({ directory, onFileClick, onClose, isExpanded, onToggleExpand, showPanel, onToggleCheckpointPanel, isCheckpointPanelActive, agentGatewayUrl = 'http://localhost:3002' }: FileTreeProps) {
  const [state, setState] = useState<FileTreeState>({
    isExpanded: false,
    selectedPath: null,
    loading: true,
    error: null,
  });
  const [items, setItems] = useState<FileItem[]>([]);

  /** 加载目录 */
  const loadDir = useCallback(async () => {
    if (!directory) {
      setItems([]);
      setState((prev) => ({ ...prev, loading: false, error: null }));
      return;
    }

    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const data = await loadDirectory(directory, agentGatewayUrl);
      setItems(data);
      setState((prev) => ({ ...prev, loading: false }));
    } catch (err) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to load directory',
      }));
    }
  }, [directory, agentGatewayUrl]);

  useEffect(() => {
    loadDir();
  }, [loadDir]);

  // 如果不显示面板且已折叠，直接返回 null（但保持展开状态以便下次显示）
  if (!showPanel && !isExpanded) {
    return null;
  }

  return (
    <div
      className={`bg-surface-secondary dark:bg-surface-secondary-dark border-l border-border dark:border-border-dark flex transition-all duration-300 ${
        isExpanded ? 'w-72' : 'w-6'
      }`}
    >
      {/* 文件树内容区域 */}
      <div
        className={`flex-1 flex flex-col overflow-hidden transition-all duration-300 ${
          isExpanded ? 'w-72' : 'w-0'
        }`}
      >
        {/* 头部 */}
        {isExpanded && (
          <div className="flex items-center justify-between px-3 py-2 border-b border-border dark:border-border-dark">
            <div className="flex items-center gap-2">
              <FolderOpen size={14} className="text-content-tertiary dark:text-content-tertiary-dark" />
              <span className="text-xs font-medium text-content-tertiary dark:text-content-tertiary-dark">
                文件
              </span>
            </div>
            <div className="flex items-center gap-1">
              {/* 快照切换按钮 */}
              {onToggleCheckpointPanel && (
                <button
                  onClick={onToggleCheckpointPanel}
                  className={`icon-btn !p-1 ${isCheckpointPanelActive ? 'text-blue-500 bg-blue-500/10' : 'text-content-tertiary dark:text-content-tertiary-dark'}`}
                  title={isCheckpointPanelActive ? '返回文件' : '快照管理'}
                >
                  <GitBranch size={15} />
                </button>
              )}
              <button
                onClick={onToggleExpand}
                className="icon-btn !p-1"
                title="收起文件树"
              >
                <Menu size={15} className="text-content-tertiary dark:text-content-tertiary-dark" />
              </button>
            </div>
          </div>
        )}

        {/* 内容区域 */}
        {isExpanded && (
          <div className="flex-1 overflow-y-auto p-2">
            {state.loading ? (
              <div className="flex items-center justify-center py-8">
                <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
              </div>
            ) : state.error ? (
              <div className="text-center py-4">
                <p className="text-xs text-red-500">{state.error}</p>
                <button
                  onClick={loadDir}
                  className="mt-2 px-2 py-1 text-xs text-accent hover:underline"
                >
                  重试
                </button>
              </div>
            ) : items.length === 0 ? (
              <div className="text-center py-4">
                <p className="text-xs text-content-tertiary dark:text-content-tertiary-dark">
                  {directory ? '目录为空' : '请选择项目'}
                </p>
              </div>
            ) : (
              <div>
                {items.map((item) => (
                  <TreeNode
                    key={item.id}
                    item={item}
                    onFileClick={onFileClick}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 展开按钮 - 始终显示在右侧边缘 */}
      {showPanel && !isExpanded && (
        <button
          onClick={onToggleExpand}
          className="w-6 h-full flex items-center justify-center text-content-tertiary dark:text-content-tertiary-dark hover:text-content dark:hover:text-content-dark hover:bg-black/[0.03] dark:hover:bg-white/[0.03] transition-colors shrink-0"
          title="展开文件树"
        >
          <Menu size={14} />
        </button>
      )}
    </div>
  );
}

export default FileTree;
