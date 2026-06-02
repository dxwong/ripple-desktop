import { useState, useEffect, useMemo } from "react";
import {
  Server,
  Shield,
  ShieldOff,
  ShieldCheck,
  Palette,
  Eye,
  EyeOff,
  Check,
  RefreshCw,
  Save,
  Loader2,
  Trash2,
  Plus,
  Search,
  Cpu,
  Globe,
  Key,
  Smartphone,
  Folder,
} from "lucide-react";
import type {
  AppSettings,
  ModelConfig,
  ModelConfigFormData,
  ApiProvider,
  PermissionMode,
} from "ripple-shared/types";
import { PERMISSION_MODES } from "ripple-shared/types";
import { testConnection } from "../services/api";

/**
 * 设置全屏页 — v2.1
 *  - 移植自 demo (plans/desktop/settings.html + settings.js)
 *  - 三个 pane: API 配置 / 风险控制 / 通用
 *  - 顶部横向 nav 切换，左侧服务商列表 + 右侧详情布局
 *  - 第一阶段 (UI) 只覆盖现有 AppSettings 字段；下一阶段再扩展 32 provider 列表
 */

type SettingsPane = "api" | "risk" | "general";

/** API 提供商选项（与现有 SettingsPanel 一致） */
const PROVIDERS: { value: ApiProvider; label: string; endpoint: string; model: string }[] = [
  { value: "custom", label: "自定义 OpenAI 兼容", endpoint: "https://api.openai.com/v1", model: "gpt-4o" },
  { value: "openai", label: "OpenAI", endpoint: "https://api.openai.com/v1", model: "gpt-4o" },
];

interface SettingsPageProps {
  settings: AppSettings;
  onUpdate: (partial: Partial<AppSettings>) => void;
  onReset: () => void;
  /** 保存模型配置（新建或编辑） */
  onSaveModelConfig: (form: ModelConfigFormData, editId?: string) => void;
  /** 删除模型配置 */
  onDeleteModelConfig: (id: string) => void;
  /** 切换当前模型 */
  onSetActiveModel: (id: string) => void;
  /** 顶栏左侧菜单按钮回调 */
  onMenuClick?: () => void;
}

/** 小图标（避免 lucide 库和现有 icon 类冲突） */
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

function FolderOpenIcon() {
  return (
    <Folder size={15} className="text-page-text-3" style={{ color: "var(--page-text-3)" }} />
  );
}

