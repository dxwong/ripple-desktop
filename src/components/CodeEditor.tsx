import { useRef, useState, useEffect } from "react";
import Editor, { OnMount, BeforeMount } from "@monaco-editor/react";
import { Check, Copy } from "lucide-react";

interface CodeEditorProps {
  code: string;
  language?: string;
  height?: number;
  readOnly?: boolean;
  title?: string;
  darkMode?: boolean;
}

/** 语言映射 */
const LANG_MAP: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  py: "python",
  rs: "rust",
  rb: "ruby",
  go: "go",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  cpp: "cpp",
  h: "c",
  hpp: "cpp",
  cs: "csharp",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  xml: "xml",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  md: "markdown",
  sql: "sql",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  dockerfile: "dockerfile",
  gitignore: "plaintext",
  env: "plaintext",
};

/** 获取 Monaco 语言 ID */
function getLanguage(language?: string): string {
  if (!language) return "plaintext";
  const lang = language.toLowerCase();
  return LANG_MAP[lang] || lang;
}

/**
 * 自定义 Monaco 主题 — 使编辑器背景与应用代码块背景色一致
 * 白天：匹配 bg-message-code (#F5F5F5)
 * 夜间：匹配 bg-message-code-dark (#1A1A1E)
 */
const CUSTOM_THEMES = {
  light: {
    base: "vs" as const,
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#E8E8E5",
      "editor.foreground": "#1A1A1A",
      "editor.lineHighlightBackground": "#DEDEDB",
      "editor.selectionBackground": "#D6D6D2",
      "editorCursor.foreground": "#D97757",
      "editorLineNumber.foreground": "#B0B0B0",
      "editorLineNumber.activeForeground": "#8A8A8A",
      "editor.inactiveSelectionBackground": "#E0E0DC",
    },
  },
  dark: {
    base: "vs-dark" as const,
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#1E1E22",
      "editor.foreground": "#E8E8E8",
      "editor.lineHighlightBackground": "#28282C",
      "editor.selectionBackground": "#333338",
      "editorCursor.foreground": "#D97757",
      "editorLineNumber.foreground": "#555555",
      "editorLineNumber.activeForeground": "#6B6B6B",
      "editor.inactiveSelectionBackground": "#2C2C30",
    },
  },
};

/**
 * Monaco 代码编辑器组件
 * 支持代码高亮、行号、复制、展开/收起
 * 自定义主题使背景色与流式代码块保持一致
 */
