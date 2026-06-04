import {
  Plus,
  MessageSquare,
  MessageSquarePlus,
  Sun,
  Moon,
  Settings,
  Trash2,
  Search,
  Folder,
  FolderOpen,
  X,
  ChevronDown,
  ChevronRight,
  Pencil,
  Check,
  Copy,
  Code,
  Users,
  Brain,
  ArrowUpDown,
  type LucideIcon,
} from "lucide-react";
import { useState, useEffect, useMemo, useCallback } from "react";
import { Conversation } from "../types";
import { syncStore } from "../hooks/useStore";

interface SidebarProps {
  darkMode: boolean;
  onToggleDarkMode: () => void;
  conversations: Conversation[];
  activeConversationId: string;
  /** 新建普通对话（保留接口以备未来"新建普通对话"按钮复用） */
  onNewConversation?: (mode?: "chat" | "code") => void;
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

  // ===== v1.4 新增：响应式 props =====
  /** 移动端 drawer 是否打开（仅 mobile 模式生效） */
  isOpen?: boolean;
  /** 移动端 drawer 关闭回调 */
  onClose?: () => void;
  /** 桌面端 sidebar 是否折叠 */
  isCollapsed?: boolean;
  /** 顶部「专家」徽章数字（占位） */
  expertCount?: number;
  /** 顶部「记忆」徽章数字（占位） */
  memoryCount?: number;

  // ===== v2.0 新增：视图路由 =====
  /** 当前激活的视图（用于 nav-item 高亮） */
  activeView?: "chat" | "experts" | "memory" | "settings";
  /** 跳转到非对话页（专家 / 记忆 / 设置） */
  onNavigate?: (view: "experts" | "memory" | "settings") => void;
}

type TabKey = "projects" | "general";

