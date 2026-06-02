import { useState, useEffect } from "react";
import {
  Save,
  AlertTriangle,
  RefreshCw,
  ChevronDown,
} from "lucide-react";
import { syncStore } from "../hooks/useStore";

/**
 * 记忆管理页 — v2.0
 *  - 移植自 demo (plans/desktop/memory.html + memory.js)
 *  - 通用记忆 / 项目记忆 两个 tab
 *  - file-tabs + file-editor，支持保存/放弃/未保存检测
 *  - 暂存到 localStorage（不接真实文件系统）
 */

const GENERAL_ROOT = "C:\\Users\\dxwang\\.open-cowork";

interface MemoryFile {
  name: string;
  desc: string;
  initial: string;
  exists: boolean;
}

const GENERAL_FILES: MemoryFile[] = [
  {
    name: "MEMORY.md",
    desc: "核心画像与稳定决策。AI 蒸馏的产物，修改前建议备份。",
    initial:
      "# MEMORY\n\n这里是跨项目长期记忆与稳定决策的沉淀区。\n\n## 偏好\n- 默认深色主题\n- 中文优先，关键术语保留英文\n\n## 关键决策\n- 桌面端技术栈：React 18 + TypeScript + Tauri 2\n\n## 待沉淀\n- 来自 .agent-orchestration/memories/ 的高频经验\n",
    exists: true,
  },
  {
    name: "hot-topics.md",
    desc: "当前活跃主题与进行中的项目。文件不存在时会自动创建。",
    initial:
      "# Hot Topics\n\n- [在办] Ripple 桌面端 · 记忆管理重构\n- [关注] mcp-tool 生态：playwright / dev-dispatcher\n",
    exists: false,
  },
];

interface ProjectInfo {
  id: string;
  label: string;
  path: string;
}

const PROJECTS: ProjectInfo[] = [
  { id: "dev", label: "dev", path: "E:\\MyBrain\\dev" },
  { id: "other", label: "other", path: "E:\\MyBrain\\dev\\other" },
  { id: "pilotdeck", label: "PilotDeck-main", path: "E:\\MyBrain\\dev\\other\\PilotDeck-main" },
];

const PROJECT_FILE_TEMPLATES: MemoryFile[] = [
  {
    name: "ripple.md",
    desc: "项目级 Ripple 记忆。存储该项目专属的上下文与约定。",
    initial: "# ripple.md\n\n本项目专属的 Ripple 记忆。\n\n## 项目目标\n- 维护个人 AI 助手桌面端\n",
    exists: true,
  },
  {
    name: "agent.md",
    desc: "Agent 运行配置与行为约束。",
    initial: "# agent.md\n\n## 工具白名单\n- read_file / write_file / list_dir\n- shell（截断 50KB）\n",
    exists: true,
  },
  {
    name: "README.md",
    desc: "项目说明文档（真实 README，非记忆文件）。",
    initial: "# Project\n\n项目根目录说明。\n",
    exists: true,
  },
];

// 持久化 key
const LS_KEY_GENERAL = "ripple-memory-general-v1";
const LS_KEY_PROJECT = (pid: string) => `ripple-memory-project-v1-${pid}`;

interface MemoryPageProps {
  /** 顶栏左侧菜单按钮回调 */
  onMenuClick?: () => void;
}

export function MemoryPage({ onMenuClick }: MemoryPageProps) {
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
            <p className="page-sub">
              全局记忆根目录：<code>{GENERAL_ROOT}</code>
            </p>
          </div>
        </div>
        <div className="page-header-right">
          {activeTab === "general" ? (
            <ReloadButton
              lsKeys={[LS_KEY_GENERAL, ...PROJECTS.map(p => LS_KEY_PROJECT(p.id))]}
              onReload={() => {
                syncStore.removeItem(LS_KEY_GENERAL);
                PROJECTS.forEach(p => syncStore.removeItem(LS_KEY_PROJECT(p.id)));
                // 触发自定义事件让子组件重载
                window.dispatchEvent(new CustomEvent("ripple-memory-reload"));
              }}
            />
          ) : null}
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
          <span className="tab-count">{PROJECTS.length}</span>
        </button>
      </div>

      <div className="content">
        {activeTab === "general" ? (
          <GeneralMemoryPane />
        ) : (
          <ProjectMemoryPane />
        )}
      </div>
    </section>
  );
}

/* ============================================================
 *  ReloadButton
 * ============================================================ */
interface ReloadButtonProps {
  lsKeys: string[];
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
      title="重新加载：丢弃未保存的修改，回到初始模板"
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
  const [activeFileName, setActiveFileName] = useState<string>(GENERAL_FILES[0].name);
  // contents/saved 字典
  const [contents, setContents] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [reloadNonce, setReloadNonce] = useState(0);

  // 初始化 / 监听 reload
  useEffect(() => {
    const stored = syncStore.getItem<Record<string, string>>(LS_KEY_GENERAL, {});
    const c: Record<string, string> = {};
    const s: Record<string, string> = {};
    GENERAL_FILES.forEach(f => {
      c[f.name] = stored[f.name] ?? f.initial;
      s[f.name] = f.initial;
    });
    setContents(c);
    setSaved(s);
  }, [reloadNonce]);

