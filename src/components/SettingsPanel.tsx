import { useState, useEffect } from "react";
import {
  X, Key, Globe, Cpu, Eye, EyeOff, Check, RefreshCw,
  Server, Palette, Trash2, Plus, Edit3, Save,
} from "lucide-react";
import type { AppSettings, ModelConfig, ModelConfigFormData, ApiProvider } from "../types";

interface SettingsPanelProps {
  settings: AppSettings;
  onUpdate: (partial: Partial<AppSettings>) => void;
  onReset: () => void;
  onClose: () => void;
  /** 保存模型配置（新建或编辑） */
  onSaveModelConfig: (form: ModelConfigFormData, editId?: string) => void;
  /** 删除模型配置 */
  onDeleteModelConfig: (id: string) => void;
  /** 切换当前模型 */
  onSetActiveModel: (id: string) => void;
}

/** API 提供商选项 */
const PROVIDERS: { value: ApiProvider; label: string; endpoint: string; model: string }[] = [
  { value: "custom", label: "自定义 OpenAI 兼容", endpoint: "https://api.openai.com/v1", model: "gpt-4o" },
  { value: "openai", label: "OpenAI", endpoint: "https://api.openai.com/v1", model: "gpt-4o" },
];

/** 导航项 */
const NAV_ITEMS = [
  { key: "api", label: "API 配置", icon: Server },
  { key: "general", label: "通用", icon: Palette },
];

/**
 * 设置面板 — Agent 桌面端典型设计
 * - 左导航右内容布局
 * - API 配置页支持多模型配置管理（新增/编辑/删除/切换）
 * - 字段顺序：提供商 → 配置名称 → 模型名称 → 接口地址 → API Key
 */
