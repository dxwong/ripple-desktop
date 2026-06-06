import { useEffect, useRef, useState } from "react";
import { ChevronDown, Check } from "lucide-react";
import { getProviderDef } from "ripple-shared/providers";
import type { ActiveModelConfig } from "ripple-shared/types";
import type { ModelEntry } from "./MessageInput";

/**
 * 模型下拉（与 demo `desktop-input-redesign.md` 一致）
 *
 * 数据源：MainApp 已传的 `modelEntries`（从 settings 启用的 provider + 启用的 model 动态生成）
 *
 * 视觉：
 *   - provider 彩色徽章（16x16 圆角方块）
 *   - 当前选中的 model 文字右侧打勾
 *   - 菜单项带 desc
 *   - 暗色模式
 *
 * 降级：
 *   - `entry.logo` 缺省时用 provider 名称首字母 + 灰色
 *   - `entry.tags` 缺省时不显示
 */
interface ModelSelectDropdownProps {
  activeConfig?: ActiveModelConfig;
  entries: ModelEntry[];
  onSwitch: (id: string) => void;
  disabled?: boolean;
  /** 内置 provider 主题色 fallback（避免给 32 个 provider 都配置 logo） */
  fallbackTheme?: Record<string, string>;
  /** 紧凑模式（只显示 provider logo + chevron，省 ~120px 横向空间） */
  compact?: boolean;
}

// Provider 主题色 fallback（与 demo 8 个热门 provider 对齐）
const DEFAULT_PROVIDER_THEMES: Record<string, string> = {
  deepseek:  "linear-gradient(135deg, #4d6bfe 0%, #5b8def 100%)",
  anthropic: "linear-gradient(135deg, #c8633f 0%, #e08555 100%)",
  openai:    "linear-gradient(135deg, #10a37f 0%, #1ac7a3 100%)",
  google:    "linear-gradient(135deg, #4285f4 0%, #9b72cb 50%, #d96570 100%)",
  alibaba:   "linear-gradient(135deg, #ff6a00 0%, #ff9a3c 100%)",
  moonshot:  "linear-gradient(135deg, #1a1a1a 0%, #404040 100%)",
  moonshotai:"linear-gradient(135deg, #1a1a1a 0%, #404040 100%)",
  zai:       "linear-gradient(135deg, #0066ff 0%, #4d94ff 100%)",
  xai:       "linear-gradient(135deg, #000000 0%, #434343 100%)",
  minimax:   "linear-gradient(135deg, #ff6b6b 0%, #ffa07a 100%)",
  mistral:   "linear-gradient(135deg, #ff7000 0%, #ff9e4d 100%)",
  ollama:    "linear-gradient(135deg, #2d2d2d 0%, #4a4a4a 100%)",
};

function getProviderTheme(
  providerId: string,
  fallback?: Record<string, string>,
): string {
  return (
    fallback?.[providerId] ||
    DEFAULT_PROVIDER_THEMES[providerId] ||
    "linear-gradient(135deg, #6b7280 0%, #9ca3af 100%)"
  );
}

/** 取 provider 名称的首 1-2 个字符作为徽章缩写 */
function getProviderShort(providerId: string, providerName: string): string {
  const def = getProviderDef(providerId);
  // 优先用 KNOWN_PROVIDERS 里的 icon 字段（如 "DS" / "AZ" / "OL"）
  if (def && def.icon) return def.icon.slice(0, 2);
  // 否则取 provider 名称首字母
  const trimmed = providerName.replace(/\s/g, "");
  if (/[一-龥]/.test(trimmed)) {
    // 中文：取第一个字
    return trimmed.slice(0, 1);
  }
  return trimmed.slice(0, 2).toUpperCase();
}

/**
 * 把 entry.name 拆成 { provider, model }
 * entry.name 形如 "DeepSeek · DeepSeek V4 Pro" → { provider: "DeepSeek", model: "DeepSeek V4 Pro" }
 * 拆分失败时降级：model = entry.model（id），provider = entry.provider（id）
 */
function splitEntryName(
  name: string,
  fallbackModel?: string,
  fallbackProvider?: string,
): { provider: string; model: string } {
  if (name.includes(" · ")) {
    const [provider, model] = name.split(" · ");
    return { provider, model };
  }
  return { provider: fallbackProvider || "", model: fallbackModel || name };
}

