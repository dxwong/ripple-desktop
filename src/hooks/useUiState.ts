import { useState, useEffect, useCallback, useRef } from "react";
import {
  fetchUiState,
  fetchUiStateKey,
  saveUiStateKey,
} from "ripple-shared/api";

/**
 * UI 状态云端同步 Hook（v2.1）
 *
 * 设计原则(与 useSettings / MemoryPage 一致):
 *   1. 云端是唯一事实来源
 *   2. 写失败 → 不更新本地内存(防止本地/云端分叉)
 *   3. 纯视图状态(sidebar-collapsed 等)仍走 localStorage,不进此处
 *
 * 适用场景:current-view / active-conversation-id 等需要跨设备同步的业务 UI 状态
 *
 * 使用方式:
 * ```ts
 * const [value, setValue] = useUiState<string>("current-view", "chat");
 * await setValue("settings");  // 失败抛错,调用方应处理
 * ```
 *
 * 启动行为:
 *   1. 先 fetchUiState() 一次性拉所有 key 到全局缓存
 *   2. 本 hook 从缓存中同步取值(无 loading 闪烁)
 *   3. 缓存未就绪时,暂时使用 defaultValue,值到位后 setState 替换
 */

// 模块级缓存(全 hook 共享一次 fetch,避免每个 hook 都拉一遍)
let _cache: Record<string, unknown> | null = null;
let _cachePromise: Promise<Record<string, unknown>> | null = null;
const _subscribers = new Set<() => void>();

async function loadCache(): Promise<Record<string, unknown>> {
  if (_cache) return _cache;
  if (_cachePromise) return _cachePromise;
  _cachePromise = (async () => {
    try {
      const res = await fetchUiState();
      if (res.data?.state) {
        _cache = { ...res.data.state };
        return _cache;
      }
    } catch {
      // 云端不可用:返回空缓存,hook 使用 defaultValue
    }
    _cache = {};
    return _cache;
  })();
  return _cachePromise;
}

function notifySubscribers() {
  _subscribers.forEach((fn) => fn());
}

/**
 * 监听云端 UI 状态变化(写成功后调用)
 * v2.1:写入成功后,直接更新本地缓存(不重新 fetch)
 *   调用方在 saveUiStateKey 成功后,应该调用 notifyAfterWrite
 */
export function notifyAfterWrite(key: string, value: unknown) {
  if (!_cache) _cache = {};
  _cache[key] = value;
  notifySubscribers();
}

/**
 * UI 状态云端同步 hook
 */
export function useUiState<T>(key: string, defaultValue: T): [T, (v: T) => Promise<void>] {
  const [value, setLocalValue] = useState<T>(defaultValue);
  const [loaded, setLoaded] = useState<boolean>(_cache !== null);
  const valueRef = useRef<T>(defaultValue);
  valueRef.current = value;

  // 订阅缓存变化(其他 hook 写入了同一个 key,这里会同步)
  useEffect(() => {
    const handler = () => {
      if (_cache && key in _cache) {
        const v = _cache[key] as T;
        if (v !== valueRef.current) {
          setLocalValue(v);
        }
      }
    };
    _subscribers.add(handler);
    return () => {
      _subscribers.delete(handler);
    };
  }, [key]);

  // 加载:从缓存中取值,缓存未就绪则等待
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (_cache) {
        const v = _cache[key] as T | undefined;
        if (v !== undefined) {
          setLocalValue(v);
        }
        if (!loaded) setLoaded(true);
        return;
      }
      const cache = await loadCache();
      if (cancelled) return;
      const v = cache[key] as T | undefined;
      if (v !== undefined) {
        setLocalValue(v);
      }
      setLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [key, loaded]);

  // 写:先 POST 云端,成功才更新本地 + 缓存
  const setValue = useCallback(
    async (v: T): Promise<void> => {
      const res = await saveUiStateKey(key, v);
      if (res.error || !res.data) {
        throw new Error(res.error || "云端写入失败");
      }
      // 写成功:更新本地 + 缓存 + 通知其他订阅者
      notifyAfterWrite(key, v);
      setLocalValue(v);
    },
    [key]
  );

  return [value, setValue];
}

/**
 * 兜底 hook:从云端单次拉取某个 key,不订阅变化
 * 用于 useUiState 不合适的场景(例如只需要一次性读,不需要写)
 */
export async function fetchUiStateOnce<T>(key: string, defaultValue: T): Promise<T> {
  try {
    const res = await fetchUiStateKey<T>(key);
    if (res.data?.value !== null && res.data?.value !== undefined) {
      return res.data.value;
    }
  } catch {
    // 云端不可用,返回默认值
  }
  return defaultValue;
}