  // 监听全局 reload 事件
  useEffect(() => {
    const handler = () => setReloadNonce(n => n + 1);
    window.addEventListener("ripple-memory-reload", handler);
    return () => window.removeEventListener("ripple-memory-reload", handler);
  }, []);

  const file = GENERAL_FILES.find(f => f.name === activeFileName);
  if (!file) return null;

  const value = contents[file.name] ?? "";
  const baseline = saved[file.name] ?? "";
  const isDirty = value !== baseline;
  const fullPath = `${GENERAL_ROOT}\\${file.name}`;

  const handleChange = (v: string) => {
    setContents(prev => ({ ...prev, [file.name]: v }));
  };

  const handleSave = () => {
    const next = { ...contents, [file.name]: value };
    setSaved(prev => ({ ...prev, [file.name]: value }));
    syncStore.setItem(LS_KEY_GENERAL, next);
  };

  const handleDiscard = () => {
    setContents(prev => ({ ...prev, [file.name]: saved[file.name] ?? "" }));
  };

  return (
    <div className="resource-list memory-editor-pane">
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
        value={value}
        isDirty={isDirty}
        fullPath={fullPath}
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
function ProjectMemoryPane() {
  const [activeProjectId, setActiveProjectId] = useState<string>(PROJECTS[0].id);
  const [activeFileName, setActiveFileName] = useState<string>(PROJECT_FILE_TEMPLATES[0].name);
  // 双层字典：contents[pid][fname]
  const [contents, setContents] = useState<Record<string, Record<string, string>>>({});
  const [saved, setSaved] = useState<Record<string, Record<string, string>>>({});
  const [reloadNonce, setReloadNonce] = useState(0);

  // 初始化 / 监听 reload
  useEffect(() => {
    const c: Record<string, Record<string, string>> = {};
    const s: Record<string, Record<string, string>> = {};
    PROJECTS.forEach(p => {
      const stored = syncStore.getItem<Record<string, string>>(LS_KEY_PROJECT(p.id), {});
      c[p.id] = {};
      s[p.id] = {};
      PROJECT_FILE_TEMPLATES.forEach(f => {
        c[p.id][f.name] = stored[f.name] ?? f.initial;
        s[p.id][f.name] = f.initial;
      });
    });
    setContents(c);
    setSaved(s);
  }, [reloadNonce]);

  useEffect(() => {
    const handler = () => setReloadNonce(n => n + 1);
    window.addEventListener("ripple-memory-reload", handler);
    return () => window.removeEventListener("ripple-memory-reload", handler);
  }, []);

  const project = PROJECTS.find(p => p.id === activeProjectId);
  const file = PROJECT_FILE_TEMPLATES.find(f => f.name === activeFileName);
  if (!project || !file) return null;

  const value = contents[project.id]?.[file.name] ?? "";
  const baseline = saved[project.id]?.[file.name] ?? "";
  const isDirty = value !== baseline;
  const fullPath = `${project.path}\\${file.name}`;

  const handleChange = (v: string) => {
    setContents(prev => ({
      ...prev,
      [project.id]: { ...prev[project.id], [file.name]: v },
    }));
  };

  const handleSave = () => {
    const nextContents = {
      ...(contents[project.id] ?? {}),
      [file.name]: value,
    };
    setSaved(prev => ({
      ...prev,
      [project.id]: { ...prev[project.id], [file.name]: value },
    }));
    syncStore.setItem(LS_KEY_PROJECT(project.id), nextContents);
  };

  const handleDiscard = () => {
    setContents(prev => ({
      ...prev,
      [project.id]: {
        ...prev[project.id],
        [file.name]: saved[project.id]?.[file.name] ?? "",
      },
    }));
  };

  return (
    <div className="resource-list memory-editor-pane">
      <div className="project-selector">
        <label className="project-selector-label" htmlFor="project-select">
          选择项目
        </label>
        <div className="project-selector-wrap">
          <select
            id="project-select"
            className="project-select"
            value={activeProjectId}
            onChange={(e) => setActiveProjectId(e.target.value)}
          >
            {PROJECTS.map(p => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
          <ChevronDown className="project-select-chevron" size={14} />
        </div>
      </div>
      <div className="file-tabs">
        {PROJECT_FILE_TEMPLATES.map(f => (
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
        value={value}
        isDirty={isDirty}
        fullPath={fullPath}
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

interface FileEditorProps {
  file: MemoryFile;
  value: string;
  isDirty: boolean;
  fullPath: string;
  onChange: (v: string) => void;
  onSave: () => void;
  onDiscard: () => void;
}
function FileEditor({ file, value, isDirty, fullPath, onChange, onSave, onDiscard }: FileEditorProps) {
  return (
    <div className="file-editor">
      <div className="file-editor-head">
        <div>
          <h3 className="file-editor-title">{file.name}</h3>
          <p className="file-editor-desc">{file.desc}</p>
          <code className="file-editor-path">{fullPath}</code>
        </div>
        <div className={`file-editor-status ${isDirty ? "status-dirty" : "status-saved"}`}>
          <span>{isDirty ? "未保存" : "已是最新"}</span>
        </div>
      </div>
      {!file.exists && (
        <div className="file-warn">
          <AlertTriangle size={14} />
          <div>
            <strong>文件不存在</strong> — 保存时会自动创建 <code>{file.name}</code>。
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
            disabled={!isDirty}
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
