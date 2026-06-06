import { useState, useEffect } from "react";
import {
  Save,
  AlertTriangle,
  RefreshCw,
  ChevronDown,
} from "lucide-react";
import ChatFabButton from "./ChatFabButton";
import {
  fetchGeneralMemory,
  saveGeneralMemory,
  fetchProjectMemory,
  saveProjectMemory,
} from "ripple-shared/api";

/**
 * 记忆管理页 — v2.2（纯云端版）
 *  - 所有记忆文件存储在云端（agent/data/memory/）
 *  - 云端优先：先写云端，成功才更新本地 state
 *  - 不再依赖 Tauri 本地磁盘或 localStorage
 */

interface MemoryFile {
  name: string;
  desc: string;
  template: string;  // 文件不存在时的初始内容
}

const GENERAL_FILES: MemoryFile[] = [
  {
    name: "MEMORY.md",
    desc: "核心画像与稳定决策。AI 蒸馏的产物，修改前建议备份。",
    template:
      "# MEMORY\n\n这里是跨项目长期记忆与稳定决策的沉淀区。\n\n## 偏好\n- 默认深色主题\n- 中文优先，关键术语保留英文\n\n## 关键决策\n- 桌面端技术栈：React 18 + TypeScript + Tauri 2\n\n## 待沉淀\n- 来自 .agent-orchestration/memories/ 的高频经验\n",
  },
  {
    name: "hot-topics.md",
    desc: "当前活跃主题与进行中的项目。文件不存在时会自动创建。",
    template:
      "# Hot Topics\n\n- [在办] Ripple 桌面端 · 记忆管理重构\n- [关注] mcp-tool 生态：playwright / dev-dispatcher\n",
  },
];

export interface ProjectInfo {
  id: string;     // normalized cwd（去重 key）
  label: string;  // 路径末段（用于下拉显示）
  path: string;   // 完整 cwd
}

const PROJECT_FILES: MemoryFile[] = [
  {
    name: "ripple.md",
    desc: "项目级 Ripple 记忆。存储该项目专属的上下文与约定。",
    template: "# ripple.md\n\n本项目专属的 Ripple 记忆。\n\n## 项目目标\n- 维护个人 AI 助手桌面端\n",
  },
  {
    name: "agent.md",
    desc: "Agent 运行配置与行为约束。",
    template: "# agent.md\n\n## 工具白名单\n- read_file / write_file / list_dir\n- shell（截断 50KB）\n",
  },
];

/** 单个文件的运行时状态 */
interface FileState {
  /** 当前编辑器中的内容 */
  content: string;
  /** 上次成功保存的内容（用于 dirty 检测） */
  saved: string;
}

type FileStates = Record<string, FileState>;

interface MemoryPageProps {
  /** 顶栏左侧菜单按钮回调 */
  onMenuClick?: () => void;
  /**
   * 项目列表（来自 Sidebar/MainApp 派生的 conversations.cwd 去重）
   * 不传则项目 tab 提示「请先在左侧添加项目」
   */
  projects?: ProjectInfo[];
  /** Chat FAB 回调：返回聊天首页 */
  onBackToChat?: () => void;
}

