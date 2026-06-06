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
  FileText,
  Lock,
  Link2,
  AlertTriangle,
  Power,
  type LucideIcon,
} from "lucide-react";
import { syncStore } from "../hooks/useStore";
import { fetchExperts, fetchExpert, updateExpert, type ExpertSummary } from "ripple-shared/api";
import {
  fetchSkills,
  fetchSkill,
  createSkill,
  updateSkill,
  deleteSkill,
  type SkillSummary,
  type SkillDetail,
  type SkillScope,
} from "ripple-shared/api";
import { logger } from "./LogPanel";
import ChatFabButton from "./ChatFabButton";
import type { ProjectInfo } from "./MemoryPage";

/**
 * 专家管理页 — v2.0（后端对接版）
 *  - Agent 专家：后端 /api/squad/agents（yaml 字段只读 + 唯一可改 .md）
 *  - Session 专家：维持 localStorage + mock 数据（功能上不做任何事）
 *  - 后端不可达时降级到 localStorage
 */

type ExpertType = "agent" | "session" | "skill";
type ExpertEntityType = Exclude<ExpertType, "skill">; // Expert 对象(非 skill)的实际类型
type ExpertStatus = "active" | "inactive";

interface Expert {
  id: string;
  name: string;
  type: ExpertEntityType;
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

const GRADIENT_MAP: Record<Exclude<ExpertType, "skill">, string> = {
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
  /**
   * 项目列表(由 MainApp 从 conversations.cwd 派生并下传)
   * 用于技能 tab 的范围下拉框
   */
  projects?: ProjectInfo[];
}

export function ExpertsPage({ onMenuClick, onBackToChat, projects = [] }: ExpertsPageProps) {
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

  // ── Skills（v2.0 重构：双 scope 架构） ───────────────────
  //   viewScope:  "global" → 显示全局(公用)skill
  //               string(cwd 路径) → 显示该项目的项目级 skill
  //   切换 viewScope 重新加载
  const [viewScope, setViewScope] = useState<"global" | string>("global");
  const [globalSkills, setGlobalSkills] = useState<SkillSummary[]>([]);
  const [projectSkills, setProjectSkills] = useState<SkillSummary[]>([]);
  const [skillDiagnostics, setSkillDiagnostics] = useState<Array<{ type: string; message: string; path?: string }>>([]);
  const [skillLoading, setSkillLoading] = useState<boolean>(false);
  const [skillError, setSkillError] = useState<string | null>(null);
  // Skill 详情 modal / 删除确认 modal / 创建 modal
  const [showSkillCreate, setShowSkillCreate] = useState(false);
  const [editingSkill, setEditingSkill] = useState<SkillDetail | null>(null);
  const [deleteSkillConfirm, setDeleteSkillConfirm] = useState<{ name: string; refs: string[] } | null>(null);
  const [togglingSkillName, setTogglingSkillName] = useState<string | null>(null);

  /**
   * 当前显示的 skill 列表(viewScope 决定)
   * - "global"   → globalSkills
   * - projectKey → projectSkills
   */
  const currentSkills = viewScope === "global" ? globalSkills : projectSkills;
  const currentScope: SkillScope = viewScope === "global" ? "global" : "project";
  const currentProjectKey = viewScope === "global" ? undefined : viewScope;

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

  // 加载 Skills（v2.0 重构：按 viewScope 加载,分组存 global/project）
  // 同时拉取所有有项目的 skills(用于"全局"视图也支持项目感知)
  const loadSkillsData = async (scope?: "global" | string) => {
    const targetScope = scope ?? viewScope;
    setSkillLoading(true);
    setSkillError(null);
    // 拉全局 + (可选)项目级;项目级只在 scope=project 时拉(避免空跑)
    const projectKey = targetScope === "global" ? undefined : targetScope;
    const res = await fetchSkills(projectKey);
    if (res.error) {
      setSkillError(res.error);
      logger.error(`加载 skills 列表失败：${res.error}`);
      // 不清空已有数据(避免抖动)
    } else if (res.data) {
      setGlobalSkills(res.data.global || []);
      setProjectSkills(res.data.project || []);
      setSkillDiagnostics(res.data.diagnostics || []);
    }
    setSkillLoading(false);
  };

  // viewScope 变化时重新加载
  useEffect(() => {
    if (activeTab === "skill") {
      loadSkillsData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewScope, activeTab]);

  useEffect(() => {
    loadAgentExperts();
    loadSkillsData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 切换 tab
  const handleTabChange = (tab: ExpertType) => setActiveTab(tab);

  // 重新加载：刷新 Agent + Skills 列表 + 重置 Session 数据
  const handleReload = () => {
    if (window.confirm("重新加载会重置 Session 专家为初始示例数据，并重新从后端拉取 Agent 专家和 Skills，确定继续？")) {
      syncStore.removeItem(LS_KEY);
      setSessionExperts(INITIAL_SESSION_EXPERTS);
      loadAgentExperts();
      loadSkillsData();
    }
  };

  /** Skill 总数(用于 tab badge: 全局 + 当前项目) */
  const skillCount = useMemo(() => {
    if (viewScope === "global") return globalSkills.length;
    return projectSkills.length;
  }, [viewScope, globalSkills, projectSkills]);

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
              if (activeTab === "skill") {
                setShowSkillCreate(true);
              } else {
                setEditingId(null);
                setShowAddModal(true);
              }
            }}
          >
            <Plus size={14} />
            <span>{activeTab === "skill" ? "新建技能" : "添加专家"}</span>
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
        <button
          role="tab"
          aria-selected={activeTab === "skill"}
          className={`tab ${activeTab === "skill" ? "active" : ""}`}
          onClick={() => handleTabChange("skill")}
        >
          技能
          <span className="tab-count">{skillCount}</span>
        </button>
      </div>

      {/* ===== Skill 范围下拉框(在 skill tab 内,tabs 下方) ===== */}
      {activeTab === "skill" && (
        <div
          className="page-subbar"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "12px 16px 4px",
          }}
        >
          <label htmlFor="skill-scope-select" style={{ fontSize: 13, color: "var(--page-text-muted, #888)" }}>
            范围:
          </label>
          <select
            id="skill-scope-select"
            className="page-select"
            value={viewScope}
            onChange={(e) => setViewScope(e.target.value)}
            title="选择技能范围(全局公用 / 某项目)"
            aria-label="技能范围"
          >
            <option value="global">🌐 全局(公用)</option>
            {projects.map(p => (
              <option key={p.id} value={p.id}>📁 {p.label}</option>
            ))}
          </select>
          {viewScope !== "global" && (
            <span className="text-xs text-content-tertiary" style={{ marginLeft: 4 }} title={viewScope}>
              {viewScope}
            </span>
          )}
        </div>
      )}