/**
 * 侧边栏 — Demo 风格重写（v1.4）
 *
 * ┌──────────────────────────────┐
 * │  [R] Ripple                  │  ← 顶部：仅 Logo
 * │  🔍 搜索对话...              │  ← 搜索框（跨 tab 可见，仅过滤通用）
 * ├──────────────────────────────┤
 * │  专家  ───  7  →            │  ← 主导航（占位）
 * │  记忆  ───  3  →            │
 * ├──────────────────────────────┤
 * │  ┌────┬────┐                 │  ← Segmented Tabs
 * │  │项目│通用│                  │
 * │  └────┴────┘                 │
 * ├──────────────────────────────┤
 * │  项目                  ⇅ +   │  ← section header
 * │  ▾ 📁 dev (2)         💬+    │  ← 折叠/展开 + hover 暴露气泡+
 * │     <> 优化代码结构           │  ← Code 图标 + 标题（去时间）
 * │     <> 重构模块              │
 * ├──────────────────────────────┤
 * │  [⚙] 设置          [🌓]      │  ← 底部：User Pill + 主题按钮
 * └──────────────────────────────┘
 *
 * 响应式行为：
 * - 移动端（≤768px）：drawer 模式，受控于 isOpen / onClose
 * - 桌面端（≥769px）：始终展示，body.sidebar-collapsed 类名控制折叠
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
  // v1.4 新增
  isOpen = false,
  onClose,
  isCollapsed = false,
  expertCount = 0,
  memoryCount = 0,
  // v2.0 新增
  activeView = "chat",
  onNavigate,
}: SidebarProps) {
  const [searchQuery, setSearchQuery] = useState("");
  // 当前 tab：默认「项目」
  const [activeTab, setActiveTab] = useState<TabKey>(() =>
    syncStore.getItem("sidebar-active-tab", "projects") as TabKey
  );
  // 每个项目文件夹独立的折叠状态 { [cwd]: boolean }
  const [folderCollapsedMap, setFolderCollapsedMap] = useState<Record<string, boolean>>(() =>
    syncStore.getItem("project-folders-collapsed", {}) as Record<string, boolean>
  );
  const [showAddProject, setShowAddProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [projectDir, setProjectDir] = useState("");
  const [pickingFolder, setPickingFolder] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [copyConfirm, setCopyConfirm] = useState<string | null>(null);
  const [copyTitle, setCopyTitle] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");

  // 持久化项目文件夹折叠状态
  useEffect(() => {
    syncStore.setItem("project-folders-collapsed", folderCollapsedMap);
  }, [folderCollapsedMap]);

  // 持久化当前 tab
  useEffect(() => {
    syncStore.setItem("sidebar-active-tab", activeTab);
  }, [activeTab]);

  // 移动端切换 tab 时维持 drawer 展开（用户需求：方便在项目/通用间切换）
  const handleTabChange = useCallback((tab: TabKey) => {
    setActiveTab(tab);
    // ❌ 不再 onClose()，让用户继续在 drawer 内切换 tab
  }, []);

  // 移动端切换对话后自动关闭 drawer
  const handleSwitchConversation = useCallback((id: string) => {
    onSwitchConversation(id);
    onClose?.();
  }, [onSwitchConversation, onClose]);

  // 项目对话 = 有 cwd 的对话
  const projectConversations = useMemo(
    () => conversations.filter(c => c.cwd),
    [conversations]
  );
  // 普通对话 = 无 cwd 的对话
  const normalConversations = useMemo(
    () => conversations.filter(c => !c.cwd),
    [conversations]
  );

  // 归一化路径：Windows 路径不区分大小写，处理尾部反斜杠差异
  const normalizePath = (p: string) => p.toLowerCase().replace(/\//g, '\\').replace(/\\+$/, '');

  // 派生：当前激活对话的归一化项目路径（用于项目激活态判断）
  const activeProjectPath = useMemo(() => {
    const activeConv = conversations.find(c => c.id === activeConversationId);
    return activeConv?.cwd ? normalizePath(activeConv.cwd) : null;
  }, [conversations, activeConversationId]);

  // 按 cwd 分组
  const groupedProjects = useMemo(() => {
    return projectConversations.reduce<Record<string, Conversation[]>>((acc, conv) => {
      const normalized = normalizePath(conv.cwd!);
      if (!acc[normalized]) acc[normalized] = [];
      acc[normalized].push(conv);
      return acc;
    }, {});
  }, [projectConversations]);

  // 保留原始路径用于显示（取该分组中第一个对话的 cwd）
  const originalDirMap = useMemo(() => {
    return projectConversations.reduce<Record<string, string>>((acc, conv) => {
      const normalized = normalizePath(conv.cwd!);
      if (!acc[normalized]) acc[normalized] = conv.cwd!;
      return acc;
    }, {});
  }, [projectConversations]);

  // 按目录路径排序
  const sortedDirs = useMemo(() => Object.keys(groupedProjects).sort(), [groupedProjects]);

  /** 切换文件夹的折叠状态 */
  const toggleFolder = (dir: string) => {
    setFolderCollapsedMap(prev => ({ ...prev, [dir]: !prev[dir] }));
  };

  /** 在指定文件夹下新建对话
   *  v1.5 变更：不再把 folderName 作为 title 传入，留空让 chat.newConversation 用默认"新对话"，
   *  配合 MainApp 的去重逻辑避免连点 + 产生一堆空白"dev"项。
   */
  const handleNewConvInFolder = (dir: string) => {
    onNewProjectConversation("", dir);
  };

  // 拷贝弹窗重名检测
  const isDuplicate = copyConfirm
    ? conversations.some(c => c.id !== copyConfirm && c.title === copyTitle.trim())
    : false;

  // 检测是否存在空的普通对话（保留逻辑：未来如需恢复顶部 + 按钮可直接启用）
  // 注：v1.4 起已不再使用，保留 hook 供未来扩展
  // const hasEmptyConversation = normalConversations.some(c => c.messages.length === 0);

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

  // 渲染 Primary Nav 项
  const renderPrimaryNavItem = (
    Icon: LucideIcon,
    label: string,
    count: number,
    onClick?: () => void,
    active = false
  ) => {
    const content = (
      <>
        <span className="primary-nav-left">
          <Icon size={14} />
          <span>{label}</span>
        </span>
        <span className="primary-nav-right">
          <span className="nav-badge">{count}</span>
          <ChevronRight size={12} className="nav-arrow" />
        </span>
      </>
    );
    if (onClick) {
      return (
        <button
          onClick={onClick}
          className={`nav-item ${active ? "active" : ""}`}
          type="button"
        >
          {content}
        </button>
      );
    }
    return (
      <div className="nav-item opacity-50 cursor-not-allowed" title="敬请期待">
        {content}
      </div>
    );
  };

  return (
    <aside
      className={[
        "sidebar",
        isOpen ? "open" : "",
        isCollapsed ? "collapsed" : "",
      ].filter(Boolean).join(" ")}
      aria-hidden={isCollapsed}
    >
      {/* ===== 顶部区域：Logo ===== */}
      <div className="titlebar-drag sidebar-top">
        <div className="titlebar-no-drag logo">
          <div className="logo-mark">R</div>
          <span className="logo-text">Ripple</span>
        </div>
      </div>

      {/* ===== 搜索框（跨 tab 可见） ===== */}
      <div className="titlebar-no-drag sidebar-search">
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-content-tertiary dark:text-content-tertiary-dark pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索对话..."
            className="sidebar-search-input"
          />
        </div>
      </div>

      {/* ===== 主导航：专家 / 记忆（v2.0：跳转对应页） ===== */}
      <nav className="titlebar-no-drag primary-nav">
        {renderPrimaryNavItem(
          Users,
          "专家",
          expertCount,
          () => onNavigate?.("experts"),
          activeView === "experts"
        )}
        {renderPrimaryNavItem(
          Brain,
          "记忆",
          memoryCount,
          () => onNavigate?.("memory"),
          activeView === "memory"
        )}
      </nav>

      {/* ===== Segmented Tabs：项目 / 通用 ===== */}
      <div className="titlebar-no-drag segmented" role="tablist">
        <button
          role="tab"
          aria-selected={activeTab === "projects"}
          className={`seg-btn ${activeTab === "projects" ? "active" : ""}`}
          onClick={() => handleTabChange("projects")}
        >
          项目
        </button>
        <button
          role="tab"
          aria-selected={activeTab === "general"}
          className={`seg-btn ${activeTab === "general" ? "active" : ""}`}
          onClick={() => handleTabChange("general")}
        >
          通用
        </button>
      </div>

      {/* ===== 列表区 ===== */}
      <div className="sidebar-scroll titlebar-no-drag">
        {/* 项目 tab */}
        {activeTab === "projects" && (
          <>
            <div className="section-head">
              <span className="section-title">项目</span>
              <div className="section-actions">
                <button
                  className="icon-btn-xs"
                  title="排序"
                  aria-label="排序"
                  onClick={() => {/* 排序功能后续实现 */}}
                >
                  <ArrowUpDown size={12} />
                </button>
                <button
                  className="icon-btn-xs"
                  title="新建项目"
                  aria-label="新建项目"
                  onClick={handleOpenAddProject}
                >
                  <Plus size={13} />
                </button>
              </div>
            </div>
            <div className="tree">
              {sortedDirs.length === 0 ? (
                <div className="empty-hint">
                  <p>暂无项目，点击 + 新建</p>
                </div>
              ) : (
                sortedDirs.map((normalizedDir) => {
                  const convs = groupedProjects[normalizedDir];
                  const dir = originalDirMap[normalizedDir] || normalizedDir;
                  const isCollapsedFolder = folderCollapsedMap[normalizedDir] !== false; // 默认展开
                  const isActive = activeProjectPath === normalizedDir;
                  const folderName = dir.replace(/\\/g, '/').split('/').filter(Boolean).pop() || dir;

                  return (
                    <div key={normalizedDir} className="tree-group">
                      <button
                        onClick={() => toggleFolder(normalizedDir)}
                        className={`tree-node folder ${isCollapsedFolder ? "folded" : ""} ${isActive ? "active" : ""}`}
                      >
                        <ChevronDown size={11} className="tree-chevron shrink-0" />
                        {isCollapsedFolder ? (
                          <Folder size={12} className="shrink-0 text-accent/50" />
                        ) : (
                          <FolderOpen size={12} className="shrink-0 text-accent/70" />
                        )}
                        <span className="tree-label">{folderName}</span>
                        <span className="tree-count">{convs.length}</span>
                        {/* v1.4 新增：hover 暴露"在项目下新建对话"按钮
                         *  - 未激活：仅 hover 可见
                         *  - 激活：常驻可见
                         */}
                        <span
                          onClick={(e) => {
                            e.stopPropagation();
                            handleNewConvInFolder(dir);
                          }}
                          className={`tree-folder-action ${isActive ? "visible" : ""}`}
                          title="在当前项目下新建对话"
                          role="button"
                          tabIndex={0}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              e.stopPropagation();
                              handleNewConvInFolder(dir);
                            }
                          }}
                        >
                          <MessageSquarePlus size={12} />
                        </span>
                      </button>
                      {!isCollapsedFolder && (
                        <div className="tree-children">
                          {/* 完整路径（仅展开时显示，提示 cwd） */}
                          <div className="tree-folder-path" title={dir}>
                            {dir}
                          </div>
                          {convs.map((conv) => (
                            <div key={conv.id} className="group relative">
                              <button
                                onClick={() => onSwitchConversation(conv.id)}
                                className={`tree-node leaf ${
                                  conv.id === activeConversationId ? "active" : ""
                                }`}
                              >
                                <Code size={12} className="shrink-0 text-content-tertiary/60 dark:text-content-tertiary-dark/60" />
                                <div className="flex-1 min-w-0 overflow-hidden text-left">
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
                                      className="w-full text-xs bg-surface dark:bg-surface-dark px-1 py-0.5 rounded border border-accent/40 outline-none"
                                      autoFocus
                                      onClick={(e) => e.stopPropagation()}
                                    />
                                  ) : (
                                    <span className="truncate">{conv.title}</span>
                                  )}
                                </div>
                                <div className="leaf-actions">
                                  {/* ✅ 与通用对话一致：仅 active 时显示 Copy 按钮（line 583 同款逻辑） */}
                                  {conv.id === activeConversationId && (
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setCopyConfirm(conv.id);
                                        setCopyTitle(`${conv.title} - 副本`);
                                      }}
                                      className="leaf-action hover:!text-green-500"
                                      title="拷贝对话"
                                    >
                                      <Copy size={10} />
                                    </button>
                                  )}
                                  <button
                                    onClick={(e) => { e.stopPropagation(); setRenamingId(conv.id); setRenameText(conv.title); }}
                                    className="leaf-action"
                                    title="重命名"
                                  >
                                    <Pencil size={10} />
                                  </button>
                                  <button
                                    onClick={(e) => { e.stopPropagation(); setDeleteConfirm(conv.id); }}
                                    className="leaf-action hover:!text-red-500"
                                    title="删除"
                                  >
                                    <Trash2 size={10} />
                                  </button>
                                </div>
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </>
        )}

        {/* 通用 tab */}
        {activeTab === "general" && (
          <>
            <div className="section-head">
              <span className="section-title">
                {searchQuery ? "搜索结果" : "对话"}
              </span>
              <div className="section-actions">
                <span className="section-count">{filteredNormalConversations.length}</span>
                <button
                  className="icon-btn-xs"
                  title="新建对话"
                  aria-label="新建对话"
                  onClick={() => onNewConversation?.()}
                >
                  <MessageSquarePlus size={13} />
                </button>
              </div>
            </div>
            <div className="tree">
              {filteredNormalConversations.length === 0 ? (
                <div className="empty-hint">
                  <div className="empty-icon">
                    <MessageSquare size={16} />
                  </div>
                  <p>
                    {searchQuery ? "未找到匹配的对话" : "还没有对话，点击 + 新建"}
                  </p>
                </div>
              ) : (
                filteredNormalConversations.map((conv) => (
                  <div key={conv.id} className="group relative">
                    <button
                      onClick={() => handleSwitchConversation(conv.id)}
                      className={`tree-node leaf ${
                        conv.id === activeConversationId ? "active" : ""
                      }`}
                    >
                      <MessageSquare size={13} className="shrink-0 text-content-tertiary/70 dark:text-content-tertiary-dark/70" />
                      <div className="flex-1 min-w-0 overflow-hidden text-left">
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
                      <div className="leaf-actions">
                        {conv.id === activeConversationId && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setCopyConfirm(conv.id);
                              setCopyTitle(`${conv.title} - 副本`);
                            }}
                            className="leaf-action hover:!text-green-500"
                            title="拷贝对话"
                          >
                            <Copy size={11} />
                          </button>
                        )}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (renamingId === conv.id) {
                              // 已编辑状态：再次点击 = 保存（与 onBlur / Enter 行为一致）
                              if (renameText.trim()) onRenameConversation(conv.id, renameText.trim());
                              setRenamingId(null);
                            } else {
                              setRenamingId(conv.id);
                              setRenameText(conv.title);
                            }
                          }}
                          className="leaf-action"
                          title={renamingId === conv.id ? "保存" : "重命名"}
                        >
                          {renamingId === conv.id ? <Check size={11} /> : <Pencil size={11} />}
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); setDeleteConfirm(conv.id); }}
                          className="leaf-action hover:!text-red-500"
                          title="删除"
                        >
                          <Trash2 size={11} />
                        </button>
                      </div>
                    </button>
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </div>

      {/* ===== 底部：User Pill + 主题按钮 ===== */}
      <div className="titlebar-no-drag sidebar-foot">
        <button
          onClick={onOpenSettings}
          className={`user-pill ${activeView === "settings" ? "active" : ""}`}
          title="设置"
          aria-label="设置"
          aria-current={activeView === "settings" ? "page" : undefined}
        >
          <div className="user-avatar">
            <Settings size={14} />
          </div>
          <span className="user-name">设置</span>
        </button>
        <button
          onClick={onToggleDarkMode}
          className="icon-btn"
          title={darkMode ? "切换到浅色" : "切换到深色"}
          aria-label="切换主题"
        >
          {darkMode ? <Sun size={14} /> : <Moon size={14} />}
        </button>
      </div>

      {/* ===== 新建项目对话弹窗 ===== */}
      {showAddProject && (
        <div className="modal-overlay">
          <div className="modal-card">
            <div className="modal-head">
              <h3 className="modal-title">新建项目对话</h3>
              <button onClick={() => { setShowAddProject(false); setProjectDir(""); }} className="icon-btn !p-1">
                <X size={15} />
              </button>
            </div>

            <label className="modal-label">对话名称</label>
            <input
              type="text"
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              placeholder="输入名称"
              className="modal-input"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && projectDir) confirmAddProject();
              }}
            />

            <label className="modal-label">项目目录</label>
            <div className="modal-row">
              <div className="modal-dir-display">
                {projectDir ? (
                  <span className="truncate text-content dark:text-content-dark">{projectDir}</span>
                ) : (
                  <span className="text-content-tertiary dark:text-content-tertiary-dark">请选择本地文件夹</span>
                )}
              </div>
              <button
                onClick={handlePickFolder}
                disabled={pickingFolder}
                className="btn-secondary"
              >
                {pickingFolder ? "选择中..." : "浏览"}
              </button>
            </div>

            <div className="modal-actions">
              <button
                onClick={() => { setShowAddProject(false); setProjectDir(""); }}
                className="btn-secondary flex-1"
              >
                取消
              </button>
              <button
                onClick={confirmAddProject}
                disabled={!newProjectName.trim() || !projectDir.trim()}
                className="btn-primary flex-1"
              >
                创建
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===== 删除对话确认弹窗 ===== */}
      {deleteConfirm && (
        <div className="modal-overlay">
          <div className="modal-card modal-card-sm">
            <h3 className="modal-title">确认删除</h3>
            <p className="modal-desc">
              确定要删除这条对话记录吗？后端数据也将被删除，此操作不可撤销。
            </p>
            <div className="modal-actions">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="btn-secondary flex-1"
              >
                取消
              </button>
              <button
                onClick={() => {
                  onDeleteConversation(deleteConfirm);
                  setDeleteConfirm(null);
                }}
                className="btn-danger flex-1"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===== 拷贝对话弹窗 ===== */}
      {copyConfirm && (
        <div className="modal-overlay">
          <div className="modal-card modal-card-sm">
            <h3 className="modal-title">拷贝对话</h3>
            <p className="modal-desc">
              将创建一份完整的副本（含所有消息和快照），与原对话完全独立。
            </p>
            <label className="modal-label">新对话标题</label>
            <input
              type="text"
              value={copyTitle}
              onChange={(e) => setCopyTitle(e.target.value)}
              className="modal-input"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && copyTitle.trim() && !isDuplicate) {
                  onCopyConversation(copyConfirm, copyTitle.trim());
                  setCopyConfirm(null);
                }
              }}
            />
            {isDuplicate && (
              <p className="modal-warn">已存在同名对话，请修改标题</p>
            )}
            <div className="modal-actions">
              <button
                onClick={() => setCopyConfirm(null)}
                className="btn-secondary flex-1"
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
                className="btn-success flex-1"
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
