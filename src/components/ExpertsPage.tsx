import { useState, useEffect, useMemo } from "react";
import {
  Plus,
  Pencil,
  Trash2,
  X,
  RefreshCw,
  Check,
  Code,
  Eye,
  Settings2,
  Bug,
  RotateCcw,
  Lightbulb,
  Brain,
  Palette,
  Home,
  type LucideIcon,
} from "lucide-react";
import { syncStore } from "../hooks/useStore";

/**
 * 专家管理页 — v2.0
 *  - 移植自 demo (plans/desktop/experts.html)
 *  - Agent 专家 / Session 专家 两个 tab
 *  - 卡片网格 + 添加/编辑 modal
 *  - 暂存到 localStorage（不接后端，后续可替换为 API）
 */

type ExpertType = "agent" | "session";
type ExpertStatus = "active" | "inactive";

interface Expert {
  id: string;
  name: string;
  type: ExpertType;
  status: ExpertStatus;
  description: string;
  tools: string[]; // 工具名列表（演示用）
  iconKey: IconKey; // 用于在卡片上选择 lucide 图标
}

type IconKey = "code" | "eye" | "arch" | "bug" | "general" | "session" | "design";

const ICON_MAP: Record<IconKey, LucideIcon> = {
  code: Code,
  eye: Eye,
  arch: Settings2,
  bug: Bug,
  general: RotateCcw,
  session: Brain,
  design: Palette,
};

const GRADIENT_MAP: Record<ExpertType, string> = {
  agent: "icon-grad-violet",
  session: "icon-grad-rose",
};

const STATUS_TAG_MAP: Record<ExpertStatus, { className: string; label: string }> = {
  active: { className: "tag tag-emerald", label: "启用" },
  inactive: { className: "tag tag-amber", label: "禁用" },
};

const LS_KEY = "ripple-experts-v1";

// 演示初始数据（与 demo 一致）
const INITIAL_EXPERTS: Expert[] = [
  {
    id: "code-writer",
    name: "code-writer",
    type: "agent",
    status: "active",
    description: "代码编写与优化专家",
    tools: ["shell", "file"],
    iconKey: "code",
  },
  {
    id: "reviewer",
    name: "reviewer",
    type: "agent",
    status: "active",
    description: "代码评审专家",
    tools: ["read", "analyze"],
    iconKey: "eye",
  },
  {
    id: "architect",
    name: "architect",
    type: "agent",
    status: "inactive",
    description: "系统架构设计专家",
    tools: ["design", "review"],
    iconKey: "arch",
  },
  {
    id: "debugger",
    name: "debugger",
    type: "agent",
    status: "active",
    description: "代码调试专家",
    tools: ["debug", "trace"],
    iconKey: "bug",
  },
  {
    id: "general",
    name: "general",
    type: "agent",
    status: "active",
    description: "通用问题专家",
    tools: ["all-round"],
    iconKey: "general",
  },
  {
    id: "my-expert",
    name: "my-expert",
    type: "session",
    status: "active",
    description: "从对话训练的专家",
    tools: ["训练数据"],
    iconKey: "session",
  },
  {
    id: "ui-designer",
    name: "ui-designer",
    type: "session",
    status: "active",
    description: "UI 设计专家",
    tools: ["排版", "配色"],
    iconKey: "design",
  },
];

const TOOL_OPTIONS = [
  "read_file",
  "write_file",
  "shell",
  "web_search",
  "execute",
  "list_dir",
  "lint",
  "test",
];

const ICON_KEY_OPTIONS: { key: IconKey; label: string }[] = [
  { key: "code", label: "代码" },
  { key: "eye", label: "评审" },
  { key: "arch", label: "架构" },
  { key: "bug", label: "调试" },
  { key: "general", label: "通用" },
  { key: "session", label: "训练" },
  { key: "design", label: "设计" },
];

interface ExpertsPageProps {
  /** 顶栏左侧菜单按钮回调：移动端打开 drawer，桌面端切换 sidebar 折叠 */
  onMenuClick?: () => void;
}

