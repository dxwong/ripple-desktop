import { useState, useEffect, useCallback } from 'react';
import { X, FileText, FileCode, FileImage, AlertCircle } from 'lucide-react';
import { readFile as apiReadFile } from '../services/api';

interface FilePreviewProps {
  filePath: string | null;
  onClose: () => void;
  /** Agent 引擎网关地址 */
  agentGatewayUrl?: string;
}

/** 判断是否为图片文件 */
function isImageFile(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase();
  return ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp'].includes(ext || '');
}

/** 判断是否为文本文件 */
function isTextFile(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase();
  return [
    'ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs', 'java', 'cpp', 'c', 'cs', 'rb', 'php', 'vue', 'svelte',
    'md', 'txt', 'mdx', 'json', 'yml', 'yaml', 'css', 'scss', 'less', 'html',
    'xml', 'toml', 'ini', 'sh', 'bat', 'cmd', 'gitignore', 'gitattributes'
  ].includes(ext || '');
}

/** 文件预览面板 */
export function FilePreview({ filePath, onClose, agentGatewayUrl = 'http://localhost:3002' }: FilePreviewProps) {
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadFile = useCallback(async () => {
    if (!filePath) return;

    setLoading(true);
    setError(null);

    try {
      if (isTextFile(filePath)) {
        const result = await apiReadFile(filePath);
        if (result.error) {
          setError(result.error);
        } else {
          setContent(result.data?.content || '');
        }
      }
      setLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load file');
      setLoading(false);
    }
  }, [filePath]);

  useEffect(() => {
    loadFile();
  }, [loadFile]);

  if (!filePath) {
    return null;
  }

  const isImage = isImageFile(filePath);
  const isText = isTextFile(filePath);
  const fileName = filePath.split(/[/\\]/).pop();

  return (
    <div className="flex-1 max-w-80 bg-surface-secondary dark:bg-surface-secondary-dark border-l border-border dark:border-border-dark flex flex-col">
      {/* 头部 */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border dark:border-border-dark">
        <div className="flex items-center gap-2 flex-1 min-w-0 overflow-hidden">
          {isImage ? (
            <FileImage size={14} className="text-green-500 shrink-0" />
          ) : isText ? (
            <FileCode size={14} className="text-blue-500 shrink-0" />
          ) : (
            <FileText size={14} className="text-gray-400 shrink-0" />
          )}
          <span className="text-xs font-medium text-content-tertiary dark:text-content-tertiary-dark truncate min-w-0">
            {fileName}
          </span>
        </div>
        <button
          onClick={onClose}
          className="icon-btn !p-1 shrink-0"
          title="关闭预览"
        >
          <X size={15} />
        </button>
      </div>

      {/* 内容区域 */}
      <div className="flex-1 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center h-full p-4">
            <AlertCircle size={24} className="text-red-500 mb-2" />
            <p className="text-xs text-red-500 text-center">{error}</p>
          </div>
        ) : isImage ? (
          <div className="h-full flex items-center justify-center p-2 bg-black/5">
            <img
              src={`${agentGatewayUrl}/api/files/read?path=${encodeURIComponent(filePath)}`}
              alt={fileName}
              className="max-w-full max-h-full object-contain rounded-lg"
              onError={(e) => {
                (e.target as HTMLImageElement).src = '';
                setError('Failed to load image');
              }}
            />
          </div>
        ) : isText ? (
          <pre className="h-full overflow-auto p-3 text-xs font-mono text-content dark:text-content-dark whitespace-pre-wrap break-all">
            {content || 'Empty file'}
          </pre>
        ) : (
          <div className="flex flex-col items-center justify-center h-full p-4">
            <FileText size={24} className="text-gray-400 mb-2" />
            <p className="text-xs text-content-tertiary dark:text-content-tertiary-dark text-center">
              不支持预览此文件类型
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

export default FilePreview;
