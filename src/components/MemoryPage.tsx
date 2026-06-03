import { useState, useEffect } from "react";
import {
  Save,
  AlertTriangle,
  RefreshCw,
  ChevronDown,
} from "lucide-react";
import { syncStore } from "../hooks/useStore";
import { isTauri } from "../hooks/useTauri";
import {
  getAppRoot,
  ensureMemoryDir,
  readTextFile,
  writeTextFile,
  pathExists,
} from "../services/appPaths";
import { logger } from "./LogPanel";

/**
 * 记忆管理页 — v2.0（真实 fs 版本）
 *  - 通用记忆：<app-root>/memory/ 下的 2 个 .md
 *  - 项目记忆：用户通过 Sidebar 添加的每个项目根目录下的 .md
 *  - Tauri 模式：真实磁盘读写
 *  - 浏览器 dev 模式：localStorage 兜底（已有 syncStore）
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
  {
    name: "README.md",
    desc: "项目说明文档（真实 README，非记忆文件）。",
    template: "# Project\n\n项目根目录说明。\n",
  },
];

// localStorage 持久化 key（仅浏览器 dev 模式使用）
const LS_KEY_GENERAL = "ripple-memory-general-v1";
const LS_KEY_PROJECT = (pid: string) => `ripple-memory-project-v1-${pid}`;

/** 单个文件的运行时状态 */
interface FileState {
  /** 当前编辑器中的内容 */
  content: string;
  /** 上次成功保存的内容（用于 dirty 检测） */
  saved: string;
  /** 磁盘上是否存在（仅 Tauri 模式有效） */
  exists: boolean;
  /** 文件 mtime（Unix 毫秒，仅 Tauri 模式从磁盘读取） */
  mtimeMs: number | null;
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
}