export function MemoryPage({ onMenuClick, projects = [], onBackToChat }: MemoryPageProps) {
  const [activeTab, setActiveTab] = useState<"general" | "project">("general");

  return (
    <>
      <section className="page" id="page-memory">
        <header className="page-header">
          <div className="page-header-left">
            {onMenuClick && (
              <button
                className="icon-btn"
                onClick={onMenuClick}
                aria-label="菜单"
                title="菜单"
            >
              <MenuIcon />
            </button>
          )}
          <div className="page-title-wrap">
            <h1 className="page-title">记忆管理</h1>
            <p className="page-sub">记忆文件存储在云端，所有设备自动同步</p>
          </div>
        </div>
        <div className="page-header-right">
          <ReloadButton
            onReload={() => {
              window.dispatchEvent(new CustomEvent("ripple-memory-reload"));
            }}
          />
        </div>
      </header>

      <div className="tabs" role="tablist">
        <button
          role="tab"
          aria-selected={activeTab === "general"}
          className={`tab ${activeTab === "general" ? "active" : ""}`}
          onClick={() => setActiveTab("general")}
        >
          通用记忆
          <span className="tab-count">{GENERAL_FILES.length}</span>
        </button>
        <button
          role="tab"
          aria-selected={activeTab === "project"}
          className={`tab ${activeTab === "project" ? "active" : ""}`}
          onClick={() => setActiveTab("project")}
        >
          项目记忆
          <span className="tab-count">{projects.length}</span>
        </button>
      </div>

      <div className="content">
        {activeTab === "general" ? (
          <GeneralMemoryPane />
        ) : (
          <ProjectMemoryPane projects={projects} />
        )}
      </div>
      </section>
      {onBackToChat && <ChatFabButton onClick={onBackToChat} />}
    </>
  );
}

/* ============================================================
 *  ReloadButton
 * ============================================================ */
interface ReloadButtonProps {
  onReload: () => void;
}
function ReloadButton({ onReload }: ReloadButtonProps) {
  const handleClick = () => {
    if (window.confirm("重新加载会丢弃当前所有未保存的修改，确定继续？")) {
      onReload();
    }
  };
  return (
    <button
      className="page-btn-secondary"
      onClick={handleClick}
      title="重新加载：丢弃未保存的修改，从云端重新读取"
    >
      <RefreshCw size={14} />
      <span>重新加载</span>
    </button>
  );
}

/* ============================================================
 *  通用记忆 Pane
 * ============================================================ */
function GeneralMemoryPane() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fileStates, setFileStates] = useState<FileStates>({});
  const [activeFileName, setActiveFileName] = useState<string>(GENERAL_FILES[0].name);
  const [reloadNonce, setReloadNonce] = useState(0);

  // 初始化：从云端加载所有通用记忆文件
  useEffect(() => {
    const init = async () => {
      setLoading(true);
      setError(null);
      try {
        const states: FileStates = {};
        for (const f of GENERAL_FILES) {
          try {
            const res = await fetchGeneralMemory(f.name);
            if (res.data?.content) {
              states[f.name] = { content: res.data.content, saved: res.data.content };
            } else {
              states[f.name] = { content: f.template, saved: "" };
            }
          } catch {
            states[f.name] = { content: f.template, saved: "" };
          }
        }
        setFileStates(states);
      } catch (e) {
        setError((e as Error).message || String(e));
        // 兜底模板
        const states: FileStates = {};
        GENERAL_FILES.forEach(f => { states[f.name] = { content: f.template, saved: "" }; });
        setFileStates(states);
      } finally {
        setLoading(false);
      }
    };
    init();
  }, [reloadNonce]);

  // 监听全局 reload 事件
  useEffect(() => {
    const handler = () => setReloadNonce(n => n + 1);
    window.addEventListener("ripple-memory-reload", handler);
    return () => window.removeEventListener("ripple-memory-reload", handler);
  }, []);

  const file = GENERAL_FILES.find(f => f.name === activeFileName);
  if (!file) return null;
  const state = fileStates[file.name] ?? { content: "", saved: "" };
  const isDirty = state.content !== state.saved;

  const handleChange = (v: string) => {
    setFileStates(prev => ({ ...prev, [file.name]: { content: v, saved: prev[file.name]?.saved ?? "" } }));
  };

  const handleSave = async () => {
    // 云优先：先写云端，成功才更新本地 state
    try {
      const res = await saveGeneralMemory(file.name, state.content);
      if (res.error) {
        setError(`保存失败：${res.error}`);
        return;
      }
      setFileStates(prev => ({
        ...prev,
        [file.name]: { content: state.content, saved: state.content },
      }));
      setError(null);
    } catch (e) {
      setError(`保存失败：${(e as Error).message || String(e)}`);
    }
  };

  const handleDiscard = () => {
    setFileStates(prev => ({
      ...prev,
      [file.name]: { content: prev[file.name].saved, saved: prev[file.name].saved },
    }));
  };

  return (
    <div className="resource-list memory-editor-pane">
      {error && (
        <div className="file-warn" style={{ marginBottom: 12 }}>
          <AlertTriangle size={14} />
          <div><strong>错误</strong> — {error}</div>
        </div>
      )}
      <div className="file-tabs">
        {GENERAL_FILES.map(f => (
          <FileTab
            key={f.name}
            name={f.name}
            active={f.name === activeFileName}
            onClick={() => setActiveFileName(f.name)}
          />
        ))}
      </div>
      {loading ? (
        <div className="file-editor" style={{ padding: 24, textAlign: "center", color: "var(--color-text-secondary)" }}>
          加载中…
        </div>
      ) : (
        <FileEditor
          file={file}
          value={state.content}
          isDirty={isDirty}
          onChange={handleChange}
          onSave={handleSave}
          onDiscard={handleDiscard}
        />
      )}
    </div>
  );
}