export function ExpertsPage({ onMenuClick }: ExpertsPageProps) {
  // 当前 tab
  const [activeTab, setActiveTab] = useState<ExpertType>("agent");
  // 专家列表（localStorage 持久化）
  const [experts, setExperts] = useState<Expert[]>(() => {
    const saved = syncStore.getItem<Expert[] | null>(LS_KEY, null);
    return Array.isArray(saved) && saved.length > 0 ? saved : INITIAL_EXPERTS;
  });
  // modal 状态
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  // 持久化
  useEffect(() => {
    syncStore.setItem(LS_KEY, experts);
  }, [experts]);

  // 切换 tab
  const handleTabChange = (tab: ExpertType) => setActiveTab(tab);

  // 重新加载：清空 localStorage，回到初始数据
  const handleReload = () => {
    if (window.confirm("重新加载会重置为初始示例数据，当前所有改动将丢失，确定继续？")) {
      syncStore.removeItem(LS_KEY);
      setExperts(INITIAL_EXPERTS);
    }
  };

  // 删除
  const handleDelete = (id: string) => {
    setExperts(prev => prev.filter(e => e.id !== id));
    setDeleteConfirmId(null);
  };

  // 按 tab 分组
  const filteredExperts = useMemo(
    () => experts.filter(e => e.type === activeTab),
    [experts, activeTab]
  );
  const agentCount = useMemo(() => experts.filter(e => e.type === "agent").length, [experts]);
  const sessionCount = useMemo(() => experts.filter(e => e.type === "session").length, [experts]);

  // 当前编辑的专家（用于 modal 回显）
  const editingExpert = editingId ? experts.find(e => e.id === editingId) ?? null : null;
  const modalOpen = showAddModal || editingExpert !== null;

  // 保存（新建或更新）
  const handleSubmit = (data: Omit<Expert, "id"> & { id?: string }) => {
    if (editingExpert) {
      setExperts(prev =>
        prev.map(e => (e.id === editingExpert.id ? { ...e, ...data, id: editingExpert.id } : e))
      );
    } else {
      const newId = data.id || data.name.trim() || `expert-${Date.now()}`;
      setExperts(prev => [...prev, { ...data, id: newId } as Expert]);
    }
    setShowAddModal(false);
    setEditingId(null);
  };

  return (
    <section className="page" id="page-experts">
      {/* ===== Page Header ===== */}
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
            <h1 className="page-title">专家管理</h1>
            <p className="page-sub">配置和管理你的 AI 专家团队</p>
          </div>
        </div>
        <div className="page-header-right">
          <button
            className="page-btn-secondary"
            onClick={handleReload}
            title="重置为初始示例数据"
          >
            <RefreshCw size={14} />
            <span>刷新</span>
          </button>
          <button
            className="page-btn"
            onClick={() => {
              setEditingId(null);
              setShowAddModal(true);
            }}
          >
            <Plus size={14} />
            <span>添加专家</span>
          </button>
        </div>
      </header>

      {/* ===== Tabs ===== */}
      <div className="tabs" role="tablist">
        <button
          role="tab"
          aria-selected={activeTab === "agent"}
          className={`tab ${activeTab === "agent" ? "active" : ""}`}
          onClick={() => handleTabChange("agent")}
        >
          Agent 专家
          <span className="tab-count">{agentCount}</span>
        </button>
        <button
          role="tab"
          aria-selected={activeTab === "session"}
          className={`tab ${activeTab === "session" ? "active" : ""}`}
          onClick={() => handleTabChange("session")}
        >
          Session 专家
          <span className="tab-count">{sessionCount}</span>
        </button>
      </div>

      {/* ===== Content ===== */}
      <div className="content">
        {filteredExperts.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">
              <Lightbulb size={20} />
            </div>
            <p className="empty-state-text">还没有专家，点击右上角「添加专家」开始</p>
          </div>
        ) : (
          <div className="resource-grid">
            {filteredExperts.map(expert => (
              <ExpertCard
                key={expert.id}
                expert={expert}
                onEdit={() => {
                  setEditingId(expert.id);
                  setShowAddModal(false);
                }}
                onDelete={() => setDeleteConfirmId(expert.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* ===== Add / Edit Modal ===== */}
      {modalOpen && (
        <ExpertFormModal
          initial={editingExpert}
          onClose={() => {
            setShowAddModal(false);
            setEditingId(null);
          }}
          onSubmit={handleSubmit}
        />
      )}

      {/* ===== Delete Confirm ===== */}
      {deleteConfirmId && (
        <div className="modal-overlay" onClick={(e) => {
          if (e.target === e.currentTarget) setDeleteConfirmId(null);
        }}>
          <div className="modal-card modal-card-sm">
            <h3 className="modal-title">确认删除</h3>
            <p className="modal-desc">
              确定要删除专家「{experts.find(e => e.id === deleteConfirmId)?.name}」吗？此操作不可撤销。
            </p>
            <div className="modal-actions">
              <button onClick={() => setDeleteConfirmId(null)} className="btn-secondary flex-1">
                取消
              </button>
              <button
                onClick={() => deleteConfirmId && handleDelete(deleteConfirmId)}
                className="btn-danger flex-1"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/* ============================================================
 *  ExpertCard
 * ============================================================ */
interface ExpertCardProps {
  expert: Expert;
  onEdit: () => void;
  onDelete: () => void;
}

function ExpertCard({ expert, onEdit, onDelete }: ExpertCardProps) {
  const Icon = ICON_MAP[expert.iconKey] ?? Home;
  const gradient = GRADIENT_MAP[expert.type];
  const status = STATUS_TAG_MAP[expert.status];
  return (
    <article className="card" data-type={expert.type}>
      <div className="card-head">
        <div className={`card-icon ${gradient}`}>
          <Icon />
        </div>
        <div className="card-title-row">
          <h3 className="card-title">{expert.name}</h3>
          <span className={status.className}>
            <span className="tag-dot" />
            {status.label}
          </span>
        </div>
        <p className="card-desc">{expert.description}</p>
      </div>
      <div className="card-meta">
        <span className="meta-item">
          <WrenchIcon />
          {expert.tools.length > 0 ? expert.tools.join(" · ") : "无工具"}
        </span>
        <span className="meta-item">
          {expert.type === "agent" ? "提示词专家" : "会话专家"}
        </span>
      </div>
      <div className="card-actions">
        <button className="btn-ghost" onClick={onEdit}>
          <Pencil size={13} />
          编辑
        </button>
        <button className="btn-ghost btn-danger-hover" onClick={onDelete}>
          <Trash2 size={13} />
          删除
        </button>
      </div>
    </article>
  );
}

/* ============================================================
 *  ExpertFormModal
 * ============================================================ */
interface ExpertFormModalProps {
  initial: Expert | null;
  onClose: () => void;
  onSubmit: (data: Omit<Expert, "id"> & { id?: string }) => void;
}

function ExpertFormModal({ initial, onClose, onSubmit }: ExpertFormModalProps) {
  const [name, setName] = useState(initial?.name ?? "");
  const [type, setType] = useState<ExpertType>(initial?.type ?? "agent");
  const [status, setStatus] = useState<ExpertStatus>(initial?.status ?? "active");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [tools, setTools] = useState<string[]>(initial?.tools ?? []);
  const [iconKey, setIconKey] = useState<IconKey>(initial?.iconKey ?? "general");
  const [systemPrompt, setSystemPrompt] = useState(""); // 仅用于演示，未持久化

  const isEdit = initial !== null;
  const isValid = name.trim().length > 0 && description.trim().length > 0;

  const toggleTool = (tool: string) => {
    setTools(prev => (prev.includes(tool) ? prev.filter(t => t !== tool) : [...prev, tool]));
  };

  const handleSubmit = () => {
    if (!isValid) return;
    onSubmit({
      name: name.trim(),
      type,
      status,
      description: description.trim(),
      tools,
      iconKey,
    });
  };

  return (
    <div className="modal-overlay" onClick={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <div className="page-modal" role="dialog" aria-modal="true">
        <header className="page-modal-head">
          <div>
            <h2 className="page-modal-title">{isEdit ? "编辑专家" : "添加专家"}</h2>
            <p className="page-modal-sub">{isEdit ? "修改专家配置" : "配置一个新的 AI 专家"}</p>
          </div>
          <button className="icon-btn modal-close" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </header>
        <div className="page-modal-body">
          <div className="field">
            <label className="field-label">专家名称</label>
            <input
              type="text"
              className="field-input"
              placeholder="例如：frontend-expert"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
          <div className="field-row">
            <div className="field">
              <label className="field-label">专家类型</label>
              <select
                className="field-input"
                value={type}
                onChange={(e) => setType(e.target.value as ExpertType)}
              >
                <option value="agent">Agent 专家（提示词）</option>
                <option value="session">Session 专家（训练）</option>
              </select>
            </div>
            <div className="field">
              <label className="field-label">状态</label>
              <select
                className="field-input"
                value={status}
                onChange={(e) => setStatus(e.target.value as ExpertStatus)}
              >
                <option value="active">启用</option>
                <option value="inactive">禁用</option>
              </select>
            </div>
          </div>
          <div className="field">
            <label className="field-label">描述</label>
            <input
              type="text"
              className="field-input"
              placeholder="一句话描述这个专家的用途"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="field">
            <label className="field-label">图标（仅用于卡片展示）</label>
            <select
              className="field-input"
              value={iconKey}
              onChange={(e) => setIconKey(e.target.value as IconKey)}
            >
              {ICON_KEY_OPTIONS.map(opt => (
                <option key={opt.key} value={opt.key}>{opt.label}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field-label">系统提示词（演示，未持久化）</label>
            <textarea
              className="field-textarea"
              placeholder="定义专家的角色、能力和行为..."
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
            />
          </div>
          <div className="field">
            <label className="field-label">可用工具</label>
            <div className="chip-group">
              {TOOL_OPTIONS.map(tool => (
                <label key={tool} className="chip">
                  <input
                    type="checkbox"
                    checked={tools.includes(tool)}
                    onChange={() => toggleTool(tool)}
                  />
                  <span>{tool}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
        <footer className="page-modal-foot">
          <button className="page-btn-secondary" onClick={onClose}>
            取消
          </button>
          <button
            className="page-btn"
            onClick={handleSubmit}
            disabled={!isValid}
          >
            <Check size={14} />
            <span>{isEdit ? "保存修改" : "创建专家"}</span>
          </button>
        </footer>
      </div>
    </div>
  );
}

/* ============================================================
 *  小图标（避免 lucide 库和现有 icon 类冲突）
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

function WrenchIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  );
}

export default ExpertsPage;
