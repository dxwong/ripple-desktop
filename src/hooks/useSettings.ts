import { useState, useCallback, useEffect } from "react";
import { useStore } from "./useStore";
import type { AppSettings, ModelConfig, ModelConfigFormData, ApiProvider } from "../types";

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
};

/** 设置存储键名 */
const STORAGE_KEY = "app_settings";

/**
 * 设置管理 Hook
 * 
 * 核心设计：
 * - 支持保存多个大模型配置（ModelConfig），以列表形式持久化到本地 JSON
 * - 通过 activeModelId 切换当前使用的配置
 * - 兼容旧版本的单个配置存储
 * - 所有配置变更自动持久化
 */
export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const { saveItem, loadItem } = useStore();

  // ========== 初始化加载 ==========
  useEffect(() => {
    const init = async () => {
      const saved = await loadItem<AppSettings | null>(STORAGE_KEY, null);
      if (saved) {
        // 确保 modelConfigs 和 activeModelId 存在
        if (!saved.modelConfigs || saved.modelConfigs.length === 0) {
          saved.modelConfigs = [{ ...DEFAULT_MODEL_CONFIG }];
          saved.activeModelId = DEFAULT_MODEL_CONFIG.id;
        }
        setSettings({ ...DEFAULT_SETTINGS, ...saved });
      } else {
        // 尝试从旧版 localStorage 迁移
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
      setLoaded(true);
    };
    init();
  }, [loadItem]);

  // ========== 自动持久化 ==========
  useEffect(() => {
    if (loaded) {
      saveItem(STORAGE_KEY, settings);
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
  }, []);

  // ========== 获取当前激活的配置 ==========
  const activeConfig = settings.modelConfigs.find((c) => c.id === settings.activeModelId)
    ?? settings.modelConfigs[0];

  return {
    settings,
    updateSettings,
    resetSettings,
    loaded,
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
