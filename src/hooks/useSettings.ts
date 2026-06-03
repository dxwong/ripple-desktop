import { useState, useCallback, useEffect, useRef } from "react";
import { useStore } from "./useStore";
import type {
  AppSettings,
  ProviderConfig,
  CustomProvider,
  ActiveModelConfig,
} from "../types";
import { DEFAULT_RISK_CONFIG } from "../types";
import {
  KNOWN_PROVIDERS,
  KNOWN_PROVIDER_MODELS,
  getProviderDef,
} from "ripple-shared/providers";
import { fetchSettings, saveSettingsToCloud } from "../services/api";

/** 生成唯一 ID */
const genId = () => Math.random().toString(36).substring(2, 10);

/**
 * 默认 provider 配置（按 32 个内置 + 默认激活 deepseek 构造）
 * - 第一个 provider 启用
 * - 启用其下所有内置 model
 */
function buildDefaultSettings(): AppSettings {
  // 默认激活 deepseek（用户最常用的国产服务，对应旧 v1.7 工作流）
  // 若 KNOWN_PROVIDERS 未来不包含 deepseek，回落到第一个有内置模型的 provider
  const defaultProviderId =
    KNOWN_PROVIDERS.find((p) => p.id === "deepseek")?.id ??
    KNOWN_PROVIDERS.find((p) => KNOWN_PROVIDER_MODELS[p.id]?.length)?.id ??
    KNOWN_PROVIDERS[0].id;
  const defaultProvider = KNOWN_PROVIDERS.find((p) => p.id === defaultProviderId) ?? KNOWN_PROVIDERS[0];
  const defaultModels = KNOWN_PROVIDER_MODELS[defaultProviderId] ?? [];

  const enabledProviders: Record<string, boolean> = {};
  const providerConfigs: Record<string, ProviderConfig> = {};

  for (const p of KNOWN_PROVIDERS) {
    enabledProviders[p.id] = p.id === defaultProviderId;
    const models = KNOWN_PROVIDER_MODELS[p.id] ?? [];
    providerConfigs[p.id] = {
      apiKey: "",
      baseUrl: "",
      enabledModels: models.reduce<Record<string, boolean>>((acc, m) => {
        acc[m.id] = true;
        return acc;
      }, {}),
      customModels: [],
    };
  }

  return {
    activeProvider: defaultProviderId,
    activeModel: defaultModels[0]?.id ?? "",
    enabledProviders,
    providerConfigs,
    customProviders: [],
    darkMode: false,
    permissionMode: "confirm",
    agentGatewayUrl: "http://localhost:3002",
    mobileBridgePort: 9876,
    riskManagement: DEFAULT_RISK_CONFIG,
  };
}

const DEFAULT_SETTINGS: AppSettings = buildDefaultSettings();

/** 设置存储键名 */
const STORAGE_KEY = "app_settings";

/**
 * v2.1 重构：从旧的 modelConfigs 体系迁移到 providerConfigs 体系
 *
 * - 检测到 v1.x schema 时，做字段映射迁移而非静默丢弃
 * - 旧 settings.json 数据若包含 modelConfigs，自动迁移为 v2.1 providerConfigs
 */
function isLegacyShape(data: any): boolean {
  if (!data || typeof data !== "object") return false;
  // 旧版 schema 标志：activeModelId + modelConfigs 数组
  return (
    "activeModelId" in data ||
    "modelConfigs" in data ||
    ("apiProvider" in data && "apiEndpoint" in data)
  );
}

/**
 * v1.x → v2.1 字段迁移
 * - modelConfigs → providerConfigs
 * - 检测 provider 是否为内置 provider，决定走 custom 还是内置路径
 */