/* ============================================================
 *  项目记忆 Pane
 * ============================================================ */
interface ProjectMemoryPaneProps {
  projects: ProjectInfo[];
}

function ProjectMemoryPane({ projects }: ProjectMemoryPaneProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(
    projects.length > 0 ? projects[0].id : null
  );
  const [activeFileName, setActiveFileName] = useState<string>(PROJECT_FILES[0].name);
  // 双层字典：states[projectId][fileName]
  const [states, setStates] = useState<Record<string, FileStates>>({});
  const [reloadNonce, setReloadNonce] = useState(0);

  // 当 projects 列表变化时，重置 activeProjectId
  useEffect(() => {
    if (activeProjectId && projects.find(p => p.id === activeProjectId)) return;
    setActiveProjectId(projects.length > 0 ? projects[0].id : null);
  }, [projects, activeProjectId]);

  // 初始化：从云端加载所有项目记忆文件
  useEffect(() => {
    const init = async () => {
      if (projects.length === 0) {
        setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const next: Record<string, FileStates> = {};
        for (const p of projects) {
          next[p.id] = {};
          for (const f of PROJECT_FILES) {
            try {
              const res = await fetchProjectMemory(p.path, f.name);
              if (res.data?.content) {
                next[p.id][f.name] = { content: res.data.content, saved: res.data.content };
              } else {
                next[p.id][f.name] = { content: f.template, saved: "" };
              }
            } catch {
              next[p.id][f.name] = { content: f.template, saved: "" };
            }
          }
        }
        setStates(next);
      } catch (e) {
        setError((e as Error).message || String(e));
      } finally {
        setLoading(false);
      }
    };
    init();
  }, [reloadNonce, projects]);

  useEffect(() => {
    const handler = () => setReloadNonce(n => n + 1);
    window.addEventListener("ripple-memory-reload", handler);
    return () => window.removeEventListener("ripple-memory-reload", handler);
  }, []);

  // 无项目时显示空态
  if (projects.length === 0) {
    return (
      <div className="resource-list memory-editor-pane">
        <div className="file-warn" style={{ marginBottom: 12 }}>
          <AlertTriangle size={14} />
          <div>
            <strong>暂无项目</strong> — 请先在左侧 Sidebar 点击「+ 新建项目」添加项目目录。
          </div>
        </div>
      </div>
    );
  }

  const project = projects.find(p => p.id === activeProjectId) ?? projects[0];
  const file = PROJECT_FILES.find(f => f.name === activeFileName);
  if (!project || !file) return null;

  const state = states[project.id]?.[file.name] ?? { content: "", saved: "" };
  const isDirty = state.content !== state.saved;

  const handleChange = (v: string) => {
    setStates(prev => ({
      ...prev,
      [project.id]: { ...prev[project.id], [file.name]: { content: v, saved: prev[project.id]?.[file.name]?.saved ?? "" } },
    }));
  };

  const handleSave = async () => {
    // 云优先：先写云端，成功才更新本地 state
    try {
      const res = await saveProjectMemory(project.path, file.name, state.content);
      if (res.error) {
        setError(`保存失败：${res.error}`);
        return;
      }
      setStates(prev => ({
        ...prev,
        [project.id]: {
          ...prev[project.id],
          [file.name]: { content: state.content, saved: state.content },
        },
      }));
      setError(null);
    } catch (e) {
      setError(`保存失败：${(e as Error).message || String(e)}`);
    }
  };

  const handleDiscard = () => {
    setStates(prev => ({
      ...prev,
      [project.id]: {
        ...prev[project.id],
        [file.name]: { content: prev[project.id]?.[file.name]?.saved ?? "", saved: prev[project.id]?.[file.name]?.saved ?? "" },
      },
    }));
  };

  return (
    <div className="resource-list memory-editor-pane">
      {error && (
        <div className="file-warn" style={{ marginBottom: 12 }}>
          <AlertTriangle size={14} />
          <div><strong>错误</strong> — {error}</div>
        </div>
      )}
      <div className="project-selector">
        <label className="project-selector-label" htmlFor="project-select">
          选择项目
        </label>
        <div className="project-selector-wrap">
          <select
            id="project-select"
            className="project-select"
            value={activeProjectId ?? ""}
            onChange={(e) => setActiveProjectId(e.target.value)}
          >
            {projects.map(p => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
          <ChevronDown className="project-select-chevron" size={14} />
        </div>
      </div>
      <div className="file-tabs">
        {PROJECT_FILES.map(f => (
          <FileTab
            key={f.name}
            name={f.name}
            active={f.name === activeFileName}
            onClick={() => setActiveFileName(f.name)}
          />
        ))}
      </div>
      {loading ? (
        <div className="file-editor" style={{ padding: 24, textAlign: "center", color: "var(--color-text-secondary)" }}>
          加载中…
        </div>
      ) : (
        <FileEditor
          file={file}
          value={state.content}
          isDirty={isDirty}
          onChange={handleChange}
          onSave={handleSave}
          onDiscard={handleDiscard}
        />
      )}
    </div>
  );
}

/* ============================================================
 *  通用组件
 * ============================================================ */
interface FileTabProps {
  name: string;
  active: boolean;
  onClick: () => void;
}
function FileTab({ name, active, onClick }: FileTabProps) {
  return (
    <button className={`file-tab ${active ? "active" : ""}`} onClick={onClick}>
      <span className="file-tab-dot" />
      <span>{name}</span>
    </button>
  );
}

interface FileEditorProps {
  file: MemoryFile;
  value: string;
  isDirty: boolean;
  onChange: (v: string) => void;
  onSave: () => void;
  onDiscard: () => void;
}
function FileEditor({
  file,
  value,
  isDirty,
  onChange,
  onSave,
  onDiscard,
}: FileEditorProps) {
  const statusText = isDirty ? "未保存" : "已是最新";
  const statusClass = isDirty ? "status-dirty" : "status-saved";

  return (
    <div className="file-editor">
      <div className="file-editor-head">
        <div>
          <h3 className="file-editor-title">{file.name}</h3>
          <p className="file-editor-desc">{file.desc}</p>
        </div>
        <div className={`file-editor-status ${statusClass}`}>
          <span>{statusText}</span>
        </div>
      </div>
      <div className="file-textarea-wrap">
        <textarea
          className={`file-textarea ${isDirty ? "dirty" : ""}`}
          value={value}
          spellCheck={false}
          placeholder={`开始编辑 ${file.name}…`}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
      <div className="file-editor-foot">
        <span className="dirty-hint" hidden={!isDirty}>
          <AlertTriangle size={13} />
          <span>有未保存的修改</span>
        </span>
        <div className="file-editor-foot-actions">
          <button
            className="btn-ghost"
            onClick={onDiscard}
            disabled={!isDirty}
          >
            放弃修改
          </button>
          <button
            className="page-btn"
            onClick={onSave}
            disabled={!isDirty}
          >
            <Save size={14} />
            <span>保存到云端</span>
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
 *  小图标
 * ============================================================ */
function MenuIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}

export default MemoryPage;
