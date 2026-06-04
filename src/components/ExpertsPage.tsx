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
  Brain,
  Palette,
  Home,
  type LucideIcon,
} from "lucide-react";
import { syncStore } from "../hooks/useStore";
import { fetchExperts, fetchExpert, updateExpert, type ExpertSummary } from "ripple-shared/api";
import { logger } from "./LogPanel";
import ChatFabButton from "./ChatFabButton";

/**
 * 专家管理页 — v2.0（后端对接版）
 *  - Agent 专家：后端 /api/squad/agents（yaml 字段只读 + 唯一可改 .md）
 *  - Session 专家：维持 localStorage + mock 数据（功能上不做任何事）
 *  - 后端不可达时降级到 localStorage
 */

type ExpertType = "agent" | "session";
type ExpertStatus = "active" | "inactive";

interface Expert {
  id: string;
  name: string;
  type: ExpertType;
  status: ExpertStatus;
  description: string;
  tools: string[];
  iconKey: IconKey;
  // Agent 专家独有（来自后端 API；Session 专家留空）
  systemPrompt?: string;
  triggers?: string[];
  config?: { provider?: string; model?: string; thinkingLevel?: string };
  content?: string;       // 原始 yaml 文本
  useCount?: number;
  messageCount?: number;
  lastUsedAt?: number | null;
  hasCheckpoint?: boolean;
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

// Session 专家的 localStorage key（Agent 专家不再用 localStorage）
const LS_KEY = "ripple-experts-v1";

// Session 专家初始数据（mock）
const INITIAL_SESSION_EXPERTS: Expert[] = [
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

/** 从专家 name 推断 iconKey（name 包含关键字 → 对应图标） */
function inferIconKey(name: string, fallback: IconKey = "general"): IconKey {
  const lower = name.toLowerCase();
  if (lower.includes("code") || lower.includes("writer")) return "code";
  if (lower.includes("review")) return "eye";
  if (lower.includes("arch")) return "arch";
  if (lower.includes("debug")) return "bug";
  if (lower.includes("design") || lower.includes("ui")) return "design";
  if (lower.includes("session") || lower.includes("train")) return "session";
  return fallback;
}

/** 把后端 ExpertSummary 转成 UI Expert */
function summaryToExpert(s: ExpertSummary): Expert {
  return {
    id: s.name,
    name: s.name,
    type: "agent",
    status: "active",
    description: s.description,
    tools: [],
    iconKey: inferIconKey(s.name),
    config: (s.config as Expert["config"]) ?? {},
    useCount: s.useCount,
    messageCount: s.messageCount,
    lastUsedAt: s.lastUsedAt,
    hasCheckpoint: s.hasCheckpoint,
  };
}

/** 格式化最后使用时间 */
function formatLastUsed(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return "从未使用";
  const diffMs = Date.now() - ms;
  if (diffMs < 0) return "刚刚";
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} 个月前`;
  const years = Math.floor(months / 12);
  return `${years} 年前`;
}

/** 卡片底部使用情况小字：已用 N 次 · 最近 X */
function buildUsageLine(e: Expert): string | null {
  if (e.type !== "agent") return null;
  const useCount = e.useCount ?? 0;
  if (useCount === 0) return "尚未使用";
  const lastUsed = formatLastUsed(e.lastUsedAt);
  // "从未使用" 不会出现因为 useCount > 0
  return `已用 ${useCount} 次 · 最近 ${lastUsed}`;
}

interface ExpertsPageProps {
  /** 顶栏左侧菜单按钮回调：移动端打开 drawer，桌面端切换 sidebar 折叠 */
  onMenuClick?: () => void;
  /** Chat FAB 回调：返回聊天首页 */
  onBackToChat?: () => void;
}

export function ExpertsPage({ onMenuClick, onBackToChat }: ExpertsPageProps) {
  // 当前 tab
  const [activeTab, setActiveTab] = useState<ExpertType>("agent");

  // Agent 专家：后端 API 加载
  const [agentExperts, setAgentExperts] = useState<Expert[]>([]);
  const [agentLoading, setAgentLoading] = useState<boolean>(false);
  const [agentError, setAgentError] = useState<string | null>(null);
  // 后端不可达时的兜底（仅 session tab 之前的数据里包含的 agent 条目）
  const [agentFallback, setAgentFallback] = useState<Expert[] | null>(null);

  // Session 专家：localStorage 持久化（维持原行为）
  const [sessionExperts, setSessionExperts] = useState<Expert[]>(() => {
    const saved = syncStore.getItem<Expert[] | null>(LS_KEY, null);
    return Array.isArray(saved) && saved.length > 0 ? saved : INITIAL_SESSION_EXPERTS;
  });

  // modal 状态
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  // 持久化 session experts
  useEffect(() => {
    syncStore.setItem(LS_KEY, sessionExperts);
  }, [sessionExperts]);

  // 加载 Agent 专家
  const loadAgentExperts = async () => {
    setAgentLoading(true);
    setAgentError(null);
    const res = await fetchExperts();
    if (res.error) {
      setAgentError(res.error);
      logger.error(`加载专家列表失败：${res.error}`);
      // 失败时从 localStorage 兜底（如果之前有缓存）
      if (agentFallback) {
        setAgentExperts(agentFallback);
      } else {
        setAgentExperts([]);
      }
    } else {
      const list = (res.data ?? []).map(summaryToExpert);
      setAgentExperts(list);
      setAgentFallback(list);  // 缓存一份用于下次失败兜底
    }
    setAgentLoading(false);
  };

  useEffect(() => {
    loadAgentExperts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 切换 tab
  const handleTabChange = (tab: ExpertType) => setActiveTab(tab);

  // 重新加载：刷新 Agent 列表 + 重置 Session 数据
  const handleReload = () => {
    if (window.confirm("重新加载会重置 Session 专家为初始示例数据，并重新从后端拉取 Agent 专家，确定继续？")) {
      syncStore.removeItem(LS_KEY);
      setSessionExperts(INITIAL_SESSION_EXPERTS);
      loadAgentExperts();
    }
  };

  // 删除（仅 Session 专家支持删除 — Agent 专家二期再做）
  const handleDelete = (id: string) => {
    setSessionExperts(prev => prev.filter(e => e.id !== id));
    setDeleteConfirmId(null);
  };

  // 当前展示的列表（按 tab）
  const filteredExperts = useMemo(
    () => (activeTab === "agent" ? agentExperts : sessionExperts),
    [activeTab, agentExperts, sessionExperts]
  );
  const agentCount = agentExperts.length;
  const sessionCount = sessionExperts.length;

  // 当前编辑的专家（用于 modal 回显）
  const editingExpert = editingId
    ? (activeTab === "agent" ? agentExperts : sessionExperts).find(e => e.id === editingId) ?? null
    : null;
  const modalOpen = showAddModal || editingExpert !== null;

  // 提交（保存）
  // Agent 专家：只允许修改 systemPrompt（yaml 字段 disabled，用户在 modal 里改不动）
  // Session 专家：维持原行为（localStorage 全字段保存）
  const handleSubmit = async (data: Omit<Expert, "id"> & { id?: string }) => {
    if (editingExpert) {
      if (editingExpert.type === "agent") {
        // 调用后端 PUT
        const sysPrompt = data.systemPrompt ?? editingExpert.systemPrompt ?? "";
        const res = await updateExpert(editingExpert.name, { systemPrompt: sysPrompt });
        if (res.error) {
          logger.error(`更新专家失败：${res.error}`);
          window.alert(`更新失败：${res.error}`);
          return;
        }
        // 保存后重新拉取（Q4: 重新 GET）
        await loadAgentExperts();
        logger.success(`已保存 ${editingExpert.name} 的系统提示词`);
      } else {
        // Session 专家：localStorage
        setSessionExperts(prev =>
          prev.map(e => (e.id === editingExpert.id ? { ...e, ...data, id: editingExpert.id } : e))
        );
      }
    } else {
      // 新建 — 二期功能，本期不开放
      // 这里走不到，因为 Agent 专家没有"添加"按钮，Session 专家 modal 也不开放
      const newId = data.id || data.name.trim() || `expert-${Date.now()}`;
      setSessionExperts(prev => [...prev, { ...data, id: newId } as Expert]);
    }
    setShowAddModal(false);
    setEditingId(null);
  };

  return (
    <>
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
            title="重新从后端拉取 Agent 专家 / 重置 Session 专家"
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
        {activeTab === "agent" && agentError && (
          <div
            className="file-warn"
            style={{ marginBottom: 12 }}
            role="alert"
          >
            <div>
              <strong>后端不可达</strong> — {agentError}。Agent 专家列表已降级到本地缓存。
            </div>
          </div>
        )}
        {activeTab === "agent" && agentLoading ? (
          <div className="empty-state">
            <p className="empty-state-text">正在从后端加载 Agent 专家…</p>
          </div>
        ) : filteredExperts.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">
              <Plus size={20} />
            </div>
            <p className="empty-state-text">
              {activeTab === "agent" ? "后端暂无 Agent 专家配置" : "还没有 Session 专家，点击右上角「添加专家」开始"}
            </p>
          </div>
        ) : (
          <div className="resource-grid">
            {filteredExperts.map(expert => (
              <ExpertCard
                key={expert.id}
                expert={expert}
                onEdit={async () => {
                  if (expert.type === "agent") {
                    // 拉详情拿到 systemPrompt（= .md 内容）
                    const res = await fetchExpert(expert.name);
                    if (res.error) {
                      logger.error(`加载专家详情失败：${res.error}`);
                      window.alert(`无法加载专家详情：${res.error}`);
                      return;
                    }
                    // 临时把详情合并到 agentExperts 中（避免另开 state）
                    setAgentExperts(prev =>
                      prev.map(e =>
                        e.id === expert.id
                          ? {
                              ...e,
                              systemPrompt: res.data?.systemPrompt ?? "",
                              triggers: res.data?.triggers ?? [],
                              tools: res.data?.tools ?? [],
                              content: res.data?.content ?? "",
                            }
                          : e
                      )
                    );
                  }
                  setEditingId(expert.id);
                  setShowAddModal(false);
                }}
                onDelete={() => {
                  if (expert.type === "agent") {
                    window.alert("Agent 专家暂不支持删除（二期功能）");
                    return;
                  }
                  setDeleteConfirmId(expert.id);
                }}
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
              确定要删除专家「{sessionExperts.find(e => e.id === deleteConfirmId)?.name}」吗？此操作不可撤销。
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
      {onBackToChat && <ChatFabButton onClick={onBackToChat} />}
    </>
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
  const usageLine = buildUsageLine(expert);
  return (
    <article className="card" data-type={expert.type}>
      <div className="card-head">
        <div className="card-head-top">
          <div className={`card-icon ${gradient}`}>
            <Icon />
          </div>
          <div className="card-head-right">
            <div className="card-title-row">
              <h3 className="card-title">{expert.name}</h3>
              <span className={status.className}>
                <span className="tag-dot" />
                {status.label}
              </span>
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
          </div>
        </div>
        <p className="card-desc">{expert.description}</p>
      </div>
      {usageLine && (
        <div className="card-meta" style={{ marginTop: 4 }}>
          <span className="meta-item" style={{ color: "var(--page-text-muted, #888)", fontSize: 12 }}>
            {usageLine}
          </span>
        </div>
      )}
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
  const [systemPrompt, setSystemPrompt] = useState(initial?.systemPrompt ?? "");

  const isEdit = initial !== null;
  // Agent 专家编辑时：yaml 字段全部只读，只有 systemPrompt 可改
  const isReadOnly = isEdit && initial?.type === "agent";
  const isValid = isReadOnly ? true : (name.trim().length > 0 && description.trim().length > 0);

  const toggleTool = (tool: string) => {
    if (isReadOnly) return;
    setTools(prev => (prev.includes(tool) ? prev.filter(t => t !== tool) : [...prev, tool]));
  };

  const handleSubmit = () => {
    if (!isValid) return;
    onSubmit({
      name: name.trim() || (initial?.name ?? ""),
      type,
      status,
      description: description.trim(),
      tools,
      iconKey,
      systemPrompt,
    });
  };

  return (
    <div className="modal-overlay" onClick={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <div className="page-modal" role="dialog" aria-modal="true">
        <header className="page-modal-head">
          <div>
            <h2 className="page-modal-title">
              {isReadOnly ? "编辑专家（仅系统提示词可改）" : isEdit ? "编辑专家" : "添加专家"}
            </h2>
            <p className="page-modal-sub">
              {isReadOnly
                ? "yaml 字段为只读（直接修改易导致解析失败），仅关联的 .md 文件可编辑"
                : isEdit
                  ? "修改专家配置"
                  : "配置一个新的 AI 专家"}
            </p>
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
              disabled={isReadOnly}
              autoFocus={!isReadOnly}
            />
          </div>
          <div className="field-row">
            <div className="field">
              <label className="field-label">专家类型</label>
              <select
                className="field-input"
                value={type}
                onChange={(e) => setType(e.target.value as ExpertType)}
                disabled={isReadOnly}
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
                disabled={isReadOnly}
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
              disabled={isReadOnly}
            />
          </div>
          <div className="field">
            <label className="field-label">图标（仅用于卡片展示）</label>
            <select
              className="field-input"
              value={iconKey}
              onChange={(e) => setIconKey(e.target.value as IconKey)}
              disabled={isReadOnly}
            >
              {ICON_KEY_OPTIONS.map(opt => (
                <option key={opt.key} value={opt.key}>{opt.label}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field-label">
              系统提示词{isReadOnly ? "（关联 .md 文件，保存即写回磁盘）" : ""}
            </label>
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
                    disabled={isReadOnly}
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
            <span>{isReadOnly ? "保存到 .md" : isEdit ? "保存修改" : "创建专家"}</span>
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