function migrateFromV1(v1: any): AppSettings | null {
  try {
    const configs = v1.modelConfigs || []
    if (configs.length === 0) {
      // 兼容旧扁平格式（只有 apiProvider/apiEndpoint/apiKey/modelName）
      if (v1.apiKey && v1.apiEndpoint) {
        return migrateFlatV1(v1)
      }
      return null
    }

    const first = configs[0]
    if (!first || !first.apiKey) return null

    // 判断 targetProvider 是否为内置 provider
    const isBuiltin = !!getProviderDef(first.provider)
    const targetProvider = isBuiltin ? first.provider : 'custom'

    const base = { ...DEFAULT_SETTINGS }

    if (!isBuiltin) {
      // 自定义 provider 迁移
      base.activeProvider = 'custom'
      base.activeModel = first.model || 'deepseek-v4-flash'
      base.enabledProviders = { ...base.enabledProviders, custom: true }
      base.providerConfigs = {
        ...base.providerConfigs,
        custom: {
          apiKey: first.apiKey,
          baseUrl: (first.endpoint || '').replace(/\/+$/, ''),
          enabledModels: { [first.model || 'deepseek-v4-flash']: true },
          customModels: [],
        },
      }
      base.customProviders = [{
        id: 'custom',
        name: first.name || '迁移的配置',
        baseUrl: (first.endpoint || '').replace(/\/+$/, ''),
        apiKey: first.apiKey,
      }]
    } else {
      // 内置 provider 迁移
      base.activeProvider = targetProvider
      base.activeModel = first.model || base.activeModel
      base.providerConfigs = {
        ...base.providerConfigs,
        [targetProvider]: {
          ...base.providerConfigs[targetProvider],
          apiKey: first.apiKey,
          baseUrl: (first.endpoint || DEFAULT_SETTINGS.providerConfigs[targetProvider]?.baseUrl || '').replace(/\/+$/, ''),
        },
      }
    }

    // 保留通用字段
    if (typeof v1.darkMode === 'boolean') base.darkMode = v1.darkMode
    if (typeof v1.permissionMode === 'string') base.permissionMode = v1.permissionMode
    if (typeof v1.agentGatewayUrl === 'string') base.agentGatewayUrl = v1.agentGatewayUrl
    if (typeof v1.mobileBridgePort === 'number') base.mobileBridgePort = v1.mobileBridgePort

    return base
  } catch (err) {
    console.warn('[useSettings] migrateFromV1 迁移失败', err)
    return null
  }
}

/**
 * 兼容旧扁平格式迁移：apiProvider/apiEndpoint/apiKey/modelName → v2.1
 */
function migrateFlatV1(v1: any): AppSettings | null {
  const base = { ...DEFAULT_SETTINGS }
  base.activeProvider = 'custom'
  base.activeModel = v1.modelName || v1.modelId || 'deepseek-v4-flash'
  base.enabledProviders = { ...base.enabledProviders, custom: true }
  base.providerConfigs = {
    ...base.providerConfigs,
    custom: {
      apiKey: v1.apiKey,
      baseUrl: (v1.apiEndpoint || '').replace(/\/+$/, ''),
      enabledModels: { [base.activeModel]: true },
      customModels: [],
    },
  }
  base.customProviders = [{
    id: 'custom',
    name: '迁移的配置',
    baseUrl: (v1.apiEndpoint || '').replace(/\/+$/, ''),
    apiKey: v1.apiKey,
  }]
  if (typeof v1.darkMode === 'boolean') base.darkMode = v1.darkMode
  if (typeof v1.agentGatewayUrl === 'string') base.agentGatewayUrl = v1.agentGatewayUrl
  return base
}

/**
 * 设置管理 Hook
 *
 * 核心设计（v2.1）：
 * - Provider 中心化：32 个内置 provider + 用户自定义 provider
 * - 每个 provider 独立配置：apiKey / baseUrl / 启用的 model 集合
 * - 当前激活：activeProvider + activeModel 两个字段
 * - 云端优先：启动时先读云端，云端无数据则读本地
 * - 双写策略：每次保存同时写本地 + 云端（云端失败不阻塞）
 */