function SettingsPanel({
  settings,
  onUpdate,
  onReset,
  onClose,
  onSaveModelConfig,
  onDeleteModelConfig,
  onSetActiveModel,
}: SettingsPanelProps) {
  const [showKey, setShowKey] = useState(false);
  const [activeTab, setActiveTab] = useState("api");
  const [saved, setSaved] = useState(false);

  // ===== 表单状态 =====
  const [formName, setFormName] = useState("");
  const [formProvider, setFormProvider] = useState<ApiProvider>("custom");
  const [formModel, setFormModel] = useState("");
  const [formEndpoint, setFormEndpoint] = useState("");
  const [formKey, setFormKey] = useState("");
  const [editId, setEditId] = useState<string | undefined>(undefined);

  // 当切换激活配置时，同步到表单
  const activeCfg = settings.modelConfigs.find((c) => c.id === settings.activeModelId)
    ?? settings.modelConfigs[0];

  useEffect(() => {
    if (editId) {
      const c = settings.modelConfigs.find((m) => m.id === editId);
      if (c) {
        setFormName(c.name);
        setFormProvider(c.provider);
        setFormModel(c.model);
        setFormEndpoint(c.endpoint);
        setFormKey(c.apiKey);
      }
    } else {
      setFormName("");
      setFormProvider(activeCfg?.provider || "custom");
      setFormModel(activeCfg?.model || "gpt-4o");
      setFormEndpoint(activeCfg?.endpoint || "https://api.openai.com/v1");
      setFormKey(activeCfg?.apiKey || "");
    }
  }, [editId, activeCfg, settings.modelConfigs]);

  /** 选择提供商时自动填充 */
  const handleProviderChange = (value: ApiProvider) => {
    const provider = PROVIDERS.find((p) => p.value === value);
    if (provider) {
      setFormEndpoint(provider.endpoint);
      if (!editId) setFormModel(provider.model);
    }
    setFormProvider(value);
  };

  /** 开始编辑已有配置 */
  const handleEdit = (cfg: ModelConfig) => {
    setEditId(cfg.id);
    setFormName(cfg.name);
    setFormProvider(cfg.provider);
    setFormModel(cfg.model);
    setFormEndpoint(cfg.endpoint);
    setFormKey(cfg.apiKey);
  };

  /** 开始新建配置 */
  const handleNew = () => {
    setEditId(undefined);
    setFormName("");
    setFormProvider(activeCfg?.provider || "custom");
    setFormModel(activeCfg?.model || "gpt-4o");
    setFormEndpoint(activeCfg?.endpoint || "https://api.openai.com/v1");
    setFormKey("");
  };

  /** 保存当前表单为模型配置 */
  const handleSave = () => {
    if (!formName.trim()) return;
    onSaveModelConfig(
      { name: formName.trim(), provider: formProvider, endpoint: formEndpoint, apiKey: formKey, model: formModel },
      editId
    );
    setSaved(true);
    setEditId(undefined);
    setTimeout(() => setSaved(false), 2000);
  };

  /** 切换配置时直接应用 */
  const handleSwitchModel = (id: string) => {
    onSetActiveModel(id);
    setEditId(undefined);
  };

  return (
    <>
      {/* 遮罩层 */}
      <div className="fixed inset-0 bg-black/30 dark:bg-black/50 z-40 animate-fade-in" onClick={onClose} />

      {/* 弹窗 */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
        <div className="bg-surface-secondary dark:bg-surface-secondary-dark rounded-2xl shadow-elevated border border-border dark:border-border-dark w-full max-w-4xl h-[600px] flex flex-col animate-fade-in">
          {/* ===== 头部 ===== */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-border dark:border-border-dark">
            <h2 className="text-base font-semibold">设置</h2>
            <button onClick={onClose} className="icon-btn" title="关闭">
              <X size={16} />
            </button>
          </div>

          {/* ===== 主体 ===== */}
          <div className="flex flex-1 min-h-0">
            {/* 左栏导航 */}
            <nav className="w-52 shrink-0 border-r border-border dark:border-border-dark p-3 space-y-1 overflow-y-auto">
              {NAV_ITEMS.map((item) => (
                <button
                  key={item.key}
                  onClick={() => setActiveTab(item.key)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-left transition-all duration-150 ${
                    activeTab === item.key
                      ? "bg-accent/10 text-accent font-medium"
                      : "text-content-secondary dark:text-content-secondary-dark hover:bg-black/5 dark:hover:bg-white/5"
                  }`}
                >
                  <item.icon size={15} />
                  <span>{item.label}</span>
                </button>
              ))}
            </nav>

            {/* 右栏内容 */}
            <div className="flex-1 overflow-y-auto p-6">
              {/* ===== API 配置 ===== */}
              {activeTab === "api" && (
                <div className="space-y-5 max-w-lg">
                  {/* ---- 已保存配置列表 ---- */}
                  <section>
                    <div className="flex items-center justify-between mb-2.5">
                      <label className="text-sm font-medium text-content-secondary dark:text-content-secondary-dark">
                        已保存的模型配置
                      </label>
                      <button
                        onClick={handleNew}
                        className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium
                                   text-accent hover:bg-accent/10 transition-all duration-150"
                      >
                        <Plus size={13} />
                        新建
                      </button>
                    </div>
                    <div className="space-y-1.5">
                      {settings.modelConfigs.map((cfg) => (
                        <div
                          key={cfg.id}
                          className={`flex items-center gap-2 px-3 py-2 rounded-xl border transition-all cursor-pointer ${
                            cfg.id === settings.activeModelId
                              ? "border-accent bg-accent/5 dark:bg-accent/10"
                              : "border-border dark:border-border-dark hover:border-accent/30"
                          }`}
                          onClick={() => handleSwitchModel(cfg.id)}
                        >
                          {/* 激活指示器 */}
                          <div className={`w-2 h-2 rounded-full shrink-0 ${
                            cfg.id === settings.activeModelId ? "bg-accent" : "bg-transparent"
                          }`} />
                          {/* 配置信息 */}
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium truncate">{cfg.name}</div>
                            <div className="text-xs text-content-tertiary dark:text-content-tertiary-dark truncate">
                              {cfg.model} · {cfg.endpoint}
                            </div>
                          </div>
                          {/* 操作按钮 */}
                          <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100"
                               style={{ opacity: 1 }}>
                            <button
                              onClick={(e) => { e.stopPropagation(); handleEdit(cfg); }}
                              className="p-1 rounded-md hover:bg-black/5 dark:hover:bg-white/5 text-content-tertiary hover:text-content-secondary transition-all"
                              title="编辑"
                            >
                              <Edit3 size={13} />
                            </button>
                            {settings.modelConfigs.length > 1 && (
                              <button
                                onClick={(e) => { e.stopPropagation(); onDeleteModelConfig(cfg.id); }}
                                className="p-1 rounded-md hover:bg-red-50 dark:hover:bg-red-900/20 text-content-tertiary hover:text-red-500 transition-all"
                                title="删除"
                              >
                                <Trash2 size={13} />
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>

                  <hr className="border-border dark:border-border-dark" />

                  {/* ---- 编辑/新建表单 ---- */}
                  <div className="text-sm font-medium text-content-secondary dark:text-content-secondary-dark mb-1">
                    {editId ? "编辑配置" : "新建配置"}
                  </div>

                  {/* 配置名称 */}
                  <section>
                    <label className="flex items-center gap-1.5 text-sm font-medium mb-2 text-content-secondary dark:text-content-secondary-dark">
                      <Server size={15} />
                      配置名称
                    </label>
                    <input
                      type="text"
                      value={formName}
                      onChange={(e) => setFormName(e.target.value)}
                      placeholder="例如：我的 OpenAI、工作用 DeepSeek"
                      className="w-full px-3.5 py-2 text-sm rounded-xl
                                 bg-black/[0.03] dark:bg-white/[0.05]
                                 border border-border dark:border-border-dark
                                 text-content dark:text-content-dark
                                 placeholder:text-content-tertiary dark:placeholder:text-content-tertiary-dark
                                 focus:outline-none focus:border-accent/40 focus:bg-transparent
                                 transition-all duration-150"
                    />
                  </section>

                  {/* API 提供商 */}
                  <section>
                    <label className="flex items-center gap-1.5 text-sm font-medium mb-2.5 text-content-secondary dark:text-content-secondary-dark">
                      <Server size={15} />
                      API 提供商
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      {PROVIDERS.map((p) => (
                        <button
                          key={p.value}
                          onClick={() => handleProviderChange(p.value)}
                          className={`text-left px-3.5 py-2.5 rounded-xl border text-sm transition-all ${
                            formProvider === p.value
                              ? "border-accent bg-accent/5 dark:bg-accent/10 text-accent"
                              : "border-border dark:border-border-dark hover:border-accent/30 hover:bg-black/[0.02] dark:hover:bg-white/[0.02]"
                          }`}
                        >
                          <div className="font-medium">{p.label}</div>
                          <div className="text-xs text-content-tertiary dark:text-content-tertiary-dark mt-0.5">
                            {p.endpoint}
                          </div>
                        </button>
                      ))}
                    </div>
                  </section>

                  {/* 模型名称（在接口地址上方） */}
                  <section>
                    <label className="flex items-center gap-1.5 text-sm font-medium mb-2 text-content-secondary dark:text-content-secondary-dark">
                      <Cpu size={15} />
                      模型名称
                    </label>
                    <input
                      type="text"
                      value={formModel}
                      onChange={(e) => setFormModel(e.target.value)}
                      placeholder="gpt-4o / deepseek-chat"
                      className="w-full px-3.5 py-2 text-sm rounded-xl
                                 bg-black/[0.03] dark:bg-white/[0.05]
                                 border border-border dark:border-border-dark
                                 text-content dark:text-content-dark
                                 placeholder:text-content-tertiary dark:placeholder:text-content-tertiary-dark
                                 focus:outline-none focus:border-accent/40 focus:bg-transparent
                                 transition-all duration-150"
                    />
                  </section>

                  {/* 接口地址 */}
                  <section>
                    <label className="flex items-center gap-1.5 text-sm font-medium mb-2 text-content-secondary dark:text-content-secondary-dark">
                      <Globe size={15} />
                      接口地址
                    </label>
                    <input
                      type="url"
                      value={formEndpoint}
                      onChange={(e) => setFormEndpoint(e.target.value)}
                      placeholder="https://api.openai.com/v1"
                      className="w-full px-3.5 py-2 text-sm rounded-xl
                                 bg-black/[0.03] dark:bg-white/[0.05]
                                 border border-border dark:border-border-dark
                                 text-content dark:text-content-dark
                                 placeholder:text-content-tertiary dark:placeholder:text-content-tertiary-dark
                                 focus:outline-none focus:border-accent/40 focus:bg-transparent
                                 transition-all duration-150"
                    />
                  </section>

                  {/* API Key */}
                  <section>
                    <label className="flex items-center gap-1.5 text-sm font-medium mb-2 text-content-secondary dark:text-content-secondary-dark">
                      <Key size={15} />
                      API Key
                    </label>
                    <div className="relative">
                      <input
                        type={showKey ? "text" : "password"}
                        value={formKey}
                        onChange={(e) => setFormKey(e.target.value)}
                        placeholder="sk-..."
                        className="w-full px-3.5 py-2 pr-9 text-sm rounded-xl
                                   bg-black/[0.03] dark:bg-white/[0.05]
                                   border border-border dark:border-border-dark
                                   text-content dark:text-content-dark
                                   placeholder:text-content-tertiary dark:placeholder:text-content-tertiary-dark
                                   focus:outline-none focus:border-accent/40 focus:bg-transparent
                                   transition-all duration-150"
                      />
                      <button
                        onClick={() => setShowKey(!showKey)}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-content-tertiary hover:text-content-secondary transition-colors"
                      >
                        {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
                      </button>
                    </div>
                  </section>

                  {/* 保存配置按钮 */}
                  <button
                    onClick={handleSave}
                    disabled={!formName.trim()}
                    className="flex items-center justify-center gap-1.5 w-full px-4 py-2.5 text-sm font-medium
                               rounded-xl bg-accent text-white
                               hover:bg-accent-hover active:scale-[0.98]
                               disabled:opacity-50 disabled:cursor-not-allowed
                               transition-all duration-150 shadow-sm"
                  >
                    {saved ? (
                      <><Check size={15} /> 已保存</>
                    ) : (
                      <><Save size={15} /> {editId ? "更新配置" : "保存配置"}</>
                    )}
                  </button>

                  {/* 测试连接 */}
                  <button
                    onClick={() => {
                      alert(`测试连接：\n端点: ${formEndpoint}\n模型: ${formModel}`);
                    }}
                    className="flex items-center justify-center gap-1.5 w-full px-4 py-2 text-sm font-medium
                               rounded-xl border border-border dark:border-border-dark
                               hover:bg-black/[0.03] dark:hover:bg-white/[0.03]
                               active:scale-[0.98] transition-all duration-150"
                  >
                    <RefreshCw size={15} />
                    测试连接
                  </button>
                </div>
              )}

              {/* ===== 通用 ===== */}
              {activeTab === "general" && (
                <div className="space-y-4 max-w-lg">
                  <div className="p-4 rounded-xl bg-black/[0.02] dark:bg-white/[0.02] border border-border dark:border-border-dark">
                    <h3 className="text-sm font-medium mb-1">关于 Ripple Desktop</h3>
                    <p className="text-sm text-content-tertiary dark:text-content-tertiary-dark leading-relaxed">
                      版本 0.1.0 · 基于 Tauri + React 构建的 AI 编程助手桌面端
                    </p>
                  </div>

                  <button
                    onClick={onReset}
                    className="flex items-center justify-center gap-1.5 w-full px-4 py-2 text-sm font-medium
                               rounded-xl border border-red-200 dark:border-red-800/30
                               text-red-600 dark:text-red-400
                               hover:bg-red-50 dark:hover:bg-red-900/10
                               active:scale-[0.98] transition-all duration-150"
                  >
                    重置所有设置
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* ===== 底部（简化） ===== */}
          <div className="flex items-center justify-end gap-2 px-6 py-3 border-t border-border dark:border-border-dark">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium rounded-xl
                         border border-border dark:border-border-dark
                         hover:bg-black/[0.03] dark:hover:bg-white/[0.03]
                         active:scale-[0.98] transition-all duration-150"
            >
              关闭
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

export default SettingsPanel;
