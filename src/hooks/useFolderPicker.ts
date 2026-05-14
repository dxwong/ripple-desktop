/**
 * 文件夹选择器 Hook
 * - Tauri 环境：使用 dialog 插件调用原生文件夹选择对话框
 * - 浏览器环境：使用 hidden file input 的 webkitdirectory 特性
 */
import { useCallback, useRef } from "react";
import { isTauri } from "./useTauri";

/**
 * 打开文件夹选择对话框，返回选中目录的路径
 * 用户取消时返回 null
 */
export function useFolderPicker() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const inTauri = isTauri();

  const pickFolder = useCallback(async (): Promise<string | null> => {
    if (inTauri) {
      try {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selected = await open({
          directory: true,
          multiple: false,
          title: "选择项目目录",
        });
        return selected || null;
      } catch (e) {
        console.warn("Tauri dialog 不可用，降级到浏览器模式:", e);
        // fallthrough to browser fallback
      }
    }

    // 浏览器降级：使用隐藏的 file input
    return new Promise((resolve) => {
      // 创建临时的 file input
      const input = document.createElement("input");
      input.type = "file";
      input.setAttribute("webkitdirectory", "");
      input.setAttribute("directory", "");
      input.style.display = "none";
      document.body.appendChild(input);

      input.addEventListener("change", () => {
        const path = input.files?.[0]?.webkitRelativePath;
        if (path) {
          // 提取目录路径（去掉文件名部分）
          const dir = path.split("/")[0];
          // 在浏览器中无法获取完整绝对路径，返回相对路径
          resolve(dir);
        } else {
          resolve(null);
        }
        document.body.removeChild(input);
      }, { once: true });

      input.addEventListener("cancel", () => {
        resolve(null);
        document.body.removeChild(input);
      }, { once: true });

      input.click();
    });
  }, [inTauri]);

  return { pickFolder, fileInputRef };
}
