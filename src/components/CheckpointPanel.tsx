import { useState, useEffect, useCallback, useRef } from 'react';
import {
  X, RotateCcw, Plus, Clock, AlertTriangle, CheckCircle,
  ChevronDown, ChevronRight, Trash2, GitBranch, RefreshCw
} from 'lucide-react';
import {
  getCheckpoints, createCheckpoint, restoreCheckpoint,
  deleteCheckpoint, getCheckpointDiff, type CheckpointSummary, type DiffEntry
} from '../services/api';

interface CheckpointPanelProps {
  cwd: string | null;
  sessionId?: string;
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
  const month = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  const hour = d.getHours().toString().padStart(2, '0');
  const min = d.getMinutes().toString().padStart(2, '0');
  const sec = d.getSeconds().toString().padStart(2, '0');
  return `${month}-${day} ${hour}:${min}:${sec}`;
}

/** Diff 预览弹窗 */
function DiffModal({ diff, checkpointName, onClose }: {
  diff: DiffEntry[];
  checkpointName: string;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/15">
      <div className="bg-surface dark:bg-surface-dark rounded-xl border border-border dark:border-border-dark w-[600px] max-h-[80vh] flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border dark:border-border-dark shrink-0">
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
function ConfirmRestoreModal({ checkpoint, cwd, sessionId, onConfirm, onCancel }: {
  checkpoint: CheckpointSummary;
  cwd: string;
  sessionId?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [showDiff, setShowDiff] = useState(false);
  const [diff, setDiff] = useState<DiffEntry[]>([]);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);

  const loadDiff = useCallback(async () => {
    setLoadingDiff(true);
    try {
      const res = await getCheckpointDiff(checkpoint.id, cwd, sessionId);
      if (res.data?.diff) {
        setDiff(res.data.diff);
        setShowDiff(true);
      }
    } catch (err: any) {
      console.warn('[ConfirmRestoreModal] 加载差异失败', err);
    } finally {
      setLoadingDiff(false);
    }
  }, [checkpoint.id, cwd, sessionId]);

  const handleRestore = async () => {
    setRestoring(true);
    const res = await restoreCheckpoint(checkpoint.id, cwd, undefined, undefined, sessionId);
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
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/15">
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/15">
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
            onClick={loadDiff}
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
            className="flex-1 px-3 py-2 rounded-lg text-xs font-medium bg-accent hover:bg-accent-hover text-white transition-colors disabled:opacity-50"
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
  sessionId,
  onRestore,
  onDelete,
}: {
  checkpoint: CheckpointSummary;
  cwd: string;
  sessionId?: string;
  onRestore: (cp: CheckpointSummary, cwd: string) => void;
  onDelete: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [diff, setDiff] = useState<DiffEntry[]>([]);
  const [showDiff, setShowDiff] = useState(false);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const loadDiff = useCallback(async () => {
    setLoadingDiff(true);
    const res = await getCheckpointDiff(checkpoint.id, cwd, sessionId);
    setLoadingDiff(false);
    if (res.data?.diff) {
      setDiff(res.data.diff);
      setShowDiff(true);
    }
  }, [checkpoint.id, cwd, sessionId]);

  const handleDelete = async () => {
    setDeleting(true);
    await onDelete(checkpoint.id);
    setDeleting(false);
    setShowDeleteConfirm(false);
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
          <div className="px-3 pb-3 pt-1 border-t border-border dark:border-border-dark flex items-center gap-2 overflow-hidden">
            <button
              onClick={() => loadDiff()}
              className="btn-secondary !text-xs !py-1 flex-1 min-w-0"
              disabled={loadingDiff}
            >
              {loadingDiff ? '加载中...' : '差异'}
            </button>
            <button
              onClick={() => setShowConfirm(true)}
              className="btn-secondary !text-xs !py-1 !text-amber-500 hover:!bg-amber-500/10 flex-1 min-w-0 whitespace-nowrap"
            >
              <RotateCcw size={12} className="inline mr-1" />
              回滚
            </button>
            <button
              onClick={() => setShowDeleteConfirm(true)}
              className="btn-secondary !text-xs !py-1 !text-red-500 hover:!bg-red-500/10 flex items-center gap-1 shrink-0 whitespace-nowrap"
              disabled={deleting}
              title="删除快照"
            >
              <Trash2 size={12} />
              <span>删除</span>
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
          sessionId={sessionId}
          onConfirm={() => setShowConfirm(false)}
          onCancel={() => setShowConfirm(false)}
        />
      )}

      {/* 删除确认弹窗 */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/15">
          <div className="bg-surface dark:bg-surface-dark rounded-xl border border-border dark:border-border-dark w-[400px] p-6 shadow-2xl">
            <div className="flex flex-col items-center gap-3">
              <AlertTriangle size={48} className="text-red-500" />
              <p className="text-sm font-medium">确认删除快照？</p>
              <p className="text-xs text-content-tertiary dark:text-content-tertiary-dark text-center">
                {checkpoint.name}
                <br />
                此操作不可恢复！
              </p>
              <div className="flex gap-2 w-full mt-2">
                <button
                  onClick={() => setShowDeleteConfirm(false)}
                  className="btn-secondary flex-1"
                >
                  取消
                </button>
                <button
                  onClick={handleDelete}
                  className="flex-1 px-3 py-2 rounded-lg text-xs font-medium bg-red-500 hover:bg-red-600 text-white transition-colors disabled:opacity-50"
                  disabled={deleting}
                >
                  {deleting ? '删除中...' : '确认删除'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** 快照面板主组件 */
export function CheckpointPanel({ cwd, sessionId, onClose }: CheckpointPanelProps) {
  const [checkpoints, setCheckpoints] = useState<CheckpointSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadingRef = useRef(false); // 用 ref 防并发，避免闭包捕获过期 loading 状态

  const loadCheckpoints = useCallback(async () => {
    if (!cwd) return;
    if (loadingRef.current) return; // 防重复请求
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const res = await getCheckpoints(cwd, sessionId);
      if (res.error) {
        setError(res.error);
      } else {
        setCheckpoints(res.data || []);
      }
    } catch (err) {
      setError('加载快照失败');
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }, [cwd, sessionId]);

  useEffect(() => {
    loadCheckpoints();
  }, [cwd, sessionId]);

  // 监听自定义事件：新快照创建时实时刷新列表
  useEffect(() => {
    const handleCheckpointCreated = (e: CustomEvent) => {
      if (e.detail?.cwd === cwd) {
        loadCheckpoints();
      }
    };
    window.addEventListener('checkpoint-created', handleCheckpointCreated as EventListener);
    return () => window.removeEventListener('checkpoint-created', handleCheckpointCreated as EventListener);
  }, [cwd, sessionId, loadCheckpoints]);

  const handleCreate = async () => {
    if (!cwd) return;
    setCreating(true);
    const name = `snapshot-${Date.now()}`;
    const res = await createCheckpoint(cwd, name, '手动创建', 'manual', sessionId);
    setCreating(false);
    if (!res.error) {
      loadCheckpoints();
    }
  };

  const handleDelete = async (id: string) => {
    if (!cwd) return;
    const res = await deleteCheckpoint(id, cwd, sessionId);
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
<div className="min-w-[260px] flex-1 max-w-80 bg-surface-secondary dark:bg-surface-secondary-dark border-l border-border dark:border-border-dark flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 border-b border-border dark:border-border-dark shrink-0">
          <div className="flex items-center gap-2">
            <GitBranch size={14} className="text-blue-500" />
            <span className="text-xs font-medium">快照管理</span>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg text-content-secondary dark:text-content-secondary-dark hover:bg-black/10 dark:hover:bg-white/10 hover:text-content dark:hover:text-content-dark transition-colors" title="关闭快照面板">
            <X size={16} />
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
    <div className="min-w-[260px] flex-1 max-w-80 bg-surface-secondary dark:bg-surface-secondary-dark border-l border-border dark:border-border-dark flex flex-col overflow-hidden">
      {/* 头部 */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border dark:border-border-dark shrink-0">
        <div className="flex items-center gap-2 flex-1 min-w-0 overflow-hidden">
          <GitBranch size={14} className="text-blue-500 shrink-0" />
          <span className="text-xs font-medium text-content-tertiary dark:text-content-tertiary-dark truncate min-w-0">
            快照管理
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={handleCreate}
            disabled={creating}
            className="p-1.5 rounded-lg text-content-secondary dark:text-content-secondary-dark hover:bg-black/10 dark:hover:bg-white/10 hover:text-content dark:hover:text-content-dark transition-colors"
            title="创建快照"
          >
            <Plus size={14} />
          </button>
          <button
            onClick={loadCheckpoints}
            disabled={loading}
            className="p-1.5 rounded-lg text-content-secondary dark:text-content-secondary-dark hover:bg-black/10 dark:hover:bg-white/10 hover:text-content dark:hover:text-content-dark transition-colors"
            title="刷新快照列表"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
          <button onClick={onClose} className="p-1.5 rounded-lg text-content-secondary dark:text-content-secondary-dark hover:bg-black/10 dark:hover:bg-white/10 hover:text-content dark:hover:text-content-dark transition-colors" title="关闭快照面板">
            <X size={16} />
          </button>
        </div>
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
              sessionId={sessionId}
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
