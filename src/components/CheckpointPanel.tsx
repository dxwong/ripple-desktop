import { useState, useEffect, useCallback } from 'react';
import {
  X, RotateCcw, Plus, Clock, AlertTriangle, CheckCircle,
  ChevronDown, ChevronRight, Trash2, GitBranch
} from 'lucide-react';
import {
  getCheckpoints, createCheckpoint, restoreCheckpoint,
  deleteCheckpoint, getCheckpointDiff, type CheckpointSummary, type DiffEntry
} from '../services/api';

interface CheckpointPanelProps {
  cwd: string | null;
  onClose: () => void;
}

const SOURCE_LABELS: Record<string, string> = {
  manual: '手动',
  auto: '自动',
  'pre-edit': '编辑前',
  'lint-failure': 'Lint失败',
  'test-failure': '测试失败',
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const diff = now.getTime() - d.getTime();

  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;

  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hour = d.getHours().toString().padStart(2, '0');
  const min = d.getMinutes().toString().padStart(2, '0');

  if (diff < 7 * 86400000) return `${month}/${day} ${hour}:${min}`;
  return `${d.getFullYear()}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
}

/** Diff 预览弹窗 */
function DiffModal({ diff, checkpointName, onClose }: {
  diff: DiffEntry[];
  checkpointName: string;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-surface dark:bg-surface-dark rounded-xl border border-border dark:border-border-dark w-[600px] max-h-[80vh] flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border dark:border-border-dark">
          <div className="flex items-center gap-2">
            <GitBranch size={16} className="text-blue-500" />
            <span className="text-sm font-medium">差异预览：{checkpointName}</span>
          </div>
          <button onClick={onClose} className="icon-btn !p-1">
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-auto p-4 space-y-3">
          {diff.length === 0 ? (
            <p className="text-sm text-content-tertiary dark:text-content-tertiary-dark text-center py-8">
              无变化
            </p>
          ) : (
            diff.map((entry, i) => (
              <div key={i} className="border border-border dark:border-border-dark rounded-lg overflow-hidden">
                <div className="flex items-center gap-2 px-3 py-1.5 bg-surface-secondary dark:bg-surface-secondary-dark">
                  <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${
                    entry.type === 'modified' ? 'bg-amber-500/20 text-amber-500' :
                    entry.type === 'added' ? 'bg-green-500/20 text-green-500' :
                    'bg-red-500/20 text-red-500'
                  }`}>
                    {entry.type === 'modified' ? '修改' : entry.type === 'added' ? '新增' : '删除'}
                  </span>
                  <span className="text-xs text-content-tertiary dark:text-content-tertiary-dark font-mono truncate">
                    {entry.path}
                  </span>
                </div>
                {entry.type === 'modified' && entry.oldContent !== undefined && entry.newContent !== undefined && (
                  <div className="grid grid-cols-2 text-xs font-mono">
                    <pre className="p-2 bg-red-50 dark:bg-red-950/20 text-red-700 dark:text-red-300 overflow-auto max-h-32 whitespace-pre-wrap break-all">
                      {entry.oldContent || '(空)'}
                    </pre>
                    <pre className="p-2 bg-green-50 dark:bg-green-950/20 text-green-700 dark:text-green-300 overflow-auto max-h-32 whitespace-pre-wrap break-all">
                      {entry.newContent || '(空)'}
                    </pre>
                  </div>
                )}
                {entry.type === 'deleted' && entry.oldContent !== undefined && (
                  <pre className="p-2 text-xs font-mono bg-red-50 dark:bg-red-950/20 text-red-700 dark:text-red-300 max-h-32 overflow-auto whitespace-pre-wrap break-all">
                    {entry.oldContent || '(空)'}
                  </pre>
                )}
                {entry.type === 'added' && entry.newContent !== undefined && (
                  <pre className="p-2 text-xs font-mono bg-green-50 dark:bg-green-950/20 text-green-700 dark:text-green-300 max-h-32 overflow-auto whitespace-pre-wrap break-all">
                    {entry.newContent || '(空)'}
                  </pre>
                )}
              </div>
            ))
          )}
        </div>
        <div className="px-4 py-3 border-t border-border dark:border-border-dark">
          <button onClick={onClose} className="btn-secondary w-full">
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

