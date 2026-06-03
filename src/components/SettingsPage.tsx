import { useState, useMemo } from "react";
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
  Loader2,
  Trash2,
  Plus,
  Search,
  Smartphone,
  Folder,
  Key,
  X as XIcon,
  ExternalLink,
} from "lucide-react";
import type {
  AppSettings,
  PermissionMode,
  CustomProvider,
  ProviderConfig,
} from "ripple-shared/types";
import { PERMISSION_MODES } from "ripple-shared/types";
import {
  KNOWN_PROVIDERS,
  KNOWN_PROVIDER_MODELS,
  getProviderDef,
  type ProviderDefinition,
} from "ripple-shared/providers";
import { testConnection } from "../services/api";

/**
 * 设置全屏页 — v2.1
 *  - 移植自 demo (plans/desktop/settings.html + settings.js)
 *  - 三个 pane: API 配置 / 风险控制 / 通用
 *  - API 配置 pane: 32 个内置 provider + 自定义添加
 *  - 复用 CSS 体系（providers-layout / provider-item / provider-icon / model-card 等）
 */

type SettingsPane = "api" | "risk" | "general";

interface SettingsPageProps {
  settings: AppSettings;
  onUpdate: (partial: Partial<AppSettings>) => void;
  onReset: () => void;
  /** 顶栏左侧菜单按钮回调 */
  onMenuClick?: () => void;

