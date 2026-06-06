import { memo, useState, useEffect, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { User, Sparkles, Brain, ChevronDown, ChevronRight, Copy, Check, RefreshCw, Undo2, XCircle, CheckCircle2, AlertTriangle } from "lucide-react";
import { marked } from "marked";
import { Message, ToolCallResult } from "../types";
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
  // ★ 关键修复：流式输出的代码块必须加 max-height 限制。
  // 之前完全靠 globals.css 中的 `.code-block-light { max-height: 70vh }` 兜底，
  // 但 70vh 在 mobile 上 ≈ 560px，多个代码块累加会撑爆消息容器。
  // 这里用 inline style 强写 max-height: min(50vh, 400px)，最小函数兼容所有浏览器，
  // 流式时裁掉超出部分，流式完成后会被 Monaco Editor（已限 400px）替换。
  return `<div class="code-block-mount" data-code="${encodedCode}" data-lang="${language}"><div class="code-block-light my-3 rounded-xl overflow-hidden bg-message-code dark:bg-message-code-dark border border-border dark:border-border-dark max-w-full" style="max-height:min(50vh,400px)"><div class="flex items-center justify-between px-4 py-1.5 border-b border-border dark:border-border-dark bg-black/[0.02] dark:bg-white/[0.02]"><span class="text-xs font-mono text-content-tertiary dark:text-content-tertiary-dark">${language || "code"}</span><button class="code-copy-btn text-xs text-content-tertiary dark:text-content-tertiary-dark hover:text-content-secondary dark:hover:text-content-secondary-dark transition-colors" data-code="${encodedCode}">复制</button></div><pre class="p-4 overflow-x-auto text-[14px] leading-relaxed font-mono whitespace-pre code-scroll-container" style="max-height:min(50vh,400px)"><code class="language-${language}">${escapeHtml(text)}</code></pre></div></div>`
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

/** 格式化执行耗时（毫秒） */
export function formatDuration(start?: number, end?: number): string {
  if (!start) return "";
  const ms = (end ?? Date.now()) - start;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${((ms % 60000) / 1000).toFixed(0)}s`;
}

interface ChatMessageProps {
  message: Message;
  isStreaming?: boolean;
  darkMode?: boolean;
  /** 重新生成回调 */
  onRegenerate?: () => void;
  /** 回滚到该消息（撤销后续 AI 操作） */
  onRollback?: (messageId: string) => void;
}

/**
 * ⭐ 专家调用卡片（Phase 1: 子代理执行可视化）
 *
 * 用于在聊天消息中展示 invoke_expert 工具调用：
 * - 进行中：默认展开，蓝色呼吸点 + 实时耗时
 * - 已完成/失败：默认折叠，绿色✅ / 红色❌ + 总耗时
 * - 展示专家名、任务描述、输出内容或错误
 *
 * 导出供测试使用（生产环境从 ChatMessage 内部引用）。
 */
export function InvokeExpertCard({ toolCall }: { toolCall: ToolCallResult }) {
  const [expanded, setExpanded] = useState(false);
  const [liveDuration, setLiveDuration] = useState("");
  const timerRef = useRef<ReturnType<typeof setInterval>>();

  const isRunning = toolCall.status === "approved";
  const isFinished = toolCall.status === "success" || toolCall.status === "error";

  // 进行中默认展开；已完成/失败默认折叠（用户可手动切换）
  const effectiveExpanded = isRunning || expanded;

  // 进行中时实时刷新耗时
  useEffect(() => {
    if (!isRunning || !toolCall.startTime) {
      setLiveDuration("");
      return;
    }
    const update = () => setLiveDuration(formatDuration(toolCall.startTime));
    update();
    timerRef.current = setInterval(update, 200);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isRunning, toolCall.startTime]);

  const finalDuration =
    isFinished && toolCall.startTime
      ? formatDuration(toolCall.startTime, toolCall.endTime)
      : "";
  const durationText = isRunning ? liveDuration : finalDuration;

  const expertName = (toolCall.args.expertName as string) || "未知专家";
  const task = (toolCall.args.task as string) || "";

  return (
    <div className="rounded-xl border border-border/60 dark:border-border-dark/60 overflow-hidden mt-1.5">
      {/* 标题栏 */}
      <div
        className="flex items-center gap-2.5 px-3 py-2 cursor-pointer select-none hover:bg-black/[0.02] dark:hover:bg-white/[0.03] transition-colors"
        onClick={() => !isRunning && setExpanded(!expanded)}
      >
        {/* 专家图标 */}
        <div className="w-6 h-6 rounded-md bg-accent/10 text-accent flex items-center justify-center shrink-0">
          <Brain size={13} />
        </div>

        {/* 专家名 + 任务 */}
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold text-content dark:text-content-dark leading-tight">
            调用专家：{expertName}
          </div>
          {task && (
            <div
              className="text-[11px] text-content-secondary dark:text-content-secondary-dark mt-0.5 truncate"
              title={task}
            >
              {task}
            </div>
          )}
        </div>

        {/* 状态 + 耗时 + 折叠箭头 */}
        <div className="flex items-center gap-1.5 shrink-0">
          {isRunning ? (
            <>
              <span className="inline-flex rounded-full h-2 w-2 bg-blue-500 animate-breath" />
              <span className="text-[11px] text-blue-500 font-medium tabular-nums">
                {durationText}
              </span>
            </>
          ) : toolCall.status === "error" ? (
            <>
              <XCircle size={11} className="text-rose-500" />
              <span className="text-[11px] text-rose-500 font-medium">
                失败 · {durationText}
              </span>
            </>
          ) : (
            <>
              <CheckCircle2 size={11} className="text-green-500" />
              <span className="text-[11px] text-green-500 font-medium">{durationText}</span>
            </>
          )}
          {!isRunning && (
            effectiveExpanded ? (
              <ChevronDown size={12} className="text-content-tertiary/50 ml-0.5" />
            ) : (
              <ChevronRight size={12} className="text-content-tertiary/50 ml-0.5" />
            )
          )}
        </div>
      </div>

      {/* 展开内容 */}
      {effectiveExpanded && (
        <div className="px-3 py-2.5 border-t border-border/30 dark:border-border-dark/30">
          {toolCall.error ? (
            <>
              <div className="flex items-center gap-1 text-[10px] text-rose-500/60 dark:text-rose-400/60 mb-1">
                <AlertTriangle size={10} />
                错误
              </div>
              <pre className="text-[11px] font-mono bg-rose-500/[0.04] dark:bg-rose-400/[0.04] rounded-lg p-2 max-h-40 overflow-auto whitespace-pre-wrap break-all text-rose-500/70 dark:text-rose-400/70 leading-relaxed">
                {toolCall.error}
              </pre>
            </>
          ) : toolCall.output ? (
            <pre className="text-[11px] font-mono bg-black/[0.02] dark:bg-white/[0.02] rounded-lg p-2 max-h-48 overflow-auto whitespace-pre-wrap break-all text-content-secondary dark:text-content-secondary-dark leading-relaxed">
              {toolCall.output}
            </pre>
          ) : isRunning ? (
            <div className="flex items-center gap-2 text-[11px] text-content-tertiary dark:text-content-tertiary-dark italic">
              <span className="inline-flex rounded-full h-1.5 w-1.5 bg-blue-500 animate-pulse" />
              正在执行...
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * ⭐ 编排结果卡片（Phase 1: orchestrate 工具的 fallback 渲染）
 *
 * 用途说明：
 * - `orchestrate` 实际上不是 AI 可调用的工具，而是后端 HTTP API（POST /api/orchestrate）
 * - AI 在对话中只能通过多次 `invoke_expert` 顺序调用实现编排效果
 * - 本卡片作为防御性 fallback：如果未来 orchestrate 变成 AI 工具，或前端以其他方式注入
 *   了 orchestrate 工具调用，本卡片会优雅地展示其结果，不会出现空白
 * - 状态、计时、折叠逻辑与 InvokeExpertCard 一致；内容区会尝试解析 JSON 渲染结构化视图，
 *   解析失败时回退到原始文本
 *
 * 导出供测试使用（生产环境从 ChatMessage 内部引用）。
 */
export function OrchestrationResultCard({ toolCall }: { toolCall: ToolCallResult }) {
  const [expanded, setExpanded] = useState(false);
  const [liveDuration, setLiveDuration] = useState("");
  const timerRef = useRef<ReturnType<typeof setInterval>>();

  const isRunning = toolCall.status === "approved";
  const isFinished = toolCall.status === "success" || toolCall.status === "error";

  // 编排结果卡片：始终默认折叠，用户可手动展开
  const effectiveExpanded = expanded;

  // 进行中时实时刷新耗时
  useEffect(() => {
    if (!isRunning || !toolCall.startTime) {
      setLiveDuration("");
      return;
    }
    const update = () => setLiveDuration(formatDuration(toolCall.startTime));
    update();
    timerRef.current = setInterval(update, 200);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isRunning, toolCall.startTime]);

  const finalDuration =
    isFinished && toolCall.startTime
      ? formatDuration(toolCall.startTime, toolCall.endTime)
      : "";
  const durationText = isRunning ? liveDuration : finalDuration;

  // 尝试解析 output 为 JSON（结构化编排结果）
  let parsed: any = null;
  if (toolCall.output) {
    try {
      parsed = JSON.parse(toolCall.output);
    } catch {
      parsed = null;
    }
  }

  return (
    <div className="rounded-xl border border-border/60 dark:border-border-dark/60 overflow-hidden mt-1.5">
      {/* 标题栏 */}
      <div
        className="flex items-center gap-2.5 px-3 py-2 cursor-pointer select-none hover:bg-black/[0.02] dark:hover:bg-white/[0.03] transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {/* 总管家图标 */}
        <div className="w-6 h-6 rounded-md bg-accent/10 text-accent flex items-center justify-center shrink-0">
          <Brain size={13} />
        </div>

        {/* 标题 + 摘要 */}
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold text-content dark:text-content-dark leading-tight">
            总管家编排结果
          </div>
          <div className="text-[11px] text-content-secondary dark:text-content-secondary-dark mt-0.5 truncate">
            {parsed && Array.isArray(parsed.results)
              ? `${parsed.results.length} 位专家参与`
              : "总管家调度多个专家完成任务"}
          </div>
        </div>

        {/* 状态 + 耗时 + 折叠箭头 */}
        <div className="flex items-center gap-1.5 shrink-0">
          {isRunning ? (
            <>
              <span className="inline-flex rounded-full h-2 w-2 bg-blue-500 animate-breath" />
              <span className="text-[11px] text-blue-500 font-medium tabular-nums">
                {durationText}
              </span>
            </>
          ) : toolCall.status === "error" ? (
            <>
              <XCircle size={11} className="text-rose-500" />
              <span className="text-[11px] text-rose-500 font-medium">
                失败 · {durationText}
              </span>
            </>
          ) : (
            <>
              <CheckCircle2 size={11} className="text-green-500" />
              <span className="text-[11px] text-green-500 font-medium">{durationText}</span>
            </>
          )}
          {effectiveExpanded ? (
            <ChevronDown size={12} className="text-content-tertiary/50 ml-0.5" />
          ) : (
            <ChevronRight size={12} className="text-content-tertiary/50 ml-0.5" />
          )}
        </div>
      </div>

      {/* 展开内容 */}
      {effectiveExpanded && (
        <div className="px-3 py-2.5 border-t border-border/30 dark:border-border-dark/30 space-y-2">
          {toolCall.error ? (
            <>
              <div className="flex items-center gap-1 text-[10px] text-rose-500/60 dark:text-rose-400/60">
                <AlertTriangle size={10} />
                错误
              </div>
              <pre className="text-[11px] font-mono bg-rose-500/[0.04] dark:bg-rose-400/[0.04] rounded-lg p-2 max-h-40 overflow-auto whitespace-pre-wrap break-all text-rose-500/70 dark:text-rose-400/70 leading-relaxed">
                {toolCall.error}
              </pre>
            </>
          ) : parsed && Array.isArray(parsed.results) ? (
            /* 结构化渲染（如果 output 是 JSON） */
            <>
              <div className="text-[11px] text-content-tertiary dark:text-content-tertiary-dark">
                各专家结果：
              </div>
              {parsed.results.map((r: any, i: number) => (
                <div
                  key={i}
                  className="text-[12px] text-content-secondary dark:text-content-secondary-dark flex items-start gap-1.5"
                >
                  {r.success ? (
                    <CheckCircle2 size={11} className="text-green-500 mt-0.5 shrink-0" />
                  ) : (
                    <XCircle size={11} className="text-rose-500 mt-0.5 shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <span className="font-medium text-content dark:text-content-dark">
                      {r.expertName || `专家 ${i + 1}`}
                    </span>
                    {typeof r.durationMs === "number" ? (
                      <span className="ml-2 text-content-tertiary dark:text-content-tertiary-dark tabular-nums">
                        {(r.durationMs / 1000).toFixed(1)}s
                      </span>
                    ) : null}
                  </div>
                </div>
              ))}
              {parsed.summary && (
                <div className="pt-2 border-t border-border/30 dark:border-border-dark/30 text-[12px] text-content-secondary dark:text-content-secondary-dark leading-relaxed">
                  <span className="font-medium text-content dark:text-content-dark">总管家汇总：</span>
                  {parsed.summary}
                </div>
              )}
            </>
          ) : toolCall.output ? (
            /* 原始文本回退 */
            <pre className="text-[11px] font-mono bg-black/[0.02] dark:bg-white/[0.02] rounded-lg p-2 max-h-48 overflow-auto whitespace-pre-wrap break-all text-content-secondary dark:text-content-secondary-dark leading-relaxed">
              {toolCall.output}
            </pre>
          ) : isRunning ? (
            <div className="flex items-center gap-2 text-[11px] text-content-tertiary dark:text-content-tertiary-dark italic">
              <span className="inline-flex rounded-full h-1.5 w-1.5 bg-blue-500 animate-pulse" />
              正在执行...
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * 消息气泡组件
 *
 * 渲染策略：
 * - 使用 marked 解析 markdown，通过 dangerouslySetInnerHTML 渲染
 * - 流式中代码块用轻量 HTML pre，完成后用 createRoot 挂载 Monaco Editor
 * - 复制按钮通过事件委托处理
 */
const ChatMessage = memo(function ChatMessage({ message, isStreaming = false, darkMode = true, onRegenerate, onRollback }: ChatMessageProps) {
  const isUser = message.role === "user";
  const hasSnapshot = isUser && !!message.snapshotId;
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const hasThinking = !!(message.thinking);
  /** 当前显示的内容（EditBlock 应用后会被清理） */
  const [displayContent, setDisplayContent] = useState(message.content);
  /** 复制状态 */
  const [copied, setCopied] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const codeRootsRef = useRef<Map<HTMLElement, Root>>(new Map());
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

  // 不再在流式输出时自动展开思考过程，保持默认折叠
	// useEffect(() => {
	// 	if (isStreaming && hasThinking && !thinkingExpanded) {
	// 		setThinkingExpanded(true);
	// 	}
	// }, [isStreaming, hasThinking, message.thinking]);

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
      const roots = codeRootsRef.current;
      const seen = new Set<HTMLElement>();

      mounts?.forEach((mount) => {
        seen.add(mount);
        const code = decodeURIComponent(mount.getAttribute("data-code") || "")
        const lang = mount.getAttribute("data-lang") || ""

        let root = roots.get(mount);
        if (!root) {
          mount.innerHTML = ""
          root = createRoot(mount)
          roots.set(mount, root);
        }
        root.render(
          <CodeEditor
            code={code.replace(/\n$/, "")}
            language={lang}
            darkMode={darkMode}
            height={Math.min(Math.max(code.split("\n").length * 22, 100), 400)}
          />
        )
      })

      // 清理不再在 DOM 中的旧 root（消息内容变化导致之前创建的 mount 被移除）
      for (const [mount, root] of roots) {
        if (!seen.has(mount)) {
          root.unmount();
          roots.delete(mount);
        }
      }
    }, 0)
    return () => clearTimeout(timer)
  }, [isStreaming, displayContent, darkMode])

  // 组件卸载时清理所有 Monaco Editor root
  useEffect(() => {
    return () => {
      const roots = codeRootsRef.current;
      for (const [mount, root] of roots) {
        root.unmount();
      }
      roots.clear();
    };
  }, [])

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
            {message.toolCalls.map((toolCall) => {
              // ⭐ Phase 1: invoke_expert 走专用专家调用卡片
              if (toolCall.toolName === "invoke_expert") {
                return (
                  <InvokeExpertCard
                    key={toolCall.toolCallId}
                    toolCall={toolCall}
                  />
                );
              }
              // ⭐ Phase 1: orchestrate 走专用编排结果卡片（防御性 fallback）
              if (toolCall.toolName === "orchestrate") {
                return (
                  <OrchestrationResultCard
                    key={toolCall.toolCallId}
                    toolCall={toolCall}
                  />
                );
              }
              return (
                <ToolCallCard
                  key={toolCall.toolCallId}
                  toolCall={toolCall}
                />
              );
            })}
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
