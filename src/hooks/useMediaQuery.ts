/**
 * 响应式断点检测 hook
 *
 * 用法：
 * ```tsx
 * const isMobile = useMediaQuery('(max-width: 768px)');
 * ```
 *
 * - 基于 `window.matchMedia` API
 * - 自动监听断点变化，组件不卸载也会同步更新
 * - SSR safe：服务端返回 `false`（与桌面端默认一致）
 */
import { useEffect, useState } from "react";

export function useMediaQuery(query: string): boolean {
  // SSR 兜底：服务端渲染时返回 false（与桌面端默认行为一致）
  // 客户端 hydration 后 useEffect 立即同步真实值
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;

    const mql = window.matchMedia(query);

    // 立即同步一次（处理 hydration 之后才出现的真实值）
    setMatches(mql.matches);

    // 监听断点变化
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener("change", handler);

    return () => mql.removeEventListener("change", handler);
  }, [query]);

  return matches;
}
