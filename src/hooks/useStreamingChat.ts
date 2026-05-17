import { useState, useRef, useCallback } from "react";
import { Message, Conversation, ChatMode, ModelConfig, ToolRequestData } from "../types";
import { SSEClient } from "../services/sse";
import { checkHealth, fetchModels, confirmToolCall } from "../services/api";

const genId = () => Math.random().toString(36).substring(2, 10);

async function* simulateStreamResponse(userMessage: string, mode: ChatMode): AsyncGenerator<string> {
  const responses: Record<string, Record<ChatMode, string[]>> = {
    default: {
      chat: [
        "这是一个模拟的普通对话回复。\n\n",
        "我可以帮你解答各种问题，比如：\n\n",
        "1. **技术咨询** — 编程问题解答\n",
        "2. **创意生成** — 写作、构思建议\n",
        "3. **知识问答** — 科普知识讲解\n\n",
        "> 提示：当前为**纯前端模拟模式**，连接后端 AI 服务后可获得真实响应。\n",
      ],
      code: [
        "这是一个模拟的编程开发回复。\n\n",
        "我可以帮你处理项目中的编程任务，比如：\n\n",
        "1. **代码分析** — 理解复杂代码逻辑\n",
        "2. **代码生成** — 根据需求生成代码\n",
        "3. **调试帮助** — 排查 Bug\n\n",
        "> 提示：当前为**纯前端模拟模式**，连接后端 AI 服务后可获得真实响应。\n",
      ],
    },
    code: {
      chat: [
        "好的，我来生成一段示例代码：\n\n",
        "```typescript\n",
        "interface User {\n",
        "  id: string;\n",
        "  name: string;\n",
        "  email: string;\n",
        "  role: 'admin' | 'user';\n",
        "}\n\n",
        "async function fetchUsers(): Promise<User[]> {\n",
        "  const response = await fetch('/api/users');\n",
        "  if (!response.ok) {\n",
        "    throw new Error(`HTTP ${response.status}`);\n",
        "  }\n",
        "  return response.json();\n",
        "}\n\n",
        "// 使用示例\n",
        "const users = await fetchUsers();\n",
        "console.log(users);\n",
        "```\n\n",
        "这段代码定义了一个 `User` 接口和获取用户列表的异步函数。\n",
      ],
      code: [
        "好的，我来帮你处理这个编程任务：\n\n",
        "```typescript\n",
        "interface User {\n",
        "  id: string;\n",
        "  name: string;\n",
        "  email: string;\n",
        "  role: 'admin' | 'user';\n",
        "}\n\n",
        "async function fetchUsers(): Promise<User[]> {\n",
        "  const response = await fetch('/api/users');\n",
        "  if (!response.ok) {\n",
        "    throw new Error(`HTTP ${response.status}`);\n",
        "  }\n",
        "  return response.json();\n",
        "}\n\n",
        "// 使用示例\n",
        "const users = await fetchUsers();\n",
        "console.log(users);\n",
        "```\n\n",
        "> 提示：连接后端 AI 服务后，我可以直接在你的项目目录中执行代码分析。\n",
      ],
    },
  };

  let chunks: string[];
  const key = userMessage.toLowerCase().includes("code") || userMessage.toLowerCase().includes("代码") ? "code" : "default";
  chunks = responses[key][mode];

  for (const chunk of chunks) {
    await new Promise((r) => setTimeout(r, 40 + Math.random() * 60));
    yield chunk;
  }
}

