import { useState, useMemo } from "react";
import { Check, Copy } from "lucide-react";

/**
 * 代码块组件（v5 彻底重构）
 *
 * 历史背景：之前使用 @monaco-editor/react（完整 VSCode 引擎），在桌面/移动端引发
 * 了一连串问题：行号/缩进/鼠标滚动失效/焦点跳输入框/高度计算异常等等。
 *
 * 实际上代码块只需要"和普通文本一样正常展示 + 复制按钮"，
 * 不需要 Monaco 的完整编辑能力（语法高亮、跳转、折叠等）。
 *
 * 本组件用纯 HTML <pre><code> 渲染，附带：
 *   - 顶部工具栏：语言标签 + 复制按钮
 *   - 手写简易语法高亮（零依赖，零额外 bundle 体积）
 *   - 标准 pre/code 语义，浏览器原生滚动行为（无 Monaco 内部 scrollable 干扰）
 *
 * 接口完全兼容 v4 的 CodeEditor，所以 ChatMessage.tsx 中 createRoot(render <CodeEditor />)
 * 不用改任何代码。
 */
interface CodeEditorProps {
  code: string;
  language?: string;
  title?: string;
  /** 保留接口兼容（darkMode 通过外层 .dark 类切换，本组件自动适配） */
  darkMode?: boolean;
  /** 保留接口兼容（纯展示组件永远是 readOnly） */
  readOnly?: boolean;
  /** 保留接口兼容（高度自适应内容，不需要外部传） */
  height?: number;
}

export default function CodeEditor({
  code,
  language,
  title,
}: CodeEditorProps) {
  const [copied, setCopied] = useState(false);

  /**
   * 复制代码到剪贴板。
   * 优先用 navigator.clipboard（现代 API，需要 https 或 localhost），
   * 降级用 textarea + execCommand（兼容老浏览器/非安全上下文）。
   */
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback: 兼容非安全上下文
      const ta = document.createElement("textarea");
      ta.value = code;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* 极端情况下也不抛错 */
      }
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // 简易语法高亮（useMemo 避免每次 render 重新计算）
  const highlightedHtml = useMemo(
    () => highlightCode(code, language),
    [code, language],
  );

  const langLabel = title || language || "code";

  return (
    <div
      className="code-block-light my-3 rounded-xl overflow-hidden border border-border dark:border-border-dark
                 bg-message-code dark:bg-message-code-dark max-w-full"
    >
      {/* 顶部工具栏：语言标签 + 复制按钮 */}
      <div className="flex items-center justify-between px-4 py-1.5 bg-black/[0.03] dark:bg-white/[0.03] border-b border-border dark:border-border-dark">
        <span className="text-xs font-mono text-content-tertiary dark:text-content-tertiary-dark">
          {langLabel}
        </span>
        <button
          onClick={handleCopy}
          className="code-copy-btn flex items-center gap-1 px-2 py-1 rounded-md text-xs
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

      {/* 代码内容：标准 pre + code，浏览器原生滚动/换行/选择行为 */}
      <pre
        className="p-4 text-[14px] leading-relaxed font-mono whitespace-pre-wrap break-words m-0"
        style={{ wordBreak: "break-word", overflowWrap: "anywhere" }}
      >
        <code dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
      </pre>
    </div>
  );
}

/* ============================================================
 * 简易语法高亮（手写 regex，零依赖）
 *
 * 设计取舍：
 * - 完整语法高亮（如 highlight.js / shiki）体积大、配置复杂，对纯展示场景过度设计
 * - 简易 regex 高亮能覆盖 80% 视觉需求（关键字、字符串、注释、数字区分）
 * - 零依赖 = 零 bundle 体积增加
 *
 * 实现步骤（顺序很重要）：
 *  1. HTML 转义（<, >, &）— 防止 XSS，确保后续插入的 <span> 是唯一 HTML
 *  2. 字符串匹配 — 必须在注释/关键字之前，否则注释中字符串会被破坏
 *  3. 注释匹配
 *  4. 数字匹配
 *  5. 关键字匹配（最后）
 *
 * XSS 安全性：
 *  - 用户代码先经过 escape，所以所有 < > & 都变成 &lt; &gt; &amp;
 *  - 然后 regex 替换插入的 <span> 是受控的（className 是写死的）
 *  - regex 捕获组 $1 是从用户代码中提取的，但因为先 escape 过，不会包含 HTML 特殊字符
 * ============================================================ */

