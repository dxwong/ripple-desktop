import { useState, useCallback, useEffect, useRef } from "react";
import { useStore } from "./useStore";
import type { AppSettings, ModelConfig, ModelConfigFormData, ApiProvider } from "../types";
import { DEFAULT_RISK_CONFIG } from "../types";
import { fetchSettings, saveSettingsToCloud } from "../services/api";

/** 生成唯一 ID */
const genId = () => Math.random().toString(36).substring(2, 10);

/** 默认模型配置 */
const DEFAULT_MODEL_CONFIG: ModelConfig = {
  id: "default",
  name: "默认配置",
  provider: "custom",
  endpoint: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o",
  createdAt: Date.now(),
};

/** 默认设置 */
const DEFAULT_SETTINGS: AppSettings = {
  activeModelId: "default",
  modelConfigs: [DEFAULT_MODEL_CONFIG],
  apiProvider: "custom",
  apiEndpoint: "https://api.openai.com/v1",
  apiKey: "",
  modelName: "gpt-4o",
  darkMode: false,
  permissionMode: "confirm",
  agentGatewayUrl: "http://localhost:3002",
  mobileBridgePort: 9876,
  riskManagement: DEFAULT_RISK_CONFIG,
};

/** 设置存储键名 */
const STORAGE_KEY = "app_settings";

/**
 * 设置管理 Hook
 *
 * 核心设计：
 * - 支持保存多个大模型配置（ModelConfig），以列表形式持久化
 * - 云端优先：启动时先读云端，云端无数据则读本地
 * - 双写策略：每次保存同时写本地 + 云端（云端失败不阻塞）
 * - 反向迁移：本地有数据但云端无时，自动推送到云端
 * - 兼容旧版本的单个配置存储
 */
