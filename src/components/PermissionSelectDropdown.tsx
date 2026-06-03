import { useEffect, useRef, useState } from "react";
import { Bot, ShieldAlert, Lock, ChevronDown, Check } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { PermissionMode } from "../types";

/**
 * 权限模式下拉（3 选 1）
 *
 * 视觉：
 *   - 默认权限      → Bot        (confirm,  默认色)
 *   - 完全访问权限  → ShieldAlert (auto,     选中后浅橙 amber-600，与 demo 一致)
 *   - Plan 模式     → Lock        (read-only, 蓝色)
 *
 * 选 Plan 模式时内部值仍是 `permissionMode === "read-only"`，
 * 复用 `useStreamingChat.ts:1263` 现有的"只读模式拒绝工具执行"逻辑。
 */

/**
 * 主题色调：
 *   - false      → 默认灰（智能体-手动）
 *   - "amber"    → 浅橙 amber-600（智能体-自动，选中后字体/图标变这个色，与 demo 一致）
 *   - "blue"     → 蓝色 blue-600（任务计划）
 */
type AccentTone = false | "amber" | "blue";

interface OptionMeta {
  label: string;
  desc: string;
  Icon: LucideIcon;
  accent: AccentTone;
}

const PERMISSION_LABELS: Record<PermissionMode, OptionMeta> = {
  "confirm":   { label: "智能体 手动",  desc: "风险操作前询问",         Icon: Bot,        accent: false },
  "auto":      { label: "智能体 自动",  desc: "跳过确认，直接处理任务", Icon: ShieldAlert, accent: "amber" },
  "read-only": { label: "Plan 模式",    desc: "先出计划，只读模式",     Icon: Lock,       accent: "blue" },
};

const ORDER: PermissionMode[] = ["confirm", "auto", "read-only"];

interface PermissionSelectDropdownProps {
  value: PermissionMode;
  onChange: (mode: PermissionMode) => void;
  disabled?: boolean;
  /** 紧凑模式（只显示图标 + 文字，去掉 chevron），用于 toolbar 极窄场景 */
  compact?: boolean;
}

export default function PermissionSelectDropdown({
  value,
  onChange,
  disabled = false,
  compact = false,
}: PermissionSelectDropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // 点外部关闭
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  const current = PERMISSION_LABELS[value];
  const CurrentIcon = current.Icon;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={[
          "inline-flex items-center gap-1.5 px-2.5 h-8 rounded-lg",
          "text-xs font-medium transition-all duration-150",
          "border border-transparent",
          disabled
            ? "cursor-not-allowed opacity-45 text-content-tertiary dark:text-content-tertiary-dark"
            : current.accent === "amber"
              ? "text-amber-600 dark:text-amber-400"
              : current.accent === "blue"
                ? "text-blue-600 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950/30"
                : "text-content-tertiary dark:text-content-tertiary-dark hover:bg-black/[0.04] dark:hover:bg-white/[0.05] hover:text-content dark:hover:text-content-dark",
        ].join(" ")}
        title={disabled ? "当前模式不支持切换权限" : `当前权限：${current.label}`}
      >
        <CurrentIcon className="h-3.5 w-3.5 shrink-0" strokeWidth={1.9} />
        {!compact && <span className="truncate max-w-[120px]">{current.label}</span>}
        <ChevronDown
          className={[
            "h-3 w-3 shrink-0 transition-transform",
            open && "rotate-180",
          ].join(" ")}
          strokeWidth={2}
        />
      </button>

      {open && !disabled && (
        <div
          role="menu"
          className={[
            "absolute bottom-full left-0 z-50 mb-2 w-60",
            "bg-surface dark:bg-surface-dark",
            "border border-border dark:border-border-dark",
            "rounded-xl shadow-elevated overflow-hidden",
            "animate-in fade-in slide-in-from-bottom-2 duration-150",
            "p-1.5",
          ].join(" ")}
        >
          {ORDER.map((mode) => {
            const opt = PERMISSION_LABELS[mode];
            const isSelected = mode === value;
            const OptIcon = opt.Icon;
            return (
              <button
                key={mode}
                type="button"
                role="menuitemradio"
                aria-checked={isSelected}
                onClick={() => {
                  onChange(mode);
                  setOpen(false);
                }}
                className={[
                  "w-full flex items-center gap-2 rounded-lg px-2.5 py-2 text-left",
                  "transition-colors duration-100",
                  isSelected
                    ? opt.accent === "blue"
                      ? "bg-blue-50 dark:bg-blue-950/30"
                      : "bg-accent/10"
                    : "hover:bg-black/[0.04] dark:hover:bg-white/[0.05]",
                ].join(" ")}
              >
                <OptIcon
                  className={[
                    "h-4 w-4 shrink-0",
                    opt.accent === "amber"
                      ? "text-amber-600 dark:text-amber-400"
                      : opt.accent === "blue"
                        ? "text-blue-600 dark:text-blue-300"
                        : isSelected
                          ? "text-accent"
                          : "text-content-tertiary dark:text-content-tertiary-dark",
                  ].join(" ")}
                  strokeWidth={1.9}
                />
                <div className="flex-1 min-w-0">
                  <div
                    className={[
                      "text-[13px] font-medium truncate",
                      opt.accent === "amber"
                        ? "text-amber-700 dark:text-amber-400"
                        : opt.accent === "blue"
                          ? "text-blue-700 dark:text-blue-300"
                          : "text-content dark:text-content-dark",
                    ].join(" ")}
                  >
                    {opt.label}
                  </div>
                  <div className="text-[11px] text-content-tertiary dark:text-content-tertiary-dark truncate">
                    {opt.desc}
                  </div>
                </div>
                {isSelected && (
                  <Check
                    className={[
                      "h-4 w-4 shrink-0",
                      opt.accent === "amber"
                        ? "text-amber-600 dark:text-amber-400"
                        : opt.accent === "blue"
                          ? "text-blue-600 dark:text-blue-300"
                          : "text-content-tertiary dark:text-content-tertiary-dark",
                    ].join(" ")}
                    strokeWidth={2}
                  />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
