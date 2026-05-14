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
        "> 提示：当前为**离线模拟模式**，连接桥接服务后可获得真实 AI 响应。\n",
      ],
      code: [
        "这是一个模拟的编程开发回复。\n\n",
        "我可以帮你处理项目中的编程任务，比如：\n\n",
        "1. **代码分析** — 理解复杂代码逻辑\n",
        "2. **代码生成** — 根据需求生成代码\n",
        "3. **调试帮助** — 排查 Bug\n\n",
        "> 提示：当前为**离线模拟模式**，连接桥接服务后可使用 OpenCode CLI。\n",
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
        "> 提示：连接桥接服务后，我可以直接在你的项目目录中执行代码。\n",
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
  const [conversations, setConversations] = useState<Conversation[]>([
    {
      id: "default",
      title: "新对话",
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      mode: "chat",
    },
  ]);
  const [activeConversationId, setActiveConversationId] = useState("default");
  const [isProcessing, setIsProcessing] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const activeConversation = conversations.find((c) => c.id === activeConversationId);

  const addMessage = useCallback(
    (role: "user" | "assistant", content: string) => {
      const msg: Message = { id: genId(), role, content, timestamp: Date.now() };
      setConversations((prev) =>
        prev.map((conv) =>
          conv.id === activeConversationId
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
    [activeConversationId]
  );

  const appendToLastAssistant = useCallback(
    (chunk: string) => {
      setConversations((prev) =>
        prev.map((conv) => {
          if (conv.id !== activeConversationId) return conv;
          const msgs = [...conv.messages];
          const last = msgs[msgs.length - 1];
          if (last && last.role === "assistant") {
            msgs[msgs.length - 1] = { ...last, content: last.content + chunk };
          } else {
            msgs.push({
              id: genId(),
              role: "assistant",
              content: chunk,
              timestamp: Date.now(),
            });
          }
          return { ...conv, messages: msgs, updatedAt: Date.now() };
        })
      );
    },
    [activeConversationId]
  );

  const sendMessage = useCallback(
    async (
      content: string,
      mode: "simulate" | "bridge" = "simulate",
      bridgeSend?: (type: string, data: any) => Promise<any>,
      bridgeSendStreaming?: (type: string, data: any) => Promise<void>,
      bridgeSetCallback?: (callback: (msg: any) => void) => void,
      projectDirectory?: string,
      openCodeModel?: string
    ) => {
      if (isProcessing) return;
      setIsProcessing(true);

      const abort = new AbortController();
      abortRef.current = abort;

      addMessage("user", content);

      try {
        // 有 OC 模型 → 走桥接（非流式，等待完整结果）
        if (openCodeModel && bridgeSend) {
          try {
            const payload: any = { command: content, cwd: projectDirectory, model: openCodeModel };
            const response = await bridgeSend("execute_opencode", payload);
            const result = response?.stdout || response?.stderr || "（无输出）";
            appendToLastAssistant(result);
            return;
          } catch (e: any) {
            appendToLastAssistant(`**OpenCode 执行错误**: ${e.message || "桥接服务不可用"}`);
            return;
          }
        }

        // 有 OC 模型但桥接未连接 → 显示错误提示并退出
        if (openCodeModel && !bridgeSend) {
          appendToLastAssistant("> ⚠️ **需要连接桥接服务**才能通过 OpenCode 执行。\n\n");
          appendToLastAssistant("**请先连接桥接服务**：\n");
          appendToLastAssistant("1. 在侧边栏点击 [连接桥接服务] 按钮\n");
          appendToLastAssistant("2. 确保 Python 桥接服务已启动 (`npm run bridge`)\n");
          return; // 不再继续模拟回复
        }

        // 模拟模式（无 OC 模型 或 OC 模型降级）
        if (mode === "simulate" || !bridgeSend) {
          const currentMode = activeConversation?.mode || "chat";
          let assistantContent = "";
          for await (const chunk of simulateStreamResponse(content, currentMode)) {
            if (abort.signal.aborted) break;
            assistantContent += chunk;
            appendToLastAssistant(chunk);
          }
          if (!abort.signal.aborted && !assistantContent) {
            appendToLastAssistant("（模拟回复为空）");
          }
        } else if (bridgeSend) {
          // 普通桥接模式（无 OC 模型）
          try {
            const payload: any = { command: content, cwd: projectDirectory };
            const response = await bridgeSend("execute_opencode", payload);
            const result = response?.stdout || response?.stderr || "（无输出）";
            appendToLastAssistant(result);
          } catch (e: any) {
            appendToLastAssistant(`**错误**: ${e.message || "请求失败"}`);
          }
        }
      } finally {
        setIsProcessing(false);
        abortRef.current = null;
      }
    },
    [isProcessing, addMessage, appendToLastAssistant, activeConversation?.mode]
  );

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
    setIsProcessing(false);
  }, []);

  const newConversation = useCallback((mode: ChatMode = "chat", projectId?: string) => {
    const newConv: Conversation = {
      id: genId(),
      title: mode === "code" ? "新开发会话" : "新对话",
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
        setActiveConversationId(remaining[remaining.length - 1]?.id || "default");
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