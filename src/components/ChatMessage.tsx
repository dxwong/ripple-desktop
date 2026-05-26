import { memo, useState, useEffect, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import { User, Sparkles, Brain, ChevronDown, ChevronRight, Copy, Check, RefreshCw, Undo2 } from "lucide-react";
import { marked } from "marked";
import { Message } from "../types";
import CodeEditor from "./CodeEditor";
import { ToolCallCard } from "./ToolCallCard";
import EditBlockPreview from "./EditBlockPreview";

// DEBUG: 追踪消息渲染
const renderLog = (id: string, role: string, contentLen: number, thinkingLen: number) => {
  console.log(`[ChatMessage] render id=${id} role=${role} content_len=${contentLen} thinking_len=${thinkingLen}`);
};

const markedRenderer = new marked.Renderer()
markedRenderer.code = function({ text, lang }: { text: string; lang?: string }) {
  const language = lang || ""
  const encodedCode = encodeURIComponent(text)
  return `<div class="code-block-mount" data-code="${encodedCode}" data-lang="${language}"><div class="code-block-light my-3 rounded-xl overflow-hidden bg-message-code dark:bg-message-code-dark border border-border dark:border-border-dark max-w-full"><div class="flex items-center justify-between px-4 py-1.5 border-b border-border dark:border-border-dark bg-black/[0.02] dark:bg-white/[0.02]"><span class="text-xs font-mono text-content-tertiary dark:text-content-tertiary-dark">${language || "code"}</span><button class="code-copy-btn text-xs text-content-tertiary dark:text-content-tertiary-dark hover:text-content-secondary dark:hover:text-content-secondary-dark transition-colors" data-code="${encodedCode}">复制</button></div><pre class="p-4 overflow-x-auto text-[14px] leading-relaxed font-mono whitespace-pre-wrap"><code class="language-${language}">${escapeHtml(text)}</code></pre></div></div>`
}

marked.use({ renderer: markedRenderer, gfm: true, breaks: true })

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/** 格式化时间戳为 YYYY/MM/DD HH:mm */
function formatTimestamp(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const Y = d.getFullYear();
  const M = String(d.getMonth() + 1).padStart(2, "0");
  const D = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${Y}/${M}/${D} ${h}:${m}`;
}

interface ChatMessageProps {
  message: Message;
  isStreaming?: boolean;
  darkMode?: boolean;
  /** EditBlock 应用成功回调 */
  onEditBlockApply?: (messageId: string, cleanContent: string, appliedCount: number) => void;
  /** 重新生成回调 */
  onRegenerate?: () => void;
  /** 回滚到该消息（撤销后续 AI 操作） */
  onRollback?: (messageId: string) => void;
}

/**
 * 消息气泡组件
 *
 * 渲染策略：
 * - 使用 marked 解析 markdown，通过 dangerouslySetInnerHTML 渲染
 * - 流式中代码块用轻量 HTML pre，完成后用 createRoot 挂载 Monaco Editor
 * - 复制按钮通过事件委托处理
 */
const ChatMessage = memo(function ChatMessage({ message, isStreaming = false, darkMode = true, onEditBlockApply, onRegenerate, onRollback }: ChatMessageProps) {
  const isUser = message.role === "user";
  const hasSnapshot = isUser && !!message.snapshotId;
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const hasThinking = !!(message.thinking);
  /** 当前显示的内容（EditBlock 应用后会被清理） */
  const [displayContent, setDisplayContent] = useState(message.content);
  /** 复制状态 */
  const [copied, setCopied] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const thinkingEndRef = useRef<HTMLDivElement>(null);
  const thinkingContainerRef = useRef<HTMLDivElement>(null);
  const thinkingScrolledUpRef = useRef(false);

  // 思考过程自动滚动
  const handleThinkingScroll = useCallback(() => {
    const el = thinkingContainerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    thinkingScrolledUpRef.current = distance > 10;
  }, []);

  useEffect(() => {
    if (thinkingExpanded && thinkingEndRef.current) {
      thinkingEndRef.current.scrollIntoView({ behavior: 'auto', block: 'end' });
    }
  }, [thinkingExpanded, message.thinking]);

  // 同步外部内容变化
  useEffect(() => {
    setDisplayContent(message.content);
  }, [message.content]);

  // 流式思考时自动展开
  useEffect(() => {
    if (isStreaming && hasThinking && !thinkingExpanded) {
      setThinkingExpanded(true);
    }
  }, [isStreaming, hasThinking, message.thinking]);

  // 复制消息内容
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  }, [message.content]);

  // 生成 markdown HTML
  const htmlContent = displayContent ? marked.parse(displayContent) as string : "";

  // 点击事件委托：处理代码块复制按钮
  const handleContentClick = useCallback((e: React.MouseEvent) => {
    const copyBtn = (e.target as HTMLElement).closest(".code-copy-btn") as HTMLElement | null
    if (copyBtn) {
      const code = decodeURIComponent(copyBtn.getAttribute("data-code") || "")
      navigator.clipboard.writeText(code)
      copyBtn.textContent = "已复制"
      setTimeout(() => { if (copyBtn) copyBtn.textContent = "复制" }, 2000)
    }
  }, [])

  // 流式完成后，将轻量代码块替换为 Monaco Editor
  useEffect(() => {
    if (isStreaming || !contentRef.current) return
    const timer = setTimeout(() => {
      const mounts = contentRef.current?.querySelectorAll<HTMLElement>(".code-block-mount")
      mounts?.forEach((mount) => {
        const code = decodeURIComponent(mount.getAttribute("data-code") || "")
        const lang = mount.getAttribute("data-lang") || ""
        mount.innerHTML = ""
        const root = createRoot(mount)
        root.render(
          <CodeEditor
            code={code.replace(/\n$/, "")}
            language={lang}
            darkMode={darkMode}
            height={Math.min(Math.max(code.split("\n").length * 22, 100), 400)}
          />
        )
      })
    }, 0)
    return () => clearTimeout(timer)
  }, [isStreaming, displayContent, darkMode])

  renderLog(message.id, message.role, message.content.length, (message.thinking || "").length);

  return (
    <div className={`flex gap-3 ${isUser ? "flex-row-reverse" : ""}`}>
      {/* 头像 */}
      <div
        className={`shrink-0 w-7 h-7 rounded-xl flex items-center justify-center ${
          isUser
            ? "bg-accent text-white shadow-sm"
            : "bg-content dark:bg-content-dark text-surface dark:text-surface-dark"
        }`}
      >
        {isUser ? <User size={14} /> : <Sparkles size={14} />}
      </div>

      {/* 消息主体 */}
      <div className={`flex-1 min-w-0 ${isUser ? "max-w-[78%]" : "max-w-full"}`}>
        {/* AI 消息头部 */}
        {!isUser && (
          <div className="flex items-center gap-2 mb-1.5 px-1">
            <span className="text-sm font-medium text-content-secondary dark:text-content-secondary-dark">
              Ripple
            </span>
            <span className="text-[11px] text-content-tertiary dark:text-content-tertiary-dark">
              AI 助手
            </span>
          </div>
        )}

        {/* 思考/推理过程（可折叠） */}
        {!isUser && hasThinking && (
          <div className="mb-2">
            <button
              onClick={() => setThinkingExpanded(!thinkingExpanded)}
              className="flex items-center gap-1.5 text-xs text-content-tertiary dark:text-content-tertiary-dark hover:text-content-secondary dark:hover:text-content-secondary-dark transition-colors px-1"
            >
              {thinkingExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <Brain size={12} />
              <span>思考过程</span>
              {isStreaming && message.thinking && !message.content && (
                <span className="inline-block w-[2px] h-[12px] bg-accent/70 animate-pulse align-middle ml-0.5" />
              )}
            </button>
            {thinkingExpanded && (
              <div ref={thinkingContainerRef} onScroll={handleThinkingScroll} className="mt-1.5 rounded-xl px-3 py-2 bg-message-code/50 dark:bg-message-code-dark/50 border border-border/50 dark:border-border-dark/50 text-xs text-content-tertiary dark:text-content-tertiary-dark whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto">
                {message.thinking}
                <div ref={thinkingEndRef} />
              </div>
            )}
          </div>
        )}

        {/* 工具调用卡片（在思考之后、文本之前，默认折叠） */}
        {!isUser && message.toolCalls && message.toolCalls.length > 0 && (
          <div className="mb-2">
            {message.toolCalls.map((toolCall) => (
              <ToolCallCard
                key={toolCall.toolCallId}
                toolCall={toolCall}
              />
            ))}
          </div>
        )}

        {/* 消息气泡 */}
        <div
          className={`rounded-2xl px-4 py-3 ${
            isUser
              ? "bg-message-user dark:bg-message-user-dark border border-border dark:border-border-dark shadow-msg"
              : "bg-message-ai dark:bg-message-ai-dark"
          }`}
        >
          {!isUser && displayContent.includes('__RIPPLE_ERROR__') ? (
            <div className="text-red-600 dark:text-red-400 font-semibold text-[14px] leading-relaxed whitespace-pre-wrap break-all">
              {displayContent.replace(/__RIPPLE_ERROR__/g, '').replace(/__RIPPLE_ERROR_END__/g, '').trim()}
            </div>
          ) : (
          <div className="markdown-body selectable-text" ref={contentRef} onClick={handleContentClick} dangerouslySetInnerHTML={{ __html: htmlContent }} />
          )}

          {/* 流式闪烁光标 */}
          {isStreaming && (
            <span className="inline-block w-[2px] h-[14px] ml-0.5 bg-accent/70 animate-pulse align-text-bottom" />
          )}
        </div>

        {/* 用户消息操作栏：时间 · 回撤 · 复制，全部靠右 */}
        {isUser && !isStreaming && (
          <div className="flex items-center justify-end mt-1.5 px-1 gap-1">
            {/* 发送时间 */}
            <span className="text-[11px] text-content-tertiary/50 dark:text-content-tertiary-dark/50 select-none">
              {formatTimestamp(message.timestamp)}
            </span>
            {/* 回滚按钮（撤销后续 AI 操作和对话） */}
            <button
              onClick={() => onRollback?.(message.id)}
              className="group relative p-1.5 rounded-lg hover:bg-amber-500/10 hover:text-amber-500 transition-all text-content-tertiary/40 dark:text-content-tertiary-dark/40"
              title="回滚到此步骤"
            >
              <Undo2 size={13} />
              {/* Tooltip */}
              <div className="absolute right-0 top-full mt-1.5 px-2.5 py-1.5 rounded-lg bg-surface dark:bg-surface-dark border border-border dark:border-border-dark text-[11px] whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none shadow-lg z-50">
                <div className="font-medium text-amber-500">回滚到此步骤</div>
                <div className="text-content-tertiary dark:text-content-tertiary-dark text-[10px] mt-0.5">撤销后续 AI 的所有操作和回复</div>
              </div>
            </button>
            {/* 复制按钮 */}
            <button
              onClick={handleCopy}
              className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 hover:text-content-secondary dark:hover:text-content-secondary-dark transition-all text-content-tertiary/30 dark:text-content-tertiary-dark/30"
              title="复制消息"
            >
              {copied ? (
                <Check size={13} className="text-green-500" />
              ) : (
                <Copy size={13} />
              )}
            </button>
          </div>
        )}

        {/* 操作按钮（非流式时在内容下方右侧显示） */}
        {!isUser && !isStreaming && (
          <div className="flex flex-row items-center gap-1 mt-2">
            {/* 重新生成按钮 */}
            {onRegenerate && (
              <button
                onClick={onRegenerate}
                className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-all"
                title="重新生成"
              >
                <RefreshCw size={14} />
              </button>
            )}
            {/* 复制按钮（只保留图标，放右边） */}
            <button
              onClick={handleCopy}
              className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-all"
              title="复制内容"
            >
              {copied ? (
                <Check size={14} className="text-green-500" />
              ) : (
                <Copy size={14} />
              )}
            </button>
          </div>
        )}

        {/* EditBlock 预览（代码编辑块预览） */}
        {!isUser && !isStreaming && (
          <EditBlockPreview
            content={message.content}
            messageId={message.id}
            isStreaming={isStreaming}
            onContentChange={setDisplayContent}
          />
        )}
      </div>
    </div>
  );
});

export default ChatMessage;