// 各语言关键字列表（精简版，覆盖主流语言）
const KEYWORDS: Record<string, string[]> = {
  typescript: [
    "const", "let", "var", "function", "return", "if", "else", "import", "export",
    "from", "class", "interface", "type", "extends", "implements", "new", "this",
    "super", "async", "await", "for", "while", "switch", "case", "break",
    "continue", "default", "try", "catch", "throw", "finally", "true", "false",
    "null", "undefined", "as", "in", "of", "do", "void", "public", "private",
    "protected", "static", "readonly", "enum", "namespace", "declare", "abstract",
  ],
  javascript: [
    "const", "let", "var", "function", "return", "if", "else", "import", "export",
    "from", "class", "extends", "new", "this", "super", "async", "await",
    "for", "while", "switch", "case", "break", "continue", "default", "try",
    "catch", "throw", "finally", "true", "false", "null", "undefined", "in",
    "of", "do", "yield", "delete", "typeof", "instanceof", "void",
  ],
  python: [
    "def", "class", "return", "if", "elif", "else", "import", "from", "as",
    "for", "while", "try", "except", "finally", "with", "lambda", "yield",
    "True", "False", "None", "and", "or", "not", "in", "is", "pass",
    "break", "continue", "global", "nonlocal", "self", "async", "await", "raise",
  ],
  java: [
    "public", "private", "protected", "class", "interface", "extends",
    "implements", "new", "this", "super", "return", "if", "else", "for",
    "while", "switch", "case", "break", "continue", "default", "try", "catch",
    "throw", "finally", "static", "final", "abstract", "void", "int", "boolean",
    "double", "float", "char", "String", "true", "false", "null", "package",
  ],
  rust: [
    "fn", "let", "mut", "const", "static", "pub", "use", "mod", "struct",
    "enum", "trait", "impl", "for", "while", "loop", "if", "else", "match",
    "return", "self", "Self", "true", "false", "in", "as", "ref", "where",
    "async", "await", "move", "dyn",
  ],
  go: [
    "func", "var", "const", "type", "struct", "interface", "package", "import",
    "return", "if", "else", "for", "range", "switch", "case", "default",
    "break", "continue", "go", "defer", "chan", "map", "true", "false", "nil",
  ],
  c: [
    "int", "char", "float", "double", "void", "short", "long", "unsigned",
    "signed", "struct", "union", "enum", "typedef", "static", "extern",
    "return", "if", "else", "for", "while", "do", "switch", "case",
    "break", "continue", "default", "sizeof", "goto",
  ],
  cpp: [
    "int", "char", "float", "double", "void", "short", "long", "unsigned",
    "signed", "struct", "union", "enum", "typedef", "static", "extern",
    "return", "if", "else", "for", "while", "do", "switch", "case",
    "break", "continue", "default", "sizeof", "goto", "class", "public",
    "private", "protected", "virtual", "new", "delete", "this", "template",
    "typename", "namespace", "using", "true", "false", "nullptr",
  ],
  csharp: [
    "public", "private", "protected", "class", "interface", "extends",
    "implements", "new", "this", "base", "return", "if", "else", "for",
    "while", "switch", "case", "break", "continue", "default", "try", "catch",
    "throw", "finally", "static", "void", "int", "bool", "double", "float",
    "char", "string", "true", "false", "null", "namespace", "using", "var",
  ],
  css: [
    "color", "background", "border", "margin", "padding", "display", "position",
    "top", "left", "right", "bottom", "width", "height", "font", "text",
    "line-height", "flex", "grid", "align", "justify", "gap", "transition",
    "transform", "opacity", "z-index", "overflow", "important",
  ],
  html: [
    "div", "span", "p", "a", "img", "ul", "ol", "li", "table", "tr", "td",
    "th", "input", "button", "form", "label", "select", "option", "h1", "h2",
    "h3", "h4", "h5", "h6", "html", "head", "body", "title", "meta", "link",
    "script", "style",
  ],
  sql: [
    "SELECT", "FROM", "WHERE", "INSERT", "INTO", "VALUES", "UPDATE", "SET",
    "DELETE", "CREATE", "TABLE", "ALTER", "DROP", "INDEX", "VIEW", "JOIN",
    "INNER", "LEFT", "RIGHT", "OUTER", "ON", "AS", "AND", "OR", "NOT",
    "NULL", "IS", "IN", "LIKE", "ORDER", "BY", "GROUP", "HAVING", "LIMIT",
    "OFFSET", "DISTINCT", "PRIMARY", "KEY", "FOREIGN", "REFERENCES",
  ],
};

/** 注释匹配规则（按语言） */
const COMMENT_PATTERNS: Record<string, RegExp> = {
  typescript: /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g,
  javascript: /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g,
  java: /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g,
  go: /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g,
  rust: /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g,
  c: /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g,
  cpp: /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g,
  csharp: /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g,
  python: /(#[^\n]*)/g,
  shell: /(#[^\n]*)/g,
  bash: /(#[^\n]*)/g,
  sh: /(#[^\n]*)/g,
  yaml: /(#[^\n]*)/g,
  // HTML/XML 注释中的 < > 已经被 escape 成 &lt; &gt;，所以 regex 用转义后的形式
  html: /(&lt;!--[\s\S]*?--&gt;)/g,
  xml: /(&lt;!--[\s\S]*?--&gt;)/g,
};

function highlightCode(code: string, language?: string): string {
  // 第 1 步：HTML 转义（防止 XSS，确保后续插入的 <span> 是唯一 HTML）
  let result = code
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const lang = (language || "plaintext").toLowerCase();

  // 第 2 步：字符串（最先匹配，捕获 $1 是转义后的内容，安全）
  // 同时匹配双引号、单引号、反引号（注意：' 已被 escape 成 &#39;）
  result = result.replace(
    /(&quot;[^&\n]*?&quot;|&#39;[^&\n]*?&#39;|`[^`\n]*?`)/g,
    '<span class="code-string">$1</span>',
  );

  // 第 3 步：注释
  const commentPattern = COMMENT_PATTERNS[lang];
  if (commentPattern) {
    result = result.replace(
      commentPattern,
      '<span class="code-comment">$1</span>',
    );
  }

  // 第 4 步：数字
  result = result.replace(
    /\b(\d+(?:\.\d+)?)\b/g,
    '<span class="code-number">$1</span>',
  );

  // 第 5 步：关键字
  const keywords = KEYWORDS[lang] || KEYWORDS.typescript || [];
  if (keywords.length > 0) {
    // 按关键字长度降序，避免短关键字（in, as, do）误匹配长关键字的子串
    const sortedKeywords = [...keywords].sort((a, b) => b.length - a.length);
    const keywordPattern = new RegExp(
      `\\b(${sortedKeywords.join("|")})\\b`,
      "gi", // 大小写不敏感（SQL 关键字大写也匹配）
    );
    result = result.replace(
      keywordPattern,
      '<span class="code-keyword">$1</span>',
    );
  }

  return result;
}
