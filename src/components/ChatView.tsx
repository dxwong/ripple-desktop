import { useRef, useEffect, useState, useCallback } from "react";
import { Sparkles, FolderOpen, Code, MessageCircle, Minus, Square, Maximize2, X } from "lucide-react";
import ChatMessage from "./ChatMessage";
import MessageInput from "./MessageInput";
import { ToolConfirmBanner } from "./ToolConfirmBanner";
import { Message, ModelConfig, ChatMode, ToolRequestData, PermissionMode, PERMISSION_MODES, UsageStats, AccountBalance, ConversationUsage } from "../types";
import { isTauri } from "../hooks/useTauri";
import { fetchStatsSummary, fetchAccountBalance } from "../services/api";

interface ChatViewProps {
  conversationId: string;
  messages: Message[];
  onSendMessage: (content: string) => void;
  isProcessing: boolean;
  /** 停止 AI 处理的回调 */
  onStop?: () => void;
  darkMode?: boolean;
  activeConfig?: ModelConfig;
  modelConfigs?: ModelConfig[];
  onSwitchModel?: (id: string) => void;
  /** 当前会话模式 */
  chatMode?: ChatMode;
  /** 当前项目目录（有值表示是项目对话） */
  cwd?: string;
  /** 后端连接状态 */
  backendConnected?: boolean;
  /** 后端可用模型列表 */
  backendModels?: { id: string; name: string }[];
  /** 待确认的工具请求 */
  pendingToolRequests?: ToolRequestData[];
  /** 确认/拒绝工具执行 */
  onToolConfirm?: (toolCallId: string, approved: boolean, reason?: string) => void;
  /** 当前权限模式 */
  permissionMode?: PermissionMode;
  /** 切换权限模式 */
  onPermissionModeChange?: (mode: PermissionMode) => void;
  /** EditBlock 应用成功回调 */
  onEditBlockApply?: (messageId: string, cleanContent: string, appliedCount: number) => void;
  /** 回滚到指定用户消息（撤销后续 AI 操作） */
  onRollbackToSnapshot?: (messageId: string) => void;
  /** 按对话累积使用统计（key = conversationId） */
  conversationUsageMap?: Record<string, ConversationUsage>;
}

function TypingIndicator() {
  return (
    <div className="flex gap-3 animate-fade-in">
      <div className="shrink-0 w-7 h-7 rounded-xl bg-content dark:bg-content-dark flex items-center justify-center">
        <Sparkles size={14} className="text-surface dark:text-surface-dark" />
      </div>
      <div className="flex items-center gap-2 px-4 py-3 rounded-2xl bg-message-ai dark:bg-message-ai-dark">
        <div className="flex items-center gap-1">
          {[0, 200, 400].map((delay) => (
            <div
              key={delay}
              className="w-2 h-2 rounded-full bg-accent/60"
              style={{
                animation: `typing-bounce 1.2s ease-in-out infinite`,
                animationDelay: `${delay}ms`,
              }}
            />
          ))}
        </div>
        <span className="text-xs text-content-tertiary dark:text-content-tertiary-dark ml-1">
          AI 思考中...
        </span>
      </div>
    </div>
  );
}

function getStreamingIndex(messages: Message[], isProcessing: boolean): number {
  if (!isProcessing || messages.length === 0) return -1;
  const last = messages[messages.length - 1];
  // 只要有内容（文本或思考）就显示 ChatMessage，让思考内容可见
  if (last.role === "assistant" && (last.content.length > 0 || last.thinking)) {
    return messages.length - 1;
  }
  return -1;
}

/** 窗口控制按钮（仅 Tauri 环境显示） */
function WindowControls() {
  const [isMaximized, setIsMaximized] = useState(false);
  const inTauri = isTauri();

  useEffect(() => {
    if (!inTauri) return;
    (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        const unlisten = await win.onResized(() => {
          win.isMaximized().then(setIsMaximized);
        });
        win.isMaximized().then(setIsMaximized);
        return () => unlisten();
      } catch (e) {
        console.warn("Tauri 窗口 API 不可用:", e);
      }
    })();
  }, [inTauri]);

  if (!inTauri) return null;

  const handleMinimize = async () => {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    getCurrentWindow().minimize();
  };

  const handleMaximize = async () => {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    getCurrentWindow().toggleMaximize();
  };

  const handleClose = async () => {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    getCurrentWindow().close();
  };

  return (
    <div className="titlebar-no-drag flex items-center gap-0.5">
      <button onClick={handleMinimize} className="icon-btn !rounded-none hover:bg-black/5 dark:hover:bg-white/5" title="最小化">
        <Minus size={12} />
      </button>
      <button onClick={handleMaximize} className="icon-btn !rounded-none hover:bg-black/5 dark:hover:bg-white/5" title={isMaximized ? "还原" : "最大化"}>
        {isMaximized ? <Maximize2 size={11} /> : <Square size={11} />}
      </button>
      <button onClick={handleClose} className="icon-btn !rounded-none hover:bg-red-500 hover:text-white ml-0.5" title="关闭">
        <X size={12} />
      </button>
    </div>
  );
}