export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [settingsSource, setSettingsSource] = useState<"cloud" | "local" | "default">("default");
  const { saveItem, loadItem } = useStore();

  // ========== 初始化加载：云端优先，本地兜底 ==========
  useEffect(() => {
    const init = async () => {
      let merged: AppSettings | null = null;
      let source: "cloud" | "local" | "default" = "default";

      // ── 1. 先尝试从云端读取 ──
      try {
        const cloudRes = await fetchSettings();
        if (cloudRes.data?.settings) {
          const cloud = cloudRes.data.settings as Record<string, unknown>;
          // 从云端数据构造 AppSettings（补充不上云的本地字段）
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
      } catch {
        /* 云端不可用，继续走本地 */
      }

      // ── 2. 云端无数据，从本地读取 ──
      if (!merged) {
        const saved = await loadItem<AppSettings | null>(STORAGE_KEY, null);
        if (saved) {
          merged = { ...DEFAULT_SETTINGS, ...saved };
          source = "local";
        }
      }

      // ── 3. 兜底默认值 ──
      if (!merged) {
        merged = { ...DEFAULT_SETTINGS };
      }

      // ── 4. 确保 modelConfigs 和 activeModelId 存在 ──
      if (!merged.modelConfigs || merged.modelConfigs.length === 0) {
        merged.modelConfigs = [{ ...DEFAULT_MODEL_CONFIG }];
        merged.activeModelId = DEFAULT_MODEL_CONFIG.id;
      }

      // ── 5. 跨设备访问修正：页面通过 IP 访问时自动修正网关地址 ──
      //   手机浏览器访问 http://192.168.1.10:1420/ 时，
      //   agentGatewayUrl 必须用同一 IP 而非 localhost，否则手机连不上后端
      if (typeof window !== 'undefined') {
        const hostname = window.location.hostname;
        if (hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '') {
          const currentUrl = merged.agentGatewayUrl;
          try {
            const url = new URL(currentUrl);
            if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
              url.hostname = hostname;
              merged.agentGatewayUrl = url.toString().replace(/\/$/, '');
            }
          } catch {
            /* URL 解析失败，跳过 */
          }
        }
      }

      setSettings(merged);
      setSettingsSource(source);
      setLoaded(true);

      // ── 5. 反向迁移：本地有数据但云端无 → 推送到云端 ──
      if (source === "local") {
        try {
          // 检查云端是否真有数据（不是超时）
          const checkRes = await fetchSettings();
          if (!checkRes.data?.settings) {
            // 云端真的空的 → 推送本地数据
            await saveSettingsToCloud(merged as unknown as Record<string, unknown>);
          }
        } catch {
          /* 推送失败不影响本地使用 */
        }
      }

      // ── 6. 尝试从旧版 localStorage 迁移（仅本地源时执行） ──
      if (source === "local") {
        try {
          const oldStored = localStorage.getItem("ripple-settings");
          if (oldStored) {
            const old = JSON.parse(oldStored);
            const migrated: AppSettings = {
              ...DEFAULT_SETTINGS,
              apiProvider: old.apiProvider || "custom",
              apiEndpoint: old.apiEndpoint || "https://api.openai.com/v1",
              apiKey: old.apiKey || "",
              modelName: old.modelName || "gpt-4o",
              darkMode: old.darkMode || false,
            };
            // 将旧配置转为第一个模型配置
            migrated.modelConfigs = [{
              ...DEFAULT_MODEL_CONFIG,
              name: "迁移配置",
              provider: migrated.apiProvider,
              endpoint: migrated.apiEndpoint,
              apiKey: migrated.apiKey,
              model: migrated.modelName,
            }];
            setSettings(migrated);
            await saveItem(STORAGE_KEY, migrated);
            localStorage.removeItem("ripple-settings");
          }
        } catch { /* 无旧数据 */ }
      }
    };
    init();
  }, [loadItem]);

  // ========== 持久化：双写本地 + 云端 ==========
  const savingRef = useRef(false);
  useEffect(() => {
    if (loaded && !savingRef.current) {
      savingRef.current = true;

      // 1. 写本地（保底）
      saveItem(STORAGE_KEY, settings).then(() => {
        // 2. 写云端（异步，失败不阻塞）
        saveSettingsToCloud(settings as unknown as Record<string, unknown>).catch(() => {
          // 云端写入失败不影响本地使用
        }).finally(() => {
          savingRef.current = false;
        });
      });
    }
  }, [settings, loaded, saveItem]);

  // ========== 辅助：从 modelConfigs 同步快捷字段 ==========
  const syncFromActiveConfig = useCallback(
    (configs: ModelConfig[], activeId: string): Partial<AppSettings> => {
      const active = configs.find((c) => c.id === activeId);
      if (active) {
        return {
          apiProvider: active.provider,
          apiEndpoint: active.endpoint,
          apiKey: active.apiKey,
          modelName: active.model,
        };
      }
      return {};
    },
    []
  );

  // ========== 更新部分设置 ==========
  const updateSettings = useCallback((partial: Partial<AppSettings>) => {
    setSettings((prev) => ({ ...prev, ...partial }));
  }, []);

  // ========== 保存/更新一个模型配置 ==========
  const saveModelConfig = useCallback(
    (form: ModelConfigFormData, editId?: string) => {
      setSettings((prev) => {
        let configs = [...prev.modelConfigs];
        let activeId = prev.activeModelId;

        if (editId) {
          // 编辑已有配置
          configs = configs.map((c) =>
            c.id === editId
              ? { ...c, name: form.name.trim(), provider: form.provider, endpoint: form.endpoint.trim(), apiKey: form.apiKey.trim(), model: form.model.trim() }
              : c
          );
        } else {
          // 新建配置
          const newConfig: ModelConfig = {
            id: genId(),
            name: form.name.trim(),
            provider: form.provider,
            endpoint: form.endpoint.trim(),
            apiKey: form.apiKey.trim(),
            model: form.model.trim(),
            createdAt: Date.now(),
          };
          configs = [...configs, newConfig];
          activeId = newConfig.id;
        }

        const syncFields = syncFromActiveConfig(configs, activeId);
        return { ...prev, modelConfigs: configs, activeModelId: activeId, ...syncFields };
      });
    },
    [syncFromActiveConfig]
  );

  // ========== 删除一个模型配置 ==========
  const deleteModelConfig = useCallback(
    (id: string) => {
      setSettings((prev) => {
        if (prev.modelConfigs.length <= 1) return prev; // 保留至少一个
        const configs = prev.modelConfigs.filter((c) => c.id !== id);
        let activeId = prev.activeModelId;
        if (activeId === id) {
          activeId = configs[0]?.id || "default";
        }
        const syncFields = syncFromActiveConfig(configs, activeId);
        return { ...prev, modelConfigs: configs, activeModelId: activeId, ...syncFields };
      });
    },
    [syncFromActiveConfig]
  );

  // ========== 切换当前使用的模型配置 ==========
  const setActiveModel = useCallback(
    (id: string) => {
      setSettings((prev) => {
        const syncFields = syncFromActiveConfig(prev.modelConfigs, id);
        return { ...prev, activeModelId: id, ...syncFields };
      });
    },
    [syncFromActiveConfig]
  );

  // ========== 重置 ==========
  const resetSettings = useCallback(() => {
    setSettings(DEFAULT_SETTINGS);
    try { localStorage.removeItem("ripple-settings"); } catch {}
    // 异步清除云端
    saveSettingsToCloud(DEFAULT_SETTINGS as unknown as Record<string, unknown>).catch(() => {});
  }, []);

  // ========== 获取当前激活的配置 ==========
  const activeConfig = settings.modelConfigs.find((c) => c.id === settings.activeModelId)
    ?? settings.modelConfigs[0];

  return {
    settings,
    updateSettings,
    resetSettings,
    loaded,
    /** 设置来源（用于调试 UI） */
    settingsSource,
    /** 当前激活的模型配置详情 */
    activeConfig,
    /** 保存/更新模型配置 */
    saveModelConfig,
    /** 删除模型配置 */
    deleteModelConfig,
    /** 切换当前模型 */
    setActiveModel,
  };
}
