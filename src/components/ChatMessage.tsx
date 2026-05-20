import { memo, useState, useEffect, useCallback } from "react";
import { User, Sparkles, Brain, ChevronDown, ChevronRight, Copy, Check, RefreshCw, RotateCcw } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Message } from "../types";
import CodeEditor from "./CodeEditor";
import { ToolCallCard } from "./ToolCallCard";
import EditBlockPreview from "./EditBlockPreview";

// DEBUG: 追踪消息渲染
const renderLog = (id: string, role: string, contentLen: number, thinkingLen: number) => {
  console.log(`[ChatMessage] render id=${id} role=${role} content_len=${contentLen} thinking_len=${thinkingLen}`);
};

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

/** 从 className 中提取语言 */
function extractLanguage(className?: string): string | undefined {
  if (!className) return undefined;
  const match = className.match(/language-(\w+)/);
  return match ? match[1] : undefined;
}

/** 轻量代码块（流式中使用，无 Monaco） */
function LightweightCodeBlock({ code, language }: { code: string; language?: string }) {
  return (
    <div className="my-3 rounded-xl overflow-hidden bg-message-code dark:bg-message-code-dark border border-border dark:border-border-dark max-w-full">
      {language && (
        <div className="flex items-center px-4 py-1 border-b border-border dark:border-border-dark bg-black/[0.02] dark:bg-white/[0.02]">
          <span className="text-xs font-mono text-content-tertiary dark:text-content-tertiary-dark">
            {language}
          </span>
        </div>
      )}
      <pre className="p-4 overflow-x-auto text-[14px] leading-relaxed font-mono whitespace-pre-wrap">
        {code}
      </pre>
    </div>
  );
}

/**
 * 从 ReactMarkdown pre 组件的 children 中提取代码内容
 * 
 * ReactMarkdown 的 pre 组件接收：
 *   children: <code>React 元素（内含代码文本 + className 语言标记）
 *   node: unist AST 节点
 */
function extractCodeInfo(children: React.ReactNode): { code: string; language?: string } {
  try {
    const codeElement = (children as any);
    // <code> 元素的 children 就是代码文本
    const code = typeof codeElement?.props?.children === "string"
      ? codeElement.props.children
      : "";
    // <code> 元素的 className 包含语言标记，如 "language-typescript"
    const className = codeElement?.props?.className || "";
    const language = extractLanguage(className);
    return { code, language };
  } catch {
    return { code: "" };
  }
}

/**
 * 消息气泡组件
 * 
 * 流式渲染策略：
 * - 流式和完成后都用 ReactMarkdown 渲染（样式一致，不闪烁）
 * - 流式中代码块用轻量 <pre>，完成后用 Monaco Editor
 * - 所有代码内容从 ReactMarkdown 的 pre children 正确提取
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
      <div className={`flex-1 min-w-0 overflow-x-hidden ${isUser ? "max-w-[78%]" : "max-w-full"}`}>
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
              <div className="mt-1.5 rounded-xl px-3 py-2 bg-message-code/50 dark:bg-message-code-dark/50 border border-border/50 dark:border-border-dark/50 text-xs text-content-tertiary dark:text-content-tertiary-dark whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto">
                {message.thinking}
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
          <div className="markdown-body selectable-text">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                // ===== 代码块：流式用轻量 pre，完成用 Monaco =====
                pre: ({ children }) => {
                  const { code, language } = extractCodeInfo(children);
                  if (!code) {
                    // 没有代码内容时回退到普通 pre
                    return (
                      <div className="my-3 rounded-xl overflow-hidden bg-message-code dark:bg-message-code-dark border border-border dark:border-border-dark max-w-full">
                        <pre className="p-4 overflow-x-auto text-[14px] leading-relaxed font-mono">
                          {children}
                        </pre>
                      </div>
                    );
                  }

                  if (isStreaming) {
                    return <LightweightCodeBlock code={code.replace(/\n$/, "")} language={language} />;
                  }

                  return (
                    <CodeEditor
                      code={code.replace(/\n$/, "")}
                      language={language}
                      darkMode={darkMode}
                      height={Math.min(Math.max(code.split("\n").length * 22, 100), 400)}
                    />
                  );
                },
                // ===== 行内代码：两种模式一致 =====
                code: ({ className, children }) => {
                  if (!className) {
                    return (
                      <code className="px-1.5 py-0.5 rounded-md bg-message-code dark:bg-message-code-dark text-accent text-[14px] font-mono">
                        {children}
                      </code>
                    );
                  }
                  return null; // 块级代码由 pre 组件处理
                },
              }}
            >
              {displayContent}
            </ReactMarkdown>
          </div>

          {/* 流式闪烁光标 */}
          {isStreaming && (
            <span className="inline-block w-[2px] h-[14px] ml-0.5 bg-accent/70 animate-pulse align-text-bottom" />
          )}
        </div>

        {/* 用户消息回滚按钮 */}
        {isUser && hasSnapshot && !isStreaming && (
          <div className="flex justify-start gap-1 mt-1.5 ml-1">
            <button
              onClick={() => onRollback?.(message.id)}
              className="group relative p-1.5 rounded-lg hover:bg-amber-500/10 hover:text-amber-500 transition-all text-content-tertiary/40 dark:text-content-tertiary-dark/40"
              title="回滚到此步骤"
            >
              <RotateCcw size={13} />
              {/* Tooltip - 下方弹出，避免被遮挡 */}
              <div className="absolute left-1/2 -translate-x-1/2 top-full mt-1.5 px-2.5 py-1.5 rounded-lg bg-surface dark:bg-surface-dark border border-border dark:border-border-dark text-[11px] whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none shadow-lg z-50">
                <div className="font-medium text-amber-500">回滚到此步骤</div>
                <div className="text-content-tertiary dark:text-content-tertiary-dark text-[10px] mt-0.5">撤销后续 AI 的所有操作和回复</div>
              </div>
            </button>
          </div>
        )}

        {/* 操作按钮（非流式时在内容右下角显示） */}
        {!isUser && !isStreaming && (
          <div className="flex justify-end gap-1 mt-1.5 mr-1">
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
