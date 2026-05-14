import { useRef, useEffect, useState } from "react";
import { Sparkles, WifiOff, FolderOpen, Code, MessageCircle, Minus, Square, Maximize2, X } from "lucide-react";
import ChatMessage from "./ChatMessage";
import MessageInput from "./MessageInput";
import { Message, ModelConfig, ChatMode, Project } from "../types";
import { isTauri } from "../hooks/useTauri";

interface ChatViewProps {
  conversationId: string;
  messages: Message[];
  onSendMessage: (content: string) => void;
  isProcessing: boolean;
  bridgeStatus: string;
  bridgeError: string;
  darkMode?: boolean;
  activeConfig?: ModelConfig;
  modelConfigs?: ModelConfig[];
  onSwitchModel?: (id: string) => void;
  /** 当前会话模式 */
  chatMode?: ChatMode;
  /** 当前关联的项目 */
  project?: Project | null;
  /** OpenCode 可用模型列表 */
  openCodeModels?: { name: string; provider?: string }[];
  /** 当前选中的 OpenCode 模型 */
  openCodeModel?: string;
  /** 切换 OpenCode 模型 */
  onSwitchOpenCodeModel?: (model: string) => void;
}

function TypingIndicator() {
  return (
    <div className="flex gap-3 animate-fade-in">
      <div className="shrink-0 w-7 h-7 rounded-xl bg-content dark:bg-content-dark flex items-center justify-center">
        <Sparkles size={14} className="text-surface dark:text-surface-dark" />
      </div>
      <div className="flex items-center gap-1.5 px-4 py-3.5 rounded-2xl bg-message-ai dark:bg-message-ai-dark">
        {[0, 150, 300].map((delay) => (
          <div
            key={delay}
            className="w-1.5 h-1.5 rounded-full bg-content-tertiary dark:bg-content-tertiary-dark"
            style={{
              animation: `pulse-dot 1.4s ease-in-out infinite`,
              animationDelay: `${delay}ms`,
            }}
          />
        ))}
      </div>
    </div>
  );
}

