import {
  Plus,
  MessageSquare,
  Sun,
  Moon,
  Settings,
  Wifi,
  WifiOff,
  RefreshCw,
  Trash2,
  Search,
  FolderOpen,
  FolderPlus,
  Code,
  X,
  ChevronDown,
  ChevronRight,
  Folder,
} from "lucide-react";
import { useState } from "react";
import { Conversation, Project, ChatMode } from "../types";

interface SidebarProps {
  darkMode: boolean;
  onToggleDarkMode: () => void;
  conversations: Conversation[];
  activeConversationId: string;
  onNewConversation: (mode?: ChatMode, projectId?: string) => void;
  onSwitchConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  bridgeStatus: string;
  onReconnectBridge: () => void;
  onOpenSettings: () => void;
  // 项目相关
  projects: Project[];
  activeProjectId: string;
  onAddProject: (name: string, directory: string) => void;
  onSwitchProject: (id: string) => void;
  onDeleteProject: (id: string) => void;
  /** 点击项目名称 → 打开关联的对话（和正常聊天一样） */
  onSelectProjectConversation: (projectId: string) => void;
  /** 打开文件夹选择器 */
  onPickFolder: () => Promise<string | null>;
}

/**
 * 侧边栏 — 上下分栏布局
 *
 * ┌──────────────────────────────┐
 * │  顶部：Logo + 搜索 + 状态 + [+] │
 * ├──────────────────────────────┤
 * │  上半部分：项目列表           │
 * │  - 新建项目（选择本地文件夹）    │
 * │  - 删除项目                   │
 * ├──────────────────────────────┤
 * │  下半部分：对话列表           │
 * └──────────────────────────────┘
 *
 * 模式切换按钮已移除，对话模式由是否关联项目自动决定。
 */