export function useStreamingChat() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [backendConnected, setBackendConnected] = useState(false);
  const [pendingToolRequests, setPendingToolRequests] = useState<ToolRequestData[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const sseClientRef = useRef<SSEClient | null>(null);

  // 用 ref 跟踪 activeConversationId + conversations，避免闭包捕获过期值
  const activeConversationIdRef = useRef(activeConversationId);
  activeConversationIdRef.current = activeConversationId;
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;

  const activeConversation = conversations.find((c) => c.id === activeConversationId) || null;
  const activeModeRef = useRef(activeConversation?.mode || "chat");
  activeModeRef.current = activeConversation?.mode || "chat";

  // ===== 检查后端连接状态 =====
  const checkBackendConnection = useCallback(async () => {
    const ok = await checkHealth();
    setBackendConnected(ok);
    return ok;
  }, []);

  // ===== 追加到指定对话 =====
  const appendToConversation = useCallback((convId: string, chunk: string) => {
    if (!convId || !chunk) return;
    setConversations((prev) => {
      const next = prev.map((conv) => {
        if (conv.id !== convId) return conv;
        const msgs = [...conv.messages];
        const last = msgs[msgs.length - 1];
        if (last && last.role === "assistant") {
          msgs[msgs.length - 1] = { ...last, content: last.content + chunk };
        } else {
          msgs.push({
            id: genId(),
            role: "assistant",
            content: chunk,
            thinking: "",
            timestamp: Date.now(),
          });
        }
        return { ...conv, messages: msgs, updatedAt: Date.now() };
      });
      return next;
    });
  }, []);

  // ===== 追加思考内容 =====
  const appendThinkingToConversation = useCallback((convId: string, chunk: string) => {
    if (!convId || !chunk) return;
    setConversations((prev) => {
      const next = prev.map((conv) => {
        if (conv.id !== convId) return conv;
        const msgs = [...conv.messages];
        const last = msgs[msgs.length - 1];
        if (last && last.role === "assistant") {
          msgs[msgs.length - 1] = { ...last, thinking: (last.thinking || "") + chunk };
        } else {
          msgs.push({
            id: genId(),
            role: "assistant",
            content: "",
            thinking: chunk,
            timestamp: Date.now(),
          });
        }
        return { ...conv, messages: msgs, updatedAt: Date.now() };
      });
      return next;
    });
  }, []);

  // ===== 添加用户/助手消息 =====
  const addMessage = useCallback(
    (role: "user" | "assistant", content: string) => {
      const convId = activeConversationIdRef.current;
      if (!convId) return null;
      const msg: Message = { id: genId(), role, content, thinking: "", timestamp: Date.now() };
      setConversations((prev) =>
        prev.map((conv) =>
          conv.id === convId
            ? {
                ...conv,
                messages: [...conv.messages, msg],
                updatedAt: Date.now(),
                title:
                  conv.messages.length === 0 && role === "user"
                    ? content.slice(0, 30) + (content.length > 30 ? "..." : "")
                    : conv.title,
              }
            : conv
        )
      );
      return msg;
    },
    []
  );

  // ===== 发送消息 =====
  const sendMessage = useCallback(
    async (
      content: string,
      useBackend = false,
      modelConfig?: ModelConfig,
      cwd?: string
    ) => {
      if (isProcessing) return;
      setIsProcessing(true);

      const abort = new AbortController();
      abortRef.current = abort;

      const targetConvId = activeConversationIdRef.current;
      if (!targetConvId) {
        console.warn("[sendMessage] 没有活跃对话，跳过发送");
        setIsProcessing(false);
        return;
      }

      // 先添加用户消息
      addMessage("user", content);

      try {
        // ===== 后端模式（Ripple-Agent SSE） =====
        if (useBackend) {
          const sseClient = new SSEClient();
          sseClientRef.current = sseClient;

          await new Promise<void>((resolve, reject) => {
            let hasContent = false;

            sseClient.connect(
              {
                message: content,
                sessionId: targetConvId,
                modelId: modelConfig?.model || "deepseek-v4-flash",
                model: modelConfig?.model,
                endpoint: modelConfig?.endpoint,
                apiKey: modelConfig?.apiKey,
                cwd,
              },
              {
                onText: (text) => {
                  hasContent = true;
                  appendToConversation(targetConvId, text);
                },
                onThinking: (text) => {
                  appendThinkingToConversation(targetConvId, text);
                },
                onToolStart: (name) => {
                  appendToConversation(
                    targetConvId,
                    `\n🔧 ${name}...\n`
                  );
                },
                onToolEnd: (name) => {
                  appendToConversation(
                    targetConvId,
                    `✅ ${name} 完成\n`
                  );
                },
                onToolRequest: (data) => {
                  // 添加到待确认队列
                  setPendingToolRequests((prev) => [...prev, data]);
                },
                onDone: () => {
                  resolve();
                },
                onError: (error) => {
                  if (!hasContent) {
                    appendToConversation(
                      targetConvId,
                      `\n\n> ❌ **错误**: ${error}\n\n`
                    );
                  }
                  reject(new Error(error));
                },
              }
            );
          });

          return;
        }

        // ===== 模拟模式（仅开发测试用） =====
        const currentMode = activeModeRef.current;
        let assistantContent = "";
        for await (const chunk of simulateStreamResponse(content, currentMode)) {
          if (abort.signal.aborted) break;
          assistantContent += chunk;
          appendToConversation(targetConvId, chunk);
        }
        if (!abort.signal.aborted && !assistantContent) {
          appendToConversation(targetConvId, "（模拟回复为空）");
        }
      } finally {
        setIsProcessing(false);
        abortRef.current = null;
        sseClientRef.current = null;
      }
    },
    [isProcessing, appendToConversation, appendThinkingToConversation, addMessage]
  );

  // ===== 停止生成 =====
  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
    sseClientRef.current?.abort();
    setIsProcessing(false);
  }, []);

  // ===== 新建对话 =====
  const newConversation = useCallback((mode: ChatMode = "chat", projectId?: string, title?: string) => {
    const newConv: Conversation = {
      id: genId(),
      title: title || (mode === "code" ? "新开发会话" : "新对话"),
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      mode,
      projectId,
    };
    setConversations((prev) => [...prev, newConv]);
    setActiveConversationId(newConv.id);
    return newConv;
  }, []);

  // ===== 切换对话 =====
  const switchConversation = useCallback((id: string) => {
    // 切换对话时，如果当前有进行中的请求，停止它并清理状态
    if (isProcessing) {
      abortRef.current?.abort();
      sseClientRef.current?.abort();
      setIsProcessing(false);
    }
    // 清理当前对话的待确认工具请求
    setPendingToolRequests([]);
    setActiveConversationId(id);
  }, [isProcessing]);

  // ===== 删除对话 =====
  const deleteConversation = useCallback(
    (id: string) => {
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (id === activeConversationId) {
        const remaining = conversations.filter((c) => c.id !== id);
        setActiveConversationId(remaining.length > 0 ? remaining[remaining.length - 1].id : "");
      }
    },
    [activeConversationId, conversations]
  );

  // ===== 确认或拒绝工具执行 =====
  const handleToolConfirm = useCallback(
    async (toolCallId: string, approved: boolean, reason?: string) => {
      const sessionId = activeConversationIdRef.current;
      if (!sessionId) return;

      const result = await confirmToolCall(sessionId, toolCallId, approved, reason);
      if (result.error) {
        console.error("[handleToolConfirm] 失败:", result.error);
      }

      // 从待确认队列中移除
      setPendingToolRequests((prev) => prev.filter((t) => t.toolCallId !== toolCallId));
    },
    []
  );

  return {
    conversations,
    activeConversation,
    activeConversationId,
    isProcessing,
    backendConnected,
    pendingToolRequests,
    sendMessage,
    stopStreaming,
    addMessage,
    newConversation,
    switchConversation,
    deleteConversation,
    checkBackendConnection,
    handleToolConfirm,
  };
}