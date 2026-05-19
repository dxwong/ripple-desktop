/**
 * 通用 JSON 持久化存储 Hook
 * 
 * - Tauri 环境：通过 Rust 命令读写本地 config.json 文件
 * - 浏览器环境：降级使用 localStorage
 * 
 * 统一接口，后续所有配置持久化都通过此模块完成。
 */

import { useCallback } from "react";
import { isTauri } from "./useTauri";

/**
 * 在 Tauri 环境中调用 save_config 命令
 */
async function tauriSaveConfig(key: string, value: unknown): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("save_config", { key, value });
  } catch (e) {
    console.warn(`Tauri save_config 失败 (${key}):`, e);
    // 降级到 localStorage
    localStorage.setItem(`ripple-${key}`, JSON.stringify(value));
  }
}

/**
 * 在 Tauri 环境中调用 load_config 命令
 */
async function tauriLoadConfig(key: string): Promise<unknown | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const result = await invoke<unknown | null>("load_config", { key });
    return result;
  } catch (e) {
    console.warn(`Tauri load_config 失败 (${key}):`, e);
    // 降级到 localStorage
    try {
      const stored = localStorage.getItem(`ripple-${key}`);
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  }
}

/** localStorage 前缀 */
const LS_PREFIX = "ripple-";

/**
 * JSON 持久化存储钩子
 * 
 * 使用方式：
 * ```ts
 * const { saveItem, loadItem } = useStore();
 * await saveItem("settings", { darkMode: true });
 * const data = await loadItem<AppSettings>("settings");
 * ```
 */
export function useStore() {
  const inTauri = isTauri();

  const saveItem = useCallback(
    async (key: string, value: unknown): Promise<void> => {
      // 总是先同步写入 localStorage（最可靠的持久化方式）
      try {
        localStorage.setItem(`${LS_PREFIX}${key}`, JSON.stringify(value));
      } catch (e) {
        console.warn(`localStorage 写入失败 (${key}):`, e);
      }
      // Tauri 模式下额外通过 IPC 保存到文件（作为备份）
      if (inTauri) {
        await tauriSaveConfig(key, value);
      }
    },
    [inTauri]
  );

  const loadItem = useCallback(
    async <T = unknown>(key: string, defaultValue: T): Promise<T> => {
      // 优先从 localStorage 读取（最快）
      try {
        const stored = localStorage.getItem(`${LS_PREFIX}${key}`);
        if (stored !== null) return JSON.parse(stored) as T;
      } catch (e) {
        console.warn(`localStorage 读取失败 (${key}):`, e);
      }
      // Tauri 模式下尝试从文件读取（兜底）
      if (inTauri) {
        const result = await tauriLoadConfig(key);
        if (result !== null && result !== undefined) {
          return result as T;
        }
      }
      return defaultValue;
    },
    [inTauri]
  );

  return { saveItem, loadItem };
}

/**
 * 同步版本的 localStorage 存储（适用于组件初始化等不需要异步的场景）
 * 仅在浏览器环境下工作
 */
export const syncStore = {
  getItem: <T>(key: string, defaultValue: T): T => {
    try {
      const stored = localStorage.getItem(`${LS_PREFIX}${key}`);
      if (stored === null) return defaultValue;
      return JSON.parse(stored) as T;
    } catch {
      return defaultValue;
    }
  },
  setItem: (key: string, value: unknown): void => {
    try {
      localStorage.setItem(`${LS_PREFIX}${key}`, JSON.stringify(value));
    } catch (e) {
      console.warn(`localStorage 写入失败 (${key}):`, e);
    }
  },
  removeItem: (key: string): void => {
    try {
      localStorage.removeItem(`${LS_PREFIX}${key}`);
    } catch (e) {
      console.warn(`localStorage 删除失败 (${key}):`, e);
    }
  },
};
