import {
  Plus,
  MessageSquare,
  Sun,
  Moon,
  Settings,
  Trash2,
  Search,
  FolderOpen,
  FolderPlus,
  Code,
  X,
  ChevronDown,
  ChevronRight,
  Pencil,
  Copy,
} from "lucide-react";
import { useState, useEffect } from "react";
import { Conversation, ChatMode } from "../types";
import { syncStore } from "../hooks/useStore";

interface SidebarProps {
  darkMode: boolean;
  onToggleDarkMode: () => void;
  conversations: Conversation[];
  activeConversationId: string;
  onNewConversation: (mode?: ChatMode) => void;
  onSwitchConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  onOpenSettings: () => void;
  /** 新建项目对话（带文件夹路径） */
  onNewProjectConversation: (name: string, directory: string) => void;
  /** 重命名对话 */
  onRenameConversation: (id: string, title: string) => void;
  /** 拷贝对话（id + 新标题） */
  onCopyConversation: (id: string, title: string) => void;
  /** 打开文件夹选择器 */
  onPickFolder: () => Promise<string | null>;
}

/**
 * 侧边栏 — 上下分栏布局
 *
 * ┌──────────────────────────────┐
 * │  顶部：Logo + 搜索 + [+]      │
 * ├──────────────────────────────┤
 * │  上半部分：项目对话列表        │
 * │  （有 cwd 的对话）            │
 * │  [+] 新建项目对话             │
 * ├──────────────────────────────┤
 * │  下半部分：普通对话列表        │
 * │  （无 cwd 的对话）            │
 * └──────────────────────────────┘
 */