      {/* ===== Content ===== */}
      <div className="content">
        {/* 顶部诊断 banner：横跨所有 tab(agent 后端不可达 + skill 解析警告) */}
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
        {activeTab === "skill" && skillError && (
          <div className="file-warn" style={{ marginBottom: 12 }} role="alert">
            <div>
              <strong>后端不可达</strong> — {skillError}。Skills 列表为空，请检查后端服务。
            </div>
          </div>
        )}

        {/* Skill tab 内容(v2.0: 按 viewScope 单 scope 显示) */}
        {activeTab === "skill" ? (
          skillLoading ? (
            <div className="empty-state">
              <p className="empty-state-text">正在从后端加载 Skills…</p>
            </div>
          ) : currentSkills.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">
                <Plus size={20} />
              </div>
              <p className="empty-state-text">
                {viewScope === "global"
                  ? "后端暂无全局 Skill 配置。点击右上角「新建技能」开始。"
                  : `项目 ${viewScope.split(/[\\/]/).pop() || viewScope} 暂无项目级 Skill。点击右上角「新建技能」创建。`}
              </p>
              <p className="empty-state-hint">
                {viewScope === "global" ? (
                  <>
                    全局 skill 存储于 <code>~/.ripple/skills/&lt;name&gt;/SKILL.md</code>，所有项目可见。
                    <br />
                    项目级 skill 存于 <code>&lt;project&gt;/.ripple/skills/&lt;name&gt;/SKILL.md</code>，仅本项目可见,可与团队共享。
                  </>
                ) : (
                  <>
                    项目级 skill 存于该项目下的 <code>.ripple/skills/</code> 目录(支持 git 跟踪)。
                    <br />
                    文件夹不存在时,新建技能会自动创建。
                  </>
                )}
                <br />
                遵循 <a href="https://agentskills.io" target="_blank" rel="noreferrer">agentskills.io</a> 规范。
              </p>
            </div>
          ) : (
            <div className="resource-grid">
              {currentSkills.map(skill => (
                <SkillCard
                  key={`${skill.scope}:${skill.projectKey ?? ""}:${skill.name}`}
                  skill={skill}
                  toggling={togglingSkillName === skill.name}
                  onEdit={async () => {
                    const res = await fetchSkill(skill.scope, skill.name, skill.projectKey ?? undefined);
                    if (res.error) {
                      logger.error(`加载 skill 详情失败：${res.error}`);
                      window.alert(`无法加载 skill 详情：${res.error}`);
                      return;
                    }
                    if (res.data) setEditingSkill(res.data);
                  }}
                  onDelete={() => {
                    // 删除前先 fetch 详情拿引用列表
                    (async () => {
                      const res = await fetchSkill(skill.scope, skill.name, skill.projectKey ?? undefined);
                      const refs = res.data?.referencedByExperts ?? [];
                      setDeleteSkillConfirm({ name: skill.name, refs });
                    })();
                  }}
                  onToggle={async (disableModelInvocation) => {
                    setTogglingSkillName(skill.name);
                    try {
                      const res = await updateSkill(
                        skill.scope,
                        skill.name,
                        disableModelInvocation,
                        skill.projectKey ?? undefined,
                      );
                      if (res.error) {
                        logger.error(`更新 skill 状态失败：${res.error}`);
                        window.alert(`更新失败：${res.error}`);
                      } else {
                        logger.success(
                          `已${disableModelInvocation ? "禁用" : "启用"} ${skill.name}，需重启 server 才能让 Agent 重新加载`,
                        );
                        await loadSkillsData();
                      }
                    } finally {
                      setTogglingSkillName(null);
                    }
                  }}
                />
              ))}
            </div>
          )
        ) : activeTab === "agent" && agentLoading ? (
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

      {/* ===== Skill Create Modal(v2.0: scope 由当前 viewScope 决定) ===== */}
      {showSkillCreate && (
        <SkillCreateModal
          scope={currentScope}
          projectKey={currentProjectKey}
          onClose={() => setShowSkillCreate(false)}
          onSubmit={async (payload) => {
            const res = await createSkill(payload);
            if (res.error) {
              logger.error(`创建 skill 失败：${res.error}`);
              window.alert(`创建失败：${res.error}`);
              return;
            }
            logger.success(`已创建技能 ${payload.name}(${currentScope}),需重启 server 才能被 Agent 加载`);
            setShowSkillCreate(false);
            await loadSkillsData();
          }}
        />
      )}

      {/* ===== Skill View Modal(只读 + 启用/禁用开关) ===== */}
      {editingSkill && (
        <SkillViewModal
          skill={editingSkill}
          onClose={() => setEditingSkill(null)}
          onToggle={async (disableModelInvocation) => {
            const res = await updateSkill(
              editingSkill.scope,
              editingSkill.name,
              disableModelInvocation,
              editingSkill.projectKey ?? undefined,
            );
            if (res.error) {
              logger.error(`更新 skill 失败：${res.error}`);
              window.alert(`更新失败：${res.error}`);
              return;
            }
            logger.success(
              `已${disableModelInvocation ? "禁用" : "启用"} ${editingSkill.name}，需重启 server 才能让 Agent 重新加载`,
            );
            setEditingSkill(null);
            await loadSkillsData();
          }}
        />
      )}

      {/* ===== Skill Delete Confirm ===== */}
      {deleteSkillConfirm && (
        <div className="modal-overlay" onClick={(e) => {
          if (e.target === e.currentTarget) setDeleteSkillConfirm(null);
        }}>
          <div className="modal-card modal-card-sm">
            <h3 className="modal-title">确认删除</h3>
            {deleteSkillConfirm.refs.length > 0 ? (
              <>
                <p className="modal-desc">
                  技能「{deleteSkillConfirm.name}」正在被 {deleteSkillConfirm.refs.length} 个专家引用：
                </p>
                <ul className="modal-refs">
                  {deleteSkillConfirm.refs.map(r => (
                    <li key={r}><code>{r}</code></li>
                  ))}
                </ul>
                <p className="modal-desc">
                  请先在对应的 <code>.agent.yaml</code> 中移除 <code>skills: [...]</code> 字段，再删除此技能。
                </p>
                <div className="modal-actions">
                  <button onClick={() => setDeleteSkillConfirm(null)} className="btn-secondary flex-1">
                    我知道了
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="modal-desc">
                  确定要删除技能「{deleteSkillConfirm.name}」吗？此操作不可撤销。
                </p>
                <div className="modal-actions">
                  <button onClick={() => setDeleteSkillConfirm(null)} className="btn-secondary flex-1">
                    取消
                  </button>
                  <button
                    onClick={async () => {
                      // 用当前编辑时的 scope/projectKey(从 editingSkill 或 currentScope 推)
                      const scope = currentScope;
                      const projectKey = currentProjectKey;
                      const res = await deleteSkill(scope, deleteSkillConfirm.name, projectKey);
                      if (res.error) {
                        // 409: 被引用
                        if ((res as any).referencedByExperts) {
                          const refs = (res as any).referencedByExperts as string[];
                          setDeleteSkillConfirm({ name: deleteSkillConfirm.name, refs });
                          return;
                        }
                        logger.error(`删除 skill 失败：${res.error}`);
                        window.alert(`删除失败：${res.error}`);
                        return;
                      }
                      logger.success(`已删除技能 ${deleteSkillConfirm.name}，需重启 server`);
                      setDeleteSkillConfirm(null);
                      await loadSkillsData();
                    }}
                    className="btn-danger flex-1"
                  >
                    删除
                  </button>
                </div>
              </>
            )}
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
  const [type, setType] = useState<ExpertEntityType>(initial?.type ?? "agent");
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
                onChange={(e) => setType(e.target.value as ExpertEntityType)}
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

/* ============================================================
 *  SkillCard — Skill 列表卡片
 *  比 ExpertCard 轻量: 无 tools/thinkingLevel/使用统计
 *  多了「被 N 个专家引用」行
 *  状态徽章可点击切换启用/禁用(快速操作)
 * ============================================================ */
interface SkillCardProps {
  skill: SkillSummary;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: (disableModelInvocation: boolean) => void;
  /** 当前是否有 toggle 请求在进行(锁定状态) */
  toggling?: boolean;
}

function SkillCard({ skill, onEdit, onDelete, onToggle, toggling }: SkillCardProps) {
  // 简化时间显示: "X 分钟前" / "X 小时前" / "X 天前"
  // 注: 列表接口的 mtimeMs/sizeBytes 是 0(只详情接口有),所以默认不显示
  const timeAgo = skill.mtimeMs > 0 ? formatTimeAgo(skill.mtimeMs) : null;
  const sizeLabel = skill.sizeBytes > 0 ? `${(skill.sizeBytes / 1024).toFixed(1)} KB` : null;
  // 禁用态卡片置灰
  const isDisabled = skill.disableModelInvocation;
  return (
    <article
      className="card"
      data-type="skill"
      style={{
        opacity: isDisabled ? 0.55 : 1,
        transition: "opacity 0.2s",
      }}
    >
      <div className="card-head">
        <div className="card-head-top">
          <div className="card-icon icon-grad-amber">
            <FileText />
          </div>
          <div className="card-head-right">
            <div className="card-title-row">
              <h3 className="card-title">{skill.name}</h3>
              {/* 作用域标签: 全局/项目 */}
              <span className={`tag ${skill.scope === "global" ? "tag-blue" : "tag-violet"}`}>
                <span className="tag-dot" />
                {skill.scope === "global" ? "全局" : "项目"}
              </span>
              {/* 启用/隐藏徽章: 可点击切换 */}
              <button
                type="button"
                className={`tag ${isDisabled ? "tag-amber" : "tag-emerald"}`}
                onClick={(e) => {
                  e.stopPropagation();
                  if (toggling) return;
                  onToggle(!isDisabled);
                }}
                disabled={toggling}
                title={isDisabled
                  ? "点击 → 启用(在 System Prompt 中可见)"
                  : "点击 → 禁用(从 System Prompt 中移除)"}
                style={{
                  border: "none",
                  cursor: toggling ? "wait" : "pointer",
                  padding: "2px 8px",
                  fontSize: 11,
                  opacity: toggling ? 0.6 : 1,
                  transition: "opacity 0.15s",
                }}
              >
                <span className="tag-dot" />
                {isDisabled ? "隐藏" : "启用"}
              </button>
            </div>
            <div className="card-meta">
              <span className="meta-item">SKILL.md</span>
              {skill.scope === "project" && skill.projectKey && (
                <span className="meta-item" title={skill.projectKey}>
                  📁 {skill.projectKey.split(/[\\/]/).pop() || skill.projectKey}
                </span>
              )}
            </div>
          </div>
        </div>
        <p className="card-desc line-clamp-2">{skill.description || "(无描述)"}</p>
      </div>
      {(timeAgo || sizeLabel) && (
        <div className="card-meta" style={{ marginTop: 4 }}>
          <span
            className="meta-item"
            style={{ color: "var(--page-text-muted, #888)", fontSize: 12 }}
            title={skill.mtimeMs > 0 ? new Date(skill.mtimeMs).toLocaleString() : ""}
          >
            {timeAgo ? `修改于 ${timeAgo}` : ""}{timeAgo && sizeLabel ? " · " : ""}{sizeLabel ?? ""}
          </span>
        </div>
      )}
      <div className="card-actions">
        <button className="btn-ghost" onClick={onEdit}>
          <Eye size={13} />
          查看
        </button>
        <button className="btn-ghost btn-danger-hover" onClick={onDelete}>
          <Trash2 size={13} />
          删除
        </button>
      </div>
    </article>
  );
}

function formatTimeAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "刚刚";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} 个月前`;
  return `${Math.floor(months / 12)} 年前`;
}

/* ============================================================
 *  SkillCreateModal — 新建技能
 *  - name 输入: 实时校验 agentskills.io 规范
 *  - description 输入: 实时字数(>1000 橙色, >1024 禁用)
 *  - content: markdown body textarea
 *  - disableModelInvocation 复选框
 * ============================================================ */
interface SkillCreateModalProps {
  /** 当前 viewScope(scope=project 时需要 projectKey) */
  scope: SkillScope;
  projectKey?: string;
  onClose: () => void;
  onSubmit: (payload: {
    scope: SkillScope;
    projectKey?: string;
    name: string;
    description: string;
    content: string;
    disableModelInvocation?: boolean;
  }) => Promise<void> | void;
}

function SkillCreateModal({ scope, projectKey, onClose, onSubmit }: SkillCreateModalProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [disableMI, setDisableMI] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // 名称校验(镜像 server 端 validateSkillName)
  const nameErrors = useMemo(() => {
    const errors: string[] = [];
    if (!name) return errors;
    if (name.length > 64) errors.push("name 超过 64 字符");
    if (!/^[a-z0-9-]+$/.test(name)) errors.push("只允许小写字母、数字、连字符");
    if (name.startsWith("-") || name.endsWith("-")) errors.push("首尾不能是连字符");
    if (name.includes("--")) errors.push("不能含连续连字符");
    return errors;
  }, [name]);

  const descLength = description.length;
  const descTooLong = descLength > 1024;
  const descWarn = descLength > 1000 && descLength <= 1024;
  const isValid = name.length > 0 && nameErrors.length === 0 && description.trim().length > 0 && !descTooLong;

  const handleSubmit = async () => {
    if (!isValid || submitting) return;
    if (scope === "project" && !projectKey) {
      window.alert("项目级 skill 必须选择项目(顶部下拉框)");
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit({
        scope,
        projectKey: scope === "project" ? projectKey : undefined,
        name: name.trim(),
        description: description.trim(),
        content,
        disableModelInvocation: disableMI,
      });
    } finally {
      setSubmitting(false);
    }
  };

  const targetPath = scope === "global"
    ? `~/.ripple/skills/${name || "<name>"}/SKILL.md`
    : `${projectKey}/.ripple/skills/${name || "<name>"}/SKILL.md`;

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="page-modal" role="dialog" aria-modal="true">
        <header className="page-modal-head">
          <div>
            <h2 className="page-modal-title">新建技能</h2>
            <p className="page-modal-sub">
              作用域: <strong>{scope === "global" ? "全局(公用)" : `项目 (${projectKey})`}</strong> ·{" "}
              遵循 <a href="https://agentskills.io" target="_blank" rel="noreferrer">agentskills.io</a> 规范
            </p>
          </div>
          <button className="icon-btn modal-close" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </header>
        <div className="page-modal-body">
          <div className="field">
            <label className="field-label">
              技能名 <span className="text-content-tertiary">(不可修改,小写字母/数字/连字符, ≤64 字符)</span>
            </label>
            <input
              type="text"
              className={`field-input ${nameErrors.length > 0 ? "!border-red-500" : ""}`}
              placeholder="例如:code-review"
              value={name}
              onChange={(e) => setName(e.target.value.trim().toLowerCase())}
              autoFocus
            />
            {nameErrors.length > 0 && (
              <p className="field-error">{nameErrors.join("; ")}</p>
            )}
            <p className="field-hint text-content-tertiary">将创建于: <code>{targetPath}</code></p>
          </div>
          <div className="field">
            <label className="field-label">
              描述 <span className="text-content-tertiary">(必填, ≤1024 字符,告诉模型何时使用此技能)</span>
            </label>
            <textarea
              className={`field-input ${descTooLong ? "!border-red-500" : descWarn ? "!border-amber-500" : ""}`}
              placeholder="例如:审查代码改动并提供具体可执行的改进建议"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />
            <p className={`field-hint ${descTooLong ? "text-red-500" : descWarn ? "text-amber-500" : "text-content-tertiary"}`}>
              {descLength} / 1024 字符
            </p>
          </div>
          <div className="field">
            <label className="field-label">
              内容 <span className="text-content-tertiary">(markdown body,详细说明技能的执行步骤)</span>
            </label>
            <textarea
              className="field-textarea"
              placeholder={`# 工作流程\n\n1. 阅读 ...\n2. 分析 ...\n3. 输出 ...`}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={12}
            />
          </div>
          <div className="field">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={disableMI}
                onChange={(e) => setDisableMI(e.target.checked)}
              />
              <span>
                隐藏技能 <span className="text-content-tertiary">(勾选后,系统提示词中不展示此技能,仅支持显式调用)</span>
              </span>
            </label>
          </div>
          <div className="file-warn !mt-2">
            <div className="text-xs">
              ⚠️ 保存后需 <strong>重启 server</strong>(<code>pm2 restart ripple-agent-3002</code>)才能被 Agent harness 加载到 system prompt。
              {scope === "project" && (
                <>
                  <br />
                  💡 项目级 skill 存于项目目录下,建议纳入 <strong>git 跟踪</strong>以便团队共享。
                </>
              )}
            </div>
          </div>
        </div>
        <footer className="page-modal-foot">
          <button className="page-btn-secondary" onClick={onClose} disabled={submitting}>
            取消
          </button>
          <button
            className="page-btn"
            onClick={handleSubmit}
            disabled={!isValid || submitting}
          >
            <Check size={14} />
            <span>{submitting ? "保存中..." : "创建技能"}</span>
          </button>
        </footer>
      </div>
    </div>
  );
}

/* ============================================================
 *  SkillViewModal — 只读查看 + 启用/禁用开关(本期策略)
 *  - 不可编辑 description / content(防破坏多行 metadata 等)
 *  - 可切换 disableModelInvocation(在 system prompt 中可见性)
 *  - 顶部 diagnostics banner(若有)
 *  - 底部显示「被 N 个专家引用」
 * ============================================================ */
interface SkillViewModalProps {
  skill: SkillDetail;
  onClose: () => void;
  /** 用户点击启用/禁用开关时调用,只传一个布尔 */
  onToggle: (disableModelInvocation: boolean) => Promise<void> | void;
}

function SkillViewModal({ skill, onClose, onToggle }: SkillViewModalProps) {
  const [disableMI, setDisableMI] = useState(skill.disableModelInvocation);
  const [submitting, setSubmitting] = useState(false);

  const handleToggle = async (next: boolean) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onToggle(next);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="page-modal" role="dialog" aria-modal="true">
        <header className="page-modal-head">
          <div>
            <h2 className="page-modal-title">
              {skill.name}
              <span
                className={`tag ${skill.scope === "global" ? "tag-blue" : "tag-violet"}`}
                style={{ marginLeft: 8 }}
              >
                <span className="tag-dot" />
                {skill.scope === "global" ? "全局" : "项目"}
              </span>
            </h2>
            <p className="page-modal-sub">
              {skill.filePath.split(/[\\/]/).slice(-2).join("/")}
            </p>
          </div>
          <button className="icon-btn modal-close" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </header>
        <div className="page-modal-body">
          {/* 诊断信息(若有) */}
          {skill.diagnostics.length > 0 && (
            <div className="file-warn" style={{ marginBottom: 12 }} role="alert">
              <div className="text-xs">
                <strong>配置问题：</strong>
                <ul className="mt-1 ml-4 list-disc">
                  {skill.diagnostics.map((d, i) => (
                    <li key={i}>{d.message}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {/* 启用/禁用开关 */}
          <div className="field">
            <div
              className="flex items-center justify-between gap-3 p-3 rounded-md"
              style={{
                background: "var(--surface-secondary, #f5f5f5)",
                border: "1px solid var(--border, #e5e5e5)",
              }}
            >
              <div className="flex items-center gap-2">
                <Power size={14} />
                <div>
                  <div className="text-sm font-medium">在 System Prompt 中启用</div>
                  <div className="text-xs text-content-tertiary">
                    关闭后,模型看不到此 skill(可显式调用但 AI 不会自动使用)
                  </div>
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={!disableMI}
                disabled={submitting}
                onClick={() => {
                  const next = !disableMI;
                  setDisableMI(next);
                  handleToggle(next);
                }}
                style={{
                  width: 40,
                  height: 22,
                  borderRadius: 11,
                  background: !disableMI ? "var(--accent, #10b981)" : "var(--border, #ccc)",
                  border: "none",
                  cursor: submitting ? "wait" : "pointer",
                  position: "relative",
                  transition: "background 0.2s",
                  padding: 0,
                }}
              >
                <span
                  style={{
                    position: "absolute",
                    top: 2,
                    left: !disableMI ? 20 : 2,
                    width: 18,
                    height: 18,
                    borderRadius: "50%",
                    background: "#fff",
                    transition: "left 0.2s",
                    boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
                  }}
                />
              </button>
            </div>
          </div>

          {/* 描述(只读) */}
          <div className="field">
            <label className="field-label flex items-center gap-1.5">
              <Lock size={12} className="text-content-tertiary" />
              描述 <span className="text-content-tertiary">(只读)</span>
            </label>
            <div
              className="field-input"
              style={{
                background: "var(--surface-secondary, #f5f5f5)",
                opacity: 0.7,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                minHeight: 40,
                padding: "8px 12px",
              }}
            >
              {skill.description || "(无描述)"}
            </div>
          </div>

          {/* 完整内容(只读,只展示,不让编辑) */}
          <div className="field">
            <label className="field-label flex items-center gap-1.5">
              <Lock size={12} className="text-content-tertiary" />
              内容 (markdown body) <span className="text-content-tertiary">(只读 — 本期仅支持启用/禁用)</span>
            </label>
            <pre
              style={{
                background: "var(--surface-secondary, #f5f5f5)",
                opacity: 0.85,
                padding: "12px",
                borderRadius: 6,
                border: "1px solid var(--border, #e5e5e5)",
                fontFamily: "ui-monospace, monospace",
                fontSize: 12,
                lineHeight: 1.6,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                maxHeight: 360,
                overflow: "auto",
                margin: 0,
              }}
            >
              {skill.content || "(空内容)"}
            </pre>
          </div>

          {/* 反向引用 */}
          {skill.referencedByExperts.length > 0 && (
            <div className="field">
              <div className="flex items-center gap-1.5 text-xs text-content-secondary dark:text-content-secondary-dark">
                <Link2 size={12} />
                <span>
                  被 <strong>{skill.referencedByExperts.length}</strong> 个专家引用:
                </span>
              </div>
              <ul className="mt-1.5 flex flex-wrap gap-1.5">
                {skill.referencedByExperts.map(r => (
                  <li key={r} className="tag tag-blue">
                    <code className="text-xs">{r}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="file-warn !mt-2">
            <div className="text-xs">
              ℹ️ 切换启用状态后需 <strong>重启 server</strong> 才能被 Agent 重新加载。
            </div>
          </div>
        </div>
        <footer className="page-modal-foot">
          <button className="page-btn-secondary" onClick={onClose} disabled={submitting}>
            关闭
          </button>
        </footer>
      </div>
    </div>
  );
}

export default ExpertsPage;