function ChatView({
  conversationId,
  messages,
  onSendMessage,
  isProcessing,
  onStop,
  darkMode = true,
  activeConfig,
  modelConfigs,
  onSwitchModel,
  chatMode = "chat",
  cwd,
  backendConnected = false,
  backendModels,
  pendingToolRequests = [],
  onToolConfirm,
  permissionMode = "confirm",
  onPermissionModeChange,
  onEditBlockApply,
  onRollbackToSnapshot,
  conversationUsageMap = {},
}: ChatViewProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const isEmpty = messages.length === 0;

  // ===== 从 conversationUsageMap 获取当前对话的累计用量 =====
  const currentConvUsage: ConversationUsage = (conversationUsageMap ?? {})[conversationId] || { input: 0, output: 0, totalTokens: 0, cost: 0 };

  // ===== 使用统计实时展示 =====
  const [usageStats, setUsageStats] = useState<UsageStats | null>(null);
  const [accountBalance, setAccountBalance] = useState<AccountBalance | null>(null);
  const statsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const balanceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 后端连接时轮询统计和余额
  useEffect(() => {
    if (!backendConnected) {
      setUsageStats(null);
      setAccountBalance(null);
      return;
    }

    const fetchStats = async () => {
      const result = await fetchStatsSummary();
      if (result.data) setUsageStats(result.data);
    };

    // 只在有 API Key 时才轮询余额（避免无效请求）
    const shouldFetchBalance = !!activeConfig?.apiKey;
    const fetchBalance = async () => {
      if (!shouldFetchBalance) return;
      const result = await fetchAccountBalance(activeConfig.apiKey, activeConfig.endpoint);
      if (result.data) setAccountBalance(result.data);
    };

    // 立即执行一次
    fetchStats();
    if (shouldFetchBalance) fetchBalance();

    // 每 10 秒轮询统计
    statsTimerRef.current = setInterval(fetchStats, 10000);
    // 每 60 秒轮询余额（仅在有关键时）
    if (shouldFetchBalance) {
      balanceTimerRef.current = setInterval(fetchBalance, 60000);
    }

    return () => {
      if (statsTimerRef.current) clearInterval(statsTimerRef.current);
      if (balanceTimerRef.current) clearInterval(balanceTimerRef.current);
    };
  }, [backendConnected, activeConfig?.apiKey, activeConfig?.endpoint]);

  const streamingIdx = getStreamingIndex(messages, isProcessing);
  const shouldShowTyping = isProcessing && streamingIdx === -1;

  // 重新生成：找到对应 AI 消息的前一条用户消息，重新发送
  const handleRegenerate = useCallback((msgIdx: number) => {
    if (isProcessing) return;
    // 向前查找用户消息
    for (let i = msgIdx - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        onSendMessage(messages[i].content);
        break;
      }
    }
  }, [isProcessing, messages, onSendMessage]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isProcessing]);

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-x-hidden">
      {/* ===== 顶部栏：窗口拖拽 + 会话信息 + 窗口控制 ===== */}
      <div className="titlebar-drag flex items-center gap-3 px-3 h-9 bg-surface-secondary dark:bg-surface-secondary-dark border-b border-border dark:border-border-dark shrink-0">
        {/* 左侧：会话模式/项目目录 — 始终显示 */}
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {(chatMode === "code" || cwd) ? (
            <div className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400 font-medium shrink-0">
              <Code size={13} />
              <span>编程开发</span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 text-xs text-content-secondary dark:text-content-secondary-dark font-medium shrink-0">
              <MessageCircle size={13} />
              <span>对话</span>
            </div>
          )}
          {cwd && (
            <>
              <span className="text-content-tertiary dark:text-content-tertiary-dark text-xs">·</span>
              <div className="flex items-center gap-1 text-xs text-content-tertiary dark:text-content-tertiary-dark truncate">
                <FolderOpen size={12} />
                <span className="truncate">{cwd}</span>
              </div>
            </>
          )}
        </div>

        {/* 右侧：后端状态 + 窗口控制按钮 */}
        <div className="flex items-center gap-2">
          {/* 后端连接状态 */}
          <div
            className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-medium transition-all duration-150 ${
              backendConnected
                ? "bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400"
                : "bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400"
            }`}
            title={backendConnected ? "已连接后端服务" : "未连接后端服务，使用模拟模式"}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${
              backendConnected ? "bg-emerald-500" : "bg-amber-500"
            }`} />
            <span>{backendConnected ? "已连接" : "模拟"}</span>
          </div>
          <WindowControls />
        </div>
      </div>

      {/* ===== 会话信息栏（项目对话但没有目录时的提示） ===== */}
      {chatMode === "code" && !cwd && (
        <div className="px-4 py-1.5 bg-amber-50/50 dark:bg-amber-900/10 border-b border-border dark:border-border-dark">
          <div className="max-w-5xl mx-auto flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400">
            <MessageCircle size={12} />
            <span>编程模式 · 请先在侧边栏选择项目目录</span>
          </div>
        </div>
      )}

      {/* ===== 消息区域 ===== */}
      <div className="flex-1 overflow-y-auto scroll-anchor">
        <div key={conversationId} className="max-w-5xl mx-auto px-2 py-6 animate-slide-up min-w-0">
          {isEmpty ? (
            <div className="flex flex-col items-center justify-center h-full min-h-[60vh] text-center animate-fade-in">
              <div className="relative mb-6">
                <div className="w-16 h-16 rounded-2xl bg-accent/10 dark:bg-accent/10 flex items-center justify-center">
                  {(chatMode === "code" || cwd) ? (
                    <Code size={28} className="text-amber-500" />
                  ) : (
                    <Sparkles size={28} className="text-accent" />
                  )}
                </div>
                <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-accent/20 animate-pulse" />
              </div>

              <h2 className="text-xl font-semibold mb-2">
                {(chatMode === "code" || cwd) ? "开始编程开发" : "开始新的对话"}
              </h2>
              <p className="text-base text-content-secondary dark:text-content-secondary-dark max-w-sm leading-relaxed">
                {chatMode === "code"
                  ? "在当前项目目录中执行代码操作。输入你的需求，我会帮你处理。"
                  : "输入你的问题，Ripple 将为你提供 AI 辅助编程帮助。"}
                {chatMode === "code" && !cwd && (
                  <span className="block mt-1 text-blue-500 dark:text-blue-400">
                    ℹ️ 请先设置项目目录以启用完整功能
                  </span>
                )}
              </p>

              <div className="mt-6 grid grid-cols-2 gap-2 w-full max-w-sm">
                {((chatMode === "code" || cwd)
                  ? [
                      { label: "初始化项目", desc: "创建项目结构" },
                      { label: "生成代码", desc: "根据需求编写" },
                      { label: "代码审查", desc: "检查代码质量" },
                      { label: "运行测试", desc: "执行测试用例" },
                    ]
                  : [
                      { label: "生成一段代码", desc: "TypeScript 示例" },
                      { label: "解释代码逻辑", desc: "代码分析" },
                      { label: "优化建议", desc: "重构优化" },
                      { label: "调试帮助", desc: "Bug 排查" },
                    ]).map((suggestion) => (
                      <button
                        key={suggestion.label}
                        onClick={() => onSendMessage(suggestion.label)}
                        className="text-left p-3 rounded-xl border border-border dark:border-border-dark
                                hover:bg-surface dark:hover:bg-surface-dark
                                active:scale-[0.98] transition-all duration-150"
                      >
                        <div className="text-sm font-medium mb-0.5">
                          {suggestion.label}
                        </div>
                        <div className="text-xs text-content-tertiary dark:text-content-tertiary-dark">
                          {suggestion.desc}
                        </div>
                      </button>
                    ))}
              </div>
            </div>
          ) : (
            <div className="space-y-5">
              {messages.map((msg, index) => (
                <ChatMessage
                  key={msg.id}
                  message={msg}
                  isStreaming={index === streamingIdx}
                  darkMode={darkMode}
                  onEditBlockApply={onEditBlockApply}
                  onRegenerate={msg.role === "assistant" ? () => handleRegenerate(index) : undefined}
                  onRollback={msg.role === "user" ? () => onRollbackToSnapshot?.(msg.id) : undefined}
                />
              ))}
            </div>
          )}

          {shouldShowTyping && <TypingIndicator />}

          <div ref={messagesEndRef} />
        </div>
      </div>

      <div className="px-4 pb-3 pt-1">
        <div className="max-w-5xl mx-auto">
          {/* 工具确认横幅 — 输入框上方靠右 */}
          {pendingToolRequests.length > 0 && onToolConfirm && permissionMode !== "auto" && (
            <div className="flex justify-end mb-2">
              <ToolConfirmBanner
                requests={pendingToolRequests}
                onConfirm={onToolConfirm}
              />
            </div>
          )}
          {/* 权限模式切换按钮 — 弹窗时隐藏 */}
          {!(pendingToolRequests.length > 0 && permissionMode !== "auto") && (
          <div className="flex justify-end mb-1.5">
            <button
              onClick={() => {
                // 循环切换三种模式
                const modes: PermissionMode[] = ["auto", "confirm", "read-only"];
                const currentIndex = modes.indexOf(permissionMode);
                const nextMode = modes[(currentIndex + 1) % modes.length];
                onPermissionModeChange?.(nextMode);
              }}
              className={`group relative flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium transition-all duration-200 ${
                permissionMode === "auto"
                  ? "bg-accent/20 text-accent hover:bg-accent/30 shadow-[0_0_6px_rgba(217,119,87,0.4)]"
                  : permissionMode === "read-only"
                  ? "bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 hover:bg-blue-150"
                  : "bg-message-ai dark:bg-message-ai-dark text-content-tertiary hover:text-content-secondary"
              }`}
            >
              <span className={`w-2 h-2 rounded-full transition-all duration-200 ${
                permissionMode === "auto"
                  ? "bg-accent shadow-[0_0_4px_rgba(217,119,87,0.5)]"
                  : permissionMode === "read-only"
                  ? "bg-blue-500"
                  : "bg-content-tertiary"
              }`} />
              <span>{permissionMode === "auto" ? "Auto" : permissionMode === "read-only" ? "只读" : "确认"}</span>
              {/* Tooltip */}
              <div className="absolute -top-20 right-0 px-2 py-1.5 rounded-lg bg-surface dark:bg-surface-dark border border-border dark:border-border-dark text-[10px] whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none shadow-xl">
                <div className="font-medium text-content-secondary mb-1">点击切换权限模式</div>
                <div className="space-y-0.5">
                  {PERMISSION_MODES.map((mode) => (
                    <div key={mode.value} className={`flex items-center gap-1.5 ${
                      permissionMode === mode.value ? "text-accent" : "text-content-tertiary"
                    }`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${
                        permissionMode === mode.value
                          ? "bg-accent"
                          : "bg-content-tertiary"
                      }`} />
                      <span>{mode.label}: {mode.description}</span>
                    </div>
                  ))}
                </div>
              </div>
            </button>
          </div>
          )}
          <MessageInput
            onSend={onSendMessage}
            disabled={isProcessing}
            isProcessing={isProcessing}
            onStop={onStop}
            activeConfig={activeConfig}
            modelConfigs={modelConfigs}
            onSwitchModel={onSwitchModel}
            chatMode={chatMode}
            hasProject={!!cwd}
            placeholder={
              isProcessing
                ? "AI 正在回复... 点击停止按钮可中断"
                : chatMode === "code" || cwd
                ? "输入编程指令..."
                : "输入消息..."
            }
          />
          <div className="flex items-center justify-between mt-2 px-1">
            {/* 左侧：使用统计实时指标 */}
            <div className="flex items-center gap-3 text-[11px] text-content-tertiary dark:text-content-tertiary-dark">
              {/* 缓存命中率 */}
              <span className="flex items-center gap-1" title="缓存命中率">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                缓存 {usageStats ? `${(usageStats.cache?.hitRate ?? 0).toFixed(1)}%` : '--'}
              </span>
              {/* 账户余额 */}
              <span className="flex items-center gap-1" title="账户余额（仅 DeepSeek 支持查询）">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                余额 {!accountBalance
                  ? '--'
                  : !accountBalance.available
                    ? '不支持'
                    : accountBalance.success && accountBalance.balance != null
                      ? `${accountBalance.balance.toFixed(2)} ${accountBalance.currency || 'CNY'}`
                      : accountBalance.error
                        ? '查询失败'
                        : '--'}
              </span>
              {/* 当前对话成本 */}
              <span className="flex items-center gap-1" title="当前对话消耗的 token 预估费用">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                对话成本 ¥{currentConvUsage.cost > 0 ? currentConvUsage.cost.toFixed(4) : '--'}
              </span>
              {/* 上下文 token */}
              <span className="flex items-center gap-1" title="当前对话累积上下文 token">
                <span className="w-1.5 h-1.5 rounded-full bg-purple-400" />
                上下文 {currentConvUsage.totalTokens > 0 ? currentConvUsage.totalTokens.toLocaleString() : (usageStats?.contextTokens ? usageStats.contextTokens.toLocaleString() : '--')} tokens
              </span>
            </div>
            {/* 右侧：模型信息 */}
            <div className="flex items-center gap-2 text-[11px] text-content-tertiary dark:text-content-tertiary-dark">
              {activeConfig && (
                <span>{activeConfig.model}</span>
              )}
              {chatMode === "code" && (
                <span className="text-amber-500 dark:text-amber-400 font-medium">· 开发模式</span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default ChatView;
