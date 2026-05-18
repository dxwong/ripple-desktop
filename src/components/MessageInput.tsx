import { useState, useRef, useEffect } from "react";
import { ArrowUp, ChevronDown, Square } from "lucide-react";
import type { ModelConfig, ChatMode } from "../types";

interface MessageInputProps {
  onSend: (content: string) => void;
  disabled?: boolean;
  /** AI 是否正在处理中（显示停止按钮） */
  isProcessing?: boolean;
  /** 停止处理回调 */
  onStop?: () => void;
  placeholder?: string;
  /** 当前激活的对话模型配置 */
  activeConfig?: ModelConfig;
  /** 所有已保存的对话模型配置列表 */
  modelConfigs?: ModelConfig[];
  /** 切换对话模型 */
  onSwitchModel?: (id: string) => void;
  /** 当前会话模式 */
  chatMode?: ChatMode;
  /** 是否有关联项目 */
  hasProject?: boolean;
}

/**
 * 消息输入框组件
 */
function MessageInput({
  onSend,
  disabled = false,
  isProcessing = false,
  onStop,
  placeholder = "输入消息...",
  activeConfig,
  modelConfigs = [],
  onSwitchModel,
  chatMode = "chat",
  hasProject = false,
}: MessageInputProps) {
  const [input, setInput] = useState("");
  const [showCMDropdown, setShowCMDropdown] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const cmDropdownRef = useRef<HTMLDivElement>(null);

  const isCodeMode = chatMode === "code" || hasProject;

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
          className="flex-1 resize-none bg-transparent text-sm
                     text-content dark:text-content-dark
                     placeholder:text-content-tertiary dark:placeholder:text-content-tertiary-dark
                     outline-none py-1 min-h-[44px] max-h-[240px]"
        />
      </div>

      {/* ===== 底部操作区 ===== */}
      <div className="flex items-center justify-between px-3 pb-2.5 pt-1">
        <div />

        <div className="flex items-center gap-1.5">
          {/* ---- 对话模型选择器 ---- */}
          <div className="relative" ref={cmDropdownRef}>
            <button
              onClick={() => setShowCMDropdown(!showCMDropdown)}
              disabled={disabled}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium
                         transition-all duration-150 border
                         disabled:cursor-not-allowed
                         bg-accent/10 dark:bg-accent/10 hover:bg-accent/20 dark:hover:bg-accent/20 text-accent border-accent/20 dark:border-accent/20`}
              title="切换对话模型"
            >
              <span className="max-w-[80px] truncate">{modelLabel}</span>
              <ChevronDown size={12} className="shrink-0" />
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

          {/* ---- 发送/停止按钮 ---- */}
          {isProcessing ? (
            <button
              onClick={onStop}
              className="send-btn bg-red-500 hover:bg-red-600"
              title="停止 (点击停止 AI 回复)"
            >
              <Square size={16} fill="currentColor" />
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!hasInput}
              className="send-btn"
              title="发送 (Enter)"
            >
              <ArrowUp size={18} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default MessageInput;
