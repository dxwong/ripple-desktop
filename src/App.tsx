import { useState, useCallback, useEffect } from "react";
import Sidebar from "./components/Sidebar";
import ChatView from "./components/ChatView";
import FileTree from "./components/FileTree";
import FilePreview from "./components/FilePreview";
import CheckpointPanel from "./components/CheckpointPanel";
import SettingsPanel from "./components/SettingsPanel";
import LogPanel from "./components/LogPanel";
import { useStreamingChat } from "./hooks/useStreamingChat";
import { useSettings } from "./hooks/useSettings";
import { useFolderPicker } from "./hooks/useFolderPicker";
import { ChatMode } from "./types";
import { fetchModels } from "./services/api";
import { logger } from "./components/LogPanel";
import { isTauri } from "./hooks/useTauri";

function App() {
  const [showSettings, setShowSettings] = useState(false);
  const [backendModels, setBackendModels] = useState<{ id: string; name: string }[]>([]);
  // 文件树状态
  const [fileTreeExpanded, setFileTreeExpanded] = useState(true);
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

  // 启动时检查后端连接
  useEffect(() => {
    const init = async () => {
      // Tauri 环境下自动启动后端
      if (isTauri()) {
        try {
          logger.info("Tauri 环境，正在启动后端服务...");
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("start_backend");
          // 等待后端启动
          await new Promise((r) => setTimeout(r, 2000));
        } catch (e: any) {
          logger.warn(`自动启动后端失败: ${e}`);
        }
      }

      logger.info("正在检查后端连接...");
      const connected = await chat.checkBackendConnection();
      if (connected) {
        logger.success("后端服务已连接 (localhost:3002)");
        const result = await fetchModels();
        if (result.data) {
          setBackendModels(result.data);
          logger.info(`获取到 ${result.data.length} 个模型: ${result.data.map(m => m.name).join(", ")}`);
        }
      } else {
        logger.warn("后端服务未连接，使用模拟模式（仅开发测试）");
      }
    };
    init();
  }, []);

  // 后端连接就绪后加载历史会话
  useEffect(() => {
    if (!chat.backendConnected) return;
    logger.info("正在恢复后端历史会话...");
    chat.loadSessionsFromBackend();
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
    const result = await chat.rollbackToSnapshot(
      msg.snapshotId,
      messageId,
      chat.activeConversationId,
      currentCwd
    );
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

  return (
    <div className={settings.darkMode ? "dark" : ""}>
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
      </div>

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
  );
}

export default App;