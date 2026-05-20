import { useState, useCallback, useEffect, useRef } from "react";
import Sidebar from "./Sidebar";
import ChatView from "./ChatView";
import FileTree from "./FileTree";
import FilePreview from "./FilePreview";
import CheckpointPanel from "./CheckpointPanel";
import SettingsPanel from "./SettingsPanel";
import LogPanel from "./LogPanel";
import { StartupLoading } from "./StartupLoading";
import { ErrorModal } from "./ErrorModal";
import { useStreamingChat } from "../hooks/useStreamingChat";
import { useSettings } from "../hooks/useSettings";
import { useFolderPicker } from "../hooks/useFolderPicker";
import { syncStore } from "../hooks/useStore";
import { ChatMode } from "../types";
import { fetchModels } from "../services/api";
import { logger } from "./LogPanel";
import { isTauri } from "../hooks/useTauri";

export function MainApp() {
  // 启动状态管理
  const [startupState, setStartupState] = useState<"loading" | "error" | "ready">("loading");
  const [startupMessage, setStartupMessage] = useState("正在加载配置，请稍后...");
  const [errorMessage, setErrorMessage] = useState("");
  
  const [showSettings, setShowSettings] = useState(false);
  const [backendModels, setBackendModels] = useState<{ id: string; name: string }[]>([]);
  // 文件树状态 - 默认折叠，从持久化存储读取上次状态
  const [fileTreeExpanded, setFileTreeExpanded] = useState(() => 
    syncStore.getItem("file-tree-expanded", false)
  );
  
  // 监听文件树展开状态变化，持久化保存
  useEffect(() => {
    syncStore.setItem("file-tree-expanded", fileTreeExpanded);
  }, [fileTreeExpanded]);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  // 快照面板状态（与文件预览互斥）
  const [showCheckpointPanel, setShowCheckpointPanel] = useState(false);
  const {
    settings,
    updateSettings,
    resetSettings,
    activeConfig,
    saveModelConfig,
    deleteModelConfig,
    setActiveModel,
  } = useSettings();
  const chat = useStreamingChat(settings.permissionMode);
  const { pickFolder } = useFolderPicker();

  // 用 ref 持有 chat 中的稳定方法，避免 [chat] 对象引用变化导致 effect 反复执行
  const checkBackendConnectionRef = useRef(chat.checkBackendConnection);
  checkBackendConnectionRef.current = chat.checkBackendConnection;
  const loadSessionsFromBackendRef = useRef(chat.loadSessionsFromBackend);
  loadSessionsFromBackendRef.current = chat.loadSessionsFromBackend;

  // 启动完成后初始化（仅执行一次：空依赖 + startedRef 确保 StrictMode 下也只跑一次）
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const init = async () => {
      try {
        // Tauri 环境下自动启动后端
        if (isTauri()) {
          logger.info("Tauri 环境，正在启动后端服务...");
          const { invoke } = await import("@tauri-apps/api/core");
          const startBackendPromise = invoke("start_backend").catch(e => {
            logger.warn(`启动后端服务失败: ${e}`);
            return null;
          });
          await new Promise(r => setTimeout(r, 200));
          await startBackendPromise;
        }

        // 检查后端连接（带超时重试）
        logger.info("正在检查后端连接...");
        const MAX_RETRY = 8;
        const RETRY_DELAY = 500;
        let connected = false;

        for (let i = 0; i < MAX_RETRY; i++) {
          await new Promise(r => requestAnimationFrame(r));
          connected = await Promise.race([
            checkBackendConnectionRef.current(),
            new Promise<false>(r => setTimeout(() => r(false), 3000))
          ]);
          if (connected) break;
          if (i < MAX_RETRY - 1) {
            await new Promise(r => setTimeout(r, RETRY_DELAY));
          }
        }

        if (connected) {
          logger.success("后端服务已连接 (localhost:3002)");
          const result = await fetchModels();
          if (result.data) {
            setBackendModels(result.data);
            logger.info(`获取到 ${result.data.length} 个模型: ${result.data.map(m => m.name).join(", ")}`);
          }
          // 启动完成，切换到 ready 状态
          setStartupState("ready");
        } else {
          logger.warn("后端服务未连接");
          // 后端未连接，也进入 ready 状态（允许离线使用）
          setStartupState("ready");
        }
      } catch (e) {
        const errorMsg = `启动过程中发生错误: ${(e as Error).message || String(e)}`;
        logger.error(`启动失败: ${e}`);
        setErrorMessage(errorMsg);
        setStartupState("error");
      }
    };
    queueMicrotask(init);
  }, []);

  // 后端连接就绪后加载历史会话（仅执行一次）
  const sessionsLoadedRef = useRef(false);
  useEffect(() => {
    if (!chat.backendConnected || sessionsLoadedRef.current) return;
    sessionsLoadedRef.current = true;
    logger.info("正在恢复后端历史会话...");
    loadSessionsFromBackendRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.backendConnected]);

  // Tauri 环境下监听后端日志事件
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | null = null;

    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        unlisten = await listen<{ level: string; message: string }>("backend-log", (event) => {
          const { level, message } = event.payload;
          switch (level) {
            case "error": logger.error(message); break;
            case "warn": logger.warn(message); break;
            case "success": logger.success(message); break;
            default: logger.info(message);
          }
        });
      } catch (e) {
        console.warn("监听后端日志失败:", e);
      }
    })();

    return () => {
      unlisten?.();
    };
  }, []);

  // 当前会话的目录（有 cwd 表示是项目对话，文件树等面板可显示）
  const currentCwd = chat.activeConversation?.cwd;
  const currentMode = chat.activeConversation?.mode || "chat";

  // 发送消息
  const handleSendMessage = useCallback(async (content: string) => {
    console.log('MainApp: 发送消息', { content, backendConnected: chat.backendConnected, activeConfigId: activeConfig?.id });
    await chat.sendMessage(content, chat.backendConnected, activeConfig, currentCwd);
  }, [chat.sendMessage, chat.backendConnected, activeConfig, currentCwd]);

  // 切换对话
  const handleSwitchConversation = useCallback((id: string) => {
    chat.switchConversation(id);
  }, [chat.switchConversation]);

  // 回滚到指定用户消息（撤销后续 AI 操作）
  const handleRollbackToSnapshot = useCallback(async (messageId: string) => {
    if (!currentCwd || !chat.activeConversationId) return;
    const conv = chat.activeConversation;
    if (!conv) return;
    const msg = conv.messages.find((m) => m.id === messageId);
    if (!msg?.snapshotId) {
      console.warn("[handleRollbackToSnapshot] 该消息没有关联的快照");
      return;
    }
    const result = await chat.rollbackToSnapshot(msg.snapshotId, messageId, conv.id, currentCwd);
    if (result.success) {
      logger.success(`已回滚到步骤「${msg.content.slice(0, 20)}...」`);
    } else {
      logger.error(`回滚失败: ${result.error}`);
    }
  }, [currentCwd, chat.activeConversation, chat.activeConversationId, chat.rollbackToSnapshot]);

  // 新建普通对话（无 cwd）
  const handleNewConversation = (mode: ChatMode = "chat") => {
    chat.newConversation(mode, undefined, undefined);
  };

  // 新建项目对话 = 创建一条带 cwd 的对话
  const handleNewProjectConversation = (name: string, directory: string) => {
    chat.newConversation("chat", name, directory);
  };

  // 重试启动流程
  const handleRetryStartup = () => {
    setStartupState("loading");
    setErrorMessage("");
    window.location.reload();
  };

  return (
    <div className={syncStore.getItem("dark-mode", false) ? "dark" : ""}>
      {/* 启动 Loading */}
      {startupState === "loading" && (
        <StartupLoading message={startupMessage} />
      )}
      
      {/* 错误弹窗 */}
      {startupState === "error" && (
        <ErrorModal
          title="启动失败"
          message={errorMessage}
          onRetry={handleRetryStartup}
        />
      )}
      
      {/* 主应用界面（启动完成后显示） */}
      {startupState === "ready" && (
        <div className="h-screen flex flex-col bg-surface dark:bg-surface-dark text-content dark:text-content-dark">
          {/* 主内容区：侧边栏 + 聊天区 + 文件树 */}
          <div className="flex flex-1 min-h-0 overflow-hidden">
            {/* 左侧边栏 */}
            <Sidebar
          darkMode={settings.darkMode}
          onToggleDarkMode={() => updateSettings({ darkMode: !settings.darkMode })}
          conversations={chat.conversations}
          activeConversationId={chat.activeConversationId}
          onNewConversation={handleNewConversation}
          onSwitchConversation={handleSwitchConversation}
          onDeleteConversation={chat.deleteConversation}
          onOpenSettings={() => setShowSettings(true)}
          onNewProjectConversation={handleNewProjectConversation}
          onRenameConversation={chat.renameConversation}
          onPickFolder={pickFolder}
        />

        {/* 中间：聊天区 */}
        <div className="flex-1 flex min-h-0">
          <ChatView
            conversationId={chat.activeConversationId}
            messages={chat.activeConversation?.messages || []}
            onSendMessage={handleSendMessage}
            isProcessing={chat.isProcessing}
            onStop={chat.stopStreaming}
            darkMode={settings.darkMode}
            activeConfig={activeConfig}
            modelConfigs={settings.modelConfigs}
            onSwitchModel={setActiveModel}
            chatMode={currentMode}
            cwd={currentCwd}
            backendConnected={chat.backendConnected}
            backendModels={backendModels}
            pendingToolRequests={chat.pendingToolRequests}
            onToolConfirm={chat.handleToolConfirm}
            permissionMode={settings.permissionMode}
            onPermissionModeChange={(mode) => updateSettings({ permissionMode: mode })}
            onRollbackToSnapshot={handleRollbackToSnapshot}
            conversationUsageMap={chat.conversationUsageMap}
          />

          {/* 右侧：文件树 + 文件预览/快照面板（只有项目对话才显示） */}
          {currentCwd && (
            <div className="flex">
              <FileTree
                directory={currentCwd}
                onFileClick={(path) => {
                  setSelectedFilePath(path);
                  setShowCheckpointPanel(false);
                }}
                onClose={() => setFileTreeExpanded(false)}
                isExpanded={fileTreeExpanded}
                onToggleExpand={() => setFileTreeExpanded(!fileTreeExpanded)}
                showPanel={!!currentCwd}
                onToggleCheckpointPanel={() => setShowCheckpointPanel(v => !v)}
                isCheckpointPanelActive={showCheckpointPanel}
              />

              {/* 文件预览面板 / 快照面板（互斥） */}
              {showCheckpointPanel ? (
                <CheckpointPanel
                  cwd={currentCwd}
                  onClose={() => setShowCheckpointPanel(false)}
                />
              ) : (
                <FilePreview
                  filePath={selectedFilePath}
                  onClose={() => setSelectedFilePath(null)}
                />
              )}
            </div>
          )}
        </div>
      </div>

      {/* 底部日志面板 */}
      <LogPanel />

      {/* 设置面板 */}
            {showSettings && (
              <SettingsPanel
                settings={settings}
                onUpdate={updateSettings}
                onReset={resetSettings}
                onClose={() => setShowSettings(false)}
                onSaveModelConfig={saveModelConfig}
                onDeleteModelConfig={deleteModelConfig}
                onSetActiveModel={setActiveModel}
              />
            )}
          </div>
        )}
      </div>
  );
}
