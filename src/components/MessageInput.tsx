import { useState, useRef, useEffect } from "react";
import { ArrowUp, ChevronDown, Cpu, Lock } from "lucide-react";
import type { ModelConfig, ChatMode } from "../types";

interface OpenCodeModel {
  name: string;
  provider?: string;
}

interface MessageInputProps {
  onSend: (content: string) => void;
  disabled?: boolean;
  placeholder?: string;
  /** 当前激活的对话模型配置 */
  activeConfig?: ModelConfig;
  /** 所有已保存的对话模型配置列表 */
  modelConfigs?: ModelConfig[];
  /** 切换对话模型 */
  onSwitchModel?: (id: string) => void;
  /** 当前会话模式 */
  chatMode?: ChatMode;
  /** OpenCode 可用模型列表 */
  openCodeModels?: OpenCodeModel[];
  /** 当前选中的 OpenCode 模型 */
  openCodeModel?: string;
  /** 切换 OpenCode 模型 */
  onSwitchOpenCodeModel?: (model: string) => void;
}

/**
 * 消息输入框组件
 *
 * ── 普通对话模式 ──
 * ┌────────────────────────────────┐
 * │  textarea                     │
 * │        [GPT-4o ▼]        [↑]  │
 * └────────────────────────────────┘
 *
 * ── 代码模式 + 已选 OC 模型 ──
 * ┌──────────────────────────────────────────────┐
 * │  textarea                                     │
 * │  [GPT-4o 🔒]  [OpenCode: gpt-4o ▼]     [↑]  │
 * └──────────────────────────────────────────────┘
 *
 * ── 代码模式 + 未选 OC 模型 ──
 * ┌──────────────────────────────────────────────┐
 * │  textarea                                     │
 * │  [GPT-4o ▼]    [OpenCode: -- ▼]         [↑]  │
 * └──────────────────────────────────────────────┘
 */