function Sidebar({
  darkMode,
  onToggleDarkMode,
  conversations,
  activeConversationId,
  onNewConversation,
  onSwitchConversation,
  onDeleteConversation,
  onOpenSettings,
  onNewProjectConversation,
  onRenameConversation,
  onCopyConversation,
  onPickFolder,
}: SidebarProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [projectsCollapsed, setProjectsCollapsed] = useState<boolean>(() => syncStore.getItem("sidebar-projects-collapsed", true) as boolean);
  const [showAddProject, setShowAddProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [projectDir, setProjectDir] = useState("");
  const [pickingFolder, setPickingFolder] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [copyConfirm, setCopyConfirm] = useState<string | null>(null);
  const [copyTitle, setCopyTitle] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");

  // 持久化项目折叠状态
  useEffect(() => {
    syncStore.setItem("sidebar-projects-collapsed", projectsCollapsed);
  }, [projectsCollapsed]);

  // 项目对话 = 有 cwd 的对话
  const projectConversations = conversations.filter(c => c.cwd);
  // 普通对话 = 无 cwd 的对话
  const normalConversations = conversations.filter(c => !c.cwd);

  // 拷贝弹窗重名检测
  const isDuplicate = copyConfirm
    ? conversations.some(c => c.id !== copyConfirm && c.title === copyTitle.trim())
    : false;

  /** 新建普通对话或定位到已有空对话 */
  const handleNewConversation = () => {
    // 查找已存在的空普通对话
    const existingEmptyConv = normalConversations.find(c => c.messages.length === 0);
    if (existingEmptyConv) {
      // 如果存在空对话，定位到该对话
      onSwitchConversation(existingEmptyConv.id);
    } else {
      // 否则创建新对话
      onNewConversation("chat");
    }
  };

  // 检测是否存在空的普通对话
  const hasEmptyConversation = normalConversations.some(c => c.messages.length === 0);

  /** 打开新建项目对话弹窗 */
  const handleOpenAddProject = () => {
    setNewProjectName("");
    setProjectDir("");
    setShowAddProject(true);
  };

  /** 选择文件夹（调用 Tauri 或浏览器 API） */
  const handlePickFolder = async () => {
    setPickingFolder(true);
    try {
      const dir = await onPickFolder();
      if (dir) {
        setProjectDir(dir);
        // 自动以文件夹名作为默认对话名称
        const folderName = dir.replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';
        if (folderName && !newProjectName) {
          setNewProjectName(folderName);
        }
      }
    } finally {
      setPickingFolder(false);
    }
  };

  /** 确认创建项目对话 */
  const confirmAddProject = () => {
    if (!newProjectName.trim() || !projectDir.trim()) return;
    onNewProjectConversation(newProjectName.trim(), projectDir);
    setShowAddProject(false);
    setNewProjectName("");
    setProjectDir("");
  };

  /** 根据搜索过滤普通对话 */
  const filteredNormalConversations = normalConversations.filter(c =>
    c.title.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <aside className="w-72 min-w-[18rem] flex flex-col bg-surface-secondary dark:bg-surface-secondary-dark border-r border-border dark:border-border-dark shrink-0">
      {/* ===== 顶部区域：Logo + 搜索 + 新建对话（窗口拖拽区） ===== */}
      <div className="titlebar-drag p-3 pb-2 space-y-2.5">
        <div className="titlebar-no-drag flex items-center gap-2">
          <div className="w-8 h-8 rounded-xl bg-accent flex items-center justify-center shrink-0">
            <span className="text-white text-base font-bold">R</span>
          </div>
          <span className="flex-1 text-base font-semibold">Ripple</span>
          {/* + 新建普通对话 */}
          <button
            onClick={handleNewConversation}
            className={`icon-btn ${hasEmptyConversation ? 'opacity-70' : ''}`}
            title={hasEmptyConversation ? '已有空对话，点击定位' : '新建对话'}
          >
            <Plus size={18} />
          </button>
        </div>

        {/* 搜索框 */}
        <div className="titlebar-no-drag relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-content-tertiary dark:text-content-tertiary-dark" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索对话..."
            className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg bg-surface dark:bg-surface-dark
                       border border-border dark:border-border-dark
                       text-content dark:text-content-dark
                       placeholder:text-content-tertiary dark:placeholder:text-content-tertiary-dark
                       focus:outline-none focus:border-accent/40 transition-all duration-150"
          />
        </div>
      </div>

      {/* ===== 上半部分：项目对话列表（有 cwd 的对话） ===== */}
      <div className="min-w-0">
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
            <span className="text-xs text-content-tertiary dark:text-content-tertiary-dark mr-1">{projectConversations.length}</span>
            {/* 新建项目对话按钮 */}
            <button
              onClick={(e) => { e.stopPropagation(); handleOpenAddProject(); }}
              className="icon-btn !p-1"
              title="添加本地文件夹作为项目对话"
            >
              <FolderPlus size={15} />
            </button>
          </div>
        </button>
        {!projectsCollapsed && (
        <div className="px-2 pb-2 max-h-[40vh] overflow-y-auto min-w-0">
          {projectConversations.length === 0 ? (
            <div className="text-center py-4">
              <p className="text-xs text-content-tertiary dark:text-content-tertiary-dark">暂无项目</p>
            </div>
          ) : (
            <div className="space-y-0.5">
              {projectConversations.map((conv) => (
                <div key={conv.id} className="group relative">
                  <button
                    onClick={() => onSwitchConversation(conv.id)}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-left transition-all duration-150 ${
                      conv.id === activeConversationId
                        ? "sidebar-btn active"
                        : "sidebar-btn"
                    }`}
                  >
                    <Code size={14} className={`shrink-0 ${
                      conv.id === activeConversationId ? "opacity-100" : "opacity-60"
                    }`} />
                    <div className="flex-1 min-w-0 overflow-hidden">
                      {renamingId === conv.id ? (
                        <input
                          type="text"
                          value={renameText}
                          onChange={(e) => setRenameText(e.target.value)}
                          onBlur={() => {
                            if (renameText.trim()) onRenameConversation(conv.id, renameText.trim());
                            setRenamingId(null);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              if (renameText.trim()) onRenameConversation(conv.id, renameText.trim());
                              setRenamingId(null);
                            } else if (e.key === "Escape") {
                              setRenamingId(null);
                            }
                            e.stopPropagation();
                          }}
                          className="w-full text-sm bg-surface dark:bg-surface-dark px-1 py-0.5 rounded border border-accent/40 outline-none"
                          autoFocus
                          onClick={(e) => e.stopPropagation()}
                        />
                      ) : (
                        <div className="truncate">{conv.title}</div>
                      )}
                      {conv.cwd && (
                        <div className="text-[11px] text-content-tertiary dark:text-content-tertiary-dark truncate">
                          {conv.cwd}
                        </div>
                      )}
                    </div>
                  </button>
                  <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-all duration-150">
                    {conv.id === activeConversationId && (
                      <button
                        onClick={(e) => { e.stopPropagation(); setCopyConfirm(conv.id); setCopyTitle(`${conv.title} - 副本`); }}
                        className="p-1 rounded-md text-content-tertiary dark:text-content-tertiary-dark hover:text-green-500 hover:bg-green-50 dark:hover:bg-green-900/20 transition-all duration-150"
                        title="拷贝对话"
                      >
                        <Copy size={12} />
                      </button>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); setRenamingId(conv.id); setRenameText(conv.title); }}
                      className="p-1 rounded-md text-content-tertiary dark:text-content-tertiary-dark hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-all duration-150"
                      title="重命名"
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); setDeleteConfirm(conv.id); }}
                      className="p-1 rounded-md text-content-tertiary dark:text-content-tertiary-dark hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-all duration-150"
                      title="删除对话"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        )}
      </div>

      {/* ===== 下半部分：普通对话列表（无 cwd 的对话） ===== */}
      <div className="flex-1 overflow-y-auto border-t border-border dark:border-border-dark min-w-0">
        <div className="px-3 py-2 flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <MessageSquare size={12} className="text-content-tertiary dark:text-content-tertiary-dark" />
            <span className="text-xs font-medium text-content-tertiary dark:text-content-tertiary-dark">
              {searchQuery ? "搜索结果" : "对话"}
            </span>
          </div>
          <span className="text-xs text-content-tertiary dark:text-content-tertiary-dark">
            {filteredNormalConversations.length}
          </span>
        </div>

        <div className="px-2 pb-2">
          {filteredNormalConversations.length === 0 ? (
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
              {filteredNormalConversations.map((conv) => (
                <div key={conv.id} className="group relative">
                  <button
                    onClick={() => onSwitchConversation(conv.id)}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-left transition-all duration-150 ${
                      conv.id === activeConversationId
                        ? "sidebar-btn active"
                        : "sidebar-btn"
                    }`}
                  >
                    <MessageSquare size={14} className="shrink-0 opacity-60 group-hover:opacity-80 transition-opacity" />
                    <div className="flex-1 min-w-0 overflow-hidden">
                      {renamingId === conv.id ? (
                        <input
                          type="text"
                          value={renameText}
                          onChange={(e) => setRenameText(e.target.value)}
                          onBlur={() => {
                            if (renameText.trim()) onRenameConversation(conv.id, renameText.trim());
                            setRenamingId(null);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              if (renameText.trim()) onRenameConversation(conv.id, renameText.trim());
                              setRenamingId(null);
                            } else if (e.key === "Escape") {
                              setRenamingId(null);
                            }
                            e.stopPropagation();
                          }}
                          className="w-full text-sm bg-surface dark:bg-surface-dark px-1 py-0.5 rounded border border-accent/40 outline-none"
                          autoFocus
                          onClick={(e) => e.stopPropagation()}
                        />
                      ) : (
                        <span className="truncate">{conv.title}</span>
                      )}
                    </div>
                  </button>
                  <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-all duration-150">
                    {conv.id === activeConversationId && (
                      <button
                        onClick={(e) => { e.stopPropagation(); setCopyConfirm(conv.id); setCopyTitle(`${conv.title} - 副本`); }}
                        className="p-1 rounded-md text-content-tertiary dark:text-content-tertiary-dark hover:text-green-500 hover:bg-green-50 dark:hover:bg-green-900/20 transition-all duration-150"
                        title="拷贝对话"
                      >
                        <Copy size={12} />
                      </button>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); setRenamingId(conv.id); setRenameText(conv.title); }}
                      className="p-1 rounded-md text-content-tertiary dark:text-content-tertiary-dark hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-all duration-150"
                      title="重命名"
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      onClick={() => onDeleteConversation(conv.id)}
                      className="p-1 rounded-md text-content-tertiary dark:text-content-tertiary-dark hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-all duration-150"
                      title="删除对话"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
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

      {/* ===== 新建项目对话弹窗 ===== */}
      {showAddProject && (
        <div className="fixed inset-0 bg-black/30 dark:bg-black/50 flex items-center justify-center z-50">
          <div className="bg-surface-secondary dark:bg-surface-secondary-dark rounded-2xl p-5 w-96 shadow-elevated border border-border dark:border-border-dark">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold">新建项目对话</h3>
              <button onClick={() => { setShowAddProject(false); setProjectDir(""); }} className="icon-btn !p-1">
                <X size={15} />
              </button>
            </div>

            <label className="text-xs font-medium text-content-secondary dark:text-content-secondary-dark mb-1.5 block">
              对话名称
            </label>
            <input
              type="text"
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              placeholder="输入名称"
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

      {/* ===== 删除对话确认弹窗 ===== */}
      {deleteConfirm && (
        <div className="fixed inset-0 bg-black/30 dark:bg-black/50 flex items-center justify-center z-50">
          <div className="bg-surface-secondary dark:bg-surface-secondary-dark rounded-2xl p-5 w-80 shadow-elevated border border-border dark:border-border-dark">
            <h3 className="text-sm font-semibold mb-2">确认删除</h3>
            <p className="text-sm text-content-secondary dark:text-content-secondary-dark mb-4">
              确定要删除这条对话记录吗？后端数据也将被删除，此操作不可撤销。
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
                  onDeleteConversation(deleteConfirm);
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

      {/* ===== 拷贝对话弹窗 ===== */}
      {copyConfirm && (
        <div className="fixed inset-0 bg-black/30 dark:bg-black/50 flex items-center justify-center z-50">
          <div className="bg-surface-secondary dark:bg-surface-secondary-dark rounded-2xl p-5 w-80 shadow-elevated border border-border dark:border-border-dark">
            <h3 className="text-sm font-semibold mb-2">拷贝对话</h3>
            <p className="text-sm text-content-secondary dark:text-content-secondary-dark mb-4">
              将创建一份完整的副本（含所有消息和快照），与原对话完全独立。
            </p>
            <label className="text-xs font-medium text-content-secondary dark:text-content-secondary-dark mb-1.5 block">
              新对话标题
            </label>
            <input
              type="text"
              value={copyTitle}
              onChange={(e) => setCopyTitle(e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-xl border border-border dark:border-border-dark
                         bg-surface dark:bg-surface-dark text-content dark:text-content-dark
                         placeholder:text-content-tertiary dark:placeholder:text-content-tertiary-dark
                         focus:outline-none focus:border-accent/40 transition-all duration-150 mb-4"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && copyTitle.trim() && !isDuplicate) {
                  onCopyConversation(copyConfirm, copyTitle.trim());
                  setCopyConfirm(null);
                }
              }}
            />
            {/* 重名警告 */}
            {isDuplicate && (
              <p className="text-xs text-red-500 -mt-3 mb-3">已存在同名对话，请修改标题</p>
            )}
            <div className="flex gap-2">
              <button
                onClick={() => setCopyConfirm(null)}
                className="flex-1 px-3 py-2 text-sm font-medium rounded-xl
                           border border-border dark:border-border-dark
                           hover:bg-black/[0.03] dark:hover:bg-white/[0.03]
                           transition-all duration-150"
              >
                取消
              </button>
              <button
                onClick={() => {
                  if (copyTitle.trim() && !isDuplicate) {
                    onCopyConversation(copyConfirm, copyTitle.trim());
                  }
                  setCopyConfirm(null);
                }}
                disabled={!copyTitle.trim() || isDuplicate}
                className="flex-1 px-4 py-2 text-sm font-medium rounded-xl
                           bg-green-500 text-white
                           hover:bg-green-600 active:scale-[0.98]
                           disabled:opacity-50 disabled:cursor-not-allowed
                           transition-all duration-150 shadow-sm"
              >
                创建副本
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}

export default Sidebar;