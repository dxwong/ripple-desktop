import { useEffect, useRef, useState, useCallback } from "react";
import { BarChart3, Loader2 } from "lucide-react";
import type { AccountBalance } from "ripple-shared/types";
import { compactSession, CompactSessionError } from "ripple-shared/api";
import { flog } from "../services/frontendLogger";

/**
 * 上下文统计 Popover（v1.1.2）
 *
 * 设计参考 `plans/desktop/desktop-input-redesign.md`。
 *
 * v1.1 重大更新：
 *   - 双色进度条：文本（蓝）/ 工具（灰）堆叠显示，颜色自己说话
 *   - "压缩"按钮：调 `POST /api/sessions/:id/compact`
 *   - 浮动 toast：成功/失败提示，3 秒自动消失
 *   - 阈值变色：< 70% 蓝灰、70-90% 琥珀、> 90% 红（整个 popover 头部 + 进度条 + 数字 同步）
 *
 * v1.1.2 修复：
 *   - compactionThreshold 改由 MainApp 通过 prop 透传（不再调 useSettings）
 *   - 原因：ContextUsagePopover 之前内部调 useSettings() 拿到的是与 MainApp 隔离的实例 B，
 *     SettingsPage 改值后 popover 永远显示 instance B 的 stale 默认值 15%
 *   - 修法：与 SettingsPage 一致（v2.1 注释），统一由 MainApp 注入
 *
 * 数据源：全部从 ChatView 透传，零 mock
 *   - cacheHitRate / balance / estimatedCost：花钱相关指标
 *   - contextTokens / contextWindowSize：总占比
 *   - textTokens / toolTokens：双色进度条的文本/工具段（systemTokens 暂不展示）
 *   - sessionId：用于压缩 API
 *   - isProcessing：AI 是否在回复（控制压缩按钮）
 *
 * 后端：
 *   - Q1：context_stats 事件已从 autoCompact 解耦，总是发送
 *   - Q4：POST /api/sessions/:id/compact 已上线
 */
interface ContextUsagePopoverProps {
  cacheHitRate: number | null;
  balance: AccountBalance | null | undefined;
  estimatedCost: number;
  contextTokens: number;
  /** 上下文窗口大小（tokens），从模型配置获取。默认 128000 */
  contextWindowSize?: number;
  /** 文本类 tokens（用于双色彩条左段：蓝） */
  textTokens?: number;
  /** 工具类 tokens（用于双色彩条右段：灰） */
  toolTokens?: number;
  /** 系统类 tokens（v1.1 暂不在 popover 展示，预留） */
  systemTokens?: number;
  /** 会话 ID（用于压缩 API） */
  sessionId?: string;
  /** AI 是否正在回复（控制压缩按钮） */
  isProcessing?: boolean;
  /**
   * 压缩阈值（百分比）。0 = 不限制，随时可手动压缩
   * 由 MainApp 从 settings.compactionThreshold 透传，**不**在内部读 useSettings
   * （避免与 MainApp 实例隔离导致 stale 值）
   */
  compactionThreshold: number;
}