function MessageInput({
  onSend,
  disabled = false,
  placeholder = "输入消息...",
  activeConfig,
  modelConfigs = [],
  onSwitchModel,
  chatMode = "chat",
  openCodeModels = [],
  openCodeModel = "",
  onSwitchOpenCodeModel,
}: MessageInputProps) {
  const [input, setInput] = useState("");
  const [showCMDropdown, setShowCMDropdown] = useState(false);
  const [showOCDropdown, setShowOCDropdown] = useState(false);
  const [customOCInput, setCustomOCInput] = useState(false);
  const [customOCValue, setCustomOCValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const cmDropdownRef = useRef<HTMLDivElement>(null);
  const ocDropdownRef = useRef<HTMLDivElement>(null);
  const manualInputRef = useRef<HTMLInputElement>(null);

  const isCodeMode = chatMode === "code";
  /** 已选了 OpenCode 模型 → 对话模型禁用；未选 → 对话模型可用 */
  const chatDisabled = isCodeMode && !!openCodeModel;
  const hasOCModels = openCodeModels.length > 0;

  // 自动调整高度
  useEffect(() => {
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 240) + "px";
    }
  }, [input]);

  // 自动聚焦
  useEffect(() => {
    if (!disabled) textareaRef.current?.focus();
  }, [disabled]);

  // 点击外部关闭下拉
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (cmDropdownRef.current && !cmDropdownRef.current.contains(e.target as Node)) {
        setShowCMDropdown(false);
      }
      if (ocDropdownRef.current && !ocDropdownRef.current.contains(e.target as Node)) {
        setShowOCDropdown(false);
        setCustomOCInput(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleSend = () => {
    if (!input.trim() || disabled) return;
    onSend(input.trim());
    setInput("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const hasInput = input.trim().length > 0;
  const modelLabel = activeConfig?.name || activeConfig?.model || "未配置";

  /** 当前显示的 OpenCode 模型标签 */
  const ocLabel = openCodeModel || "OpenCode: --";

  /** 选择 OpenCode 模型 */
  const handleSelectOC = (model: string) => {
    onSwitchOpenCodeModel?.(model);
    setShowOCDropdown(false);
    setCustomOCInput(false);
  };

  /** 手动输入模型 */
  const handleManualOC = () => {
    if (customOCValue.trim()) {
      onSwitchOpenCodeModel?.(customOCValue.trim());
    }
    setCustomOCInput(false);
    setShowOCDropdown(false);
  };

  return (
    <div className="input-container flex-col items-stretch gap-0 p-0">
      {/* ===== 文本输入区 ===== */}
      <div className="flex items-start px-4 pt-3 pb-1">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={1}
          disabled={disabled}
          className="flex-1 resize-none bg-transparent text-sm
                     text-content dark:text-content-dark
                     placeholder:text-content-tertiary dark:placeholder:text-content-tertiary-dark
                     outline-none py-1 min-h-[44px] max-h-[240px]
                     disabled:cursor-not-allowed disabled:opacity-50"
        />
      </div>

      {/* ===== 底部操作区 ===== */}
      <div className="flex items-center justify-between px-3 pb-2.5 pt-1">
        <div />

        <div className="flex items-center gap-1.5">
          {/* ---- 对话模型选择器（选中 OC 模型时禁用） ---- */}
          <div className="relative" ref={cmDropdownRef}>
            <button
              onClick={() => !chatDisabled && setShowCMDropdown(!showCMDropdown)}
              disabled={disabled || chatDisabled}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium
                         transition-all duration-150 border
                         disabled:cursor-not-allowed
                         ${chatDisabled
                           ? "bg-black/[0.03] dark:bg-white/[0.05] text-content-tertiary dark:text-content-tertiary-dark border-transparent opacity-60"
                           : "bg-accent/10 dark:bg-accent/10 hover:bg-accent/20 dark:hover:bg-accent/20 text-accent border-accent/20 dark:border-accent/20"
                         }`}
              title={chatDisabled ? "已选择 OpenCode 模型，对话模型暂时禁用" : "切换对话模型"}
            >
              {chatDisabled && <Lock size={11} className="shrink-0" />}
              <span className="max-w-[80px] truncate">{modelLabel}</span>
              {!chatDisabled && <ChevronDown size={12} className="shrink-0" />}
            </button>

            {showCMDropdown && modelConfigs.length > 0 && (
              <div className="absolute bottom-full right-0 mb-1.5 w-56
                              bg-surface-secondary dark:bg-surface-secondary-dark
                              border border-border dark:border-border-dark
                              rounded-xl shadow-elevated overflow-hidden z-50 animate-fade-in">
                <div className="px-3 py-2 text-xs font-medium text-content-tertiary dark:text-content-tertiary-dark border-b border-border dark:border-border-dark">
                  对话模型
                </div>
                <div className="max-h-[200px] overflow-y-auto py-1">
                  {modelConfigs.map((cfg) => (
                    <button
                      key={cfg.id}
                      onClick={() => { onSwitchModel?.(cfg.id); setShowCMDropdown(false); }}
                      className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition-all duration-100
                        ${cfg.id === activeConfig?.id
                          ? "bg-accent/10 text-accent font-medium"
                          : "text-content dark:text-content-dark hover:bg-black/[0.03] dark:hover:bg-white/[0.03]"
                        }`}
                    >
                      <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${cfg.id === activeConfig?.id ? "bg-accent" : "bg-transparent"}`} />
                      <div className="flex-1 min-w-0">
                        <div className="truncate">{cfg.name}</div>
                        <div className="text-xs text-content-tertiary dark:text-content-tertiary-dark truncate">{cfg.model}</div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* ---- OpenCode 开发模型选择器（仅代码模式） ---- */}
          {isCodeMode && (
            <div className="relative" ref={ocDropdownRef}>
              <button
                onClick={() => setShowOCDropdown(!showOCDropdown)}
                disabled={disabled}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium
                           bg-emerald-50 dark:bg-emerald-900/20
                           hover:bg-emerald-100 dark:hover:bg-emerald-900/30
                           text-emerald-700 dark:text-emerald-400
                           border border-emerald-200 dark:border-emerald-800/30
                           transition-all duration-150
                           disabled:opacity-50 disabled:cursor-not-allowed"
                title="选择 OpenCode 执行模型"
              >
                <Cpu size={12} className="shrink-0" />
                <span className="max-w-[100px] truncate">{ocLabel}</span>
                <ChevronDown size={12} className="shrink-0" />
              </button>

              {showOCDropdown && (
                <div className="absolute bottom-full right-0 mb-1.5 w-64
                                bg-surface-secondary dark:bg-surface-secondary-dark
                                border border-border dark:border-border-dark
                                rounded-xl shadow-elevated overflow-hidden z-50 animate-fade-in">
                  <div className="px-3 py-2 text-xs font-medium text-content-tertiary dark:text-content-tertiary-dark border-b border-border dark:border-border-dark">
                    OpenCode 执行模型
                  </div>
                  <div className="max-h-[220px] overflow-y-auto py-1">
                    {/* 默认：不指定模型 */}
                    <button
                      onClick={() => handleSelectOC("")}
                      className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition-all duration-100
                        ${!openCodeModel
                          ? "bg-accent/10 text-accent font-medium"
                          : "text-content dark:text-content-dark hover:bg-black/[0.03] dark:hover:bg-white/[0.03]"
                        }`}
                    >
                      <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${!openCodeModel ? "bg-accent" : "bg-transparent"}`} />
                      <div className="flex-1 min-w-0">
                        <div className="truncate">OpenCode: --</div>
                        <div className="text-xs text-content-tertiary dark:text-content-tertiary-dark">使用 CLI 默认模型</div>
                      </div>
                    </button>

                    {/* 从配置读取的模型列表 */}
                    {hasOCModels && openCodeModels.map((m) => (
                      <button
                        key={m.name}
                        onClick={() => handleSelectOC(m.name)}
                        className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition-all duration-100
                          ${openCodeModel === m.name
                            ? "bg-accent/10 text-accent font-medium"
                            : "text-content dark:text-content-dark hover:bg-black/[0.03] dark:hover:bg-white/[0.03]"
                          }`}
                      >
                        <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${openCodeModel === m.name ? "bg-accent" : "bg-transparent"}`} />
                        <div className="flex-1 min-w-0">
                          <div className="truncate">{m.name}</div>
                          {m.provider && (
                            <div className="text-xs text-content-tertiary dark:text-content-tertiary-dark truncate">{m.provider}</div>
                          )}
                        </div>
                      </button>
                    ))}

                    {/* 手动输入分隔线 */}
                    <div className="border-t border-border dark:border-border-dark my-1" />

                    {/* 手动输入模式 */}
                    {!customOCInput ? (
                      <button
                        onClick={() => setCustomOCInput(true)}
                        className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left
                                   text-content-secondary dark:text-content-secondary-dark
                                   hover:bg-black/[0.03] dark:hover:bg-white/[0.03]
                                   transition-all duration-100"
                      >
                        <Cpu size={13} />
                        <span>手动输入模型名称...</span>
                      </button>
                    ) : (
                      <div className="px-3 py-2">
                        <div className="flex gap-1.5">
                          <input
                            ref={manualInputRef}
                            type="text"
                            value={customOCValue}
                            onChange={(e) => setCustomOCValue(e.target.value)}
                            placeholder="输入模型名如 gpt-4o"
                            className="flex-1 px-2 py-1.5 text-xs rounded-lg
                                       bg-black/[0.04] dark:bg-white/[0.06]
                                       border border-border dark:border-border-dark
                                       text-content dark:text-content-dark
                                       placeholder:text-content-tertiary
                                       focus:outline-none focus:border-accent/40
                                       transition-all duration-150"
                            autoFocus
                            onKeyDown={(e) => {
                              if (e.key === "Enter") handleManualOC();
                            }}
                          />
                          <button
                            onClick={handleManualOC}
                            disabled={!customOCValue.trim()}
                            className="px-2 py-1 text-xs font-medium rounded-lg
                                       bg-accent text-white
                                       hover:bg-accent-hover
                                       disabled:opacity-50 disabled:cursor-not-allowed
                                       transition-all duration-150"
                          >
                            确定
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ---- 发送按钮 ---- */}
          <button
            onClick={handleSend}
            disabled={disabled || !hasInput}
            className="send-btn"
            title="发送 (Enter)"
          >
            <ArrowUp size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}

export default MessageInput;
