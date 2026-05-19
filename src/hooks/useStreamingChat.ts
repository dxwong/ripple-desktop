import { useState, useRef, useCallback, useEffect } from "react";
import { Message, Conversation, ChatMode, ModelConfig, ToolRequestData, PermissionMode, ToolCallResult, Project } from "../types";
import { SSEClient } from "../services/sse";
import { checkHealth, fetchSessions, fetchSession, confirmToolCall, deleteSession, saveSession, createCheckpoint, restoreCheckpoint } from "../services/api";
import { useStore } from "./useStore";

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

export function useStreamingChat(permissionMode: PermissionMode = "confirm") {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [backendConnected, setBackendConnected] = useState(false);
  const [pendingToolRequests, setPendingToolRequests] = useState<ToolRequestData[]>([]);
  // 根据权限模式自动设置 autoConfirm：auto 模式自动确认，confirm 和 read-only 需要确认
  const [autoConfirm, setAutoConfirm] = useState(permissionMode === "auto");
  // 追踪哪些会话已加载过消息详情（避免重复请求）
  const [loadedMessageIds, setLoadedMessageIds] = useState<Set<string>>(new Set());
  // 记录当前正在加载消息的会话 ID（用于 UI 加载态）
  const [loadingMessagesFor, setLoadingMessagesFor] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sseClientRef = useRef<SSEClient | null>(null);
  const { saveItem, loadItem } = useStore();
  const loadedInitRef = useRef(false); // 确保本地存储加载只执行一次
  // 追踪已删除的会话 ID（持久化到 localStorage，防止重启后"复活"）
  const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set());

  // 用 ref 跟踪 activeConversationId + conversations，避免闭包捕获过期值
  const activeConversationIdRef = useRef(activeConversationId);
  activeConversationIdRef.current = activeConversationId;
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;
  // 用于 addMessage 中捕获 saveItem/deletedIds 的最新引用（避免闭包过期）
  const deletedIdsRef = useRef(deletedIds);
  deletedIdsRef.current = deletedIds;
  const saveItemRef = useRef(saveItem);
  saveItemRef.current = saveItem;

  // 监听全局权限模式变化，自动同步 autoConfirm 状态
  useEffect(() => {
    setAutoConfirm(permissionMode === "auto");
  }, [permissionMode]);

  // ===== 从本地存储加载会话（仅首次执行） =====
  useEffect(() => {
    if (loadedInitRef.current) return;
    loadedInitRef.current = true;
    (async () => {
      // 加载已删除 ID 集合
      const savedDeleted = await loadItem<string[]>("deletedConversationIds", []);
      if (savedDeleted && savedDeleted.length > 0) {
        setDeletedIds(new Set(savedDeleted));
        console.log(`[useStreamingChat] 加载了 ${savedDeleted.length} 个已删除会话记录`);
      }
      // 加载会话列表（排除已删除的）
      const saved = await loadItem<Conversation[]>("conversations", []);
      if (saved && saved.length > 0) {
        const active = saved.filter((c) => !savedDeleted?.includes(c.id));
        active.sort((a, b) => b.updatedAt - a.updatedAt);
        setConversations(active);
        // 重建 loadedMessageIds：已有消息的会话标记为已加载
        const ids = new Set<string>();
        for (const c of active) {
          if (c.messages && c.messages.length > 0) ids.add(c.id);
        }
        setLoadedMessageIds(ids);
        console.log(`[useStreamingChat] 从本地存储加载了 ${active.length} 个会话（排除 ${saved.length - active.length} 个已删除），其中 ${ids.size} 个已有消息`);
      }
    })();
  }, []);

  // ===== 持久化：debounce 保存会话到本地存储（排除已删除） =====
  useEffect(() => {
    if (!loadedInitRef.current) return; // 等待首次加载完成后再保存
    const timer = setTimeout(() => {
      // 保存会话列表（过滤掉已删除的）和已删除 ID 集合
      const active = conversations.filter((c) => !deletedIds.has(c.id));
      saveItem("conversations", active);
      saveItem("deletedConversationIds", Array.from(deletedIds));
    }, 100);
    return () => clearTimeout(timer);
  }, [conversations, deletedIds, saveItem]);

  // ===== 懒加载单个会话的消息详情 =====
  const loadConversationMessages = useCallback(async (convId: string, projects: Project[]) => {
    if (loadedMessageIds.has(convId) || loadingMessagesFor === convId) return;
    setLoadingMessagesFor(convId);
    try {
      const result = await fetchSession(convId);
      if (result.error || !result.data) {
        console.warn(`[loadConversationMessages] 加载失败 ${convId}:`, result.error);
        return;
      }
      const sessionData = result.data;
      // 建立 directory → projectId 映射
      const dirToProjectId = new Map<string, string>();
      for (const p of projects) {
        if (p.directory) {
          dirToProjectId.set(p.directory.toLowerCase().replace(/\\/g, '/'), p.id);
        }
      }
      const inferProjectId = (cwd?: string): string | undefined => {
        if (!cwd) return undefined;
        const normalized = cwd.toLowerCase().replace(/\\/g, '/');
        if (dirToProjectId.has(normalized)) return dirToProjectId.get(normalized);
        for (const [dir, pid] of dirToProjectId.entries()) {
          if (normalized === dir || normalized.startsWith(dir + '/')) return pid;
        }
        return undefined;
      };
      const projectId = inferProjectId(sessionData.cwd);
      setConversations((prev) =>
        prev.map((c) => {
          if (c.id !== convId) return c;
          // 已有消息时优先保留本地（合并策略）
          if (c.messages && c.messages.length > 0) {
            // 即使有消息，也更新 cwd（用于 sendMessage）
            return {
              ...c,
              cwd: sessionData.cwd || c.cwd,
              projectId: projectId || c.projectId,
            };
          }
          return {
            ...c,
            messages: (sessionData.messages || []) as Message[],
            mode: projectId ? 'code' : ((sessionData.mode as ChatMode) || c.mode),
            projectId: projectId || c.projectId,
            cwd: sessionData.cwd || c.cwd,
          };
        })
      );
      setLoadedMessageIds((prev) => new Set([...prev, convId]));
      console.log(`[loadConversationMessages] ${convId} 消息加载完成，共 ${(sessionData.messages || []).length} 条，cwd=${sessionData.cwd || '(none)'}, projectId=${projectId || '(none)'}`);
    } finally {
      setLoadingMessagesFor((v) => (v === convId ? null : v));
    }
  }, [loadedMessageIds, loadingMessagesFor]);

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
    (role: "user" | "assistant", content: string, extraFields?: { snapshotId?: string }) => {
      const convId = activeConversationIdRef.current;
      if (!convId) return null;
      const msg: Message = { id: genId(), role, content, thinking: "", timestamp: Date.now(), ...extraFields };
      let newTitle: string | undefined;
      let newProjectId: string | undefined;
      setConversations((prev) =>
        prev.map((conv) => {
          if (conv.id !== convId) return conv;
          const isFirstUserMessage = conv.messages.length === 0 && role === "user";
          const title = isFirstUserMessage
            ? content.slice(0, 30) + (content.length > 30 ? "..." : "")
            : conv.title;
          if (isFirstUserMessage) {
            newTitle = title;
            newProjectId = conv.projectId;
          }
          return {
            ...conv,
            messages: [...conv.messages, msg],
            updatedAt: Date.now(),
            title,
          };
        })
      );
      // 同步标题到后端（使用 ref 确保拿到最新值），防止快速关闭导致标题丢失
      if (newTitle !== undefined) {
        // 立即保存到本地存储（不等待 debounce）
        const active = conversationsRef.current.filter((c) => !deletedIdsRef.current.has(c.id));
        saveItemRef.current("conversations", active);
        // 同时同步到后端 .json 元数据文件
        // 注意：只传 cwd（项目目录），不传 projectId。cwd 用于后端正确路由，projectId 是前端内部标识
        const body: { title: string; cwd?: string } = { title: newTitle };
        if (newProjectId) {
          // 如果是项目对话，从 conversation 中获取正确的 cwd
          const conv = conversationsRef.current.find((c) => c.id === convId);
          if (conv && conv.projectId) {
            // projectId 存在说明是项目对话，但 cwd 存储在后端 .json 中
            // 这里不传 cwd，让后端从 .json 读取已有的 cwd
            // body.cwd 会通过 loadConversationMessages 时从后端获取并更新到前端
          }
        }
        saveSession(convId, body).catch((err) => {
          console.warn(`[addMessage] 同步标题到后端失败 ${convId}:`, err);
        });
      }
      return msg;
    },
    // 空依赖数组：所有引用都通过 ref 访问最新值
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

      // 如果没有传入 cwd，尝试从当前会话获取（懒加载后已保存 cwd）
      const effectiveCwd = cwd || conversationsRef.current.find((c) => c.id === targetConvId)?.cwd;

      // ── 发送消息前创建快照 ──────────────────────────────────
      // 记录当前文件状态，方便用户回滚撤销 AI 的操作
      let snapshotId: string | undefined;
      if (effectiveCwd) {
        try {
          const cpRes = await createCheckpoint(effectiveCwd, `pre-msg-${targetConvId.slice(0, 8)}-${Date.now()}`, `AI处理前快照: ${content.slice(0, 30)}`);
          if (cpRes.data?.checkpoint?.id) {
            snapshotId = cpRes.data.checkpoint.id;
          }
        } catch {
          // 快照创建失败不影响消息发送
        }
      }

      // 添加用户消息（携带 snapshotId）
      addMessage("user", content, { snapshotId });

      try {
        // ===== 后端模式（Ripple-Agent SSE） =====
        if (useBackend) {
          const sseClient = new SSEClient();
          sseClientRef.current = sseClient;

          await new Promise<void>((resolve, reject) => {
            let hasContent = false;

            // 获取当前会话标题，传递给后端确保 .jsonl header 正确保存
            const currentConv = conversationsRef.current.find((c) => c.id === targetConvId);
            sseClient.connect(
              {
                message: content,
                sessionId: targetConvId,
                modelId: modelConfig?.model || "deepseek-v4-flash",
                model: modelConfig?.model,
                endpoint: modelConfig?.endpoint,
                apiKey: modelConfig?.apiKey,
                cwd: effectiveCwd,
                title: currentConv?.title,
              },
              {
                onText: (text) => {
                  hasContent = true;
                  appendToConversation(targetConvId, text);
                },
                onThinking: (text) => {
                  appendThinkingToConversation(targetConvId, text);
                },
                onToolStart: (toolCallId, toolName) => {
                  // 不再追加纯文本，用结构化 ToolCallCard 展示
                },
                onToolEnd: (toolCallId, toolName, result) => {
                  // 更新对应 toolCall 的结果
                  // 用 ref 检查当前活跃对话是否还是原来的对话，防止切换后写入错误对话
                  if (activeConversationIdRef.current !== targetConvId) return;
                  setConversations((prev) => {
                    const convId = targetConvId;
                    return prev.map((conv) => {
                      if (conv.id !== convId) return conv;
                      const msgs = [...conv.messages];
                      const last = msgs[msgs.length - 1];
                      if (!last || last.role !== "assistant") return conv;
                      const toolCalls = [...(last.toolCalls || [])];
                      const idx = toolCalls.findIndex((tc) => tc.toolCallId === toolCallId);
                      if (idx >= 0) {
                        toolCalls[idx] = {
                          ...toolCalls[idx],
                          status: result.error ? "error" : "success",
                          output: result.output,
                          error: result.error,
                        };
                      }
                      msgs[msgs.length - 1] = { ...last, toolCalls };
                      return { ...conv, messages: msgs, updatedAt: Date.now() };
                    });
                  });
                },
                onToolRequest: (data) => {
                  // 添加到待确认队列
                  setPendingToolRequests((prev) => [...prev, data]);

                  // 同时在当前 assistant 消息中创建一个 pending 的工具调用卡片
                  const pendingToolCall: ToolCallResult = {
                    toolCallId: data.toolCallId,
                    toolName: data.toolName,
                    args: data.args,
                    status: "pending",
                  };
                  setConversations((prev) =>
                    prev.map((conv): Conversation => {
                      if (conv.id !== targetConvId) return conv;
                      const msgs: Message[] = [...conv.messages];
                      const last = msgs[msgs.length - 1];
                      if (!last || last.role !== "assistant") {
                        // 还没创建 assistant 消息，先创建一个
                        const newMsg: Message = {
                          id: genId(),
                          role: "assistant",
                          content: "",
                          thinking: "",
                          timestamp: Date.now(),
                          toolCalls: [pendingToolCall],
                        };
                        msgs.push(newMsg);
                      } else {
                        msgs[msgs.length - 1] = {
                          ...last,
                          toolCalls: [...(last.toolCalls || []), pendingToolCall],
                        };
                      }
                      return { ...conv, messages: msgs, updatedAt: Date.now() };
                    })
                  );
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
  const stopStreaming = useCallback(async () => {
    abortRef.current?.abort();
    sseClientRef.current?.abort();
    
    // 调用后端 abort 端点，清理后端状态
    const targetConvId = activeConversationIdRef.current;
    if (targetConvId && backendConnected) {
      try {
        await fetch('http://localhost:3002/api/chat/abort', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            sessionId: targetConvId, 
            reason: 'User clicked stop button' 
          }),
        });
        console.log(`[stopStreaming] Called backend abort for session ${targetConvId}`);
      } catch (err) {
        console.warn('[stopStreaming] Failed to call backend abort:', err);
      }
    }
    
    setIsProcessing(false);
  }, [backendConnected]);

  // ===== 新建对话 =====
  const newConversation = useCallback((mode: ChatMode = "chat", projectId?: string, title?: string, cwd?: string) => {
    const newConv: Conversation = {
      id: genId(),
      title: title || (mode === "code" ? "新开发会话" : "新对话"),
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      mode,
      projectId,
      cwd, // 保存 cwd，用于 sendMessage 时传递
    };
    setConversations((prev) => [newConv, ...prev]);
    // 新会话消息为空，直接标记为已加载（无需从后端请求）
    setLoadedMessageIds((prev) => new Set([...prev, newConv.id]));
    setActiveConversationId(newConv.id);
    // 同时在后端创建对应 session，确保重启后可恢复
    // 普通模式和项目模式都需要创建后端文件，否则 .jsonl header 中无 title，重启后会丢失标题
    saveSession(newConv.id, { title: newConv.title, cwd }).catch(() => { /* 静默 */ });
    return newConv;
  }, []);

  // ===== 切换对话 =====
  const switchConversation = useCallback((id: string, projects: Project[] = []) => {
    if (isProcessing) {
      // 彻底中止当前的 SSE 流和 AbortController
      abortRef.current?.abort();
      // 立即关闭 SSE 客户端，防止旧流继续写入任何对话
      sseClientRef.current?.abort();
      sseClientRef.current = null;
      abortRef.current = null;
      setIsProcessing(false);
    }
    // 清理当前对话的待确认工具请求（切换后旧请求不再有效）
    setPendingToolRequests([]);
    setActiveConversationId(id);
    // 懒加载：切换到未加载消息的会话时自动拉取后端详情
    if (!loadedMessageIds.has(id)) {
      loadConversationMessages(id, projects);
    }
  }, [isProcessing, loadedMessageIds, loadConversationMessages]);

  // ===== 删除对话 =====
  const deleteConversation = useCallback(
    (id: string) => {
      setConversations((prev) => prev.filter((c) => c.id !== id));
      // 标记为已删除（防止重启后"复活"）
      setDeletedIds((prev) => new Set([...prev, id]));
      // 从 loadedMessageIds 移除（避免遗留状态干扰）
      setLoadedMessageIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      if (id === activeConversationId) {
        const remaining = conversations.filter((c) => c.id !== id);
        setActiveConversationId(remaining.length > 0 ? remaining[remaining.length - 1].id : "");
      }
      // 通知后端删除对应 session
      deleteSession(id).catch((err) => {
        console.warn(`[deleteConversation] 后端删除失败 ${id}:`, err);
      });
    },
    [activeConversationId, conversations]
  );

  // ===== 确认或拒绝工具执行 =====
  const handleToolConfirm = useCallback(
    async (toolCallId: string, approved: boolean, reason?: string) => {
      const sessionId = activeConversationIdRef.current;
      if (!sessionId) return;

      // 同时更新消息中的 toolCalls 状态
      setConversations((prev): Conversation[] =>
        prev.map((conv): Conversation => {
          if (conv.id !== sessionId) return conv;
          const msgs: Message[] = conv.messages.map((msg) => {
            if (msg.role !== "assistant") return msg;
            const toolCalls: ToolCallResult[] | undefined = msg.toolCalls?.map((tc): ToolCallResult =>
              tc.toolCallId === toolCallId
                ? {
                    ...tc,
                    status: (approved ? "approved" : "denied") as ToolCallResult["status"],
                    error: approved ? undefined : reason,
                  }
                : tc
            );
            if (!toolCalls) return msg;
            return { ...msg, toolCalls };
          });
          return { ...conv, messages: msgs };
        })
      );

      const result = await confirmToolCall(sessionId, toolCallId, approved, reason);
      if (result.error) {
        console.error("[handleToolConfirm] 失败:", result.error);
      }

      // 从待确认队列中移除
      setPendingToolRequests((prev) => prev.filter((t) => t.toolCallId !== toolCallId));
    },
    []
  );

  // ===== Auto 确认：队列变化时自动批准 =====
  useEffect(() => {
    if (!autoConfirm || pendingToolRequests.length === 0) return;
    const req = pendingToolRequests[0];
    // 延迟一小段时间再确认，让 UI 有时间反应
    const timer = setTimeout(() => {
      handleToolConfirm(req.toolCallId, true);
    }, 100);
    return () => clearTimeout(timer);
  }, [pendingToolRequests, autoConfirm, handleToolConfirm]);

  // ===== 从后端加载历史会话列表（仅合并元数据，不拉取消息） =====
  const loadSessionsFromBackend = useCallback(async (projects: Project[]) => {
    const result = await fetchSessions();
    if (result.error || !result.data) {
      console.warn('[loadSessionsFromBackend] 加载失败:', result.error);
      return;
    }

    // 建立 directory → projectId 的映射（统一转为小写和正斜杠，兼容 Windows 路径）
    const dirToProjectId = new Map<string, string>();
    for (const p of projects) {
      if (p.directory) {
        const normalized = p.directory.toLowerCase().replace(/\\/g, '/');
        dirToProjectId.set(normalized, p.id);
      }
    }

    /** 根据后端 cwd 推断 projectId */
    const inferProjectId = (cwd?: string): string | undefined => {
      if (!cwd) return undefined;
      const normalized = cwd.toLowerCase().replace(/\\/g, '/');
      if (dirToProjectId.has(normalized)) return dirToProjectId.get(normalized);
      for (const [dir, pid] of dirToProjectId.entries()) {
        if (normalized === dir || normalized.startsWith(dir + '/')) return pid;
      }
      return undefined;
    };

    // 只构建元数据，后端会话的 messages 初始为空，切换到该会话时才懒加载
    const backendConversations = result.data.map((session) => {
      const projectId = inferProjectId(session.cwd);
      return {
        id: session.id,
        title: session.title,
        messages: [] as Message[],
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        mode: projectId ? 'code' : ((session.mode as ChatMode) || 'chat'),
        projectId,
        cwd: session.cwd, // 保存 cwd，用于 sendMessage 时传递
      };
    });

      // 合并策略：本地已有会话优先（保留消息和 loadedMessageIds 状态），
      // 后端新增的会话追加；后端会话不在 loadedMessageIds 中（消息待懒加载）；
      // 已删除的会话不追加（deletedIds 已标记，重启后不会复活）
      setConversations((prev) => {
        const merged = new Map<string, Conversation>();
        // 先保留本地已有的（消息和状态完整）
        for (const c of prev) merged.set(c.id, c);
        // 再处理后端会话：追加本地没有的，或选择更好的标题
        for (const c of backendConversations) {
          if (deletedIds.has(c.id)) continue;
          const backendConv = c as Conversation;
          if (!merged.has(c.id)) {
            merged.set(c.id, backendConv);
            continue;
          }
          // 本地已有：比较标题，保留更有意义的（非默认格式）
          const localConv = merged.get(c.id)!;
          const isLocalDefault = !localConv.title || /^(新对话|新开发会话|会话\s+\w+|未命名对话)$/.test(localConv.title);
          const isBackendDefault = !backendConv.title || /^(新对话|新开发会话|会话\s+\w+|未命名对话)$/.test(backendConv.title);
          if (isLocalDefault && !isBackendDefault) {
            merged.set(c.id, { ...localConv, title: backendConv.title });
          }
          // 其他情况保留本地（本地非默认标题优先）
        }
        const arr = Array.from(merged.values());
        // 按 updatedAt 降序排列
        arr.sort((a, b) => b.updatedAt - a.updatedAt);
        console.log(`[loadSessionsFromBackend] 后端 ${backendConversations.length} 个会话，与本地合并后共 ${arr.length} 个（过滤了 ${deletedIds.size} 个已删除）`);
        return arr;
      });
  }, [deletedIds]);

  // ===== 回滚到指定消息的快照 =====
  const rollbackToSnapshot = useCallback(
    async (snapshotId: string, messageId: string, convId: string, cwd?: string) => {
      if (isProcessing) {
        console.warn("[rollbackToSnapshot] 正在处理中，无法回滚");
        return { success: false, error: "正在处理中，无法回滚" };
      }

      // 1. 恢复文件快照
      if (cwd) {
        const res = await restoreCheckpoint(snapshotId, cwd);
        if (res.error) {
          return { success: false, error: res.error };
        }
        if (!res.data?.success) {
          return { success: false, error: res.data?.errors?.join(", ") || "回滚失败" };
        }
      }

      // 2. 截断对话：删除该消息之后的所有消息
      setConversations((prev) =>
        prev.map((conv) => {
          if (conv.id !== convId) return conv;
          const msgIndex = conv.messages.findIndex((m) => m.id === messageId);
          if (msgIndex < 0) return conv;
          return {
            ...conv,
            messages: conv.messages.slice(0, msgIndex + 1),
            updatedAt: Date.now(),
          };
        })
      );

      // 3. 通知后端重置会话（清理 Agent 上下文）
      if (backendConnected) {
        try {
          await fetch("http://localhost:3002/api/reset", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId: convId }),
          });
        } catch (err) {
          console.warn("[rollbackToSnapshot] 后端重置失败:", err);
        }
      }

      return { success: true, error: undefined };
    },
    [isProcessing, backendConnected]
  );

  return {
    conversations,
    activeConversation,
    activeConversationId,
    isProcessing,
    backendConnected,
    pendingToolRequests,
    autoConfirm,
    setAutoConfirm,
    sendMessage,
    stopStreaming,
    addMessage,
    newConversation,
    switchConversation,
    deleteConversation,
    checkBackendConnection,
    handleToolConfirm,
    loadSessionsFromBackend,
    loadConversationMessages,
    loadedMessageIds,
    loadingMessagesFor,
    rollbackToSnapshot,
  };
}