export default function ModelSelectDropdown({
  activeConfig,
  entries,
  onSwitch,
  disabled = false,
  fallbackTheme,
  compact = false,
}: ModelSelectDropdownProps) {
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

  // 当前 entry
  const activeEntry = entries.find(
    (e) => e.provider === activeConfig?.provider && e.model === activeConfig?.model,
  );

  // 显示文本：model 在前 · provider 在后（短）
  const displayLabel = activeConfig
    ? activeEntry
      ? `${splitEntryName(activeEntry.name).model} · ${splitEntryName(activeEntry.name).provider}`
      : `${activeConfig.model} · ${activeConfig.name}`
    : "未配置模型";

  const currentProviderId = activeConfig?.provider || "";
  const currentProviderName = activeConfig?.name || currentProviderId;
  const currentShort = getProviderShort(currentProviderId, currentProviderName);
  const currentBg = getProviderTheme(currentProviderId, fallbackTheme);

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
            : "text-content-tertiary dark:text-content-tertiary-dark hover:bg-black/[0.04] dark:hover:bg-white/[0.05] hover:text-content dark:hover:text-content-dark",
        ].join(" ")}
        title="切换对话模型"
      >
        {/* provider logo */}
        <span
          className="inline-flex items-center justify-center w-[18px] h-[18px] rounded-[5px] text-[9.5px] font-semibold text-white shrink-0"
          style={{ background: currentBg }}
        >
          {currentShort}
        </span>
        {/* compact 模式：mobile 视口下只显示 logo + chevron，省 ~120px 横向空间 */}
        {!compact && <span className="truncate max-w-[140px]">{displayLabel}</span>}
        <ChevronDown
          className={[
            "h-3 w-3 shrink-0 transition-transform",
            open && "rotate-180",
          ].join(" ")}
          strokeWidth={2}
        />
      </button>

      {open && !disabled && entries.length > 0 && (
        <div
          role="menu"
          className={[
            "absolute bottom-full left-0 z-50 mb-2 w-72 max-w-[90vw]",
            "bg-surface dark:bg-surface-dark",
            "border border-border dark:border-border-dark",
            "rounded-xl shadow-elevated overflow-hidden",
            "animate-in fade-in slide-in-from-bottom-2 duration-150",
            "p-1.5",
          ].join(" ")}
        >
          <div className="px-3 py-1.5 text-[11px] font-medium text-content-tertiary dark:text-content-tertiary-dark uppercase tracking-wide">
            对话模型
          </div>
          <div className="max-h-[260px] overflow-y-auto">
            {entries.map((entry) => {
              const isActive = entry.id === activeEntry?.id;
              const bg = getProviderTheme(entry.provider, fallbackTheme);
              const short = getProviderShort(entry.provider, entry.name.split(" · ")[0] || entry.provider);
              return (
                <button
                  key={entry.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isActive}
                  onClick={() => {
                    onSwitch(entry.id);
                    setOpen(false);
                  }}
                  className={[
                    "w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left",
                    "transition-colors duration-100",
                    isActive
                      ? "bg-accent/10 text-accent"
                      : "hover:bg-black/[0.04] dark:hover:bg-white/[0.05] text-content dark:text-content-dark",
                  ].join(" ")}
                >
                  <span
                    className="inline-flex items-center justify-center w-6 h-6 rounded-md text-[11px] font-semibold text-white shrink-0"
                    style={{ background: bg }}
                  >
                    {short}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-medium truncate">
                      {(() => {
                        const { model, provider } = splitEntryName(entry.name);
                        return `${model} · ${provider}`;
                      })()}
                    </div>
                    {entry.tags && entry.tags.length > 0 && (
                      <div className="flex items-center gap-1 mt-0.5">
                        {entry.tags.map((t) => (
                          <span
                            key={t}
                            className="text-[10px] px-1.5 py-px rounded text-content-tertiary dark:text-content-tertiary-dark bg-black/[0.04] dark:bg-white/[0.05]"
                          >
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  {isActive && (
                    <Check className="h-4 w-4 shrink-0 text-accent" strokeWidth={2} />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