function Sidebar({
  darkMode,
  onToggleDarkMode,
  conversations,
  activeConversationId,
  onNewConversation,
  onSwitchConversation,
  onDeleteConversation,
  bridgeStatus,
  onReconnectBridge,
  onOpenSettings,
  projects,
  activeProjectId,
  onAddProject,
  onSwitchProject,
  onDeleteProject,
  onSelectProjectConversation,
  onPickFolder,
}: SidebarProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [projectsCollapsed, setProjectsCollapsed] = useState(false);
  const [showAddProject, setShowAddProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [projectDir, setProjectDir] = useState("");
  const [pickingFolder, setPickingFolder] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const isOnline = bridgeStatus === "connected";
  const isConnecting = bridgeStatus === "connecting";

  const filteredConversations = conversations.filter((c) =>
    c.title.toLowerCase().includes(searchQuery.toLowerCase())
  );

  /** 新建对话：+号始终创建普通对话模式（项目对话通过点击项目名称进入） */
  const handleNewConversation = () => {
    onNewConversation("chat");
  };

  /** 打开新建项目弹窗 */
  const handleOpenAddProject = () => {
    setNewProjectName("");
    setProjectDir("");
    setShowAddProject(true);
  };

  /** 选择文件夹 */
  const handlePickFolder = async () => {
    setPickingFolder(true);
    const dir = await onPickFolder();
    setPickingFolder(false);
    if (dir) {
      setProjectDir(dir);
      // 如果还没有名称，自动从路径提取
      if (!newProjectName.trim()) {
        const defaultName = dir.split(/[/\\]/).filter(Boolean).pop() || "新项目";
        setNewProjectName(defaultName);
      }
    }
  };

  /** 确认创建项目（只创建，不再弹文件夹选择器） */
  const confirmAddProject = () => {
    if (!newProjectName.trim() || !projectDir.trim()) return;
    onAddProject(newProjectName.trim(), projectDir);
    setShowAddProject(false);
    setNewProjectName("");
    setProjectDir("");
  };

  return (
    <aside className="w-72 flex flex-col bg-surface-secondary dark:bg-surface-secondary-dark border-r border-border dark:border-border-dark shrink-0">
      {/* ===== 顶部区域：Logo + 搜索 + 状态 + 新建对话（窗口拖拽区） ===== */}
      <div className="titlebar-drag p-3 pb-2 space-y-2.5">
        <div className="titlebar-no-drag flex items-center gap-2">
          <div className="w-8 h-8 rounded-xl bg-accent flex items-center justify-center shrink-0">
            <span className="text-white text-base font-bold">R</span>
          </div>
          <span className="flex-1 text-base font-semibold">Ripple</span>
          {/* + 新建对话 */}
          <button
            onClick={handleNewConversation}
            className="icon-btn"
            title="新建对话"
          >
            <Plus size={18} />
          </button>
        </div>

        {/* 搜索框 */}
        <div className="titlebar-no-drag relative">
          <Search
            size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-content-tertiary dark:text-content-tertiary-dark"
          />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索对话..."
            className="w-full pl-8 pr-3 py-1.5 text-sm rounded-lg
                       bg-black/[0.04] dark:bg-white/[0.06]
                       border border-transparent
                       placeholder:text-content-tertiary dark:placeholder:text-content-tertiary-dark
                       text-content dark:text-content-dark
                       focus:outline-none focus:border-accent/30 focus:bg-transparent
                       transition-all duration-150"
          />
        </div>

        {/* 桥接状态 */}
        <div
          className={`titlebar-no-drag flex items-center gap-2 px-2.5 py-1.5 rounded-lg transition-colors ${
            isOnline
              ? "text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/15"
              : isConnecting
              ? "text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/15"
              : "text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/15"
          }`}
        >
          {isOnline ? (
            <Wifi size={14} />
          ) : isConnecting ? (
            <RefreshCw size={14} className="animate-spin" />
          ) : (
            <WifiOff size={14} />
          )}
          <span className="text-xs font-medium flex-1">
            {isOnline
              ? "桥接已连接"
              : isConnecting
              ? "连接中..."
              : "未连接"}
          </span>
          {!isOnline && !isConnecting && (
            <button
              onClick={onReconnectBridge}
              className="hover:text-accent transition-colors"
              title="重新连接"
            >
              <RefreshCw size={12} />
            </button>
          )}
        </div>
      </div>

      {/* ===== 上半部分：项目列表（可折叠） ===== */}
      <div className="border-t border-border dark:border-border-dark">
        {/* 项目头部 — 点击可折叠 */}
        <button
          onClick={() => setProjectsCollapsed(!projectsCollapsed)}
          className="w-full flex items-center justify-between px-3 py-2 hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors"
        >
          <div className="flex items-center gap-1.5">
            {projectsCollapsed ? (
              <ChevronRight size={13} className="text-content-tertiary dark:text-content-tertiary-dark" />
            ) : (
              <ChevronDown size={13} className="text-content-tertiary dark:text-content-tertiary-dark" />
            )}
            <FolderOpen size={13} className="text-content-tertiary dark:text-content-tertiary-dark" />
            <span className="text-xs font-medium text-content-tertiary dark:text-content-tertiary-dark">项目</span>
          </div>
          <div className="flex items-center gap-0.5">
            <span className="text-xs text-content-tertiary dark:text-content-tertiary-dark mr-1">{projects.length}</span>
            {/* 添加项目按钮 */}
            <button
              onClick={(e) => { e.stopPropagation(); handleOpenAddProject(); }}
              className="icon-btn !p-1"
              title="添加本地项目文件夹"
            >
              <FolderPlus size={15} />
            </button>
          </div>
        </button>
        {/* 项目列表内容 — 可折叠 */}
        {!projectsCollapsed && (
        <div className="px-2 pb-2 max-h-[40vh] overflow-y-auto">
          {projects.length === 0 ? (
            <div className="text-center py-4">
              <p className="text-xs text-content-tertiary dark:text-content-tertiary-dark">暂无项目</p>
            </div>
          ) : (
            <div className="space-y-0.5">
              {projects.map((project) => (
                <div key={project.id} className="group relative">
                  <button
                    onClick={() => onSelectProjectConversation(project.id)}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-left transition-all duration-150 ${
                      project.id === activeProjectId
                        ? "sidebar-btn active"
                        : "sidebar-btn"
                    }`}
                  >
                    <Code size={14} className={`shrink-0 ${
                      project.id === activeProjectId ? "opacity-100" : "opacity-60"
                    }`} />
                    <div className="flex-1 min-w-0">
                      <div className="truncate">{project.name}</div>
                      {project.directory && (
                        <div className="text-[11px] text-content-tertiary dark:text-content-tertiary-dark truncate">
                          {project.directory}
                        </div>
                      )}
                    </div>
                  </button>
                  {projects.length > 1 && (
                    <button
                      onClick={(e) => { e.stopPropagation(); setDeleteConfirm(project.id); }}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 p-1 rounded-md text-content-tertiary dark:text-content-tertiary-dark hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-all duration-150"
                      title="删除项目"
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        )}
      </div>

      {/* ===== 下半部分：对话列表 ===== */}
      <div className="flex-1 overflow-y-auto border-t border-border dark:border-border-dark">
        <div className="px-3 py-2 flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <MessageSquare size={12} className="text-content-tertiary dark:text-content-tertiary-dark" />
            <span className="text-xs font-medium text-content-tertiary dark:text-content-tertiary-dark">
              {searchQuery ? "搜索结果" : "对话"}
            </span>
          </div>
          <span className="text-xs text-content-tertiary dark:text-content-tertiary-dark">
            {filteredConversations.length}
          </span>
        </div>

        <div className="px-2 pb-2">
          {filteredConversations.length === 0 ? (
            <div className="text-center py-8">
              <div className="w-10 h-10 rounded-full bg-black/[0.03] dark:bg-white/[0.03] flex items-center justify-center mx-auto mb-2">
                <MessageSquare size={16} className="text-content-tertiary dark:text-content-tertiary-dark" />
              </div>
              <p className="text-sm text-content-tertiary dark:text-content-tertiary-dark">
                {searchQuery ? "未找到匹配的对话" : "还没有对话，点击 + 新建"}
              </p>
            </div>
          ) : (
            <div className="space-y-0.5">
              {filteredConversations.map((conv) => (
                <div key={conv.id} className="group relative">
                  <button
                    onClick={() => onSwitchConversation(conv.id)}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-left transition-all duration-150 ${
                      conv.id === activeConversationId
                        ? "sidebar-btn active"
                        : "sidebar-btn"
                    }`}
                  >
                    {conv.mode === "code" ? (
                      <Code size={14} className="shrink-0 text-amber-500 dark:text-amber-400 opacity-80" />
                    ) : (
                      <MessageSquare size={14} className="shrink-0 opacity-60 group-hover:opacity-80 transition-opacity" />
                    )}
                    <span className="truncate flex-1">{conv.title}</span>
                  </button>
                  <button
                    onClick={() => onDeleteConversation(conv.id)}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 p-1 rounded-md text-content-tertiary dark:text-content-tertiary-dark hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-all duration-150"
                    title="删除对话"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ===== 底部菜单 ===== */}
      <div className="p-1.5 border-t border-border dark:border-border-dark space-y-0.5">
        <button onClick={onToggleDarkMode} className="sidebar-btn">
          {darkMode ? <Sun size={14} /> : <Moon size={14} />}
          <span>{darkMode ? "浅色" : "深色"}</span>
        </button>
        <button onClick={onOpenSettings} className="sidebar-btn">
          <Settings size={14} />
          <span>设置</span>
        </button>
      </div>

      {/* ===== 新建项目弹窗 ===== */}
      {showAddProject && (
        <div className="fixed inset-0 bg-black/30 dark:bg-black/50 flex items-center justify-center z-50">
          <div className="bg-surface-secondary dark:bg-surface-secondary-dark rounded-2xl p-5 w-96 shadow-elevated border border-border dark:border-border-dark">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold">新建项目</h3>
              <button onClick={() => { setShowAddProject(false); setProjectDir(""); }} className="icon-btn !p-1">
                <X size={15} />
              </button>
            </div>

            <label className="text-xs font-medium text-content-secondary dark:text-content-secondary-dark mb-1.5 block">
              项目名称
            </label>
            <input
              type="text"
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              placeholder="输入项目名称"
              className="w-full px-3 py-2 text-sm rounded-xl border border-border dark:border-border-dark
                         bg-surface dark:bg-surface-dark text-content dark:text-content-dark
                         placeholder:text-content-tertiary dark:placeholder:text-content-tertiary-dark
                         focus:outline-none focus:border-accent/40 transition-all duration-150 mb-4"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && projectDir) confirmAddProject();
              }}
            />

            <label className="text-xs font-medium text-content-secondary dark:text-content-secondary-dark mb-1.5 block">
              项目目录
            </label>
            <div className="flex items-center gap-2 mb-4">
              <div className="flex-1 flex items-center gap-2 px-3 py-2 text-sm rounded-xl
                              border border-border dark:border-border-dark
                              bg-surface dark:bg-surface-dark min-h-[38px]">
                {projectDir ? (
                  <span className="truncate text-content dark:text-content-dark">{projectDir}</span>
                ) : (
                  <span className="text-content-tertiary dark:text-content-tertiary-dark">请选择本地文件夹</span>
                )}
              </div>
              <button
                onClick={handlePickFolder}
                disabled={pickingFolder}
                className="shrink-0 px-3 py-2 text-sm font-medium rounded-xl
                           border border-border dark:border-border-dark
                           hover:bg-black/[0.03] dark:hover:bg-white/[0.03]
                           disabled:opacity-50 disabled:cursor-not-allowed
                           transition-all duration-150"
              >
                {pickingFolder ? "选择中..." : "浏览"}
              </button>
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => { setShowAddProject(false); setProjectDir(""); }}
                className="flex-1 px-3 py-2 text-sm font-medium rounded-xl
                           border border-border dark:border-border-dark
                           hover:bg-black/[0.03] dark:hover:bg-white/[0.03]
                           transition-all duration-150"
              >
                取消
              </button>
              <button
                onClick={confirmAddProject}
                disabled={!newProjectName.trim() || !projectDir.trim()}
                className="flex-1 px-4 py-2 text-sm font-medium rounded-xl
                           bg-accent text-white
                           hover:bg-accent-hover active:scale-[0.98]
                           disabled:opacity-50 disabled:cursor-not-allowed
                           transition-all duration-150 shadow-sm"
              >
                创建
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===== 删除项目确认弹窗 ===== */}
      {deleteConfirm && (
        <div className="fixed inset-0 bg-black/30 dark:bg-black/50 flex items-center justify-center z-50">
          <div className="bg-surface-secondary dark:bg-surface-secondary-dark rounded-2xl p-5 w-80 shadow-elevated border border-border dark:border-border-dark">
            <h3 className="text-sm font-semibold mb-2">确认删除</h3>
            <p className="text-sm text-content-secondary dark:text-content-secondary-dark mb-4">
              确定要删除项目「{projects.find((p) => p.id === deleteConfirm)?.name}」吗？此操作不可撤销。
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="flex-1 px-3 py-2 text-sm font-medium rounded-xl
                           border border-border dark:border-border-dark
                           hover:bg-black/[0.03] dark:hover:bg-white/[0.03]
                           transition-all duration-150"
              >
                取消
              </button>
              <button
                onClick={() => {
                  onDeleteProject(deleteConfirm);
                  setDeleteConfirm(null);
                }}
                className="flex-1 px-4 py-2 text-sm font-medium rounded-xl
                           bg-red-500 text-white
                           hover:bg-red-600 active:scale-[0.98]
                           transition-all duration-150 shadow-sm"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}

export default Sidebar;
