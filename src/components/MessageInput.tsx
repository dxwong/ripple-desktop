import { useState, useRef, useEffect } from "react";
import { ArrowUp, Square, Paperclip, AtSign } from "lucide-react";
import type { ChatMode, ActiveModelConfig, PermissionMode, AccountBalance } from "../types";
import PermissionSelectDropdown from "./PermissionSelectDropdown";
import ModelSelectDropdown from "./ModelSelectDropdown";
import ContextUsagePopover from "./ContextUsagePopover";
import { useMediaQuery } from "../hooks/useMediaQuery";

/**
 * v2.2: 扩展 ModelEntry，添加 logo/tags/supportedPermissions 可选字段
 * MainApp 拼装 modelEntries 时填好；老调用方不填也能降级使用
 */
export interface ModelEntry {
  id: string;
  name: string;
  model: string;
  provider: string;
  /** Provider 主题色（CSS 渐变字符串或 class） */
  logo?: string;
  /** 标签徽章（如 "推荐" / "推理" / "快速"） */
  tags?: string[];
  /** 该模型支持的 permissionMode，undefined 表示全部支持 */
  supportedPermissions?: PermissionMode[];
}

interface MessageInputProps {
  onSend: (content: string) => void;
  disabled?: boolean;
  /** AI 是否正在处理中（显示停止按钮） */
  isProcessing?: boolean;
  /** 停止处理回调 */
  onStop?: () => void;
  placeholder?: string;
  /** 当前激活的对话模型配置 */
  activeConfig?: ActiveModelConfig;
  /** 模型条目列表（id 形如 "provider::model"） */
  modelEntries?: ModelEntry[];
  /** 切换模型条目 */
  onSwitchModelEntry?: (id: string) => void;
  /** 当前会话模式 */
  chatMode?: ChatMode;

  // v2.2 新增：权限模式（来自 settings.permissionMode）
  permissionMode?: PermissionMode;
  onPermissionModeChange?: (mode: PermissionMode) => void;

  // v2.2 新增：上下文统计（来自 ChatView 现有 state）
  cacheHitRate?: number | null;
  balance?: AccountBalance | null;
  estimatedCost?: number;
  contextTokens?: number;
  // v2.3 新增：上下文三分拆 + 窗口大小
  contextWindowSize?: number;
  textTokens?: number;
  toolTokens?: number;
  systemTokens?: number;
  // v1.1 新增：会话 ID（用于 ContextUsagePopover 内的"压缩"按钮）
  sessionId?: string;
  // v1.1.2 新增：压缩阈值（百分比），透传给 ContextUsagePopover
  compactionThreshold?: number;
}

/**
 * 消息输入框组件（v2.2）
 *
 * UI：textarea + 底部 toolbar（权限 / 模型 / 附件 / @ / 上下文 / 发送）
 * 数据源：modelEntries（v2.1 格式）+ 真实 chatContext 统计
 *
 * 设计参考 `plans/desktop/desktop-input-redesign.md`：
 *   - 权限下拉 3 选 1（含"Plan 模式"=read-only）
 *   - 模型下拉彩色 logo
 *   - 上下文按钮 hover popover（**无压缩按钮**，避免"假成功"）
 */
function MessageInput({
  onSend,
  disabled = false,
  isProcessing = false,
  onStop,
  placeholder = "输入消息...",
  activeConfig,
  modelEntries,
  onSwitchModelEntry,
  chatMode = "chat",
  permissionMode = "confirm",
  onPermissionModeChange,
  cacheHitRate = null,
  balance = null,
  estimatedCost = 0,
  contextTokens = 0,
  contextWindowSize,
  textTokens,
  toolTokens,
  systemTokens,
  // v1.1 新增
  sessionId,
  // v1.1.2 新增
  compactionThreshold = 15,
}: MessageInputProps) {
  // ★ 关键修复：mobile 视口下启用 compact 模式，避免 toolbar 内容溢出
  // 把 send-btn 推出视口。mobile 下隐藏占位按钮（附件/@），permission 用
  // compact 模式只显示图标，model 走 truncate 截断。
  const isMobile = useMediaQuery("(max-width: 640px)");

  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  const entryList = modelEntries ?? [];

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
      {/* flex-wrap：极端窄屏下（如 320px）允许左侧内容换行，避免右侧 send-btn 被裁 */}
      <div className="flex items-center justify-between gap-1.5 flex-wrap px-3 pb-2.5 pt-1">
        {/* 左侧：权限 + 模型 */}
        <div className="flex items-center gap-1 min-w-0 flex-1">
          {/* v2.2: 权限下拉（含"Plan 模式"=read-only）
              mobile 下用 compact 模式只显示图标，省 ~80px 横向空间 */}
          {onPermissionModeChange && (
            <PermissionSelectDropdown
              value={permissionMode}
              onChange={onPermissionModeChange}
              disabled={disabled}
              compact={isMobile}
            />
          )}

          {/* v2.2: 模型下拉（彩色 logo 替代旧的内联实现）
              mobile 下用 compact 模式只显示 provider logo，省 ~120px 横向空间 */}
          {onSwitchModelEntry && (
            <ModelSelectDropdown
              activeConfig={activeConfig}
              entries={entryList}
              onSwitch={onSwitchModelEntry}
              disabled={disabled}
              compact={isMobile}
            />
          )}

          {/* 占位：附件 / @ 按钮（保留入口，TODO 接入）
              ★ mobile 隐藏：这两个按钮是 disabled 占位，mobile 视口下隐藏避免挤压
              send-btn 空间，导致发送按钮被推出视口。 */}
          {!isMobile && (
            <>
              <button
                type="button"
                disabled
                title="附件 (即将推出)"
                className="inline-flex items-center justify-center w-7 h-7 rounded-md
                           text-content-tertiary dark:text-content-tertiary-dark
                           opacity-40 cursor-not-allowed"
              >
                <Paperclip className="h-3.5 w-3.5" strokeWidth={1.75} />
              </button>
              <button
                type="button"
                disabled
                title="@ 文件 (即将推出)"
                className="inline-flex items-center justify-center w-7 h-7 rounded-md
                           text-content-tertiary dark:text-content-tertiary-dark
                           opacity-40 cursor-not-allowed"
              >
                <AtSign className="h-3.5 w-3.5" strokeWidth={1.75} />
              </button>
            </>
          )}
        </div>

        {/* 右侧：上下文 + 发送
            ★ shrink-0：流式输出代码块暴增时，发送按钮始终可见不压缩。
            这两个元素（popover + send-btn）必须保留，缺一不可。 */}
        <div className="flex items-center gap-1.5 shrink-0">
          {/* v2.2: 上下文 popover（v1.1 集成"压缩"按钮 + 双色进度条 + v1.1.2 prop 透传阈值） */}
          <ContextUsagePopover
            cacheHitRate={cacheHitRate}
            balance={balance}
            estimatedCost={estimatedCost}
            contextTokens={contextTokens}
            contextWindowSize={contextWindowSize}
            textTokens={textTokens}
            toolTokens={toolTokens}
            systemTokens={systemTokens}
            sessionId={sessionId}
            isProcessing={isProcessing}
            compactionThreshold={compactionThreshold}
          />

          {/* 发送/停止按钮 */}
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
