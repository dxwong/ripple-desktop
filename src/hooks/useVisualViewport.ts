/**
 * 动态视口高度 hook
 *
 * 解决的问题：
 * - 移动浏览器的 `100vh` 包含 URL 栏，且 URL 栏动态显示/隐藏时 CSS 不会自动重算
 * - 手机锁屏 → 唤醒后，`100vh` 可能不更新，导致输入框被遮挡
 * - iOS Safari / Android Chrome 在键盘弹出 / 屏幕旋转时 viewport 变化
 *
 * 方案：
 * - 优先使用 `100dvh`（dynamic viewport height）作为 fallback
 * - 在支持 `visualViewport` 的浏览器中，监听 `resize` 事件，
 *   主动把 `window.visualViewport.height` 写入 `:root` 的 CSS 变量 `--app-height`
 * - Tauri 桌面端用 `window.innerHeight` 即可，行为与传统一致
 *
 * 用法：
 * ```css
 * // globals.css 或 Tailwind arbitrary value
 * .my-app { height: var(--app-height, 100dvh); }
 * ```
 * ```tsx
 * // 在 MainApp 顶层调用一次
 * function App() {
 *   useVisualViewport();
 *   return <div className="h-[var(--app-height,100dvh)]">...</div>
 * }
 * ```
 *
 * 兼容性：
 * - 桌面浏览器 / Tauri：fallback 到 `window.innerHeight`
 * - 不支持 visualViewport 的浏览器：fallback 到 `100dvh`（仍优于 100vh）
 * - 旧浏览器无 dvh：fallback 到 `100vh`（行为不变，不退化）
 */
import { useEffect } from "react";

/** 把像素高度写入 :root 的 --app-height CSS 变量 */
function setAppHeight(px: number) {
  // 取像素值整数，避免抖动
  const value = `${Math.round(px)}px`;
  document.documentElement.style.setProperty("--app-height", value);
}

export function useVisualViewport(): void {
  useEffect(() => {
    if (typeof window === "undefined") return;

    // Tauri 桌面端：没有 mobile URL 栏，innerHeight 即真实可视高度
    // 直接用 resize 监听即可，不依赖 visualViewport
    const isTauriEnv =
      typeof (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !==
      "undefined";

    // 计算当前应使用的"应用高度"
    // ★ 关键：用 Math.min(innerHeight, vv.height) 兜底。
    // iOS Safari 在锁屏→唤醒时 visualViewport.height 可能短暂 stale（> innerHeight），
    // 此时用 innerHeight 更安全。同时考虑浏览器 URL 栏/软键盘遮罩。
    const compute = () => {
      const inner = window.innerHeight;
      const vv = window.visualViewport;
      let h: number;
      if (vv && vv.height > 0) {
        // 两者取小：避免 vv 异常大或 innerHeight stale 导致溢出
        h = Math.min(inner, vv.height);
      } else {
        h = inner;
      }
      // 防御：极端值（h <= 0 或过大）使用 innerHeight
      if (h <= 0 || h > window.screen.height * 1.5) {
        h = inner;
      }
      setAppHeight(h);
    };

    // 初始化一次
    compute();

    // 监听 visualViewport.resize（精确，键盘/URL 栏变化时触发）
    const vv = window.visualViewport;
    if (vv && !isTauriEnv) {
      vv.addEventListener("resize", compute);
      vv.addEventListener("scroll", compute);
    }

    // 兜底监听 window.resize（覆盖旋转屏幕、Tauri 窗口尺寸变化）
    window.addEventListener("resize", compute);
    // 屏幕旋转（部分浏览器不触发 resize）
    window.addEventListener("orientationchange", () => {
      // orientationchange 触发时 height 可能尚未更新，延迟一帧
      requestAnimationFrame(compute);
    });

    // ★ 关键：页面从后台回到前台时，mobile 浏览器可能不会自动触发 resize。
    // 必须手动监听 visibilitychange 和 pageshow 强制重算一次，
    // 否则锁屏唤醒/切回标签页后视觉高度 stale 导致输入框被遮挡。
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        // 双重 rAF：等浏览器完成布局后取最新值
        requestAnimationFrame(() => {
          requestAnimationFrame(compute);
        });
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    // pageshow: 处理 BFCache（Safari 后退缓存）恢复
    window.addEventListener("pageshow", () => {
      requestAnimationFrame(compute);
    });
    // pagehide: 清理 --app-height
    window.addEventListener("pagehide", () => {
      document.documentElement.style.removeProperty("--app-height");
    });

    return () => {
      if (vv && !isTauriEnv) {
        vv.removeEventListener("resize", compute);
        vv.removeEventListener("scroll", compute);
      }
      window.removeEventListener("resize", compute);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);
}