export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [settingsSource, setSettingsSource] = useState<"cloud" | "local" | "default">("default");
  const { saveItem, loadItem } = useStore();

  // ========== 初始化加载：云端优先，本地兜底 ==========
  /** init 完成前锁，防止用户操作在 init 完成前修改 state 后被覆盖 */
  const initLockRef = useRef(true);

  useEffect(() => {
    const init = async () => {
      let merged: AppSettings | null = null;
      let source: "cloud" | "local" | "default" = "default";

      // ── 1. 先尝试从云端读取 ──
      try {
        const cloudRes = await fetchSettings();
        if (cloudRes.data?.settings) {
          const cloud = cloudRes.data.settings as Record<string, unknown>;
          // 旧版 schema 检测 → 尝试迁移而非丢弃
          if (isLegacyShape(cloud)) {
            const migrated = migrateFromV1(cloud);
            if (migrated) {
              merged = migrated;
              source = "cloud";
              await log("info", "SETTINGS", "云端 v1.x 数据已迁移到 v2.1");
              // 立即写回迁移后的数据
              await saveSettingsToCloud(migrated as unknown as Record<string, unknown>).catch(() => {});
              await saveItem(STORAGE_KEY, migrated);
            } else {
              await log("warn", "SETTINGS", "云端 v1.x 数据无法迁移，使用默认");
            }
          } else {
            merged = {
              ...DEFAULT_SETTINGS,
              ...cloud,
              // 不上云的字段：保留本地值或默认值
              agentGatewayUrl: DEFAULT_SETTINGS.agentGatewayUrl,
              mobileBridgePort: DEFAULT_SETTINGS.mobileBridgePort,
            } as AppSettings;
            source = "cloud";
            // 用云端数据更新 localStorage
            await saveItem(STORAGE_KEY, merged);
          }
        }
      } catch {
        /* 云端不可用，继续走本地 */
      }

      // ── 2. 云端无数据，从本地读取 ──
      if (!merged) {
        const saved = await loadItem<AppSettings | null>(STORAGE_KEY, null);
        if (saved && !isLegacyShape(saved)) {
          merged = { ...DEFAULT_SETTINGS, ...saved };
          source = "local";
        } else if (saved && isLegacyShape(saved)) {
          // 本地旧格式 → 迁移
          const migrated = migrateFromV1(saved);
          if (migrated) {
            merged = migrated;
            source = "local";
            await log("info", "SETTINGS", "本地 v1.x 数据已迁移到 v2.1");
            await saveItem(STORAGE_KEY, migrated);
          } else {
            await log("warn", "SETTINGS", "本地 v1.x 数据无法迁移，使用默认");
          }
        }
      }

      // ── 3. 兜底默认值 ──
      if (!merged) {
        merged = { ...DEFAULT_SETTINGS };
      }

      // ── 4. 确保必需字段存在（防部分持久化数据缺字段） ──
      merged.activeProvider = merged.activeProvider || DEFAULT_SETTINGS.activeProvider;
      merged.activeModel = merged.activeModel || DEFAULT_SETTINGS.activeModel;
      merged.enabledProviders = { ...DEFAULT_SETTINGS.enabledProviders, ...(merged.enabledProviders || {}) };
      merged.providerConfigs = { ...DEFAULT_SETTINGS.providerConfigs, ...(merged.providerConfigs || {}) };
      merged.customProviders = merged.customProviders || [];
      merged.riskManagement = merged.riskManagement || DEFAULT_RISK_CONFIG;

      // ── 5. 跨设备访问修正：页面通过 IP 访问时自动修正网关地址 ──
      //   手机浏览器访问 http://192.168.1.10:1420/ 时，
      //   agentGatewayUrl 必须用同一 IP 而非 localhost，否则手机连不上后端
      if (typeof window !== "undefined") {
        const hostname = window.location.hostname;
        if (hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "") {
          const currentUrl = merged.agentGatewayUrl;
          try {
            const url = new URL(currentUrl);
            if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
              url.hostname = hostname;
              merged.agentGatewayUrl = url.toString().replace(/\/$/, "");
            }
          } catch {
            /* URL 解析失败，跳过 */
          }
        }
      }

      // 释放 init 锁，允许 provider 操作
      initLockRef.current = false;

      setSettings(merged);
      setSettingsSource(source);
      setLoaded(true);

      // ── 6. 反向迁移：本地有数据但云端无 → 推送到云端 ──
      if (source === "local") {
        try {
          const checkRes = await fetchSettings();
          if (!checkRes.data?.settings) {
            await saveSettingsToCloud(merged as unknown as Record<string, unknown>);
          }
        } catch {
          /* 推送失败不影响本地使用 */
        }
      }
    };
    init();
  }, [loadItem]);

  // ========== 持久化：双写本地 + 云端 ==========
  const savingRef = useRef(false);
  useEffect(() => {
    if (loaded && !savingRef.current) {
      savingRef.current = true;

      // 用 async IIFE + try/finally 确保 savingRef 永远解锁
      (async () => {
        try {
          // 1. 写本地（保底）
          await saveItem(STORAGE_KEY, settings);
          // 2. 写云端（异步，失败不阻塞）
          await saveSettingsToCloud(settings as unknown as Record<string, unknown>).catch(() => {
            // 云端写入失败不影响本地使用
          });
        } finally {
          savingRef.current = false;
        }
      })();
    }
  }, [settings, loaded, saveItem]);

  // ========== 更新部分设置 ==========
  const updateSettings = useCallback((partial: Partial<AppSettings>) => {
    if (initLockRef.current) return; // init 未完成，禁止修改
    setSettings((prev) => ({ ...prev, ...partial }));
  }, []);

  // ========== Provider 操作 ==========

  /** 切换激活的 provider（同步切换 activeModel 到该 provider 第一个启用的 model） */
  const setActiveProvider = useCallback((providerId: string, modelId?: string) => {
    if (initLockRef.current) return; // init 未完成，禁止修改
    setSettings((prev) => {
      const targetModel =
        modelId ??
        (() => {
          // 优先取该 provider 下已启用的 model，否则取第一个内置 model
          const cfg = prev.providerConfigs[providerId];
          if (cfg) {
            const builtinIds = (KNOWN_PROVIDER_MODELS[providerId] ?? []).map((m) => m.id);
            const firstEnabledBuiltin = builtinIds.find((id) => cfg.enabledModels[id] !== false);
            if (firstEnabledBuiltin) return firstEnabledBuiltin;
            const firstCustom = cfg.customModels?.[0];
            if (firstCustom) return firstCustom;
          }
          return KNOWN_PROVIDER_MODELS[providerId]?.[0]?.id ?? "";
        })();
      return { ...prev, activeProvider: providerId, activeModel: targetModel };
    });
  }, []);

  /** 切换激活的 model（必须在当前 activeProvider 下） */
  const setActiveModel = useCallback((modelId: string) => {
    if (initLockRef.current) return; // init 未完成，禁止修改
    setSettings((prev) => ({ ...prev, activeModel: modelId }));
  }, []);

  /** 启用 / 禁用某个 provider */
  const setProviderEnabled = useCallback((providerId: string, enabled: boolean) => {
    if (initLockRef.current) return; // init 未完成，禁止修改
    setSettings((prev) => ({
      ...prev,
      enabledProviders: { ...prev.enabledProviders, [providerId]: enabled },
    }));
  }, []);

  /** 更新某个 provider 的配置（apiKey / baseUrl / enabledModels / customModels） */
  const updateProviderConfig = useCallback(
    (providerId: string, patch: Partial<ProviderConfig>) => {
      if (initLockRef.current) return; // init 未完成，禁止修改
      setSettings((prev) => {
        const existing = prev.providerConfigs[providerId] ?? {
          apiKey: "",
          baseUrl: "",
          enabledModels: {},
          customModels: [],
        };
        return {
          ...prev,
          providerConfigs: {
            ...prev.providerConfigs,
            [providerId]: { ...existing, ...patch },
          },
        };
      });
    },
    []
  );

  /** 添加自定义 provider */
  const addCustomProvider = useCallback((provider: CustomProvider) => {
    if (initLockRef.current) return; // init 未完成，禁止修改
    setSettings((prev) => ({
      ...prev,
      customProviders: [...prev.customProviders, provider],
      enabledProviders: { ...prev.enabledProviders, [provider.id]: true },
      providerConfigs: {
        ...prev.providerConfigs,
        [provider.id]: {
          apiKey: provider.apiKey,
          baseUrl: provider.baseUrl,
          enabledModels: {},
          customModels: [],
        },
      },
    }));
  }, []);

  /** 移除自定义 provider */
  const removeCustomProvider = useCallback((providerId: string) => {
    if (initLockRef.current) return; // init 未完成，禁止修改
    setSettings((prev) => {
      const remaining = prev.customProviders.filter((p) => p.id !== providerId);
      const { [providerId]: _removed, ...restConfigs } = prev.providerConfigs;
      const { [providerId]: _removedEnabled, ...restEnabled } = prev.enabledProviders;
      // 若删的是当前激活 provider，切回第一个内置
      const fallbackId = prev.activeProvider === providerId
        ? (KNOWN_PROVIDERS[0]?.id ?? "openai")
        : prev.activeProvider;
      return {
        ...prev,
        customProviders: remaining,
        providerConfigs: restConfigs,
        enabledProviders: restEnabled,
        activeProvider: fallbackId,
        activeModel: KNOWN_PROVIDER_MODELS[fallbackId]?.[0]?.id ?? prev.activeModel,
      };
    });
  }, []);

  /** 启用 / 禁用某个 model */
  const setModelEnabled = useCallback(
    (providerId: string, modelId: string, enabled: boolean) => {
      if (initLockRef.current) return; // init 未完成，禁止修改
      setSettings((prev) => {
        const cfg = prev.providerConfigs[providerId];
        if (!cfg) return prev;
        return {
          ...prev,
          providerConfigs: {
            ...prev.providerConfigs,
            [providerId]: {
              ...cfg,
              enabledModels: { ...cfg.enabledModels, [modelId]: enabled },
            },
          },
        };
      });
    },
    []
  );

  /** 添加自定义 model id 到某个 provider */
  const addCustomModel = useCallback((providerId: string, modelId: string) => {
    if (initLockRef.current) return; // init 未完成，禁止修改
    setSettings((prev) => {
      const cfg = prev.providerConfigs[providerId];
      if (!cfg) return prev;
      if (cfg.customModels.includes(modelId)) return prev;
      return {
        ...prev,
        providerConfigs: {
          ...prev.providerConfigs,
          [providerId]: {
            ...cfg,
            customModels: [...cfg.customModels, modelId],
            enabledModels: { ...cfg.enabledModels, [modelId]: true },
          },
        },
      };
    });
  }, []);

  // ========== 重置 ==========
  const resetSettings = useCallback(() => {
    if (initLockRef.current) return; // init 未完成，禁止修改
    setSettings({ ...DEFAULT_SETTINGS });
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {}
    saveSettingsToCloud(DEFAULT_SETTINGS as unknown as Record<string, unknown>).catch(() => {});
  }, []);

  // ========== 派生：当前激活的 provider + model 配置 ==========
  /**
   * 当前激活的"完整模型信息"，给 sendMessage / ChatView 等下游使用
   * - 优先从当前 activeProvider 的 ProviderConfig 取 apiKey + baseUrl
   * - baseUrl 缺省时回落到 KNOWN_PROVIDERS 的 defaultBaseUrl
   * - 兼容字段：endpoint (=baseUrl) / apiKey / model (=activeModel) / provider (=activeProvider)
   */
  const activeConfig: ActiveModelConfig = (() => {
    const providerId = settings.activeProvider;
    const providerDef = getProviderDef(providerId);
    const cfg = settings.providerConfigs[providerId];
    const baseUrl = cfg?.baseUrl || providerDef?.defaultBaseUrl || "";
    return {
      provider: providerId,
      model: settings.activeModel,
      endpoint: baseUrl,
      baseUrl,
      apiKey: cfg?.apiKey || "",
      name: providerDef?.name || providerId,
    };
  })();

  return {
    settings,
    updateSettings,
    resetSettings,
    loaded,
    /** 设置来源（用于调试 UI） */
    settingsSource,
    /** 当前激活的 provider + model 完整配置（endpoint / apiKey / model / provider） */
    activeConfig,
    /** 切换激活的 provider，可选同时指定 model */
    setActiveProvider,
    /** 切换激活的 model（必须在当前 provider 下） */
    setActiveModel,
    /** 启用 / 禁用 provider */
    setProviderEnabled,
    /** 更新 provider 配置（apiKey / baseUrl / enabledModels / customModels） */
    updateProviderConfig,
    /** 启用 / 禁用 model */
    setModelEnabled,
    /** 添加自定义 model id */
    addCustomModel,
    /** 添加自定义 provider */
    addCustomProvider,
    /** 移除自定义 provider */
    removeCustomProvider,
  };
}

// 简易 logger
async function log(_level: string, _msg: string, _data?: any) {
  // hook 加载期间 console 调试
  // eslint-disable-next-line no-console
  console.debug(`[useSettings] ${_level} ${_msg}`, _data ?? "");
}
