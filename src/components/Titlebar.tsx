import { useState, useEffect } from "react";
import {
  Minus,
  Square,
  Maximize2,
  X,
} from "lucide-react";
import { isTauri } from "../hooks/useTauri";

/**
 * 自定义标题栏组件
 * - Tauri 环境：提供窗口拖拽、最小化、最大化/还原、关闭
 * - 浏览器环境：静态标题栏（无窗口控制），区分开发模式
 */
function Titlebar() {
  const [isMaximized, setIsMaximized] = useState(false);
  const inTauri = isTauri();

  useEffect(() => {
    if (!inTauri) return;
    // Tauri 环境下动态导入，避免在浏览器中报错
    (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        const unlisten = await win.onResized(() => {
          win.isMaximized().then(setIsMaximized);
        });
        win.isMaximized().then(setIsMaximized);
        return () => unlisten();
      } catch (e) {
        console.warn("Tauri 窗口 API 不可用:", e);
      }
    })();
  }, [inTauri]);

  const handleMinimize = async () => {
    if (!inTauri) return;
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    getCurrentWindow().minimize();
  };

  const handleMaximize = async () => {
    if (!inTauri) return;
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    getCurrentWindow().toggleMaximize();
  };

  const handleClose = async () => {
    if (!inTauri) return;
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    getCurrentWindow().close();
  };

  return (
    <div
      className={`flex items-center justify-between h-9 px-3 
        bg-surface-secondary dark:bg-surface-secondary-dark 
        border-b border-border dark:border-border-dark
        ${inTauri ? "titlebar-drag" : ""}`}
    >
      {/* 左侧：应用标题 */}
      <div className="flex items-center gap-2.5">
        <div className="w-5 h-5 rounded-md bg-accent flex items-center justify-center">
          <span className="text-white text-xs font-bold">R</span>
        </div>
        <span className="text-sm font-medium text-content-secondary dark:text-content-secondary-dark">
          Ripple Desktop
        </span>
        {!inTauri && (
          <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 font-medium">
            开发模式
          </span>
        )}
      </div>

      {/* 右侧：窗口控制按钮 — 仅 Tauri 环境显示 */}
      {inTauri && (
        <div className="titlebar-no-drag flex items-center gap-0.5">
          <button
            onClick={handleMinimize}
            className="icon-btn rounded-none hover:bg-black/5 dark:hover:bg-white/5"
            title="最小化"
          >
            <Minus size={12} />
          </button>
          <button
            onClick={handleMaximize}
            className="icon-btn rounded-none hover:bg-black/5 dark:hover:bg-white/5"
            title={isMaximized ? "还原" : "最大化"}
          >
            {isMaximized ? <Maximize2 size={11} /> : <Square size={11} />}
          </button>
          <button
            onClick={handleClose}
            className="icon-btn rounded-none hover:bg-red-500 hover:text-white ml-0.5"
            title="关闭"
          >
            <X size={12} />
          </button>
        </div>
      )}
    </div>
  );
}

export default Titlebar;
