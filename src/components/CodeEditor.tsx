import { useRef, useState } from "react";
import Editor, { OnMount, BeforeMount } from "@monaco-editor/react";
import { Check, Copy, Maximize2, Minimize2 } from "lucide-react";

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
      "editor.background": "#F5F5F5",
      "editor.foreground": "#1A1A1A",
      "editor.lineHighlightBackground": "#EBEBE8",
      "editor.selectionBackground": "#D6D6D2",
      "editorCursor.foreground": "#D97757",
      "editorLineNumber.foreground": "#B0B0B0",
      "editorLineNumber.activeForeground": "#8A8A8A",
      "editor.inactiveSelectionBackground": "#E8E8E5",
    },
  },
  dark: {
    base: "vs-dark" as const,
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#1A1A1E",
      "editor.foreground": "#E8E8E8",
      "editor.lineHighlightBackground": "#222225",
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
  const [expanded, setExpanded] = useState(false);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);

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

  const displayHeight = expanded ? Math.min(code.split("\n").length * 22 + 40, 600) : height;
  const langLabel = getLanguage(language);

  return (
    <div
      className={`my-3 rounded-xl overflow-hidden border border-border dark:border-border-dark
                   bg-message-code dark:bg-message-code-dark transition-all duration-200 max-w-full`}
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
          <button
            onClick={() => setExpanded(!expanded)}
            className="p-1 rounded-md text-content-tertiary dark:text-content-tertiary-dark
                       hover:text-content-secondary dark:hover:text-content-secondary-dark
                       hover:bg-black/[0.05] dark:hover:bg-white/[0.05]
                       transition-all duration-150"
            title={expanded ? "收起" : "展开"}
          >
            {expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
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
          minimap: { enabled: false },
          lineNumbers: "on",
          scrollBeyondLastLine: false,
          fontSize: 14,
          fontFamily: '"JetBrains Mono", "Fira Code", monospace',
          padding: { top: 12, bottom: 12 },
          wordWrap: "on",
          tabSize: 2,
          renderWhitespace: "selection",
          bracketPairColorization: { enabled: true },
          scrollbar: {
            verticalScrollbarSize: 6,
            horizontalScrollbarSize: 6,
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
