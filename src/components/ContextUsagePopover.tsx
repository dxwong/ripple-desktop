import { useEffect, useRef, useState } from "react";
import { BarChart3, X } from "lucide-react";
import type { AccountBalance } from "ripple-shared/types";

/**
 * 上下文使用量 Popover（仅展示 3 指标，**不**含压缩按钮）
 *
 * 设计参考 `plans/desktop/desktop-input-redesign.md`。
 *
 * 数据源：全部从 ChatView 传入，零 mock
 *   - cacheHitRate    : ChatView.tsx:290  convCacheHitRate
 *   - balance         : ChatView 已有
 *   - estimatedCost   : ChatView.tsx:304  estimatedCost
 *   - contextTokens   : ChatView.tsx:284  currentConvUsage.totalTokens
 *
 * ⚠️ 压缩按钮暂不放：后端 `POST /api/session/:id/compact` 接口缺失，
 *    避免"UI 假成功"风险（详见 desktop-context-usage.md §2.3）。
 */
interface ContextUsagePopoverProps {
  cacheHitRate: number | null;
  balance: AccountBalance | null | undefined;
  estimatedCost: number;
  contextTokens: number;
  /** 上下文窗口大小（tokens），用于计算百分比。默认 32000 */
  contextWindowSize?: number;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function formatYuan(n: number): string {
  if (n === 0) return "免费";
  if (n < 0.01) return "<¥0.01";
  return `¥${n.toFixed(2)}`;
}

function pctClass(pct: number): "" | "warn" | "danger" {
  if (pct >= 95) return "danger";
  if (pct >= 80) return "warn";
  return "";
}

export default function ContextUsagePopover({
  cacheHitRate,
  balance,
  estimatedCost,
  contextTokens,
  contextWindowSize = 32000,
}: ContextUsagePopoverProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);

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

  // 计算百分比
  const pct = Math.min(100, Math.round((contextTokens / contextWindowSize) * 100));
  const tone = pctClass(pct);

  // 渲染 3 个指标的值
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
        <span className="tabular-nums">{pct}% · {formatTokens(contextTokens)}</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="上下文统计"
          className={[
            "absolute bottom-full right-0 z-50 mb-2 w-[280px]",
            "bg-surface dark:bg-surface-dark",
            "border border-border dark:border-border-dark",
            "rounded-xl shadow-elevated",
            "p-3",
            "animate-in fade-in slide-in-from-bottom-2 duration-150",
          ].join(" ")}
        >
          {/* 头部 */}
          <div className="flex items-center gap-1.5 mb-2">
            <BarChart3 className="h-3.5 w-3.5 text-content-tertiary dark:text-content-tertiary-dark" strokeWidth={1.75} />
            <span className="text-[12px] font-semibold text-content dark:text-content-dark">
              上下文统计
            </span>
            <span
              className={[
                "ml-auto text-[11.5px] font-semibold tabular-nums",
                tone === "danger"
                  ? "text-red-600 dark:text-red-400"
                  : tone === "warn"
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-blue-600 dark:text-blue-400",
              ].join(" ")}
            >
              {pct}%
            </span>
          </div>

          {/* 进度条 */}
          <div className="w-full h-1 bg-black/[0.06] dark:bg-white/[0.08] rounded-full overflow-hidden mb-3">
            <div
              className={[
                "h-full rounded-full transition-all duration-300",
                tone === "danger"
                  ? "bg-red-500"
                  : tone === "warn"
                    ? "bg-amber-500"
                    : "bg-blue-500",
              ].join(" ")}
              style={{ width: `${pct}%` }}
            />
          </div>

          {/* 3 个指标 */}
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

          {/* 提示（无压缩按钮） */}
          <div className="text-center text-[10.5px] text-content-tertiary dark:text-content-tertiary-dark tracking-wide">
            悬停查看实时统计
          </div>
        </div>
      )}
    </div>
  );
}