/** 确认回滚弹窗 */
function ConfirmRestoreModal({ checkpoint, cwd, onConfirm, onCancel }: {
  checkpoint: CheckpointSummary;
  cwd: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [showDiff, setShowDiff] = useState(false);
  const [diff, setDiff] = useState<DiffEntry[]>([]);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);

  const handleRestore = async () => {
    setRestoring(true);
    const res = await restoreCheckpoint(checkpoint.id, cwd);
    setRestoring(false);
    if (res.error) {
      setResult({ success: false, message: res.error });
    } else if (res.data?.success) {
      setResult({ success: true, message: '回滚成功！' });
      setTimeout(() => {
        onConfirm();
      }, 1500);
    } else {
      setResult({ success: false, message: res.data?.errors?.join(', ') || '回滚失败' });
    }
  };

  if (result) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        <div className="bg-surface dark:bg-surface-dark rounded-xl border border-border dark:border-border-dark w-[400px] p-6 shadow-2xl">
          <div className="flex flex-col items-center gap-3">
            {result.success ? (
              <CheckCircle size={48} className="text-green-500" />
            ) : (
              <AlertTriangle size={48} className="text-red-500" />
            )}
            <p className="text-sm font-medium">{result.message}</p>
            <button onClick={onCancel} className="btn-secondary w-full mt-2">
              确定
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-surface dark:bg-surface-dark rounded-xl border border-border dark:border-border-dark w-[500px] shadow-2xl">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border dark:border-border-dark">
          <RotateCcw size={16} className="text-amber-500" />
          <span className="text-sm font-medium">确认回滚到快照</span>
        </div>
        <div className="p-4 space-y-3">
          <div className="p-3 bg-surface-secondary dark:bg-surface-secondary-dark rounded-lg">
            <p className="text-sm font-medium mb-1">{checkpoint.name}</p>
            <p className="text-xs text-content-tertiary dark:text-content-tertiary-dark">
              创建时间：{new Date(checkpoint.createdAt).toLocaleString('zh-CN')}
            </p>
          </div>
          <div className="flex items-start gap-2 p-3 bg-amber-50 dark:bg-amber-950/20 rounded-lg border border-amber-500/30">
            <AlertTriangle size={16} className="text-amber-500 shrink-0 mt-0.5" />
            <p className="text-xs text-amber-700 dark:text-amber-300">
              回滚将覆盖当前文件。此操作会自动创建备份快照。
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 px-4 pb-4">
          <button
            onClick={() => setShowDiff(!showDiff)}
            className="btn-secondary flex-1"
            disabled={loadingDiff}
          >
            {loadingDiff ? '加载中...' : showDiff ? '隐藏差异' : '查看差异'}
          </button>
          <button onClick={onCancel} className="btn-secondary flex-1">
            取消
          </button>
          <button
            onClick={handleRestore}
            className="btn-primary flex-1 !bg-amber-500 hover:!bg-amber-600"
            disabled={restoring}
          >
            {restoring ? '回滚中...' : '确认回滚'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 快照卡片 */
function CheckpointCard({
  checkpoint,
  cwd,
  onRestore,
  onDelete,
}: {
  checkpoint: CheckpointSummary;
  cwd: string;
  onRestore: (cp: CheckpointSummary, cwd: string) => void;
  onDelete: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [diff, setDiff] = useState<DiffEntry[]>([]);
  const [showDiff, setShowDiff] = useState(false);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const loadDiff = useCallback(async () => {
    setLoadingDiff(true);
    const res = await getCheckpointDiff(checkpoint.id, cwd);
    setLoadingDiff(false);
    if (res.data?.diff) {
      setDiff(res.data.diff);
      setShowDiff(true);
    }
  }, [checkpoint.id, cwd]);

  const handleDelete = async () => {
    setDeleting(true);
    await onDelete(checkpoint.id);
  };

  return (
    <>
      <div className="border border-border dark:border-border-dark rounded-lg overflow-hidden hover:border-accent/50 transition-colors">
        {/* 卡片头部 */}
        <div
          className="flex items-center gap-2 px-3 py-2 cursor-pointer"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? (
            <ChevronDown size={14} className="text-content-tertiary shrink-0" />
          ) : (
            <ChevronRight size={14} className="text-content-tertiary shrink-0" />
          )}
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium truncate">{checkpoint.name}</p>
            <div className="flex items-center gap-2 mt-0.5">
              <Clock size={10} className="text-content-tertiary" />
              <span className="text-[10px] text-content-tertiary">
                {formatTime(checkpoint.createdAt)}
              </span>
              <span className="text-[10px] px-1 py-0.5 rounded bg-surface-secondary dark:bg-surface-secondary-dark text-content-tertiary">
                {SOURCE_LABELS[checkpoint.source] || checkpoint.source}
              </span>
              <span className="text-[10px] text-content-tertiary">
                {formatBytes(checkpoint.bytes)}
              </span>
            </div>
          </div>
        </div>

        {/* 展开内容 */}
        {expanded && (
          <div className="px-3 pb-3 pt-1 border-t border-border dark:border-border-dark flex items-center gap-2">
            <button
              onClick={() => loadDiff()}
              className="btn-secondary !text-xs !py-1 flex-1"
              disabled={loadingDiff}
            >
              {loadingDiff ? '加载中...' : '差异'}
            </button>
            <button
              onClick={() => setShowConfirm(true)}
              className="btn-secondary !text-xs !py-1 !text-amber-500 hover:!bg-amber-500/10 flex-1"
            >
              <RotateCcw size={12} className="inline mr-1" />
              回滚
            </button>
            <button
              onClick={handleDelete}
              className="btn-secondary !text-xs !py-1 !text-red-500 hover:!bg-red-500/10"
              disabled={deleting}
            >
              <Trash2 size={12} />
            </button>
          </div>
        )}
      </div>

      {/* Diff 弹窗 */}
      {showDiff && (
        <DiffModal
          diff={diff}
          checkpointName={checkpoint.name}
          onClose={() => setShowDiff(false)}
        />
      )}

      {/* 确认回滚弹窗 */}
      {showConfirm && (
        <ConfirmRestoreModal
          checkpoint={checkpoint}
          cwd={cwd}
          onConfirm={() => setShowConfirm(false)}
          onCancel={() => setShowConfirm(false)}
        />
      )}
    </>
  );
}

/** 快照面板主组件 */
export function CheckpointPanel({ cwd, onClose }: CheckpointPanelProps) {
  const [checkpoints, setCheckpoints] = useState<CheckpointSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadCheckpoints = useCallback(async () => {
    if (!cwd) return;
    setLoading(true);
    setError(null);
    const res = await getCheckpoints(cwd);
    setLoading(false);
    if (res.error) {
      setError(res.error);
    } else {
      setCheckpoints(res.data || []);
    }
  }, [cwd]);

  useEffect(() => {
    loadCheckpoints();
  }, [loadCheckpoints]);

  const handleCreate = async () => {
    if (!cwd) return;
    setCreating(true);
    const name = `snapshot-${Date.now()}`;
    const res = await createCheckpoint(cwd, name, '手动创建');
    setCreating(false);
    if (!res.error) {
      loadCheckpoints();
    }
  };

  const handleDelete = async (id: string) => {
    if (!cwd) return;
    const res = await deleteCheckpoint(id, cwd);
    if (!res.error) {
      setCheckpoints(prev => prev.filter(cp => cp.id !== id));
    }
  };

  const handleRestore = async (cp: CheckpointSummary, currentCwd: string) => {
    // ConfirmRestoreModal 内部会处理回滚逻辑，回调此函数
    loadCheckpoints();
  };

  if (!cwd) {
    return (
      <div className="flex-1 max-w-80 bg-surface-secondary dark:bg-surface-secondary-dark border-l border-border dark:border-border-dark flex flex-col">
        <div className="flex items-center justify-between px-3 py-2 border-b border-border dark:border-border-dark">
          <div className="flex items-center gap-2">
            <GitBranch size={14} className="text-blue-500" />
            <span className="text-xs font-medium">快照管理</span>
          </div>
          <button onClick={onClose} className="icon-btn !p-1">
            <X size={15} />
          </button>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <p className="text-xs text-content-tertiary dark:text-content-tertiary-dark">
            请先选择工作目录
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 max-w-80 bg-surface-secondary dark:bg-surface-secondary-dark border-l border-border dark:border-border-dark flex flex-col">
      {/* 头部 */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border dark:border-border-dark">
        <div className="flex items-center gap-2 flex-1 min-w-0 overflow-hidden">
          <GitBranch size={14} className="text-blue-500 shrink-0" />
          <span className="text-xs font-medium text-content-tertiary dark:text-content-tertiary-dark truncate min-w-0">
            快照管理
          </span>
        </div>
        <button onClick={onClose} className="icon-btn !p-1 shrink-0">
          <X size={15} />
        </button>
      </div>

      {/* 创建快照按钮 */}
      <div className="px-3 py-2 border-b border-border dark:border-border-dark">
        <button
          onClick={handleCreate}
          disabled={creating}
          className="btn-secondary w-full !text-xs flex items-center justify-center gap-1.5"
        >
          <Plus size={14} />
          {creating ? '创建中...' : '创建快照'}
        </button>
      </div>

      {/* 快照列表 */}
      <div className="flex-1 overflow-auto p-3 space-y-2">
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center h-32 gap-2">
            <AlertTriangle size={24} className="text-red-500" />
            <p className="text-xs text-red-500 text-center">{error}</p>
            <button onClick={loadCheckpoints} className="btn-secondary !text-xs">
              重试
            </button>
          </div>
        ) : checkpoints.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 gap-2">
            <GitBranch size={24} className="text-content-tertiary" />
            <p className="text-xs text-content-tertiary text-center">
              暂无快照
              <br />
              <span className="text-[10px]">点击上方按钮创建第一个快照</span>
            </p>
          </div>
        ) : (
          checkpoints.map(cp => (
            <CheckpointCard
              key={cp.id}
              checkpoint={cp}
              cwd={cwd}
              onRestore={handleRestore}
              onDelete={handleDelete}
            />
          ))
        )}
      </div>
    </div>
  );
}

export default CheckpointPanel;
