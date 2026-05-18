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
import { useProjects } from "./hooks/useProjects";
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
  const projects = useProjects();
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

  // 获取当前会话关联的项目和模式
  const currentProject = chat.activeConversation?.projectId
    ? projects.projects.find((p) => p.id === chat.activeConversation?.projectId)
    : null;
  const currentMode = chat.activeConversation?.mode || "chat";
  const isCodeMode = currentMode === "code";

  // 发送消息 - 后端可用走后端，否则走模拟（仅开发测试）
  const handleSendMessage = useCallback(async (content: string) => {
    await chat.sendMessage(content, chat.backendConnected, activeConfig, currentProject?.directory);
  }, [chat.sendMessage, chat.backendConnected, activeConfig, currentProject?.directory]);

  // 新建对话
  const handleNewConversation = (mode: ChatMode = "chat", projectId?: string) => {
    chat.newConversation(mode, projectId);
  };

  // 添加项目 = 创建一条聊天记录
  const handleAddProject = (name: string, directory: string) => {
    const newProject = projects.addProject(name, directory);
    chat.newConversation("chat", newProject.id, name);
  };

  // 点击项目 → 切换到关联的聊天记录
  const handleSelectProjectConversation = (projectId: string) => {
    projects.setActiveProject(projectId);
    const existingConv = chat.conversations.find(
      (c) => c.projectId === projectId
    );
    if (existingConv) {
      chat.switchConversation(existingConv.id);
    } else {
      const project = projects.projects.find((p) => p.id === projectId);
      chat.newConversation("chat", projectId, project?.name || "项目对话");
    }
  };

  return (
    <div className={settings.darkMode ? "dark" : ""}>
      <div className="h-screen flex flex-col bg-surface dark:bg-surface-dark text-content dark:text-content-dark">
        {/* 主内容区：侧边栏 + 聊天区 + 文件树 */}
        <div className="flex flex-1 min-h-0">
          {/* 左侧边栏 */}
          <Sidebar
            darkMode={settings.darkMode}
            onToggleDarkMode={() => updateSettings({ darkMode: !settings.darkMode })}
            conversations={chat.conversations}
            activeConversationId={chat.activeConversationId}
            onNewConversation={handleNewConversation}
            onSwitchConversation={chat.switchConversation}
            onDeleteConversation={chat.deleteConversation}
            onOpenSettings={() => setShowSettings(true)}
            projects={projects.projects}
            activeProjectId={projects.activeProjectId}
            onAddProject={handleAddProject}
            onSwitchProject={projects.setActiveProject}
            onDeleteProject={projects.deleteProject}
            onSelectProjectConversation={handleSelectProjectConversation}
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
              project={currentProject}
              backendConnected={chat.backendConnected}
              backendModels={backendModels}
              pendingToolRequests={chat.pendingToolRequests}
              onToolConfirm={chat.handleToolConfirm}
              permissionMode={settings.permissionMode}
              onPermissionModeChange={(mode) => updateSettings({ permissionMode: mode })}
            />

            {/* 右侧：文件树 + 文件预览/快照面板（只有项目模式才显示） */}
            {currentProject && (
              <div className="flex">
                <FileTree
                  directory={currentProject?.directory || ""}
                  onFileClick={(path) => {
                    setSelectedFilePath(path);
                    setShowCheckpointPanel(false);
                  }}
                  onClose={() => setFileTreeExpanded(false)}
                  isExpanded={fileTreeExpanded}
                  onToggleExpand={() => setFileTreeExpanded(!fileTreeExpanded)}
                  showPanel={!!currentProject}
                  onToggleCheckpointPanel={() => setShowCheckpointPanel(v => !v)}
                  isCheckpointPanelActive={showCheckpointPanel}
                />

                {/* 文件预览面板 / 快照面板（互斥） */}
                {showCheckpointPanel ? (
                  <CheckpointPanel
                    cwd={currentProject?.directory || null}
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

        {/* 底部日志面板 — 在 flex 列布局内，不影响上方内容 */}
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