function CodeEditor({
  code,
  language,
  height = 300,
  readOnly = true,
  title,
  darkMode = true,
}: CodeEditorProps) {
  const [copied, setCopied] = useState(false);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // ★ 关键修复：阻止 Monaco 拦截触摸事件和滚轮，让外层消息容器滚动。
  // 背景：Monaco 内部的 .monaco-scrollable-element 用了 touch-action: none + JS preventDefault
  // 阻止触摸事件冒泡。CSS touch-action: pan-y 对 Monaco 不够（Monaco 仍 preventDefault）。
  // 必须用 capture + passive:false 强制拦截并把 deltaY 转发到外层 .scroll-anchor。
  // 效果：
  //   - 触屏滑动代码块 → 滚动消息列表（修复 mobile 端用户痛点）
  //   - 鼠标滚轮在代码块上 → 滚动消息列表（之前已实现）
  //   - Monaco 内部仍可滚轮查看长代码（用编辑器内 touchpad / 鼠标滚轮）
  // ★ 同时阻止 contextmenu 事件，避免浏览器原生右键菜单（"Back/Reload"等）
  // 出现在代码块上。这是简单的样式/交互处理，不涉及业务逻辑。
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const getScrollParent = (): HTMLElement | null => {
      return container.closest<HTMLElement>(".scroll-anchor");
    };

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const parent = getScrollParent();
      if (parent) {
        parent.scrollTop += e.deltaY;
      }
    };

    // 触摸事件处理：拦截 touchmove，强制滚动外层
    let lastTouchY = 0;
    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        lastTouchY = e.touches[0].clientY;
      }
    };
    const handleTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const currentY = e.touches[0].clientY;
      const deltaY = lastTouchY - currentY;
      lastTouchY = currentY;
      // ★ 关键：preventDefault 必须 + passive: false，否则浏览器无视
      e.preventDefault();
      e.stopPropagation();
      const parent = getScrollParent();
      if (parent) {
        parent.scrollTop += deltaY;
      }
    };

    // 阻止浏览器原生 context menu（与 Monaco 的 contextmenu: false 配合）
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };

    // 用 capture phase 拦截（Monaco 内部事件不会先于我们触发）
    container.addEventListener("wheel", handleWheel, { capture: true, passive: false });
    container.addEventListener("touchstart", handleTouchStart, { capture: true, passive: true });
    container.addEventListener("touchmove", handleTouchMove, { capture: true, passive: false });
    container.addEventListener("contextmenu", handleContextMenu, { capture: true });

    return () => {
      container.removeEventListener("wheel", handleWheel, { capture: true } as EventListenerOptions);
      container.removeEventListener("touchstart", handleTouchStart, { capture: true } as EventListenerOptions);
      container.removeEventListener("touchmove", handleTouchMove, { capture: true } as EventListenerOptions);
      container.removeEventListener("contextmenu", handleContextMenu, { capture: true } as EventListenerOptions);
    };
  }, []);

  /** 复制代码 */
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
      const ta = document.createElement("textarea");
      ta.value = code;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  /** 编辑器挂载完成 */
  const handleMount: OnMount = (editor) => {
    editorRef.current = editor;
  };

  /** Monaco 加载前注册自定义主题 */
  const handleBeforeMount: BeforeMount = (monaco) => {
    monaco.editor.defineTheme("ripple-light", CUSTOM_THEMES.light);
    monaco.editor.defineTheme("ripple-dark", CUSTOM_THEMES.dark);
  };

  // ★ 关键修复：加 400px 上限。1000 行代码 = 22020px 会撑爆页面布局，
  // 把下面的输入框挤出视口，参见 INC-2026-06-07 codeblock-overflow。
  // 超长代码块可在 Monaco 编辑器内自带垂直滚动条，无需暴露给外层。
  const MAX_EDITOR_HEIGHT = 400;
  const displayHeight = Math.min(
    Math.max(code.split("\n").length * 22 + 20, 100),
    MAX_EDITOR_HEIGHT
  );
  const langLabel = getLanguage(language);

  return (
    // ★ 关键修复：touch-action: pan-y 告诉浏览器此元素只处理上下滚动手势，
    // 横向手势直接忽略并冒泡到外层。配合 monaco editor 内部 scrollbar.horizontal: hidden，
    // 避免 mobile 端触摸事件被 Monaco scrollable 吞掉导致无法滚动消息列表。
    // overflow-hidden 防止代码块内容溢出到外层（wordWrap bounded 后内容应在容器内）。
    <div
      ref={containerRef}
      className={`my-3 rounded-xl overflow-hidden border border-border dark:border-border-dark
                   bg-message-code dark:bg-message-code-dark transition-all duration-200 max-w-full`}
      style={{ touchAction: "pan-y", overscrollBehavior: "contain" }}
    >
      {/* 顶部工具栏 */}
      <div className="flex items-center justify-between px-4 py-1.5 bg-black/[0.03] dark:bg-white/[0.03] border-b border-border dark:border-border-dark">
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-content-tertiary dark:text-content-tertiary-dark">
            {title || langLabel}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-xs
                       text-content-tertiary dark:text-content-tertiary-dark
                       hover:text-content-secondary dark:hover:text-content-secondary-dark
                       hover:bg-black/[0.05] dark:hover:bg-white/[0.05]
                       transition-all duration-150"
          >
            {copied ? (
              <>
                <Check size={12} className="text-green-500" />
                已复制
              </>
            ) : (
              <>
                <Copy size={12} />
                复制
              </>
            )}
          </button>
        </div>
      </div>

      {/* Monaco 编辑器 — 使用自定义主题保持背景一致 */}
      <Editor
        height={displayHeight}
        language={getLanguage(language)}
        value={code}
        theme={darkMode ? "ripple-dark" : "ripple-light"}
        options={{
          readOnly,
          // ★ 关键修复：domReadOnly: true 强化 readOnly。
          // readOnly 只阻止 Monaco 内部修改，但仍允许 cursor focus。
          // domReadOnly 进一步阻止 Monaco DOM 接受输入事件（包括 focus）。
          // 配合 CSS user-select: none，让代码块彻底"只读"，不响应任何交互。
          domReadOnly: true,
          // ★ 关键修复：禁用 Monaco 内置 context menu。
          // 之前 contextmenu: true (默认) 时右键代码块会显示 Monaco 菜单
          // (Cut/Copy/Paste/Command Palette 等)。改为 false 彻底禁用。
          contextmenu: false,
          // ★ 关键修复：点击行号不再选中整行（避免误操作）。
          selectOnLineNumbers: false,
          // ★ 关键修复：让 Monaco 弹出层（如 hover tooltip）不超出编辑器范围，
          // 避免 mobile 端溢出造成额外滚动/缩放问题。
          fixedOverflowWidgets: true,
          minimap: { enabled: false },
          lineNumbers: "on",
          scrollBeyondLastLine: false,
          fontSize: 14,
          fontFamily: '"JetBrains Mono", "Fira Code", monospace',
          padding: { top: 12, bottom: 12 },
          // ★ 关键修复：wordWrap: "on"。
          // 之前 "bounded" + wordWrapColumn: 120 限制过严——长行（>120 列）才会换行，
          // 普通长行（60-100 列）不会换行。用户明确要求"开启自动换行"。
          // "on" 按视口宽度换行（不论 wordWrapColumn），mobile 窄屏自然换行。
          wordWrap: "on",
          tabSize: 2,
          renderWhitespace: "selection",
          bracketPairColorization: { enabled: true },
          // ★ 关键修复：禁用横向滚动条。wordWrap: on 后代码已自动换行，
          // 不再需要横向滚动，horizontal: 'hidden' + size 0 彻底隐藏。
          scrollbar: {
            vertical: 'auto',
            horizontal: 'hidden',
            verticalScrollbarSize: 6,
            horizontalScrollbarSize: 0,
            alwaysConsumeMouseWheel: false,  // 滚轮事件不被 Monaco 消费
          },
          overviewRulerLanes: 0,
          hideCursorInOverviewRuler: true,
          overviewRulerBorder: false,
          lineDecorationsWidth: 8,
          folding: true,
          foldingHighlight: true,
          automaticLayout: true,
        }}
        beforeMount={handleBeforeMount}
        onMount={handleMount}
        loading={
          <div className="flex items-center justify-center h-full py-8 text-sm text-content-tertiary">
            加载编辑器...
          </div>
        }
      />
    </div>
  );
}

export default CodeEditor;
