/**
 * Tauri 环境检测工具
 * 在浏览器中运行时，@tauri-apps/api 会抛出异常，
 * 此工具用于优雅降级。
 */

/** 判断是否在 Tauri 环境中运行 */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * 安全调用 Tauri API，失败时返回 fallback 值
 */
export async function safeInvoke<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  if (!isTauri()) return fallback;
  try {
    return await fn();
  } catch {
    return fallback;
  }
}
