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

  // ========== 初始化加载：本地优先 + 云端兜底（updatedAt 仲裁） ==========
  /** init 完成前锁，防止用户操作在 init 完成前修改 state 后被覆盖 */
  const initLockRef = useRef(true);

  useEffect(() => {
    const init = async () => {
      let merged: AppSettings | null = null;
      let source: "cloud" | "local" | "default" = "default";

      // ── 1. 先读本地（O(1) 同步）──
      // v1.1.2 修复：本地优先（避免云端旧值覆盖本地新值导致"重启后设置丢失"）
      const local = await loadItem<AppSettings | null>(STORAGE_KEY, null);

      // ── 2. 异步读云端（best-effort，失败不阻塞） ──
      let cloud: any = null;
      try {
        const cloudRes = await fetchSettings();
        if (cloudRes.data?.settings) {
          cloud = cloudRes.data.settings;
        }
      } catch (err) {
        // 云端读取失败不应阻塞启动
        await log("warn", "SETTINGS", "云端读取失败，使用本地或默认", { err: String(err) });
      }

      // ── 3. 旧版 schema 检测与迁移 ──
      if (cloud && isLegacyShape(cloud)) {
        const migrated = migrateFromV1(cloud);
        if (migrated) {
          cloud = migrated;
          await log("info", "SETTINGS", "云端 v1.x 数据已迁移到 v2.1");
          // 立即写回迁移后的数据（先本地后云端，保证双写一致）
          await saveItem(STORAGE_KEY, migrated);
          await saveSettingsToCloud(migrated as unknown as Record<string, unknown>);
        } else {
          await log("warn", "SETTINGS", "云端 v1.x 数据无法迁移，跳过云端");
          cloud = null;
        }
      }
      if (local && isLegacyShape(local)) {
        const migrated = migrateFromV1(local);
        if (migrated) {
          await log("info", "SETTINGS", "本地 v1.x 数据已迁移到 v2.1");
          await saveItem(STORAGE_KEY, migrated);
          // 注：local 仍是原始 v1.x 形状数据（不可改 const），下面走"用 migrated"路径
          merged = migrated;
          source = "local";
        } else {
          await log("warn", "SETTINGS", "本地 v1.x 数据无法迁移，跳过本地");
        }
      }

      // ── 4. 仲裁：本地 vs 云端（用 updatedAt）──
      // 关键：原子双写保证本地和云端最终一致，仲裁只是处理历史遗留的旧云端数据
      if (local && cloud) {
        const localTs = (local as any).updatedAt ?? 0;
        const cloudTs = (cloud as any).updatedAt ?? 0;
        if (cloudTs > localTs) {
          merged = cloud;
          source = "cloud";
          // 用云端数据更新 localStorage（让本地也跟上最新值）
          await saveItem(STORAGE_KEY, merged);
        } else {
          merged = local;
          source = "local";
          // 本地比云端新（多设备场景下，设备 A 写完但设备 B 上次未同步）
          // 把本地新值推到云端，保持多设备一致
          await saveSettingsToCloud(merged as unknown as Record<string, unknown>);
        }
        await log("info", "SETTINGS", `init 仲裁：local_ts=${localTs} cloud_ts=${cloudTs} → 用${source}`);
      } else if (cloud) {
        merged = cloud;
        source = "cloud";
        // 首次安装但有云端数据 → 同步到本地
        await saveItem(STORAGE_KEY, merged);
      } else if (local) {
        merged = local;
        source = "local";
        // 本地有但云端无 → 推到云端（多设备同步）
        await saveSettingsToCloud(merged as unknown as Record<string, unknown>);
      }

      // ── 5. 兜底默认值 ──
      if (!merged) {
        merged = { ...DEFAULT_SETTINGS };
        source = "default";
        // 首次启动：双写到本地和云端，建立"事实上有设置"的状态
        await saveItem(STORAGE_KEY, merged);
        await saveSettingsToCloud(merged as unknown as Record<string, unknown>);
      }

      // ── 6. 确保必需字段存在（防部分持久化数据缺字段） ──
      merged.activeProvider = merged.activeProvider || DEFAULT_SETTINGS.activeProvider;
      merged.activeModel = merged.activeModel || DEFAULT_SETTINGS.activeModel;
      merged.enabledProviders = { ...DEFAULT_SETTINGS.enabledProviders, ...(merged.enabledProviders || {}) };
      merged.providerConfigs = { ...DEFAULT_SETTINGS.providerConfigs, ...(merged.providerConfigs || {}) };
      merged.customProviders = merged.customProviders || [];
      merged.riskManagement = merged.riskManagement || DEFAULT_RISK_CONFIG;

      // ── 7. 跨设备访问修正：页面通过 IP 访问时自动修正网关地址 ──
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
    };
    init();
  }, [loadItem]);

  // ========== 持久化：双写本地 + 云端（v1.1.2 保留 useEffect 兜底） ==========
  // 设计：updateSettings 显式路径走"原子双写 + 失败回滚"（见下）
  //       useEffect 路径作为兜底：内部 setSettings 调用（setActiveProvider / setModelEnabled 等）
  //       不走 updateSettings，由 useEffect 自动双写
  //       标记 lastWrittenByUpdateSettings 避免 updateSettings + useEffect 重复双写
  const lastWrittenByUpdateSettingsRef = useRef<AppSettings | null>(null);
  useEffect(() => {
    if (loaded) {
      // 跳过 updateSettings 刚写的 settings（避免重复双写）
      if (lastWrittenByUpdateSettingsRef.current === settings) {
        lastWrittenByUpdateSettingsRef.current = null;
        return;
      }
      // 内部 setSettings 触发的变化 → 自动双写（异步，失败不阻塞 UI）
      (async () => {
        try {
          await saveItem(STORAGE_KEY, settings);
          await saveSettingsToCloud(settings as unknown as Record<string, unknown>);
        } catch (err) {
          // 内部 setSettings 触发的双写失败：仅记录，不回滚
          // （用户已经在 UI 上看到新值了，无法无副作用回滚）
          await log("warn", "SETTINGS", "useEffect 自动双写失败（仅记录）", {
            err: String(err),
          });
        }
      })();
    }
  }, [settings, loaded, saveItem]);

  // ========== 更新部分设置（v1.1.2 原子双写 + 失败回滚） ==========
  // 关键：本地写 + 云端写 必须都成功，否则内存仍是原值
  // 用 settingsRef 避免闭包陷阱（快速连续更新时取最新值）
  // 错误**不**抛给 caller（保持 (partial) => void 签名兼容 SettingsPage），
  // 失败时用 flog 记录 + toast（如有），内存不更新
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const updateSettings = useCallback(
    async (partial: Partial<AppSettings>): Promise<void> => {
      if (initLockRef.current) {
        await log("warn", "SETTINGS", "init 未完成，拒绝 updateSettings", { keys: Object.keys(partial).join(",") });
        return;
      }

      const prev = settingsRef.current;
      const next: AppSettings = { ...prev, ...partial, updatedAt: Date.now() };

      // Step 1: 写本地
      try {
        await saveItem(STORAGE_KEY, next);
      } catch (err) {
        await log("error", "SETTINGS", "本地写入失败", { err: String(err), keys: Object.keys(partial).join(",") });
        // 内存不更新（setSettings 没调用），用户看到的仍是旧值
        return;
      }

      // Step 2: 写云端（失败则回滚本地）
      try {
        await saveSettingsToCloud(next as unknown as Record<string, unknown>);
      } catch (err) {
        await log("error", "SETTINGS", "云端写入失败，回滚本地", { err: String(err), keys: Object.keys(partial).join(",") });
        // 回滚本地到旧值（保证本地和云端一致：都是旧值）
        try {
          await saveItem(STORAGE_KEY, prev);
        } catch (rollbackErr) {
          await log("error", "SETTINGS", "本地回滚失败（需手动修复数据不一致）", {
            rollbackErr: String(rollbackErr),
          });
        }
        // 内存不更新（setSettings 没调用）
        return;
      }

      // Step 3: 两边都成功 → 更新内存
      // 标记"刚双写过"让 useEffect 跳过这一帧
      lastWrittenByUpdateSettingsRef.current = next;
      setSettings(next);
      await log("info", "SETTINGS", "设置已原子双写成功", { keys: Object.keys(partial).join(",") });
    },
    [saveItem]
  );

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

// 简易 logger（v1.1.2：支持可变参数，兼容旧 (level, msg, data) 和新 (level, tag, msg, data) 调用）
async function log(level: string, tag: string, ...args: any[]) {
  // hook 加载期间 console 调试
  // eslint-disable-next-line no-console
  console.debug(`[useSettings] ${level} ${tag}`, ...args);
}