interface ToastMsg {
  id: number;
  text: string;
  kind: "success" | "error";
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * 头部 "234K/1000K" 用：整数 + 大写 K，无小数。
 * 与 formatTokens 的区别：用于窄空间的关键数字（不抢百分比的颜色权重）。
 */
function formatTokensShort(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function formatYuan(n: number): string {
  if (n === 0) return "免费";
  if (n < 0.01) return "<¥0.01";
  return `¥${n.toFixed(2)}`;
}

export default function ContextUsagePopover({
  cacheHitRate,
  balance,
  estimatedCost,
  contextTokens,
  contextWindowSize = 128000,
  textTokens = 0,
  toolTokens = 0,
  sessionId,
  isProcessing = false,
  compactionThreshold,
}: ContextUsagePopoverProps) {
  const [open, setOpen] = useState(false);
  const [compressing, setCompressing] = useState(false);
  const [toast, setToast] = useState<ToastMsg | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const toastIdRef = useRef(0);

  // 鼠标进出时延迟关闭（避免按钮→popover 滑过缝隙时关闭）
  const onEnter = () => {
    if (closeTimerRef.current) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setOpen(true);
  };
  const onLeave = () => {
    closeTimerRef.current = window.setTimeout(() => {
      setOpen(false);
      closeTimerRef.current = null;
    }, 120);
  };

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  // 卸载时清理 timer
  useEffect(() => {
    return () => {
      if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    };
  }, []);

  // toast 提示（成功/失败，3 秒自动消失）
  const showToast = useCallback((text: string, kind: "success" | "error") => {
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    const id = ++toastIdRef.current;
    setToast({ id, text, kind });
    toastTimerRef.current = window.setTimeout(() => {
      setToast((cur) => (cur && cur.id === id ? null : cur));
      toastTimerRef.current = null;
    }, 3000);
  }, []);

  // ===== 进度条计算（双色彩条） =====
  // 总占比：优先用 (textTokens + toolTokens) / contextWindow（"用户可控"）
  // 兜底用 contextTokens / contextWindowSize（来自 usage 事件累计，可能含 system）
  const userUsed = textTokens + toolTokens;
  const hasUserBreakdown = textTokens > 0 || toolTokens > 0;
  const totalUsed = hasUserBreakdown ? userUsed : contextTokens;
  const totalPct = Math.min(100, Math.round((totalUsed / contextWindowSize) * 100));
  const textPct = (textTokens / contextWindowSize) * 100;
  const toolPct = (toolTokens / contextWindowSize) * 100;

  // 整体阈值色调（只控制头部数字 + 触发按钮颜色，**不**控制进度条本身）
  // 设计：进度条文本段永远蓝、工具段永远灰，颜色和下方图例严格一致
  //       警示信息交给头部百分比文字和触发按钮承担
  const tone: "" | "warn" | "danger" =
    totalPct > 90 ? "danger" : totalPct > 70 ? "warn" : "";

  // 数字色（用于头部百分比）
  const headColor =
    tone === "danger"
      ? "text-red-600 dark:text-red-400"
      : tone === "warn"
        ? "text-amber-600 dark:text-amber-400"
        : "text-blue-600 dark:text-blue-400";

  // 文本段色（固定蓝色，不随阈值变）
  const textBarClass = "bg-blue-500 dark:bg-blue-400";

  // 工具段色（固定灰色，不随阈值变）
  const toolBarClass = "bg-gray-400 dark:bg-gray-500";

  // ===== 压缩按钮可用性 =====
  // 阈值 0% = 不限制，始终可压缩
  const thresholdUnlimited = compactionThreshold === 0;
  const canCompress =
    !isProcessing &&
    !compressing &&
    !!sessionId &&
    (thresholdUnlimited || totalPct >= compactionThreshold);

  const handleCompress = useCallback(async () => {
    if (!canCompress || !sessionId) return;
    setCompressing(true);
    try {
      flog.info('CTX_POPOVER', `手动压缩会话`, { sessionId, totalPct });
      const result = await compactSession(sessionId);
      flog.info('CTX_POPOVER', `压缩成功`, {
        sessionId,
        tokensBefore: result.tokensBefore,
        summaryLen: result.summary.length,
      });
      showToast(`已压缩，节省约 ${result.tokensBefore.toLocaleString()} tokens`, "success");
    } catch (err) {
      let msg = "压缩失败";
      if (err instanceof CompactSessionError) {
        if (err.statusCode === 409) {
          msg = "AI 正在回复，请等待完成后再压缩";
        } else if (err.statusCode === 404) {
          msg = "请先发送一条消息加载上下文";
        } else {
          msg = err.message;
        }
      } else if (err instanceof Error) {
        msg = err.message;
      }
      flog.error('CTX_POPOVER', `压缩失败`, { sessionId, error: msg });
      showToast(msg, "error");
    } finally {
      setCompressing(false);
    }
  }, [canCompress, sessionId, showToast, totalPct]);

  // ===== 3 指标（花钱相关） =====
  const cacheText = cacheHitRate === null ? "--" : `${cacheHitRate.toFixed(1)}%`;
  const cacheColor = cacheHitRate === null
    ? "text-content-tertiary dark:text-content-tertiary-dark"
    : "text-emerald-600 dark:text-emerald-400";

  let balanceText: string;
  let balanceColor: string;
  if (balance?.available === false) {
    balanceText = "不支持";
    balanceColor = "text-content-tertiary dark:text-content-tertiary-dark";
  } else if (balance?.success === true && balance.balance != null) {
    balanceText = `${balance.balance.toFixed(2)} ${balance.currency || "CNY"}`;
    balanceColor = "text-blue-600 dark:text-blue-400";
  } else if (balance?.error) {
    balanceText = "查询失败";
    balanceColor = "text-content-tertiary dark:text-content-tertiary-dark";
  } else {
    balanceText = "--";
    balanceColor = "text-content-tertiary dark:text-content-tertiary-dark";
  }

  const costText = formatYuan(estimatedCost);
  const costColor = estimatedCost > 0
    ? "text-amber-600 dark:text-amber-400"
    : "text-content-tertiary dark:text-content-tertiary-dark";

  return (
    <div
      className="relative"
      ref={ref}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={[
          "inline-flex items-center gap-1.5 px-2.5 h-8 rounded-lg",
          "text-xs font-medium transition-colors duration-150",
          "border border-transparent",
          open
            ? "bg-accent/10 text-content dark:text-content-dark"
            : "text-content-tertiary dark:text-content-tertiary-dark hover:bg-black/[0.04] dark:hover:bg-white/[0.05] hover:text-content dark:hover:text-content-dark",
        ].join(" ")}
        title="悬停查看统计"
      >
        <BarChart3 className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
        <span className="tabular-nums">{totalPct}% · {formatTokens(totalUsed)}</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="上下文统计"
          className={[
            "absolute bottom-full right-0 z-50 mb-2 w-[300px]",
            "bg-surface dark:bg-surface-dark",
            "border border-border dark:border-border-dark",
            "rounded-xl shadow-elevated",
            "p-3",
          ].join(" ")}
        >
          {/* 头部：标题 + 已用/总长 + 总占比 */}
          <div className="flex items-center gap-1.5 mb-2">
            <BarChart3 className="h-3.5 w-3.5 text-content-tertiary dark:text-content-tertiary-dark" strokeWidth={1.75} />
            <span className="text-[12px] font-semibold text-content dark:text-content-dark">
              上下文统计
            </span>
            <span
              className="ml-auto text-[11.5px] font-semibold tabular-nums text-content-tertiary dark:text-content-tertiary-dark"
              title={`已用 ${formatTokens(totalUsed)} / ${formatTokens(contextWindowSize)} tokens`}
            >
              {formatTokensShort(totalUsed)}/{formatTokensShort(contextWindowSize)}
            </span>
            <span className={`text-[11.5px] font-semibold tabular-nums ${headColor}`}>
              {totalPct}%
            </span>
          </div>

          {/* 双色进度条：文本（蓝/琥珀/红）+ 工具（灰/浅琥珀/浅红） */}
          <div
            className="w-full h-1.5 bg-black/[0.06] dark:bg-white/[0.08] rounded-full overflow-hidden mb-1 flex"
            title={
              hasUserBreakdown
                ? `文本 ${formatTokens(textTokens)} + 工具 ${formatTokens(toolTokens)} / ${formatTokens(contextWindowSize)} tokens`
                : `已用 ${formatTokens(totalUsed)} / ${formatTokens(contextWindowSize)} tokens（等待细分数据）`
            }
          >
            {textPct > 0 && (
              <div
                className={`h-full transition-all duration-300 ${textBarClass}`}
                style={{ width: `${textPct}%` }}
              />
            )}
            {toolPct > 0 && (
              <div
                className={`h-full transition-all duration-300 ${toolBarClass}`}
                style={{ width: `${toolPct}%` }}
              />
            )}
            {/* 兜底：没有细分数据时，按总占比显示一个单色块 */}
            {!hasUserBreakdown && totalPct > 0 && (
              <div
                className={`h-full transition-all duration-300 ${textBarClass}`}
                style={{ width: `${totalPct}%` }}
              />
            )}
          </div>

          {/* 进度条细分图例（只读，颜色自解释） */}
          {hasUserBreakdown && (
            <div className="flex items-center gap-3 text-[10.5px] text-content-tertiary dark:text-content-tertiary-dark mb-2.5 tabular-nums">
              <span className="inline-flex items-center gap-1">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 dark:bg-blue-400" />
                文本 {formatTokens(textTokens)}
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-gray-400 dark:bg-gray-500" />
                工具 {formatTokens(toolTokens)}
              </span>
            </div>
          )}

          {/* 3 个指标（花钱相关） */}
          <ul className="space-y-1.5 mb-2.5">
            <li className="flex items-center gap-2 text-[12px]">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
              <span className="text-content-tertiary dark:text-content-tertiary-dark">缓存命中率</span>
              <span className={`ml-auto font-semibold tabular-nums ${cacheColor}`}>
                {cacheText}
              </span>
            </li>
            <li className="flex items-center gap-2 text-[12px]">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0" />
              <span className="text-content-tertiary dark:text-content-tertiary-dark">账户余额</span>
              <span className={`ml-auto font-semibold tabular-nums ${balanceColor}`}>
                {balanceText}
              </span>
            </li>
            <li className="flex items-center gap-2 text-[12px]">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
              <span className="text-content-tertiary dark:text-content-tertiary-dark">预估费用</span>
              <span className={`ml-auto font-semibold tabular-nums ${costColor}`}>
                {costText}
              </span>
            </li>
          </ul>

          {/* 压缩按钮（替代原"悬停查看实时统计"提示） */}
          <button
            type="button"
            onClick={handleCompress}
            disabled={!canCompress}
            className={[
              "w-full inline-flex items-center justify-center gap-1.5 h-7 px-2.5 rounded-md",
              "text-[11.5px] font-medium transition-colors duration-150",
              "border border-border dark:border-border-dark",
              canCompress
                ? "text-content dark:text-content-dark hover:bg-accent/10 hover:border-accent/30 active:scale-[0.98]"
                : "text-content-tertiary/50 dark:text-content-tertiary-dark/50 cursor-not-allowed",
            ].join(" ")}
            title={
              isProcessing
                ? "AI 正在回复，无法压缩"
                : !sessionId
                  ? "等待会话初始化"
                  : thresholdUnlimited
                    ? "不限制 — 随时可手动压缩"
                    : totalPct < compactionThreshold
                      ? `上下文占用 < ${compactionThreshold}%，暂不需要压缩`
                      : "压缩上下文（节省 token）"
            }
          >
            {compressing ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                <span>压缩中…</span>
              </>
            ) : (
              <span>压缩上下文</span>
            )}
          </button>

          {/* 浮动 toast（成功/失败，3 秒自动消失） */}
          {toast && (
            <div
              className={[
                "absolute left-1/2 -translate-x-1/2 bottom-full mb-2 z-10",
                "px-3 py-1.5 rounded-md shadow-elevated text-[11.5px] font-medium whitespace-nowrap",
                "transition-opacity duration-150",
                toast.kind === "success"
                  ? "bg-emerald-50 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800"
                  : "bg-red-50 dark:bg-red-900/40 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800",
              ].join(" ")}
              role="status"
            >
              {toast.text}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