export function SettingsPage({
  settings,
  onUpdate,
  onReset,
  onSaveModelConfig,
  onDeleteModelConfig,
  onSetActiveModel,
  onMenuClick,
}: SettingsPageProps) {
  // 当前 pane
  const [activePane, setActivePane] = useState<SettingsPane>("api");

  // ===== API 配置：列表选中态 =====
  const [selectedConfigId, setSelectedConfigId] = useState<string>(
    settings.activeModelId || settings.modelConfigs[0]?.id || ""
  );
  // 编辑态（undefined = 新建）
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  // 表单字段
  const [formName, setFormName] = useState("");
  const [formProvider, setFormProvider] = useState<ApiProvider>("custom");
  const [formModel, setFormModel] = useState("");
  const [formEndpoint, setFormEndpoint] = useState("");
  const [formKey, setFormKey] = useState("");
  // API Key 显示/隐藏
  const [showKey, setShowKey] = useState(false);
  // 服务商列表搜索
  const [providerSearch, setProviderSearch] = useState("");
  // 已保存提示
  const [saved, setSaved] = useState(false);
  // 测试连接
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  // 当前选中的配置（来自 selectedConfigId，找不到则用第一个）
  const activeCfg = useMemo(
    () => settings.modelConfigs.find((c) => c.id === selectedConfigId) ?? settings.modelConfigs[0],
    [settings.modelConfigs, selectedConfigId]
  );

  // 表单对应的源配置
  // - editingId 为真（非空字符串） → 编辑该 ID 的配置
  // - editingId 为 "" → 新建模式（formSource = undefined）
  // - editingId 为 undefined → 查看模式，用 activeCfg
  const formSource = useMemo(() => {
    if (editingId !== undefined) {
      // 编辑或新建模式：editingId 是空字符串或具体 ID
      if (editingId === "") return undefined;
      return settings.modelConfigs.find((c) => c.id === editingId);
    }
    return activeCfg;
  }, [editingId, activeCfg, settings.modelConfigs]);

  // 同步表单字段（仅在 formSource 变化或 editingId 变化时同步）
  useEffect(() => {
    if (formSource === undefined) {
      // 新建模式（editingId === ""）
      setFormName("");
      setFormProvider("custom");
      setFormModel("gpt-4o");
      setFormEndpoint("https://api.openai.com/v1");
      setFormKey("");
    } else {
      // 查看或编辑模式
      setFormName(formSource.name);
      setFormProvider(formSource.provider);
      setFormModel(formSource.model);
      setFormEndpoint(formSource.endpoint);
      setFormKey(formSource.apiKey);
    }
  }, [formSource]);

  // 新建标志：editingId 为 ""（空字符串）表示新建
  const isNew = editingId === "";

  // 过滤后的服务商列表（按名称搜索）
  const filteredConfigs = useMemo(() => {
    const q = providerSearch.trim().toLowerCase();
    if (!q) return settings.modelConfigs;
    return settings.modelConfigs.filter(
      (c) => c.name.toLowerCase().includes(q) || c.model.toLowerCase().includes(q)
    );
  }, [settings.modelConfigs, providerSearch]);

  /** 选择提供商时自动填充 */
  const handleProviderChange = (value: ApiProvider) => {
    const provider = PROVIDERS.find((p) => p.value === value);
    if (provider) {
      setFormEndpoint(provider.endpoint);
      if (isNew) setFormModel(provider.model);
    }
    setFormProvider(value);
  };

  /** 开始编辑已有配置 */
  const handleEdit = (cfg: ModelConfig) => {
    setSelectedConfigId(cfg.id);
    setEditingId(cfg.id);
  };

  /** 开始新建配置 */
  const handleNew = () => {
    setEditingId(""); // 空字符串 = 新建模式
    setSelectedConfigId("");
  };

  /** 保存当前表单为模型配置 */
  const handleSave = () => {
    if (!formName.trim()) return;
    // 新建：传 undefined；编辑：传 editingId；查看但修改：传 selectedConfigId（当作编辑）
    const targetId = isNew
      ? undefined
      : editingId ?? (selectedConfigId || undefined);
    onSaveModelConfig(
      {
        name: formName.trim(),
        provider: formProvider,
        endpoint: formEndpoint,
        apiKey: formKey,
        model: formModel,
      },
      targetId
    );
    setSaved(true);
    setEditingId(undefined);
    setTimeout(() => setSaved(false), 2000);
  };

  /** 切换配置为激活 */
  const handleSwitchModel = (id: string) => {
    onSetActiveModel(id);
    setSelectedConfigId(id);
    setEditingId(undefined);
  };

  /** 测试当前表单配置的连接（通过后端） */
  const handleTestConnection = async () => {
    if (!formEndpoint || !formKey || !formModel) return;
    setTesting(true);
    setTestResult(null);
    const result = await testConnection({
      endpoint: formEndpoint,
      apiKey: formKey,
      model: formModel,
    });
    if (result.error) {
      setTestResult({ ok: false, msg: result.error });
    } else if (result.data) {
      setTestResult({
        ok: result.data.success,
        msg: result.data.message || result.data.error || "未知结果",
      });
    }
    setTesting(false);
  };

  // 渲染 nav 按钮
  const renderNavItem = (key: SettingsPane, Icon: typeof Server, label: string) => (
    <button
      type="button"
      className={`settings-nav-item ${activePane === key ? "active" : ""}`}
      onClick={() => setActivePane(key)}
    >
      <Icon size={15} />
      <span>{label}</span>
    </button>
  );

  return (
    <section className="page page-settings" id="page-settings">
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
            <h1 className="page-title">设置</h1>
          </div>
        </div>
      </header>

      {/* ===== Settings Layout ===== */}
      <div className="settings-layout">
        {/* 顶部 nav */}
        <nav className="settings-nav">
          {renderNavItem("api", Server, "API 配置")}
          {renderNavItem("risk", Shield, "风险控制")}
          {renderNavItem("general", Palette, "通用")}
        </nav>

        {/* 内容区 */}
        <div className="settings-content">
          {/* ===== Pane 1: API 配置 ===== */}
          <div className={`settings-pane ${activePane === "api" ? "active" : ""}`} data-pane="api">
            <div className="providers-layout">
              {/* 左侧：服务商列表 */}
              <aside className="providers-sidebar">
                <div className="providers-search">
                  <Search size={14} />
                  <input
                    type="text"
                    className="providers-search-input"
                    placeholder="搜索模型配置..."
                    value={providerSearch}
                    onChange={(e) => setProviderSearch(e.target.value)}
                    spellCheck={false}
                  />
                  <button
                    className="icon-btn providers-add-btn"
                    type="button"
                    onClick={handleNew}
                    title="新建模型配置"
                    aria-label="新建模型配置"
                  >
                    <Plus size={14} />
                  </button>
                </div>

                <div className="providers-list">
                  {filteredConfigs.length === 0 ? (
                    <div className="providers-empty">
                      {providerSearch ? "没有匹配的模型配置" : "还没有模型配置"}
                    </div>
                  ) : (
                    <div className="providers-group">
                      <div className="providers-group-items">
                        {filteredConfigs.map((cfg) => (
                          <button
                            key={cfg.id}
                            type="button"
                            className={`provider-item ${
                              cfg.id === selectedConfigId && editingId === undefined ? "active" : ""
                            }`}
                            onClick={() => {
                              setSelectedConfigId(cfg.id);
                              setEditingId(undefined);
                            }}
                          >
                            <span
                              className={`provider-icon ${cfg.provider === "openai" ? "openai" : "custom"}`}
                            >
                              {cfg.provider === "openai" ? "O" : "C"}
                            </span>
                            <span className="provider-name">{cfg.name}</span>
                            {cfg.id === settings.activeModelId && (
                              <span className="provider-dot" title="当前激活" />
                            )}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </aside>

              {/* 右侧：详情 */}
              <div className="provider-detail">
                {activeCfg || isNew ? (
                  <>
                    <div className="provider-detail-head">
                      <div className="provider-detail-title">
                        <span
                          className={`provider-icon ${formProvider === "openai" ? "openai" : "custom"}`}
                        >
                          {formProvider === "openai" ? "O" : "C"}
                        </span>
                        <div>
                          <div className="provider-detail-name">
                            {isNew
                              ? "新建模型配置"
                              : editingId
                                ? `编辑：${formName || "(未命名)"}`
                                : formName || "(未命名)"}
                          </div>
                          <div className="provider-detail-sub">
                            {isNew
                              ? "填写下方字段后点击保存"
                              : editingId
                                ? "修改后点击保存"
                                : `${activeCfg?.model ?? ""} · ${activeCfg?.endpoint ?? ""}`}
                          </div>
                        </div>
                      </div>
                      {!isNew && !editingId && activeCfg && (
                        <div className="flex items-center gap-1.5 shrink-0">
                          {activeCfg.id !== settings.activeModelId && (
                            <button
                              type="button"
                              className="page-btn-secondary"
                              onClick={() => handleSwitchModel(activeCfg.id)}
                            >
                              <Check size={14} />
                              <span>启用</span>
                            </button>
                          )}
                          {settings.modelConfigs.length > 1 && (
                            <button
                              type="button"
                              className="icon-btn"
                              onClick={() => onDeleteModelConfig(activeCfg.id)}
                              title="删除配置"
                              aria-label="删除配置"
                            >
                              <Trash2 size={14} />
                            </button>
                          )}
                        </div>
                      )}
                    </div>

                    {/* 配置名称 */}
                    <div className="setting-section">
                      <div className="setting-section-title">
                        <Server size={15} />
                        <span>配置名称</span>
                      </div>
                      <input
                        type="text"
                        className="field-input"
                        value={formName}
                        onChange={(e) => setFormName(e.target.value)}
                        placeholder="例如：我的 OpenAI、工作用 DeepSeek"
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </div>

                    {/* API 提供商 */}
                    <div className="setting-section">
                      <div className="setting-section-title">
                        <Globe size={15} />
                        <span>API 提供商</span>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {PROVIDERS.map((p) => (
                          <button
                            key={p.value}
                            type="button"
                            onClick={() => handleProviderChange(p.value)}
                            className={`page-btn-secondary ${
                              formProvider === p.value ? "!border-rose" : ""
                            }`}
                            style={
                              formProvider === p.value
                                ? {
                                    borderColor: "var(--page-rose)",
                                    color: "var(--page-rose)",
                                    background: "var(--page-rose-soft)",
                                  }
                                : undefined
                            }
                          >
                            <span className="font-medium">{p.label}</span>
                            <span className="text-xs opacity-60 ml-1.5">{p.endpoint}</span>
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* 模型名称 */}
                    <div className="setting-section">
                      <div className="setting-section-title">
                        <Cpu size={15} />
                        <span>模型名称</span>
                      </div>
                      <input
                        type="text"
                        className="field-input"
                        value={formModel}
                        onChange={(e) => setFormModel(e.target.value)}
                        placeholder="gpt-4o / deepseek-chat"
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </div>

                    {/* 接口地址 */}
                    <div className="setting-section">
                      <div className="setting-section-title">
                        <Globe size={15} />
                        <span>接口地址</span>
                      </div>
                      <input
                        type="text"
                        className="field-input"
                        value={formEndpoint}
                        onChange={(e) => setFormEndpoint(e.target.value)}
                        placeholder="https://api.openai.com/v1"
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </div>

                    {/* API Key */}
                    <div className="setting-section">
                      <div className="setting-section-title">
                        <Key size={15} />
                        <span>API Key</span>
                      </div>
                      <div className="input-with-action">
                        <input
                          type={showKey ? "text" : "password"}
                          className="field-input"
                          value={formKey}
                          onChange={(e) => setFormKey(e.target.value)}
                          placeholder="sk-..."
                          autoComplete="off"
                          spellCheck={false}
                        />
                        <button
                          type="button"
                          className="icon-action"
                          onClick={() => setShowKey(!showKey)}
                          title={showKey ? "隐藏" : "显示"}
                          aria-label={showKey ? "隐藏 API Key" : "显示 API Key"}
                        >
                          {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
                        </button>
                      </div>
                    </div>

                    {/* 保存按钮 */}
                    <button
                      type="button"
                      onClick={handleSave}
                      disabled={!formName.trim()}
                      className="page-btn w-full justify-center"
                    >
                      {saved ? (
                        <>
                          <Check size={14} />
                          <span>已保存</span>
                        </>
                      ) : (
                        <>
                          <Save size={14} />
                          <span>{isNew || !editingId ? "保存配置" : "更新配置"}</span>
                        </>
                      )}
                    </button>

                    {/* 测试连接 */}
                    <button
                      type="button"
                      onClick={handleTestConnection}
                      disabled={testing || !formEndpoint || !formKey || !formModel}
                      className="page-btn-secondary w-full justify-center"
                    >
                      {testing ? (
                        <>
                          <Loader2 size={14} className="animate-spin" />
                          <span>测试中...</span>
                        </>
                      ) : (
                        <>
                          <RefreshCw size={14} />
                          <span>测试连接</span>
                        </>
                      )}
                    </button>

                    {/* 测试结果 */}
                    {testResult && (
                      <div
                        className="connectivity-result"
                        style={
                          testResult.ok
                            ? {
                                background: "rgba(34, 197, 94, 0.08)",
                                borderColor: "rgba(34, 197, 94, 0.3)",
                                color: "#16a34a",
                              }
                            : {
                                background: "rgba(239, 68, 68, 0.08)",
                                borderColor: "rgba(239, 68, 68, 0.3)",
                                color: "#dc2626",
                              }
                        }
                      >
                        {testResult.ok ? "✓ " : "✗ "}
                        {testResult.msg}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="provider-empty">
                    <FolderOpenIcon />
                    <span>从左侧选择一个模型配置，或点击 + 新建</span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* ===== Pane 2: 风险控制 ===== */}
          <div className={`settings-pane ${activePane === "risk" ? "active" : ""}`} data-pane="risk">
            <div className="setting-section">
              <div className="setting-section-head">
                <div>
                  <div className="setting-section-title">
                    <Shield size={15} />
                    <span>命令白名单</span>
                  </div>
                  <p className="setting-section-desc">
                    开启后, AI 只能执行白名单中的 shell 命令。不在白名单的命令会被拒绝执行。
                  </p>
                </div>
                <label className="toggle" title="启用命令白名单">
                  <input
                    type="checkbox"
                    checked={settings.riskManagement.commandWhitelistEnabled}
                    onChange={() => {
                      onUpdate({
                        riskManagement: {
                          ...settings.riskManagement,
                          commandWhitelistEnabled: !settings.riskManagement.commandWhitelistEnabled,
                        },
                      });
                    }}
                  />
                  <span className="toggle-slider" />
                </label>
              </div>
              <div
                className={`checkbox-list ${
                  !settings.riskManagement.commandWhitelistEnabled ? "disabled" : ""
                }`}
              >
                {settings.riskManagement.whitelist.map((entry) => (
                  <label key={entry.command} className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={entry.enabled}
                      disabled={!settings.riskManagement.commandWhitelistEnabled}
                      onChange={() => {
                        onUpdate({
                          riskManagement: {
                            ...settings.riskManagement,
                            whitelist: settings.riskManagement.whitelist.map((w) =>
                              w.command === entry.command ? { ...w, enabled: !w.enabled } : w
                            ),
                          },
                        });
                      }}
                    />
                    <span className="checkbox-row-key">{entry.command}</span>
                    <span className="checkbox-row-desc">{entry.label}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="setting-section">
              <div className="setting-section-title">
                <Folder size={15} />
                <span>文件系统路径限制</span>
              </div>
              <div className="setting-card">
                <div className="setting-row">
                  <div className="setting-row-meta">
                    <div className="setting-row-label">限制到工作目录</div>
                    <div className="setting-row-desc">
                      AI 只能操作当前项目工作目录下的文件（通过 <code className="setting-row-code">cwd</code> 指定）。
                    </div>
                  </div>
                  <label className="toggle" title="限制到工作目录">
                    <input
                      type="checkbox"
                      checked={settings.riskManagement.pathRestriction.enabled}
                      onChange={() => {
                        onUpdate({
                          riskManagement: {
                            ...settings.riskManagement,
                            pathRestriction: {
                              ...settings.riskManagement.pathRestriction,
                              enabled: !settings.riskManagement.pathRestriction.enabled,
                            },
                          },
                        });
                      }}
                    />
                    <span className="toggle-slider" />
                  </label>
                </div>
                <div className="setting-row">
                  <div className="setting-row-meta">
                    <div className="setting-row-label">允许读取外部文件</div>
                    <div className="setting-row-desc">
                      开启后 AI 可以读取工作目录外的文件，但不能写入。关闭后 AI 只能访问工作目录内的文件。
                    </div>
                  </div>
                  <label className="toggle" title="允许读取外部文件">
                    <input
                      type="checkbox"
                      checked={settings.riskManagement.pathRestriction.allowReadOutside}
                      disabled={!settings.riskManagement.pathRestriction.enabled}
                      onChange={() => {
                        onUpdate({
                          riskManagement: {
                            ...settings.riskManagement,
                            pathRestriction: {
                              ...settings.riskManagement.pathRestriction,
                              allowReadOutside: !settings.riskManagement.pathRestriction.allowReadOutside,
                            },
                          },
                        });
                      }}
                    />
                    <span className="toggle-slider" />
                  </label>
                </div>
              </div>
            </div>

            <div className="setting-section">
              <div className="setting-section-title">
                <Shield size={15} />
                <span>权限模式</span>
              </div>
              <p className="setting-section-desc">
                决定 AI 在执行敏感操作前是否需要用户确认。
              </p>
              <div className="grid gap-2" style={{ gridTemplateColumns: "1fr" }}>
                {PERMISSION_MODES.map((mode) => {
                  const ModeIcon =
                    mode.value === "auto"
                      ? ShieldOff
                      : mode.value === "confirm"
                        ? Shield
                        : ShieldCheck;
                  const isActive = settings.permissionMode === mode.value;
                  return (
                    <button
                      key={mode.value}
                      type="button"
                      onClick={() => onUpdate({ permissionMode: mode.value as PermissionMode })}
                      style={{
                        textAlign: "left",
                        cursor: "pointer",
                        padding: "12px 14px",
                        borderRadius: "var(--page-radius-md)",
                        background: isActive
                          ? "var(--page-surface-2)"
                          : "var(--page-bg)",
                        border: isActive
                          ? "1px solid var(--page-rose)"
                          : "1px solid var(--page-border)",
                        display: "flex",
                        alignItems: "center",
                        gap: "12px",
                        transition: "background-color 120ms ease, border-color 120ms ease",
                      }}
                    >
                      <ModeIcon
                        size={16}
                        style={{
                          color: isActive ? "var(--page-rose)" : "var(--page-text-3)",
                          flexShrink: 0,
                        }}
                      />
                      <div className="setting-row-meta">
                        <div className="setting-row-label">{mode.label}</div>
                        <div className="setting-row-desc">{mode.description}</div>
                      </div>
                      {isActive && <Check size={16} style={{ color: "var(--page-rose)" }} />}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* ===== Pane 3: 通用 ===== */}
          <div
            className={`settings-pane ${activePane === "general" ? "active" : ""}`}
            data-pane="general"
          >
            <div className="setting-section">
              <div className="setting-section-title">
                <Server size={15} />
                <span>Agent 引擎网关地址</span>
              </div>
              <input
                type="text"
                className="field-input"
                value={settings.agentGatewayUrl}
                onChange={(e) => onUpdate({ agentGatewayUrl: e.target.value })}
                placeholder="http://localhost:3002"
                autoComplete="off"
                spellCheck={false}
              />
              <p className="setting-section-desc">
                设置 ripple-agent 后端服务地址, 默认 <code className="setting-row-code">http://localhost:3002</code>
              </p>
            </div>

            <div className="setting-section">
              <div className="setting-section-title">
                <Smartphone size={15} />
                <span>Mobile Bridge 端口</span>
              </div>
              <input
                type="number"
                className="field-input"
                value={settings.mobileBridgePort || 9876}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  if (!isNaN(v) && v >= 1 && v <= 65535) {
                    onUpdate({ mobileBridgePort: v });
                  }
                }}
                min={1}
                max={65535}
                placeholder="9876"
                autoComplete="off"
              />
              <p className="setting-section-desc">
                桌面端内嵌 HTTP 服务端口, 手机端通过此端口连接桌面端进行交互。修改后需重启应用生效。手机端访问地址示例:{" "}
                <code className="setting-row-code">
                  http://192.168.1.x:{settings.mobileBridgePort || 9876}
                </code>
              </p>
            </div>

            <div className="setting-section">
              <div className="info-card">
                <div className="info-card-title">关于 Ripple Desktop</div>
                <div className="info-card-meta">
                  版本 0.2.0 · 基于 Tauri + React 构建的 AI 编程助手桌面端
                </div>
              </div>
            </div>

            <div className="setting-section">
              <button type="button" className="btn-danger-outline" onClick={onReset}>
                <Trash2 size={14} />
                <span>重置所有设置</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export default SettingsPage;
