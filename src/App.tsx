import { useState, useCallback } from "react";
import Sidebar from "./components/Sidebar";
import ChatView from "./components/ChatView";
import SettingsPanel from "./components/SettingsPanel";
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
  const chat = useStreamingChat();
  const projects = useProjects();
  const { pickFolder } = useFolderPicker();

  // 获取当前会话关联的项目和模式
  const currentProject = chat.activeConversation?.projectId
    ? projects.projects.find((p) => p.id === chat.activeConversation?.projectId)
    : null;
  const currentMode = chat.activeConversation?.mode || "chat";
  const isCodeMode = currentMode === "code";

  // 发送消息 - 纯模拟模式
  const handleSendMessage = useCallback(async (content: string) => {
    await chat.sendMessage(content);
  }, [chat.sendMessage]);

  // 新建对话
  const handleNewConversation = (mode: ChatMode = "chat", projectId?: string) => {
    chat.newConversation(mode, projectId);
  };

  // 添加项目 = 创建一条聊天记录（项目本身就是一条对话）
  const handleAddProject = (name: string, directory: string) => {
    const newProject = projects.addProject(name, directory);
    // 创建立刻创建关联的聊天记录，标题 = 项目名，mode = chat
    chat.newConversation("chat", newProject.id, name);
  };

  // 点击项目 → 切换到关联的聊天记录（不会创建新对话）
  const handleSelectProjectConversation = (projectId: string) => {
    projects.setActiveProject(projectId);
    const existingConv = chat.conversations.find(
      (c) => c.projectId === projectId
    );
    if (existingConv) {
      chat.switchConversation(existingConv.id);
    } else {
      // 兜底：兼容旧数据（升级前添加的项目没有对应对话）
      const project = projects.projects.find((p) => p.id === projectId);
      chat.newConversation("chat", projectId, project?.name || "项目对话");
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
            darkMode={settings.darkMode}
            activeConfig={activeConfig}
            modelConfigs={settings.modelConfigs}
            onSwitchModel={setActiveModel}
            chatMode={currentMode}
            project={currentProject}
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
