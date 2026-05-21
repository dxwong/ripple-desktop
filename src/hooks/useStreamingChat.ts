import { useState, useRef, useCallback, useEffect } from "react";
import { Message, Conversation, ChatMode, ModelConfig, ToolRequestData, PermissionMode, ToolCallResult, ConversationUsage } from "../types";
import { SSEClient } from "../services/sse";
import { checkHealth, fetchSessions, fetchSession, confirmToolCall, deleteSession, saveSession, createCheckpoint, restoreCheckpoint } from "../services/api";
import { useStore } from "./useStore";
import { flog } from "../services/frontendLogger";
import { healthSSEClient } from "../services/healthSSEClient";

const genId = () => `chat-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 5)}`;

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

export function useStreamingChat(permissionMode: PermissionMode = "confirm", agentGatewayUrl: string = "http://localhost:3002") {
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
  /** 按对话累积的使用统计（token 和费用），key = conversationId */
  const [conversationUsageMap, setConversationUsageMap] = useState<Record<string, ConversationUsage>>({});
  const abortRef = useRef<AbortController | null>(null);
  const sseClientRef = useRef<SSEClient | null>(null);
  const { saveItem, loadItem } = useStore();
  const loadedInitRef = useRef(false); // 确保本地存储加载只执行一次

  // 用 ref 跟踪 activeConversationId + conversations，避免闭包捕获过期值
  const activeConversationIdRef = useRef(activeConversationId);
  activeConversationIdRef.current = activeConversationId;
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;
  // 用于 addMessage 中捕获 saveItem 的最新引用（避免闭包过期）
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
      flog.info('STREAMING', '初始化：从本地存储加载会话');
      // 加载会话列表
      const saved = await loadItem<Conversation[]>("conversations", []);
      if (saved && saved.length > 0) {
        saved.sort((a, b) => b.updatedAt - a.updatedAt);
        setConversations(saved);
        const ids = new Set<string>();
        for (const c of saved) {
          if (c.messages && c.messages.length > 0) ids.add(c.id);
        }
        setLoadedMessageIds(ids);
        flog.info('STREAMING', `从本地存储加载会话`, {
          total: saved.length,
          withMessages: ids.size,
        });
      } else {
        flog.info('STREAMING', '本地无已保存会话');
      }
      // 清理旧的软删除标记（已改为物理删除）
      const oldDeletedIds = await loadItem<string[]>("deletedConversationIds", []);
      if (oldDeletedIds && oldDeletedIds.length > 0) {
        localStorage.removeItem("ripple-deletedConversationIds");
        flog.info('STREAMING', `已清理旧的软删除标记（${oldDeletedIds.length}条）`);
      }
    })();
  }, []);

  // ===== 持久化：保存会话到本地存储（物理删除） =====
  // 每次 conversations 变化时触发（带防抖）
  useEffect(() => {
    if (!loadedInitRef.current) return;
    const timer = setTimeout(async () => {
      try {
        await saveItem("conversations", conversations);
      } catch (err) {
        flog.warn('STREAMING', '保存会话到本地存储失败', { error: String(err) });
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [conversations, saveItem]);

  // ===== 窗口关闭前强制保存 =====
  useEffect(() => {
    const handleBeforeUnload = async () => {
      await saveItem("conversations", conversationsRef.current);
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [saveItem]);

  // ===== 通过 SSE 实时检测后端连接状态（替代轮询） =====
  // 用 ref 记录上次连接状态，避免连接稳定后频繁重复日志
  const prevConnectedRef = useRef<boolean | null>(null);
  useEffect(() => {
    flog.info('STREAMING', '启动 SSE 健康检测');
    prevConnectedRef.current = null;
    healthSSEClient.connect((connected) => {
      setBackendConnected(connected);
      // 仅当状态发生变化时输出 INFO 日志，稳定心跳用 DEBUG
      if (prevConnectedRef.current !== connected) {
        prevConnectedRef.current = connected;
        flog.info('STREAMING', `SSE 健康检测: ${connected ? '已连接' : '未连接'}`);
      } else {
        flog.debug('STREAMING', `SSE 心跳: ${connected ? '已连接' : '未连接'}`);
      }
    });
    return () => healthSSEClient.close();
  }, []);

  // ===== 懒加载单个会话的消息详情 =====
  const loadConversationMessages = useCallback(async (convId: string) => {
    if (loadedMessageIds.has(convId) || loadingMessagesFor === convId) {
      flog.debug('STREAMING', `跳过已加载/正在加载的会话`, { convId });
      return;
    }
    setLoadingMessagesFor(convId);
    
    flog.info('STREAMING', `开始加载会话消息`, { convId });
    
    try {
      const result = await fetchSession(convId);
      if (result.error || !result.data) {
        flog.error('STREAMING', `加载会话失败`, { convId, error: result.error });
        return;
      }
      const sessionData = result.data;
      flog.info('STREAMING', `从后端获取会话数据`, {
        convId,
        id: sessionData.id,
        cwd: sessionData.cwd || '(none)',
        title: sessionData.title || '(none)',
        messageCount: (sessionData.messages || []).length,
      });

      // 有 cwd 的项目对话自动标记为 code 模式
      const inferredMode: ChatMode = sessionData.cwd ? 'code' : ((sessionData.mode as ChatMode) || 'chat');

      setConversations((prev) =>
        prev.map((c) => {
          if (c.id !== convId) return c;
          if (c.messages && c.messages.length > 0) {
            return { ...c, cwd: sessionData.cwd || c.cwd };
          }
          return {
            ...c,
            messages: (sessionData.messages || []) as Message[],
            mode: inferredMode,
            cwd: sessionData.cwd || c.cwd,
          };
        })
      );
      setLoadedMessageIds((prev) => new Set([...prev, convId]));
      flog.info('STREAMING', `会话消息加载完成`, {
        convId,
        messageCount: (sessionData.messages || []).length,
        cwd: sessionData.cwd || '(none)',
      });
    } finally {
      setLoadingMessagesFor((v) => (v === convId ? null : v));
    }
  }, [loadedMessageIds, loadingMessagesFor]);

  const activeConversation = conversations.find((c) => c.id === activeConversationId) || null;
  const activeModeRef = useRef(activeConversation?.mode || "chat");
  activeModeRef.current = activeConversation?.mode || "chat";

  // ===== 检查后端连接状态（仅返回结果，不修改状态——状态由 SSE 健康检测管理） =====
  // 日志用 DEBUG 级别，避免启动时大量 INFO 刷屏
  const checkBackendConnection = useCallback(async () => {
    flog.debug('STREAMING', '检查后端连接状态');
    const ok = await checkHealth();
    if (!ok) {
      flog.debug('STREAMING', '首次连接失败，1秒后重试');
      await new Promise(r => setTimeout(r, 1000));
      const retryOk = await checkHealth();
      flog.debug('STREAMING', `重试后端连接状态: ${retryOk ? '已连接' : '未连接'}`);
      return retryOk;
    }
    flog.debug('STREAMING', `后端连接状态: ${ok ? '已连接' : '未连接'}`);
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
      if (!convId) {
        flog.warn('STREAMING', 'addMessage 失败：无活跃会话');
        return null;
      }
      flog.info('STREAMING', `添加消息: ${role}`, {
        convId,
        role,
        contentLength: content.length,
        contentPreview: content.slice(0, 50),
        extraFields,
      });
      const msg: Message = { id: genId(), role, content, thinking: "", timestamp: Date.now(), ...extraFields };
      let newTitle: string | undefined;
      setConversations((prev) =>
        prev.map((conv) => {
          if (conv.id !== convId) return conv;
          const isFirstUserMessage = conv.messages.length === 0 && role === "user";
          const title = isFirstUserMessage
            ? content.slice(0, 30) + (content.length > 30 ? "..." : "")
            : conv.title;
          if (isFirstUserMessage) {
            newTitle = title;
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
        saveItemRef.current("conversations", conversationsRef.current);
        // 同步到后端 .json 元数据文件
        saveSession(convId, { title: newTitle }).catch((err) => {
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
      cwd?: string,
      regenerate?: boolean
    ) => {
      flog.info('STREAMING', `发送消息请求`, {
        contentLength: content.length,
        contentPreview: content.slice(0, 50),
        useBackend,
        backendConnected: backendConnected,
        hasModelConfig: !!modelConfig,
        modelConfigId: modelConfig?.id || '(none)',
        cwd: cwd || '(none)',
        regenerate,
      });

      if (isProcessing) {
        flog.warn('STREAMING', '发送跳过：正在处理中');
        return;
      }
      setIsProcessing(true);

      const abort = new AbortController();
      abortRef.current = abort;

      const targetConvId = activeConversationIdRef.current;
      if (!targetConvId) {
        flog.error('STREAMING', '发送失败：没有活跃对话');
        setIsProcessing(false);
        return;
      }

      const effectiveCwd = cwd || conversationsRef.current.find((c) => c.id === targetConvId)?.cwd;
      const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 8)}`;
      flog.info('STREAMING', `发送消息确认`, { targetConvId, effectiveCwd: effectiveCwd || '(none)', requestId });

      // 重新生成时：移除最后一个完整轮次（AI 回复 + 触发它的用户消息）
      // 用户消息将由 handleRegenerate 重新提交，确保不在上下文中重复出现
      if (regenerate) {
        setConversations(prev => prev.map(conv => {
          if (conv.id !== targetConvId) return conv;
          let msgs = conv.messages;
          // 移除最后一条 AI 回复
          if (msgs.length > 0 && msgs[msgs.length - 1].role === 'assistant') {
            msgs = msgs.slice(0, -1);
          }
          // 移除触发该回复的用户消息（将由 handleRegenerate 重新发送）
          if (msgs.length > 0 && msgs[msgs.length - 1].role === 'user') {
            msgs = msgs.slice(0, -1);
          }
          return { ...conv, messages: msgs };
        }));
      }

      let snapshotId: string | undefined;
      if (effectiveCwd) {
        try {
          const label = `AI处理前 - ${content.slice(0, 20).replace(/\n/g, ' ')}`;
          const cpRes = await createCheckpoint(
            effectiveCwd,
            label,
            `AI处理前自动快照: ${content.slice(0, 60)}`,
            "auto"
          );
          if ((cpRes as any).data?.checkpoint?.id) {
            snapshotId = (cpRes as any).data.checkpoint.id;
            flog.info('STREAMING', '创建快照成功', { snapshotId, cwd: effectiveCwd });
            // 通知 CheckpointPanel 刷新快照列表（实时更新）
            window.dispatchEvent(new CustomEvent('checkpoint-created', { detail: { cwd: effectiveCwd } }));
          } else {
            flog.warn('STREAMING', '创建快照返回异常（不影响消息发送）', {
              cwd: effectiveCwd,
              error: (cpRes as any).error || 'unknown',
            });
          }
        } catch (err) {
          flog.warn('STREAMING', '创建快照失败（不影响消息发送）', {
            cwd: effectiveCwd,
            error: String(err),
          });
        }
      }

      addMessage("user", content, { snapshotId });

      try {
        if (useBackend) {
          flog.info('STREAMING', '使用后端模式发送');
          const sseClient = new SSEClient({ baseUrl: agentGatewayUrl });
          sseClientRef.current = sseClient;

          // 预先添加一个空的 assistant 消息，以便后续能在上面显示错误或内容
          addMessage("assistant", "");

          await new Promise<void>((resolve, reject) => {
            let hasContent = false;

            const currentConv = conversationsRef.current.find((c) => c.id === targetConvId);
            
            const backendParams = {
              message: content,
              sessionId: targetConvId,
              regenerate: regenerate || false,
              modelId: modelConfig?.model || "deepseek-v4-flash",
              model: modelConfig?.model,
              endpoint: modelConfig?.endpoint,
              apiKey: modelConfig?.apiKey,
              cwd: effectiveCwd,
              title: currentConv?.title,
              requestId,
            };
            flog.info('STREAMING', `发送到后端的参数`, {
              sessionId: backendParams.sessionId,
              title: backendParams.title || '(none)',
              requestId,
              cwd: backendParams.cwd || '(none)',
              modelId: backendParams.modelId,
              model: backendParams.model || '(none)',
              endpoint: backendParams.endpoint || '(none)',
              hasApiKey: !!backendParams.apiKey,
              messagePreview: content.slice(0, 50),
            });
            
            sseClient.connect(
              backendParams,
              {
                onText: (text) => {
                  hasContent = true;
                  appendToConversation(targetConvId, text);
                },
                onThinking: (text) => {
                  appendThinkingToConversation(targetConvId, text);
                },
                onToolStart: (toolCallId, toolName) => {
                  flog.debug('STREAMING', `工具开始执行`, { toolCallId, toolName });
                  if (activeConversationIdRef.current !== targetConvId) return;
                  // 将工具调用状态推进到执行中（后续 onToolEnd 变为 success/error）
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
                        toolCalls[idx] = { ...toolCalls[idx], status: "approved" };
                      }
                      msgs[msgs.length - 1] = { ...last, toolCalls };
                      return { ...conv, messages: msgs, updatedAt: Date.now() };
                    });
                  });
                },
                onToolEnd: (toolCallId, toolName, result) => {
                  flog.debug('STREAMING', `工具结束`, { toolCallId, toolName, hasError: !!result.error });
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
                  flog.info('STREAMING', `工具执行请求`, { toolCallId: data.toolCallId, toolName: data.toolName });
                  setPendingToolRequests((prev) => [...prev, data]);
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
                // Agent 生命周期事件（日志级别，用于追踪）
                onAgentStart: () => {
                  flog.debug('STREAMING', 'Agent 开始处理');
                },
                onTurnStart: () => {
                  flog.debug('STREAMING', '新轮次开始');
                },
                onTurnEnd: (data) => {
                  flog.debug('STREAMING', `轮次结束`, { 
                    hasToolResults: data.hasToolResults, 
                    hasError: data.hasError, 
                    errorMessage: data.errorMessage 
                  });
                  
                  // 如果有错误，显示到对话中
                  if (data.hasError) {
                    let errorContent = data.errorMessage;
                    
                    if (!errorContent) {
                      errorContent = "请求处理过程中发生未知错误";
                      flog.warn('STREAMING', `turn-end 有错误但 errorMessage 为空，使用默认提示`);
                    }
                    
                    flog.error('STREAMING', `收到错误消息，显示到对话中`, { errorMessage: errorContent });
                    const sanitized = errorContent.replace(/<[^>]+>/g, '');
                    const errorMsg = `\n\n__RIPPLE_ERROR__\n❌ ${sanitized}\n__RIPPLE_ERROR_END__\n\n`;
                    appendToConversation(targetConvId, errorMsg);
                  }
                },
                onMessageStart: (role) => {
                  flog.debug('STREAMING', `消息开始`, { role });
                },
                onMessageEnd: (role) => {
                  flog.debug('STREAMING', `消息结束`, { role });
                },
                onToolUpdate: (toolCallId, toolName) => {
                  flog.debug('STREAMING', `工具部分结果更新`, { toolCallId, toolName });
                },
                onUsage: (usage) => {
                  flog.debug('STREAMING', `收到 usage 事件`, {
                    targetConvId,
                    usage,
                  });
                  // 按对话累积 token、费用和缓存
                  setConversationUsageMap((prev) => {
                    const existing = prev[targetConvId] || { input: 0, output: 0, totalTokens: 0, cost: 0, cacheRead: 0, cacheWrite: 0 };
                    const newUsage = {
                      input: existing.input + (usage.input ?? 0),
                      output: existing.output + (usage.output ?? 0),
                      totalTokens: existing.totalTokens + (usage.totalTokens ?? 0),
                      cost: existing.cost + (usage.cost ?? 0),
                      cacheRead: existing.cacheRead + (usage.cacheRead ?? 0),
                      cacheWrite: existing.cacheWrite + (usage.cacheWrite ?? 0),
                    };
                    flog.debug('STREAMING', '更新对话 usage 数据', {
                      before: existing,
                      adding: usage,
                      after: newUsage,
                    });
                    return {
                      ...prev,
                      [targetConvId]: newUsage,
                    };
                  });
                },
                onDone: () => {
                  flog.info('STREAMING', 'SSE 流正常结束');
                  resolve();
                },
                onError: (error, errorDetails) => {
                  flog.error('STREAMING', `SSE 流错误`, { error, errorDetails });
                  
                  // 构建完整的错误信息
                  let fullErrorMessage = error;
                  if (errorDetails) {
                    if (errorDetails.response) {
                      const { status, statusText, data } = errorDetails.response;
                      fullErrorMessage = `${error}\n\nHTTP ${status} ${statusText}`;
                      if (data) {
                        fullErrorMessage += `\n\n响应数据: ${typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data)}`;
                      }
                    }
                    if (errorDetails.code) {
                      fullErrorMessage += `\n错误代码: ${errorDetails.code}`;
                    }
                    if (errorDetails.stack) {
                      fullErrorMessage += `\n\n堆栈信息:\n${errorDetails.stack}`;
                    }
                  }
                  
                  const sanitized = fullErrorMessage.replace(/<[^>]+>/g, '');
                  const errorMsg = `\n\n__RIPPLE_ERROR__\n❌ ${sanitized}\n__RIPPLE_ERROR_END__\n\n`;
                  appendToConversation(targetConvId, errorMsg);
                  resolve();
                },
              }
            );
          });

          return;
        }

        flog.info('STREAMING', '使用模拟模式发送');
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
      } catch (err: any) {
        flog.error('STREAMING', `发送消息异常`, { error: err.message });
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
    flog.info('STREAMING', '用户请求停止生成');
    abortRef.current?.abort();
    sseClientRef.current?.abort();
    
    const targetConvId = activeConversationIdRef.current;
    if (targetConvId && backendConnected) {
      try {
        await fetch(`${agentGatewayUrl}/api/chat/abort`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            sessionId: targetConvId, 
            reason: 'User clicked stop button' 
          }),
        });
        flog.info('STREAMING', `后端 abort 已调用`, { sessionId: targetConvId });
      } catch (err) {
        flog.warn('STREAMING', '调用后端 abort 失败', { error: err instanceof Error ? err.message : String(err) });
      }
    }
    
    setIsProcessing(false);
  }, [backendConnected, agentGatewayUrl]);

  // ===== 新建对话 =====
  const newConversation = useCallback((mode: ChatMode = "chat", title?: string, cwd?: string) => {
    const newConv: Conversation = {
      id: genId(),
      title: title || (mode === "code" ? "新开发会话" : "新对话"),
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      mode,
      cwd,
    };
    flog.info('STREAMING', `新建对话`, {
      id: newConv.id,
      title: newConv.title,
      mode,
      cwd: cwd || '(none)',
    });
    setConversations((prev) => [newConv, ...prev]);
    setLoadedMessageIds((prev) => new Set([...prev, newConv.id]));
    setActiveConversationId(newConv.id);
    saveSession(newConv.id, { title: newConv.title, cwd }).catch(() => { /* 静默 */ });
    return newConv;
  }, []);

  // ===== 切换对话 =====
  const switchConversation = useCallback((id: string) => {
    const target = conversationsRef.current.find(c => c.id === id);
    flog.info('STREAMING', `切换对话`, {
      fromId: activeConversationIdRef.current,
      toId: id,
      toTitle: target?.title || '(unknown)',
      isProcessing,
    });
    if (isProcessing) {
      // 切换前清理当前会话中未完成的工具调用（中断所有 pending/approved 工具）
      const fromConvId = activeConversationIdRef.current;
      if (fromConvId) {
        setConversations((prev) =>
          prev.map((conv) => {
            if (conv.id !== fromConvId) return conv;
            const msgs = conv.messages.map((msg) => {
              if (msg.role !== "assistant" || !msg.toolCalls?.length) return msg;
              const hasActiveTool = msg.toolCalls.some(
                (tc) => tc.status === "pending" || tc.status === "approved"
              );
              if (!hasActiveTool) return msg;
              const toolCalls = msg.toolCalls.map((tc) =>
                tc.status === "pending" || tc.status === "approved"
                  ? { ...tc, status: "error" as const, error: "用户切换会话，工具执行已中断" }
                  : tc
              );
              return { ...msg, toolCalls };
            });
            return { ...conv, messages: msgs, updatedAt: Date.now() };
          })
        );
      }

      abortRef.current?.abort();
      sseClientRef.current?.abort();
      sseClientRef.current = null;
      abortRef.current = null;
      setIsProcessing(false);
    }
    setPendingToolRequests([]);
    setActiveConversationId(id);
    if (!loadedMessageIds.has(id)) {
      loadConversationMessages(id);
    }
  }, [isProcessing, loadedMessageIds, loadConversationMessages]);

  // ===== 删除对话（物理删除） =====
  const deleteConversation = useCallback(
    (id: string) => {
      const target = conversationsRef.current.find(c => c.id === id);
      flog.info('STREAMING', `删除对话`, {
        id,
        title: target?.title || '(unknown)',
        cwd: target?.cwd || '(none)',
        messageCount: target?.messages?.length || 0,
      });
      setConversations((prev) => prev.filter((c) => c.id !== id));
      setLoadedMessageIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      if (id === activeConversationId) {
        const remaining = conversations.filter((c) => c.id !== id);
        setActiveConversationId(remaining.length > 0 ? remaining[remaining.length - 1].id : "");
      }
      deleteSession(id).catch((err) => {
        flog.warn('STREAMING', `后端删除失败`, { id, error: err instanceof Error ? err.message : String(err) });
      });
    },
    [activeConversationId, conversations]
  );

  // ===== 确认或拒绝工具执行 =====
  const handleToolConfirm = useCallback(
    async (toolCallId: string, approved: boolean, reason?: string) => {
      // read-only 模式下禁止批准任何工具执行
      if (approved && permissionMode === "read-only") {
        flog.warn('STREAMING', 'read-only 模式下拒绝了工具执行', { toolCallId });
        setPendingToolRequests((prev) => prev.filter((t) => t.toolCallId !== toolCallId));
        return;
      }

      const sessionId = activeConversationIdRef.current;
      flog.info('STREAMING', `工具执行确认: ${approved ? '批准' : '拒绝'}`, {
        toolCallId,
        approved,
        reason: reason || '(无)',
        sessionId,
      });
      if (!sessionId) return;

      // 幂等检查：避免同一 toolCallId 被确认/拒绝多次
      const existingConv = conversationsRef.current.find(c => c.id === sessionId);
      if (existingConv) {
        const msgs = existingConv.messages;
        const lastAssistantMsg = [...msgs].reverse().find(m => m.role === 'assistant');
        if (lastAssistantMsg) {
          const existingTc = (lastAssistantMsg as any).toolCalls?.find(
            (tc: any) => tc.toolCallId === toolCallId
          );
          if (existingTc && existingTc.status !== 'pending') {
            flog.warn('STREAMING', `工具 ${toolCallId} 已被确认/拒绝，跳过重复操作`, { status: existingTc.status });
            setPendingToolRequests((prev) => prev.filter((t) => t.toolCallId !== toolCallId));
            return;
          }
        }
      }

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
        flog.error('STREAMING', `工具确认失败`, { toolCallId, error: result.error });
      }

      setPendingToolRequests((prev) => prev.filter((t) => t.toolCallId !== toolCallId));
    },
    [permissionMode]
  );

  // ===== Auto 确认：队列变化时自动批准 =====
  useEffect(() => {
    if (!autoConfirm || pendingToolRequests.length === 0) return;
    const req = pendingToolRequests[0];

    // 二次验证：确认该 toolCallId 在当前会话中仍是 pending 状态
    // 防止 100ms 窗口内用户手动拒绝后 auto-confirm 仍批准
    const currentConv = conversationsRef.current.find(
      c => c.id === activeConversationIdRef.current
    );
    if (currentConv) {
      const msgs = currentConv.messages;
      const lastAssistantMsg = [...msgs].reverse().find(m => m.role === 'assistant');
      if (lastAssistantMsg) {
        const targetTc = (lastAssistantMsg as any).toolCalls?.find(
          (tc: any) => tc.toolCallId === req.toolCallId
        );
        if (targetTc && targetTc.status !== 'pending') {
          flog.debug('STREAMING', `auto-confirm 跳过：工具 ${req.toolCallId} 状态已变更为 ${targetTc.status}`);
          return;
        }
      }
    }

    // 延迟一小段时间再确认，让 UI 有时间反应
    const timer = setTimeout(() => {
      handleToolConfirm(req.toolCallId, true);
    }, 100);
    return () => clearTimeout(timer);
  }, [pendingToolRequests, autoConfirm, handleToolConfirm]);

  // ===== 从后端加载历史会话列表（仅合并元数据，不拉取消息） =====
  const loadSessionsFromBackend = useCallback(async () => {
    flog.info('STREAMING', '从后端加载历史会话列表');
    const result = await fetchSessions();
    if (result.error || !result.data) {
      flog.warn('STREAMING', '从后端加载会话失败', { error: result.error });
      return;
    }

    // 根据 cwd 推断 mode：有 cwd 则为 code 模式
    const backendConversations = result.data.map((session) => {
      const inferredMode: ChatMode = session.cwd ? 'code' : ((session.mode as ChatMode) || 'chat');
      return {
        id: session.id,
        title: session.title,
        messages: [] as Message[],
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        mode: inferredMode,
        cwd: session.cwd,
      };
    });

      setConversations((prev) => {
        const merged = new Map<string, Conversation>();
        for (const c of prev) merged.set(c.id, c);
        for (const c of backendConversations) {
          const backendConv = c as Conversation;
          if (!merged.has(c.id)) {
            merged.set(c.id, backendConv);
            continue;
          }
          const localConv = merged.get(c.id)!;
          // 构建合并字段，优先保留本地非默认值，同时从后端补齐缺失数据
          const mergedFields: Partial<Conversation> = {};
          const isLocalDefault = !localConv.title || /^(新对话|新开发会话|会话\s+\w+|未命名对话)$/.test(localConv.title);
          const isBackendDefault = !backendConv.title || /^(新对话|新开发会话|会话\s+\w+|未命名对话)$/.test(backendConv.title);
          if (isLocalDefault && !isBackendDefault) {
            mergedFields.title = backendConv.title;
          }
          // 本地缺少 cwd 时从后端补齐（确保项目对话快照功能可用）
          if (backendConv.cwd && !localConv.cwd) {
            mergedFields.cwd = backendConv.cwd;
            mergedFields.mode = backendConv.mode;
          }
          if (Object.keys(mergedFields).length > 0) {
            merged.set(c.id, { ...localConv, ...mergedFields });
          }
        }
        const arr = Array.from(merged.values());
        arr.sort((a, b) => b.updatedAt - a.updatedAt);
        flog.info('STREAMING', `后端会话合并完成`, {
          backendCount: backendConversations.length,
          mergedCount: arr.length,
        });
        return arr;
      });
  }, []);

  // ===== 回滚到指定消息的快照 =====
  const rollbackToSnapshot = useCallback(
    async (snapshotId: string, messageId: string, convId: string, cwd?: string) => {
      if (isProcessing) {
        console.warn("[rollbackToSnapshot] 正在处理中，无法回滚");
        return { success: false, error: "正在处理中，无法回滚" };
      }

      // 1. 恢复文件快照（有 snapshotId 和 cwd 时才恢复）
      if (cwd && snapshotId) {
        const res = await restoreCheckpoint(snapshotId, cwd);
        if (res.error) {
          return { success: false, error: res.error };
        }
        if (!res.data?.success) {
          return { success: false, error: res.data?.errors?.join(", ") || "回滚失败" };
        }
      }

      // 2. 截断对话：删除该消息之后的所有消息，并捕获截断后的消息用于持久化
      let truncatedMessages: Message[] | undefined;
      setConversations((prev) =>
        prev.map((conv) => {
          if (conv.id !== convId) return conv;
          const msgIndex = conv.messages.findIndex((m) => m.id === messageId);
          if (msgIndex < 0) return conv;
          truncatedMessages = conv.messages.slice(0, msgIndex + 1);
          return {
            ...conv,
            messages: truncatedMessages,
            updatedAt: Date.now(),
          };
        })
      );

      // 2.1 持久化截断后的对话（写入 .json，确保重启后 GET 直接返回截断消息，不再从 .jsonl 完整读取）
      if (truncatedMessages) {
        saveSession(convId, { messages: truncatedMessages }).catch((err) => {
          flog.warn('STREAMING', '回滚后持久化失败', { convId, error: String(err) });
        });
      }

      // 3. 通知后端重置会话（清理 Agent 上下文）
      if (backendConnected) {
        try {
          await fetch(`${agentGatewayUrl}/api/reset`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId: convId }),
          });
        } catch (err) {
          console.warn("[rollbackToSnapshot] 后端重置失败:", err);
        }
      }

      // 4. 通知 CheckpointPanel 刷新快照列表（回滚可能创建了备份快照）
      if (cwd) {
        window.dispatchEvent(new CustomEvent('checkpoint-created', { detail: { cwd } }));
      }

      return { success: true, error: undefined };
    },
    [isProcessing, backendConnected, agentGatewayUrl]
  );

  // ===== 重命名对话 =====
  const renameConversation = useCallback((id: string, title: string) => {
    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, title, updatedAt: Date.now() } : c))
    );
    saveSession(id, { title }).catch(() => {});
  }, []);

  // ===== 清空所有项目对话（有 cwd 的对话） =====
  const clearAllProjectConversations = useCallback(() => {
    const projectConversations = conversationsRef.current.filter(c => c.cwd);
    if (projectConversations.length === 0) return;

    const ids = projectConversations.map(c => c.id);
    setConversations((prev) => prev.filter((c) => !c.cwd));
    setLoadedMessageIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
    if (ids.includes(activeConversationId)) {
      const remaining = conversationsRef.current.filter((c) => !ids.includes(c.id));
      setActiveConversationId(remaining.length > 0 ? remaining[remaining.length - 1].id : "");
    }
    // 异步批量删除后端记录
    for (const id of ids) {
      deleteSession(id).catch((err) => {
        flog.warn('STREAMING', `后端删除项目对话失败`, { id, error: err instanceof Error ? err.message : String(err) });
      });
    }
    flog.info('STREAMING', `清空项目对话`, { count: ids.length, ids });
  }, [activeConversationId]);

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
    renameConversation,
    clearAllProjectConversations,
    /** 按对话累积使用统计（token + 费用） */
    conversationUsageMap,
  };
}