function getStreamingIndex(messages: Message[], isProcessing: boolean): number {
  if (!isProcessing || messages.length === 0) return -1;
  const last = messages[messages.length - 1];
  if (last.role === "assistant" && last.content.length > 0) {
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
  bridgeStatus,
  bridgeError,
  darkMode = true,
  activeConfig,
  modelConfigs,
  onSwitchModel,
  chatMode = "chat",
  project,
  openCodeModels,
  openCodeModel,
  onSwitchOpenCodeModel,
}: ChatViewProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const isOnline = bridgeStatus === "connected";
  const isConnecting = bridgeStatus === "connecting";
  const isEmpty = messages.length === 0;
  const isOffline = !isOnline && !isConnecting;

  const streamingIdx = getStreamingIndex(messages, isProcessing);
  const shouldShowTyping = isProcessing && streamingIdx === -1;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isProcessing]);

  return (
    <div className="flex-1 flex flex-col min-w-0">
      {/* ===== 顶部栏：窗口拖拽 + 会话信息 + 窗口控制 ===== */}
      <div className="titlebar-drag flex items-center gap-3 px-3 h-9 bg-surface-secondary dark:bg-surface-secondary-dark border-b border-border dark:border-border-dark shrink-0">
        {/* 左侧：会话模式/项目目录 — 始终显示 */}
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {chatMode === "code" ? (
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
          {project?.directory && (
            <>
              <span className="text-content-tertiary dark:text-content-tertiary-dark text-xs">·</span>
              <div className="flex items-center gap-1 text-xs text-content-tertiary dark:text-content-tertiary-dark truncate">
                <FolderOpen size={12} />
                <span className="truncate">{project.directory}</span>
              </div>
            </>
          )}
        </div>

        {/* 右侧：窗口控制按钮 */}
        <WindowControls />
      </div>

      {/* ===== 会话信息栏（代码模式下的额外提示） ===== */}
      {chatMode === "code" && !project?.directory && (
        <div className="px-4 py-1.5 bg-amber-50/50 dark:bg-amber-900/10 border-b border-border dark:border-border-dark">
          <div className="max-w-5xl mx-auto flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400">
            <MessageCircle size={12} />
            <span>编程模式 · 请先在侧边栏选择项目目录</span>
          </div>
        </div>
      )}

      {/* ===== 消息区域 ===== */}
      <div className="flex-1 overflow-y-auto scroll-anchor">
        <div key={conversationId} className="max-w-5xl mx-auto px-2 py-6 animate-slide-up">
          {isEmpty ? (
            <div className="flex flex-col items-center justify-center h-full min-h-[60vh] text-center animate-fade-in">
              <div className="relative mb-6">
                <div className="w-16 h-16 rounded-2xl bg-accent/10 dark:bg-accent/10 flex items-center justify-center">
                  {chatMode === "code" ? (
                    <Code size={28} className="text-amber-500" />
                  ) : (
                    <Sparkles size={28} className="text-accent" />
                  )}
                </div>
                <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-accent/20 animate-pulse" />
              </div>

              <h2 className="text-xl font-semibold mb-2">
                {chatMode === "code" ? "开始编程开发" : "开始新的对话"}
              </h2>
              <p className="text-base text-content-secondary dark:text-content-secondary-dark max-w-sm leading-relaxed">
                {chatMode === "code"
                  ? "在当前项目目录中执行代码操作。输入你的需求，我会帮你处理。"
                  : "输入你的问题，Ripple 将为你提供 AI 辅助编程帮助。"}
                {isOffline && (
                  <span className="block mt-1 text-amber-500 dark:text-amber-400">
                    ℹ️ 当前处于离线模拟模式
                  </span>
                )}
                {chatMode === "code" && project && !project.directory && (
                  <span className="block mt-1 text-blue-500 dark:text-blue-400">
                    ℹ️ 请先设置项目目录以启用完整功能
                  </span>
                )}
              </p>

              <div className="mt-6 grid grid-cols-2 gap-2 w-full max-w-sm">
                {((chatMode === "code")
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
                />
              ))}
            </div>
          )}

          {shouldShowTyping && <TypingIndicator />}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {isOffline && (
        <div className="mx-4 mb-2">
          <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-800/30">
            <WifiOff size={14} className="text-amber-500 dark:text-amber-400 shrink-0" />
            <span className="text-sm text-amber-600 dark:text-amber-400">
              离线模式 · 可在侧边栏连接桥接服务
            </span>
          </div>
        </div>
      )}

      <div className="px-4 pb-3 pt-1">
        <div className="max-w-5xl mx-auto">
          <MessageInput
            onSend={onSendMessage}
            disabled={isProcessing}
            activeConfig={activeConfig}
            modelConfigs={modelConfigs}
            onSwitchModel={onSwitchModel}
            chatMode={chatMode}
            openCodeModels={openCodeModels}
            openCodeModel={openCodeModel}
            onSwitchOpenCodeModel={onSwitchOpenCodeModel}
            placeholder={
              isProcessing
                ? "AI 正在回复..."
                : chatMode === "code"
                ? "输入编程指令... (Enter 发送, Shift+Enter 换行)"
                : "输入消息... (Enter 发送, Shift+Enter 换行)"
            }
          />
          <div className="flex items-center justify-center gap-2 mt-2">
            <span className="text-xs text-content-tertiary dark:text-content-tertiary-dark">
              Enter 发送 · Shift+Enter 换行
            </span>
            {activeConfig && (
              <span className="text-xs text-content-tertiary dark:text-content-tertiary-dark">
                · 模型: {activeConfig.model}
              </span>
            )}
            {chatMode === "code" && (
              <span className="text-xs text-amber-500 dark:text-amber-400 font-medium">
                · 开发模式
              </span>
            )}
            {isOffline && (
              <span className="text-xs text-amber-500 dark:text-amber-400 font-medium">
                · 模拟模式
              </span>
            )}
            {isOnline && (
              <span className="text-xs text-emerald-500 dark:text-emerald-400 font-medium">
                · 在线模式
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default ChatView;