export function MemoryPage({ onMenuClick, projects = [] }: MemoryPageProps) {
  const [activeTab, setActiveTab] = useState<"general" | "project">("general");

  return (
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
            <p className="page-sub">通用记忆位于桌面软件根目录的 memory/ 子目录</p>
          </div>
        </div>
        <div className="page-header-right">
          {activeTab === "general" ? (
            <ReloadButton
              onReload={() => {
                // 通用 tab：清掉 localStorage 暂存 + 触发子组件重载
                syncStore.removeItem(LS_KEY_GENERAL);
                projects.forEach(p => syncStore.removeItem(LS_KEY_PROJECT(p.id)));
                window.dispatchEvent(new CustomEvent("ripple-memory-reload"));
              }}
            />
          ) : (
            <ReloadButton
              onReload={() => {
                projects.forEach(p => syncStore.removeItem(LS_KEY_PROJECT(p.id)));
                window.dispatchEvent(new CustomEvent("ripple-memory-reload"));
              }}
            />
          )}
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
      title="重新加载：丢弃未保存的修改，重新从磁盘读取"
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
  const [appRoot, setAppRoot] = useState<string | null>(null);
  const [tauriMode, setTauriMode] = useState<boolean>(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [fileStates, setFileStates] = useState<FileStates>({});
  const [activeFileName, setActiveFileName] = useState<string>(GENERAL_FILES[0].name);
  const [reloadNonce, setReloadNonce] = useState(0);

  // 初始化：探测 Tauri 环境 → 拿 app_root → 加载所有文件
  useEffect(() => {
    const init = async () => {
      const isTauriEnv = isTauri();
      setTauriMode(isTauriEnv);
      if (!isTauriEnv) {
        // 浏览器 dev 模式：localStorage 兜底
        loadFromLocalStorage();
        return;
      }
      try {
        const root = await getAppRoot();
        await ensureMemoryDir(root);
        setAppRoot(root);
        await loadAllFromDisk(root);
      } catch (e) {
        const msg = (e as Error).message || String(e);
        setInitError(`初始化失败：${msg}`);
        logger.error(`记忆模块初始化失败：${msg}`);
        loadFromLocalStorage();  // 兜底
      }
    };
    init();
  }, [reloadNonce]);

  // 监听全局 reload 事件（来自 ReloadButton）
  useEffect(() => {
    const handler = () => setReloadNonce(n => n + 1);
    window.addEventListener("ripple-memory-reload", handler);
    return () => window.removeEventListener("ripple-memory-reload", handler);
  }, []);

  /** 从磁盘加载所有 GENERAL_FILES 的最新内容 */
  const loadAllFromDisk = async (root: string) => {
    const states: FileStates = {};
    for (const f of GENERAL_FILES) {
      const path = `${root}\\memory\\${f.name}`;
      try {
        const exists = await pathExists(path);
        if (exists) {
          const { content, mtime_ms } = await readTextFile(path);
          states[f.name] = { content, saved: content, exists: true, mtimeMs: mtime_ms };
        } else {
          states[f.name] = { content: f.template, saved: "", exists: false, mtimeMs: null };
        }
      } catch (e) {
        logger.error(`读取 ${f.name} 失败：${e}`);
        states[f.name] = { content: f.template, saved: "", exists: false, mtimeMs: null };
      }
    }
    setFileStates(states);
  };

  /** localStorage 兜底加载 */
  const loadFromLocalStorage = () => {
    const stored = syncStore.getItem<Record<string, string>>(LS_KEY_GENERAL, {});
    const states: FileStates = {};
    GENERAL_FILES.forEach(f => {
      const content = stored[f.name] ?? f.template;
      states[f.name] = { content, saved: content, exists: true, mtimeMs: null };
    });
    setFileStates(states);
  };

  const file = GENERAL_FILES.find(f => f.name === activeFileName);
  if (!file) return null;
  const state = fileStates[file.name] ?? { content: "", saved: "", exists: false, mtimeMs: null };
  const isDirty = state.content !== state.saved;
  const fullPath = appRoot ? `${appRoot}\\memory\\${file.name}` : `(本地暂存) ${file.name}`;

  const handleChange = (v: string) => {
    setFileStates(prev => ({ ...prev, [file.name]: { ...prev[file.name], content: v } }));
  };

  const handleSave = async () => {
    if (tauriMode && appRoot) {
      const path = `${appRoot}\\memory\\${file.name}`;
      try {
        await writeTextFile(path, state.content);
        // 保存后重新读一次以拿到真实 mtime
        try {
          const { mtime_ms } = await readTextFile(path);
          setFileStates(prev => ({
            ...prev,
            [file.name]: { content: state.content, saved: state.content, exists: true, mtimeMs: mtime_ms },
          }));
        } catch {
          // 写成功但重读失败，用 Date.now() 兜底
          setFileStates(prev => ({
            ...prev,
            [file.name]: { content: state.content, saved: state.content, exists: true, mtimeMs: Date.now() },
          }));
        }
        logger.success(`已保存 ${file.name}`);
      } catch (e) {
        const msg = (e as Error).message || String(e);
        logger.error(`保存 ${file.name} 失败：${msg}`);
        // 写盘失败时降级到 localStorage
        saveToLocalStorage();
      }
    } else {
      saveToLocalStorage();
    }
  };

  const saveToLocalStorage = () => {
    const stored: Record<string, string> = {};
    Object.entries(fileStates).forEach(([name, s]) => {
      stored[name] = name === file.name ? state.content : s.saved;
    });
    syncStore.setItem(LS_KEY_GENERAL, stored);
    setFileStates(prev => ({
      ...prev,
      [file.name]: { ...prev[file.name], content: state.content, saved: state.content, mtimeMs: Date.now() },
    }));
    logger.info(`${file.name} 已暂存到 localStorage（浏览器模式）`);
  };

  const handleDiscard = () => {
    setFileStates(prev => ({
      ...prev,
      [file.name]: { ...prev[file.name], content: prev[file.name].saved },
    }));
  };

  return (
    <div className="resource-list memory-editor-pane">
      {initError && (
        <div className="file-warn" style={{ marginBottom: 12 }}>
          <AlertTriangle size={14} />
          <div>
            <strong>初始化失败</strong> — {initError}。已降级到本地暂存模式。
          </div>
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
      <FileEditor
        file={file}
        value={state.content}
        isDirty={isDirty}
        fullPath={fullPath}
        exists={state.exists}
        mtimeMs={state.mtimeMs}
        storageMode={tauriMode ? "tauri" : "local"}
        onChange={handleChange}
        onSave={handleSave}
        onDiscard={handleDiscard}
      />
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
  const [tauriMode, setTauriMode] = useState<boolean>(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(
    projects.length > 0 ? projects[0].id : null
  );
  const [activeFileName, setActiveFileName] = useState<string>(PROJECT_FILES[0].name);
  // 双层字典：states[projectId][fileName]
  const [states, setStates] = useState<Record<string, FileStates>>({});
  const [reloadNonce, setReloadNonce] = useState(0);

  // 当 projects 列表变化时（如新加/删除项目），重置 activeProjectId
  useEffect(() => {
    if (activeProjectId && projects.find(p => p.id === activeProjectId)) return;
    setActiveProjectId(projects.length > 0 ? projects[0].id : null);
  }, [projects, activeProjectId]);

  useEffect(() => {
    const init = async () => {
      const isTauriEnv = isTauri();
      setTauriMode(isTauriEnv);
      if (!isTauriEnv) {
        loadAllFromLocalStorage();
        return;
      }
      if (projects.length === 0) return;
      try {
        await loadAllFromDiskForProjects();
      } catch (e) {
        const msg = (e as Error).message || String(e);
        setInitError(`初始化失败：${msg}`);
        logger.error(`项目记忆初始化失败：${msg}`);
        loadAllFromLocalStorage();
      }
    };
    init();
  }, [reloadNonce, projects]);

  useEffect(() => {
    const handler = () => setReloadNonce(n => n + 1);
    window.addEventListener("ripple-memory-reload", handler);
    return () => window.removeEventListener("ripple-memory-reload", handler);
  }, []);

  const loadAllFromDiskForProjects = async () => {
    const next: Record<string, FileStates> = {};
    for (const p of projects) {
      next[p.id] = {};
      for (const f of PROJECT_FILES) {
        const path = `${p.path}\\${f.name}`;
        try {
          const exists = await pathExists(path);
          if (exists) {
            const { content, mtime_ms } = await readTextFile(path);
            next[p.id][f.name] = { content, saved: content, exists: true, mtimeMs: mtime_ms };
          } else {
            next[p.id][f.name] = { content: f.template, saved: "", exists: false, mtimeMs: null };
          }
        } catch (e) {
          logger.error(`读取 ${p.path}\\${f.name} 失败：${e}`);
          next[p.id][f.name] = { content: f.template, saved: "", exists: false, mtimeMs: null };
        }
      }
    }
    setStates(next);
  };

  const loadAllFromLocalStorage = () => {
    const next: Record<string, FileStates> = {};
    projects.forEach(p => {
      const stored = syncStore.getItem<Record<string, string>>(LS_KEY_PROJECT(p.id), {});
      next[p.id] = {};
      PROJECT_FILES.forEach(f => {
        const content = stored[f.name] ?? f.template;
        next[p.id][f.name] = { content, saved: content, exists: true, mtimeMs: null };
      });
    });
    setStates(next);
  };

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

  const state = states[project.id]?.[file.name] ?? { content: "", saved: "", exists: false, mtimeMs: null };
  const isDirty = state.content !== state.saved;
  const fullPath = `${project.path}\\${file.name}`;

  const handleChange = (v: string) => {
    setStates(prev => ({
      ...prev,
      [project.id]: { ...prev[project.id], [file.name]: { ...prev[project.id]?.[file.name], content: v } },
    }));
  };

  const handleSave = async () => {
    if (tauriMode) {
      const path = `${project.path}\\${file.name}`;
      try {
        await writeTextFile(path, state.content);
        try {
          const { mtime_ms } = await readTextFile(path);
          setStates(prev => ({
            ...prev,
            [project.id]: {
              ...prev[project.id],
              [file.name]: { content: state.content, saved: state.content, exists: true, mtimeMs: mtime_ms },
            },
          }));
        } catch {
          setStates(prev => ({
            ...prev,
            [project.id]: {
              ...prev[project.id],
              [file.name]: { content: state.content, saved: state.content, exists: true, mtimeMs: Date.now() },
            },
          }));
        }
        logger.success(`已保存 ${file.name}（${project.label}）`);
      } catch (e) {
        const msg = (e as Error).message || String(e);
        logger.error(`保存 ${file.name}（${project.label}）失败：${msg}`);
        saveToLocalStorage();
      }
    } else {
      saveToLocalStorage();
    }
  };

  const saveToLocalStorage = () => {
    const stored: Record<string, string> = {};
    PROJECT_FILES.forEach(f => {
      const cur = states[project.id]?.[f.name];
      stored[f.name] = f.name === file.name ? state.content : (cur?.saved ?? f.template);
    });
    syncStore.setItem(LS_KEY_PROJECT(project.id), stored);
    setStates(prev => ({
      ...prev,
      [project.id]: {
        ...prev[project.id],
        [file.name]: { ...prev[project.id]?.[file.name], content: state.content, saved: state.content, mtimeMs: Date.now() },
      },
    }));
    logger.info(`${file.name}（${project.label}）已暂存到 localStorage`);
  };

  const handleDiscard = () => {
    setStates(prev => ({
      ...prev,
      [project.id]: {
        ...prev[project.id],
        [file.name]: { ...prev[project.id]?.[file.name], content: prev[project.id]?.[file.name]?.saved ?? "" },
      },
    }));
  };

  return (
    <div className="resource-list memory-editor-pane">
      {initError && (
        <div className="file-warn" style={{ marginBottom: 12 }}>
          <AlertTriangle size={14} />
          <div>
            <strong>初始化失败</strong> — {initError}。已降级到本地暂存模式。
          </div>
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
      <FileEditor
        file={file}
        value={state.content}
        isDirty={isDirty}
        fullPath={fullPath}
        exists={state.exists}
        mtimeMs={state.mtimeMs}
        storageMode={tauriMode ? "tauri" : "local"}
        onChange={handleChange}
        onSave={handleSave}
        onDiscard={handleDiscard}
      />
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

/**
 * 将 Unix 毫秒时间戳格式化为 YYYY-MM-DD HH:MM:SS
 * 失败/为空时返回 null
 */
function formatMtime(ms: number | null): string | null {
  if (!ms || ms <= 0) return null;
  const d = new Date(ms);
  if (isNaN(d.getTime())) return null;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

interface FileEditorProps {
  file: MemoryFile;
  value: string;
  isDirty: boolean;
  fullPath: string;
  exists: boolean;
  mtimeMs: number | null;
  storageMode: "tauri" | "local";
  onChange: (v: string) => void;
  onSave: () => void;
  onDiscard: () => void;
}
function FileEditor({
  file,
  value,
  isDirty,
  fullPath,
  exists,
  mtimeMs,
  storageMode,
  onChange,
  onSave,
  onDiscard,
}: FileEditorProps) {
  const mtimeStr = formatMtime(mtimeMs);
  // 状态文案：脏 → 未保存；未创建 → 等待创建；已保存且有 mtime → 最后更新 YYYY-MM-DD HH:MM:SS
  const statusText = isDirty
    ? "未保存"
    : !exists
      ? "等待创建"
      : mtimeStr
        ? `最后更新 ${mtimeStr}`
        : "已是最新";
  const statusClass = isDirty
    ? "status-dirty"
    : !exists
      ? "status-amber"
      : "status-saved";

  return (
    <div className="file-editor">
      <div className="file-editor-head">
        <div>
          <h3 className="file-editor-title">{file.name}</h3>
          <p className="file-editor-desc">{file.desc}</p>
          <code className="file-editor-path">{fullPath}</code>
        </div>
        <div className={`file-editor-status ${statusClass}`}>
          <span>{statusText}</span>
        </div>
      </div>
      {!exists && (
        <div className="file-warn">
          <AlertTriangle size={14} />
          <div>
            <strong>文件不存在</strong> — 保存时会自动创建 <code>{file.name}</code>。
          </div>
        </div>
      )}
      {storageMode === "local" && (
        <div className="file-warn" style={{ marginTop: 8 }}>
          <AlertTriangle size={14} />
          <div>
            <strong>本地暂存模式</strong> — 浏览器 dev 环境无法访问本地磁盘，编辑内容仅保存在 localStorage，刷新可能丢失。
          </div>
        </div>
      )}
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
            disabled={!isDirty && exists}
          >
            <Save size={14} />
            <span>保存</span>
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
