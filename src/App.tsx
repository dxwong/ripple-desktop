import { useState, useCallback } from "react";
import Sidebar from "./components/Sidebar";
import ChatView from "./components/ChatView";
import SettingsPanel from "./components/SettingsPanel";
import { useBridge } from "./hooks/useBridge";
import { useStreamingChat } from "./hooks/useStreamingChat";
import { useSettings } from "./hooks/useSettings";
import { useProjects } from "./hooks/useProjects";
import { useFolderPicker } from "./hooks/useFolderPicker";
import { ChatMode } from "./types";

function App() {
  const [showSettings, setShowSettings] = useState(false);
  const {
    settings,
    updateSettings,
    resetSettings,
    activeConfig,
    saveModelConfig,
    deleteModelConfig,
    setActiveModel,
  } = useSettings();
  const bridge = useBridge();
  const chat = useStreamingChat();
  const projects = useProjects();
  const { pickFolder } = useFolderPicker();

  // OpenCode 模型列表（从 opencode models 命令获取）
  const [openCodeModels, setOpenCodeModels] = useState<{ id: string; name: string }[]>([
    { id: "opencode/deepseek-v4-flash-free", name: "DeepSeek V4 Flash (免费)" },
    { id: "opencode/minimax-m2.5-free", name: "MiniMax M2.5 (免费)" },
    { id: "opencode/nemotron-3-super-free", name: "Nemotron 3 Super (免费)" },
    { id: "opencode/ring-2.6-1t-free", name: "Ring 2.6 1T (免费)" },
  ]);
  // 当前选择的 OpenCode 模型
  const [openCodeModel, setOpenCodeModel] = useState("");

  // 获取当前会话关联的项目和模式
  const currentProject = chat.activeConversation?.projectId
    ? projects.projects.find((p) => p.id === chat.activeConversation?.projectId)
    : null;
  const currentMode = chat.activeConversation?.mode || "chat";
  const isCodeMode = currentMode === "code";

  // 离开代码模式时清空 OpenCode 模型选择
  if (!isCodeMode && openCodeModel) setOpenCodeModel("");

  // 发送消息
  const handleSendMessage = useCallback(async (content: string) => {
    const isOnline = bridge.status === "connected";
    const projectDirectory = currentProject?.directory;
    const ocModel = isCodeMode ? openCodeModel : undefined;
    await chat.sendMessage(
      content,
      isOnline ? "bridge" : "simulate",
      isOnline ? bridge.sendMessage : undefined,
      isOnline ? bridge.sendStreamingMessage : undefined,
      isOnline ? bridge.setMessageCallback : undefined,
      projectDirectory,
      ocModel
    );
  }, [bridge.status, bridge.sendMessage, bridge.sendStreamingMessage, bridge.setMessageCallback, chat.sendMessage, currentProject?.directory, isCodeMode, openCodeModel]);

  // 新建对话
  const handleNewConversation = (mode: ChatMode = "chat", projectId?: string) => {
    chat.newConversation(mode, projectId);
  };

  // 添加项目
  const handleAddProject = (name: string, directory: string) => {
    projects.addProject(name, directory);
  };

  // 点击项目 → 打开关联对话
  const handleSelectProjectConversation = (projectId: string) => {
    projects.setActiveProject(projectId);
    const existingConv = chat.conversations.find((c) => c.projectId === projectId);
    if (existingConv) {
      chat.switchConversation(existingConv.id);
    } else {
      chat.newConversation("code", projectId);
    }
  };

  return (
    <div className={settings.darkMode ? "dark" : ""}>
      <div className="h-screen flex flex-col bg-surface dark:bg-surface-dark text-content dark:text-content-dark">
        <div className="flex flex-1 min-h-0">
          {/* 侧边栏 */}
          <Sidebar
            darkMode={settings.darkMode}
            onToggleDarkMode={() => updateSettings({ darkMode: !settings.darkMode })}
            conversations={chat.conversations}
            activeConversationId={chat.activeConversationId}
            onNewConversation={handleNewConversation}
            onSwitchConversation={chat.switchConversation}
            onDeleteConversation={chat.deleteConversation}
            bridgeStatus={bridge.status}
            onReconnectBridge={bridge.connect}
            onOpenSettings={() => setShowSettings(true)}
            projects={projects.projects}
            activeProjectId={projects.activeProjectId}
            onAddProject={handleAddProject}
            onSwitchProject={projects.setActiveProject}
            onDeleteProject={projects.deleteProject}
            onSelectProjectConversation={handleSelectProjectConversation}
            onPickFolder={pickFolder}
          />

          {/* 聊天区 */}
          <ChatView
            conversationId={chat.activeConversationId}
            messages={chat.activeConversation?.messages || []}
            onSendMessage={handleSendMessage}
            isProcessing={chat.isProcessing}
            bridgeStatus={bridge.status}
            bridgeError={bridge.error}
            darkMode={settings.darkMode}
            activeConfig={activeConfig}
            modelConfigs={settings.modelConfigs}
            onSwitchModel={setActiveModel}
            chatMode={currentMode}
            project={currentProject}
            openCodeModels={openCodeModels}
            openCodeModel={openCodeModel}
            onSwitchOpenCodeModel={setOpenCodeModel}
          />
        </div>
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