  // ── v2.1: Provider 体系操作（从 useSettings 注入，避免双重 hook 实例） ──
  /** 切换激活的 provider，可选同时指定 model */
  setActiveProvider: (providerId: string, modelId?: string) => void;
  /** 启用 / 禁用某个 provider */
  setProviderEnabled: (providerId: string, enabled: boolean) => void;
  /** 更新某个 provider 的配置（apiKey / baseUrl / enabledModels / customModels） */
  updateProviderConfig: (providerId: string, patch: Partial<ProviderConfig>) => void;
  /** 启用 / 禁用某个 model */
  setModelEnabled: (providerId: string, modelId: string, enabled: boolean) => void;
  /** 添加自定义 model id 到某个 provider */
  addCustomModel: (providerId: string, modelId: string) => void;
  /** 添加自定义 provider */
  addCustomProvider: (provider: CustomProvider) => void;
  /** 移除自定义 provider */
  removeCustomProvider: (providerId: string) => void;
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

/** 校验自定义 provider id 格式：小写字母开头，仅含小写字母/数字/连字符 */
function isValidCustomId(id: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(id);
}

export function SettingsPage({
  settings,
  onUpdate,
  onReset,
  onMenuClick,
  // v2.1: provider 操作（从 MainApp 注入，复用同一份 hook 状态）
  setActiveProvider,
  setProviderEnabled,
  updateProviderConfig,
  setModelEnabled,
  addCustomModel,
  addCustomProvider,
  removeCustomProvider,
}: SettingsPageProps) {
  const [activePane, setActivePane] = useState<SettingsPane>("api");

  // API 配置：服务商搜索
  const [providerSearch, setProviderSearch] = useState("");

  // API 配置：自定义服务商弹窗
  const [showAddCustom, setShowAddCustom] = useState(false);
  const [customName, setCustomName] = useState("");
  const [customId, setCustomId] = useState("");
  const [customEndpoint, setCustomEndpoint] = useState("");
  const [customKey, setCustomKey] = useState("");
  const [customError, setCustomError] = useState("");

  // API 配置：测试连接结果
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  // 风险控制：重置提示
  const [savedRisk, setSavedRisk] = useState(false);

  // API Key 显示/隐藏
  const [showKeyState, setShowKeyState] = useState(false);

  // API 配置：添加模型内联输入（替代 window.prompt，Tauri WebView 不支持原生 dialog）
  const [addModelOpen, setAddModelOpen] = useState(false);
  const [addModelInput, setAddModelInput] = useState("");
  const [addModelError, setAddModelError] = useState("");

  // 当前激活的 provider id（兼容字段 → 优先 activeProvider）
  const activeProvider = settings.activeProvider;
  const activeProviderDef = getProviderDef(activeProvider);
  const activeProviderCfg = settings.providerConfigs[activeProvider];

  // ── 拼接"全量 provider 列表"（32 内置 + 自定义） ──
  const allProviders = useMemo(() => {
    const list: Array<
      | { type: "builtin"; def: ProviderDefinition }
      | { type: "custom"; def: CustomProvider; iconClass: string }
    > = [];
    for (const p of KNOWN_PROVIDERS) {
      list.push({ type: "builtin", def: p });
    }
    for (const cp of settings.customProviders) {
      list.push({
        type: "custom",
        def: cp,
        iconClass: "custom",
      });
    }
    return list;
  }, [settings.customProviders]);

  // ── 按"启用 / 禁用"分组 + 搜索过滤 ──
  const groupedProviders = useMemo(() => {
    const q = providerSearch.trim().toLowerCase();
    const matches = allProviders.filter((item) => {
      const name = item.def.name.toLowerCase();
      const id = item.def.id.toLowerCase();
      return !q || name.includes(q) || id.includes(q);
    });
    const enabled = matches.filter((it) => !!settings.enabledProviders[it.def.id]);
    const disabled = matches.filter((it) => !settings.enabledProviders[it.def.id]);
    return { enabled, disabled };
  }, [allProviders, settings.enabledProviders, providerSearch]);

  // ── 选中 provider 的内置 model 列表 + 自定义 model 列表 ──
  // 统一类型：所有元素都有 custom 字段（boolean），避免 union 类型推断导致的 JSX 类型问题
  const providerModels = useMemo(() => {
    if (!activeProvider) return [] as Array<{ id: string; name: string; inPrice: string; outPrice: string; cacheWrite: string; cacheRead: string; custom: boolean }>;
    const builtin = (KNOWN_PROVIDER_MODELS[activeProvider] ?? []).map((m) => ({
      ...m,
      custom: false as const,
    }));
    const customIds = activeProviderCfg?.customModels ?? [];
    const customAsModels = customIds.map((id) => ({
      id,
      name: id,
      inPrice: "—",
      outPrice: "—",
      cacheWrite: "—",
      cacheRead: "—",
      custom: true as const,
    }));
    // 拼接 + 去重
    const seen = new Set(builtin.map((m) => m.id));
    return [...builtin, ...customAsModels.filter((m) => !seen.has(m.id))];
  }, [activeProvider, activeProviderCfg]);

  // 当前 provider 是否是自定义
  const activeProviderIsCustom = useMemo(() => {
    if (!activeProvider) return false;
    return settings.customProviders.some((p) => p.id === activeProvider);
  }, [activeProvider, settings.customProviders]);

  // ── 切换 provider ──
  const handleSelectProvider = (id: string) => {
    if (id === activeProvider) return;
    setActiveProvider(id); // 自动挑该 provider 第一个启用的 model
    setTestResult(null);
  };

  // ── 启用/禁用 provider ──
  const handleToggleProvider = (enabled: boolean) => {
    setProviderEnabled(activeProvider, enabled);
  };

  // ── 启用/禁用 model ──
  const handleToggleModel = (modelId: string, enabled: boolean) => {
    setModelEnabled(activeProvider, modelId, enabled);
  };

  // ── 添加自定义 model id（内联输入框，避免依赖 Tauri 不支持的 window.prompt） ──
  const handleOpenAddModel = () => {
    setAddModelInput("");
    setAddModelError("");
    setAddModelOpen(true);
  };

  const handleCloseAddModel = () => {
    setAddModelOpen(false);
    setAddModelInput("");
    setAddModelError("");
  };

  const handleSubmitAddModel = () => {
    const trimmed = addModelInput.trim();
    if (!trimmed) {
      setAddModelError("请输入模型 ID");
      return;
    }
    if (providerModels.some((m) => m.id === trimmed)) {
      setAddModelError(`模型 "${trimmed}" 已存在`);
      return;
    }
    addCustomModel(activeProvider, trimmed);
    handleCloseAddModel();
  };

  // ── 测试连接 ──
  const handleTestConnection = async () => {
    if (!activeProviderCfg?.apiKey || !activeProviderCfg?.baseUrl || !settings.activeModel) {
      setTestResult({ ok: false, msg: "请先填写 API Key、接口地址并选择模型" });
      return;
    }
    setTesting(true);
    setTestResult(null);
    const result = await testConnection({
      endpoint: activeProviderCfg.baseUrl,
      apiKey: activeProviderCfg.apiKey,
      model: settings.activeModel,
      provider: activeProvider,
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

  // ── 添加自定义 provider ──
  const handleAddCustom = () => {
    setCustomError("");
    const name = customName.trim();
    const id = customId.trim();
    const endpoint = customEndpoint.trim();
    const apiKey = customKey.trim();
    if (!name) return setCustomError("请输入服务商名称");
    if (!id) return setCustomError("请输入服务商标识");
    if (!isValidCustomId(id))
      return setCustomError("服务商标识仅支持小写字母、数字和连字符，且必须以字母开头");
    if (!endpoint) return setCustomError("请输入接口地址");
    if (!endpoint.startsWith("http://") && !endpoint.startsWith("https://"))
      return setCustomError("接口地址必须以 http:// 或 https:// 开头");
    if (KNOWN_PROVIDERS.some((p) => p.id === id))
      return setCustomError(`标识 "${id}" 已被内置服务商占用`);
    if (settings.customProviders.some((p) => p.id === id))
      return setCustomError(`标识 "${id}" 已被其他自定义服务商占用`);

    addCustomProvider({ id, name, baseUrl: endpoint, apiKey });
    setShowAddCustom(false);
    setCustomName("");
    setCustomId("");
    setCustomEndpoint("");
    setCustomKey("");
  };

  // ── 渲染 provider 列表条目 ──
  const renderProviderItem = (
    item:
      | { type: "builtin"; def: ProviderDefinition }
      | { type: "custom"; def: CustomProvider; iconClass: string },
    enabled: boolean
  ) => {
    const isActive = item.def.id === activeProvider;
    const iconText =
      item.type === "builtin"
        ? item.def.icon
        : item.def.name.slice(0, 2).toUpperCase();
    const iconCls =
      item.type === "builtin"
        ? item.def.iconClass
        : item.iconClass;
    return (
      <button
        key={item.def.id}
        type="button"
        className={`provider-item ${isActive ? "active" : ""}`}
        onClick={() => handleSelectProvider(item.def.id)}
      >
        <span className={`provider-icon ${iconCls}`}>{iconText}</span>
        <span className="provider-name">{item.def.name}</span>
        <span
          className="provider-dot"
          style={{ background: enabled ? "#22c55e" : "#737373" }}
          title={enabled ? "已启用" : "已禁用"}
        />
      </button>
    );
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

  // 风险控制 toggle 包装
  const triggerRiskSaved = () => {
    setSavedRisk(true);
    setTimeout(() => setSavedRisk(false), 1500);
  };

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
                    placeholder="搜索服务商..."
                    value={providerSearch}
                    onChange={(e) => setProviderSearch(e.target.value)}
                    spellCheck={false}
                  />
                  <button
                    className="icon-btn providers-add-btn"
                    type="button"
                    onClick={() => setShowAddCustom(true)}
                    title="添加自定义服务商"
                    aria-label="添加自定义服务商"
                  >
                    <Plus size={14} />
                  </button>
                </div>

                <div className="providers-list">
                  {/* 已启用组 */}
                  <div className="providers-group">
                    <div className="providers-group-title">
                      已启用 ({groupedProviders.enabled.length})
                    </div>
                    <div className="providers-group-items">
                      {groupedProviders.enabled.length === 0 ? (
                        <div className="providers-empty">暂无启用的服务商</div>
                      ) : (
                        groupedProviders.enabled.map((it) => renderProviderItem(it, true))
                      )}
                    </div>
                  </div>

                  {/* 已禁用组 */}
                  <div className="providers-group">
                    <div className="providers-group-title">
                      已禁用 ({groupedProviders.disabled.length})
                    </div>
                    <div className="providers-group-items">
                      {groupedProviders.disabled.length === 0 ? (
                        <div className="providers-empty">暂无其他服务商</div>
                      ) : (
                        groupedProviders.disabled.map((it) => renderProviderItem(it, false))
                      )}
                    </div>
                  </div>
                </div>
              </aside>

              {/* 右侧：详情 */}
              <div className="provider-detail">
                {activeProvider ? (
                  <>
                    {/* 头部 */}
                    <div className="provider-detail-head">
                      <div className="provider-detail-title">
                        <span
                          className={`provider-icon ${
                            activeProviderDef?.iconClass ||
                            (activeProviderIsCustom ? "custom" : "")
                          }`}
                          style={
                            activeProviderIsCustom && !activeProviderDef
                              ? { background: "#888" }
                              : undefined
                          }
                        >
                          {activeProviderDef?.icon ||
                            (activeProviderIsCustom
                              ? activeProvider.slice(0, 2).toUpperCase()
                              : "?")}
                        </span>
                        <div>
                          <div className="provider-detail-name">
                            {activeProviderDef?.name ||
                              settings.customProviders.find((p) => p.id === activeProvider)?.name ||
                              activeProvider}
                          </div>
                          <div className="provider-detail-sub">
                            {activeProviderDef?.apiType ||
                              (activeProviderIsCustom ? "OpenAI 兼容 (自定义)" : "")}
                          </div>
                        </div>
                      </div>
                      <label className="toggle" title="启用 / 禁用服务商">
                        <input
                          type="checkbox"
                          checked={!!settings.enabledProviders[activeProvider]}
                          onChange={(e) => handleToggleProvider(e.target.checked)}
                        />
                        <span className="toggle-slider" />
                      </label>
                    </div>

                    {/* API Key */}
                    <div className="setting-section">
                      <div className="setting-section-head">
                        <div className="setting-section-title">
                          <Key size={15} />
                          <span>API Key</span>
                        </div>
                        {activeProviderDef?.apiKeyUrl && (
                          <a
                            className="link"
                            href={activeProviderDef.apiKeyUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <ExternalLink size={12} />
                            获取 API Key
                          </a>
                        )}
                      </div>
                      <div className="input-with-action">
                        <input
                          type={showKeyState ? "text" : "password"}
                          className="field-input"
                          value={activeProviderCfg?.apiKey ?? ""}
                          onChange={(e) =>
                            updateProviderConfig(activeProvider, {
                              apiKey: e.target.value,
                            })
                          }
                          placeholder="sk-..."
                          autoComplete="off"
                          spellCheck={false}
                        />
                        <button
                          type="button"
                          className="icon-action"
                          onClick={() => setShowKeyState((v) => !v)}
                          title={showKeyState ? "隐藏" : "显示"}
                          aria-label={showKeyState ? "隐藏 API Key" : "显示 API Key"}
                        >
                          {showKeyState ? <EyeOff size={15} /> : <Eye size={15} />}
                        </button>
                      </div>
                    </div>

                    {/* 接口地址 */}
                    <div className="setting-section">
                      <div className="setting-section-title">接口地址</div>
                      <input
                        type="text"
                        className="field-input"
                        value={activeProviderCfg?.baseUrl || activeProviderDef?.defaultBaseUrl || ""}
                        onChange={(e) =>
                          updateProviderConfig(activeProvider, {
                            baseUrl: e.target.value,
                          })
                        }
                        placeholder={activeProviderDef?.defaultBaseUrl ?? "https://..."}
                        autoComplete="off"
                        spellCheck={false}
                      />
                      <p className="setting-section-desc">
                        已预填系统默认地址。可手动修改用于代理转发或自定义网关。
                      </p>
                    </div>

                    {/* 自定义 provider 的标识（只读） */}
                    {activeProviderIsCustom && (
                      <div className="setting-section">
                        <div className="setting-section-title">服务商标识</div>
                        <input
                          type="text"
                          className="field-input"
                          value={activeProvider}
                          disabled
                          readOnly
                        />
                        <p className="setting-section-desc">
                          自定义服务商的唯一标识，创建后不可修改。
                        </p>
                      </div>
                    )}

                    {/* 模型列表 */}
                    <div className="setting-section">
                      <div className="setting-section-head">
                        <div className="setting-section-title">模型列表</div>
                        {!addModelOpen ? (
                          <button
                            className="link"
                            type="button"
                            onClick={handleOpenAddModel}
                            title="添加自定义模型"
                          >
                            <Plus size={12} />
                            添加模型
                          </button>
                        ) : (
                          <button
                            className="link"
                            type="button"
                            onClick={handleCloseAddModel}
                            title="取消"
                          >
                            取消
                          </button>
                        )}
                      </div>

                      {/* 添加模型内联输入框（Tauri 不支持 window.prompt） */}
                      {addModelOpen && (
                        <div className="add-model-form">
                          <input
                            type="text"
                            className="field-input"
                            value={addModelInput}
                            onChange={(e) => {
                              setAddModelInput(e.target.value);
                              if (addModelError) setAddModelError("");
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                handleSubmitAddModel();
                              } else if (e.key === "Escape") {
                                e.preventDefault();
                                handleCloseAddModel();
                              }
                            }}
                            placeholder="例如: my-custom-model-v1"
                            autoComplete="off"
                            spellCheck={false}
                            autoFocus
                          />
                          <button
                            type="button"
                            className="btn-primary btn-primary-sm"
                            onClick={handleSubmitAddModel}
                            disabled={!addModelInput.trim()}
                          >
                            添加
                          </button>
                          {addModelError && (
                            <span className="add-model-error">{addModelError}</span>
                          )}
                        </div>
                      )}
                      <div className="model-list">
                        {providerModels.length === 0 ? (
                          <div className="providers-empty">
                            暂无模型。点击右上"添加模型"新增。
                          </div>
                        ) : (
                          providerModels.map((m) => {
                            const enabled =
                              activeProviderCfg?.enabledModels?.[m.id] !== false;
                            const isCurrent =
                              settings.activeProvider === activeProvider &&
                              settings.activeModel === m.id;
                            const iconCls = activeProviderDef?.iconClass || "";
                            const iconText = activeProviderDef?.icon || "M";
                            return (
                              <div
                                key={m.id}
                                className="model-card"
                                data-model={m.id}
                              >
                                <div className={`model-icon ${iconCls}`}>{iconText}</div>
                                <div className="model-info">
                                  <div className="model-name">
                                    <span>{m.name}</span>
                                    <span className="model-id">{m.id}</span>
                                    {"custom" in m && m.custom && (
                                      <span
                                        className="model-id"
                                        style={{
                                          background: "var(--page-amber-soft)",
                                          color: "var(--page-amber-soft-text)",
                                        }}
                                      >
                                        自定义
                                      </span>
                                    )}
                                    {isCurrent && (
                                      <span
                                        className="model-id"
                                        style={{
                                          background: "var(--page-rose-soft)",
                                          color: "var(--page-rose)",
                                        }}
                                      >
                                        当前
                                      </span>
                                    )}
                                  </div>
                                  <div className="model-meta">
                                    输入 ${(m.inPrice || "—").replace("$", "")} · 输出 ${(m.outPrice || "—").replace("$", "")}
                                    <span className="model-meta-sep">·</span>
                                    cache: 写 ${(m.cacheWrite || "—").replace("$", "")} / 读 ${(m.cacheRead || "—").replace("$", "")}
                                  </div>
                                </div>
                                <label
                                  className="toggle"
                                  title={enabled ? "禁用模型" : "启用模型"}
                                >
                                  <input
                                    type="checkbox"
                                    checked={enabled}
                                    onChange={(e) =>
                                      handleToggleModel(m.id, e.target.checked)
                                    }
                                  />
                                  <span className="toggle-slider" />
                                </label>
                                {isCurrent ? null : (
                                  <button
                                    type="button"
                                    className="page-btn-secondary"
                                    style={{ height: 28, padding: "0 10px", fontSize: 12 }}
                                    onClick={() => setActiveProvider(activeProvider, m.id)}
                                  >
                                    <Check size={12} />
                                    <span>使用</span>
                                  </button>
                                )}
                              </div>
                            );
                          })
                        )}
                      </div>
                    </div>

                    {/* 测试连接 */}
                    <div className="setting-section">
                      <div className="setting-section-title">连通性测试</div>
                      <button
                        type="button"
                        onClick={handleTestConnection}
                        disabled={
                          testing ||
                          !activeProviderCfg?.apiKey ||
                          !activeProviderCfg?.baseUrl ||
                          !settings.activeModel
                        }
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
                    </div>

                    {/* 移除自定义服务商 */}
                    {activeProviderIsCustom && (
                      <div className="setting-section">
                        <button
                          type="button"
                          className="btn-danger-outline"
                          onClick={() => {
                            if (
                              !window.confirm(
                                `确定移除此自定义服务商「${
                                  settings.customProviders.find(
                                    (p) => p.id === activeProvider
                                  )?.name || activeProvider
                                }」？`
                              )
                            )
                              return;
                            removeCustomProvider(activeProvider);
                          }}
                        >
                          <Trash2 size={14} />
                          <span>移除此服务商</span>
                        </button>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="provider-empty">
                    <FolderOpenIcon />
                    <span>从左侧选择一个服务商，或点击 + 添加</span>
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
                          commandWhitelistEnabled:
                            !settings.riskManagement.commandWhitelistEnabled,
                        },
                      });
                      triggerRiskSaved();
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
                              w.command === entry.command
                                ? { ...w, enabled: !w.enabled }
                                : w
                            ),
                          },
                        });
                        triggerRiskSaved();
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
                        triggerRiskSaved();
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
                              allowReadOutside:
                                !settings.riskManagement.pathRestriction.allowReadOutside,
                            },
                          },
                        });
                        triggerRiskSaved();
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

            {savedRisk && (
              <div className="connectivity-result" style={{
                background: "rgba(34, 197, 94, 0.08)",
                borderColor: "rgba(34, 197, 94, 0.3)",
                color: "#16a34a",
              }}>
                ✓ 已保存
              </div>
            )}
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

      {/* ===== 自定义服务商弹窗 ===== */}
      {showAddCustom && (
        <div
          className="modal-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowAddCustom(false);
          }}
        >
          <div className="modal" style={{ maxWidth: 460 }}>
            <div className="modal-head">
              <div className="modal-title">添加自定义服务商</div>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setShowAddCustom(false)}
                aria-label="关闭"
              >
                <XIcon size={16} />
              </button>
            </div>
            <div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div className="field">
                <label className="field-label">服务商名称</label>
                <input
                  type="text"
                  className="field-input"
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  placeholder="例如：公司内部网关"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <div className="field">
                <label className="field-label">服务商标识 (ID)</label>
                <input
                  type="text"
                  className="field-input"
                  value={customId}
                  onChange={(e) => setCustomId(e.target.value)}
                  placeholder="例如：my-corp-gateway"
                  autoComplete="off"
                  spellCheck={false}
                />
                <p style={{ fontSize: 12, color: "var(--page-text-3)", marginTop: 4 }}>
                  唯一标识，创建后不可修改。仅支持小写字母、数字和连字符。
                </p>
              </div>
              <div className="field">
                <label className="field-label">接口地址</label>
                <input
                  type="text"
                  className="field-input"
                  value={customEndpoint}
                  onChange={(e) => setCustomEndpoint(e.target.value)}
                  placeholder="https://your-gateway.com/v1"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <div className="field">
                <label className="field-label">API Key（可选）</label>
                <input
                  type="password"
                  className="field-input"
                  value={customKey}
                  onChange={(e) => setCustomKey(e.target.value)}
                  placeholder="sk-..."
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>

              {/* v2.1: sensenova / 其他非内置服务商的快速参考 */}
              <div
                style={{
                  fontSize: 12,
                  color: "var(--page-text-3)",
                  background: "var(--page-surface-2)",
                  border: "1px solid var(--page-border)",
                  borderRadius: "var(--page-radius)",
                  padding: "10px 12px",
                  lineHeight: 1.55,
                }}
              >
                <div style={{ fontWeight: 500, marginBottom: 4, color: "var(--page-text-2)" }}>
                  常用示例
                </div>
                <div>
                  <code style={{ fontFamily: "ui-monospace, monospace" }}>sensenova</code>：
                  ID 填 <code style={{ fontFamily: "ui-monospace, monospace" }}>sensenova</code>，
                  接口地址 <code style={{ fontFamily: "ui-monospace, monospace" }}>https://api.sensenova.cn/v1</code>，
                  模型 <code style={{ fontFamily: "ui-monospace, monospace" }}>deepseek-v4-flash</code>（在"模型列表"用"添加模型"输入）
                </div>
              </div>
              {customError && (
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--page-red)",
                    background: "var(--page-red-soft)",
                    border: "1px solid var(--page-red)",
                    borderRadius: "var(--page-radius)",
                    padding: "8px 10px",
                  }}
                >
                  ✗ {customError}
                </div>
              )}
            </div>
            <div className="modal-foot">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setShowAddCustom(false)}
              >
                取消
              </button>
              <button type="button" className="btn-primary" onClick={handleAddCustom}>
                添加
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

export default SettingsPage;
