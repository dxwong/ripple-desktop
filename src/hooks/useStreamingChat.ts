import { useState, useRef, useCallback } from "react";
import { Message, Conversation, ChatMode } from "../types";

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
  const abortRef = useRef<AbortController | null>(null);

  // 用 ref 跟踪 activeConversationId + conversations，避免闭包捕获过期值
  const activeConversationIdRef = useRef(activeConversationId);
  activeConversationIdRef.current = activeConversationId;
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;

  const activeConversation = conversations.find((c) => c.id === activeConversationId) || null;
  const activeModeRef = useRef(activeConversation?.mode || "chat");
  activeModeRef.current = activeConversation?.mode || "chat";

  // ===== 追加到指定对话（显式传 convId，避免闭包过期） =====
  const appendToConversation = useCallback((convId: string, chunk: string) => {
    if (!convId) {
      console.warn("[appendToConversation] convId 为空");
      return;
    }
    if (!chunk) return;
    let found = false;
    setConversations((prev) => {
      const next = prev.map((conv) => {
        if (conv.id !== convId) return conv;
        found = true;
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
      if (!found) console.warn("[appendToConversation] 未找到对话:", convId);
      return next;
    });
  }, []);

  // ===== 追加思考内容到指定对话的最后一个 assistant 消息 =====
  const appendThinkingToConversation = useCallback((convId: string, chunk: string) => {
    if (!convId || !chunk) return;
    let found = false;
    setConversations((prev) => {
      const next = prev.map((conv) => {
        if (conv.id !== convId) return conv;
        found = true;
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
      if (!found) console.warn("[appendThinkingToConversation] 未找到对话:", convId);
      return next;
    });
  }, []);

  // ===== 追加到当前活跃对话（由 ref 决定目标对话） =====
  const appendToLastAssistant = useCallback((chunk: string) => {
    const convId = activeConversationIdRef.current;
    if (!convId) return;
    appendToConversation(convId, chunk);
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
    [] // 使用 ref 无依赖
  );

  // ===== 发送消息 - 纯模拟模式 =====
  const sendMessage = useCallback(
    async (content: string) => {
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
        // ===== 模拟模式 =====
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
      }
    },
    [isProcessing, appendToConversation, addMessage]
  );

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
    setIsProcessing(false);
  }, []);

  /** 新建对话 */
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

  const switchConversation = useCallback((id: string) => {
    setActiveConversationId(id);
  }, []);

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

  return {
    conversations,
    activeConversation,
    activeConversationId,
    isProcessing,
    sendMessage,
    stopStreaming,
    addMessage,
    appendToLastAssistant,
    newConversation,
    switchConversation,
    deleteConversation,
  };
}
