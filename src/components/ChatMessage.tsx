import { memo } from "react";
import { User, Sparkles } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Message } from "../types";
import CodeEditor from "./CodeEditor";

interface ChatMessageProps {
  message: Message;
  isStreaming?: boolean;
  darkMode?: boolean;
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
    <div className="my-3 rounded-xl overflow-hidden bg-message-code dark:bg-message-code-dark border border-border dark:border-border-dark">
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
const ChatMessage = memo(function ChatMessage({ message, isStreaming = false, darkMode = true }: ChatMessageProps) {
  const isUser = message.role === "user";

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
                      <div className="my-3 rounded-xl overflow-hidden bg-message-code dark:bg-message-code-dark border border-border dark:border-border-dark">
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
              {message.content}
            </ReactMarkdown>
          </div>

          {/* 流式闪烁光标 */}
          {isStreaming && (
            <span className="inline-block w-[2px] h-[14px] ml-0.5 bg-accent/70 animate-pulse align-text-bottom" />
          )}
        </div>
      </div>
    </div>
  );
});

export default ChatMessage;
