import { useState, useRef, useEffect } from "react";
import { ArrowUp, ChevronDown, Square } from "lucide-react";
import type { ModelConfig, ChatMode, ActiveModelConfig } from "../types";

/**
 * v2.1: modelEntries 数据源（id 形如 "provider::model"）
 * 来自 MainApp 拼装的"已启用 provider + 启用 model"列表
 */
interface ModelEntry {
  id: string;
  name: string;
  model: string;
  provider: string;
}

interface MessageInputProps {
  onSend: (content: string) => void;
  disabled?: boolean;
  /** AI 是否正在处理中（显示停止按钮） */
  isProcessing?: boolean;
  /** 停止处理回调 */
  onStop?: () => void;
  placeholder?: string;
  /** 当前激活的对话模型配置（v2.1: ActiveModelConfig 优先；v2.0: ModelConfig 也兼容） */
  activeConfig?: ModelConfig | ActiveModelConfig;
  /** v2.0 风格：所有已保存的对话模型配置列表 */
  modelConfigs?: ModelConfig[];
  /** v2.0 风格：切换对话模型 */
  onSwitchModel?: (id: string) => void;
  /** v2.1 风格：模型条目列表（id 形如 "provider::model"） */
  modelEntries?: ModelEntry[];
  /** v2.1 风格：切换模型条目 */
  onSwitchModelEntry?: (id: string) => void;
  /** 当前会话模式 */
  chatMode?: ChatMode;
  /** 是否有关联项目 */
  hasProject?: boolean;
}

/**
 * 消息输入框组件（v2.0 baseline + v2.1 modelEntries 适配）
 *
 * UI 与 v2.0 一致：textarea + 右下"模型选择器 + 发送/停止"
 * 数据源支持两种：
 *   - v2.0: modelConfigs: ModelConfig[] + onSwitchModel(id)
 *   - v2.1: modelEntries: {id,name,model,provider}[] + onSwitchModelEntry(id)
 * 同时存在时优先使用 v2.1
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
  modelEntries,
  onSwitchModelEntry,
  chatMode = "chat",
  hasProject = false,
}: MessageInputProps) {
  const [input, setInput] = useState("");
  const [showCMDropdown, setShowCMDropdown] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const cmDropdownRef = useRef<HTMLDivElement>(null);

  const isCodeMode = chatMode === "code" || hasProject;

  // v2.1 优先使用 modelEntries；回退 v2.0 modelConfigs
  const useV21 = !!modelEntries && modelEntries.length > 0;
  const entryList = useV21 ? modelEntries! : [];

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

  // 模型按钮显示文本：v2.1 ActiveModelConfig 是 "name · model"；v2.0 ModelConfig 是 "name"
  const modelLabel = useV21
    ? (activeConfig?.name
        ? `${(activeConfig as ActiveModelConfig).name} · ${(activeConfig as ActiveModelConfig).model}`
        : (activeConfig as ActiveModelConfig)?.model || "未配置")
    : (activeConfig?.name || activeConfig?.model || "未配置");

  // 当前激活条目 id（v2.1 风格）
  const activeEntryId = useV21 && activeConfig
    ? `${(activeConfig as ActiveModelConfig).provider}::${(activeConfig as ActiveModelConfig).model}`
    : "";

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

            {showCMDropdown && (useV21 ? entryList.length > 0 : modelConfigs.length > 0) && (
              <div className="absolute bottom-full right-0 mb-1.5 w-56
                              bg-surface-secondary dark:bg-surface-secondary-dark
                              border border-border dark:border-border-dark
                              rounded-xl shadow-elevated overflow-hidden z-50 animate-fade-in">
                <div className="px-3 py-2 text-xs font-medium text-content-tertiary dark:text-content-tertiary-dark border-b border-border dark:border-border-dark">
                  对话模型
                </div>
                <div className="max-h-[200px] overflow-y-auto py-1">
                  {useV21
                    ? entryList.map((entry) => {
                        const isActive = entry.id === activeEntryId;
                        return (
                          <button
                            key={entry.id}
                            onClick={() => { onSwitchModelEntry?.(entry.id); setShowCMDropdown(false); }}
                            className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition-all duration-100
                              ${isActive
                                ? "bg-accent/10 text-accent font-medium"
                                : "text-content dark:text-content-dark hover:bg-black/[0.03] dark:hover:bg-white/[0.03]"
                              }`}
                          >
                            <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${isActive ? "bg-accent" : "bg-transparent"}`} />
                            <div className="flex-1 min-w-0">
                              <div className="truncate">{entry.name}</div>
                              <div className="text-xs text-content-tertiary dark:text-content-tertiary-dark truncate">{entry.model}</div>
                            </div>
                          </button>
                        );
                      })
                    : modelConfigs.map((cfg) => {
                        // v2.0 ModelConfig 有 id 字段；v2.1 ActiveModelConfig 没有 id
                        const activeIsV20 = activeConfig && "id" in activeConfig;
                        const isActive = activeIsV20 && (activeConfig as ModelConfig).id === cfg.id;
                        return (
                        <button
                          key={cfg.id}
                          onClick={() => { onSwitchModel?.(cfg.id); setShowCMDropdown(false); }}
                          className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition-all duration-100
                            ${isActive
                              ? "bg-accent/10 text-accent font-medium"
                              : "text-content dark:text-content-dark hover:bg-black/[0.03] dark:hover:bg-white/[0.03]"
                            }`}
                        >
                          <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${isActive ? "bg-accent" : "bg-transparent"}`} />
                          <div className="flex-1 min-w-0">
                            <div className="truncate">{cfg.name}</div>
                            <div className="text-xs text-content-tertiary dark:text-content-tertiary-dark truncate">{cfg.model}</div>
                          </div>
                        </button>
                        );
                      })
                  }
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
              title="发送"
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
