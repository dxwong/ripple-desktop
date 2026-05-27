import { useState, useRef, useCallback, useEffect } from "react";
import { Message, Conversation, ChatMode, ModelConfig, ToolRequestData, PermissionMode, ToolCallResult, ConversationUsage } from "../types";
import { SSEClient } from "../services/sse";
import { checkHealth, fetchSessions, fetchSession, confirmToolCall, deleteSession, saveSession, createCheckpoint, restoreCheckpoint, copySession } from "../services/api";
import { useStore, syncStore } from "./useStore";
import { flog } from "../services/frontendLogger";
import { healthSSEClient } from "../services/healthSSEClient";
import { emitShellCommandStart, emitShellCommandOutput, emitShellCommandEnd } from "../services/shellEventBus";

const genId = () => `chat-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 5)}`;
const MESSAGES_PAGE_SIZE = 5;

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

export function useStreamingChat(
  permissionMode: PermissionMode = "confirm",
  agentGatewayUrl: string = "http://localhost:3002",
  onStreamEvent?: (eventType: string, sessionId: string, data?: Record<string, unknown>) => void,
  onLog?: (message: string) => void,  // 可选：回调日志到调用方（用于磁盘日志）
  onConversationsChanged?: () => void, // 可选：对话列表变更时通知对方刷新
) {
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
  // 分页状态：追踪每个会话是否还有更早消息可加载
  const [hasMoreMessages, setHasMoreMessages] = useState<Record<string, boolean>>({});
  /** 按对话累积的使用统计（token 和费用），key = conversationId */
  const [conversationUsageMap, setConversationUsageMap] = useState<Record<string, ConversationUsage>>({});
  const abortRef = useRef<AbortController | null>(null);
  const sseClientRef = useRef<SSEClient | null>(null);
  // 同步 processing 锁：防止 React 异步状态更新导致的竞态条件
  // isProcessing 是 state，setIsProcessing 后需要 re-render 才生效
  // isProcessingRef 是同步的，赋值后立即生效，用于并发防护
  const isProcessingRef = useRef(false);
  // 正在创建中的对话 ID 集合（防止事件竞态导致 ensureConversation 重复创建）
  const ensuringIdsRef = useRef<Set<string>>(new Set());
  const { loadItem } = useStore();
  const loadedInitRef = useRef(false); // 确保本地存储加载只执行一次

  // 用 ref 跟踪 activeConversationId + conversations，避免闭包捕获过期值
  const activeConversationIdRef = useRef(activeConversationId);
  activeConversationIdRef.current = activeConversationId;
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;

  // 监听全局权限模式变化，自动同步 autoConfirm 状态
  useEffect(() => {
    setAutoConfirm(permissionMode === "auto");
  }, [permissionMode]);

  // ===== 初始化：优先从后端加载会话列表（仅首次执行） =====
  useEffect(() => {
    if (loadedInitRef.current) return;
    loadedInitRef.current = true;
    (async () => {
      // 先尝试从后端加载（仅列表元数据，不含消息体，避免启动卡顿）
      const result = await fetchSessions();
      if (result.data && Array.isArray(result.data) && result.data.length > 0) {
        const backendSessions: Conversation[] = result.data.map((session: any) => ({
          id: session.id,
          title: session.title || '未命名对话',
          messages: [] as Message[],
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          mode: (session.cwd ? 'code' : 'chat') as ChatMode,
          cwd: session.cwd || '',
        }));
        backendSessions.sort((a, b) => b.updatedAt - a.updatedAt);
        setConversations(backendSessions);
        // 恢复上次活跃的会话（页面重载后自动定位到之前正在查看的对话）
        const savedId = syncStore.getItem<string>("active-conversation-id", "");
        if (savedId && backendSessions.some(c => c.id === savedId)) {
          setActiveConversationId(savedId);
          // 自动加载该会话的消息
          loadConversationMessages(savedId);
        }
        // loadedMessageIds 保持为空，点击会话时才懒加载消息
        flog.info('STREAMING', `初始化：从后端加载会话列表成功`, { count: backendSessions.length });
        return;
      }

      // 后端不可用，降级到本地存储（仅用于恢复已有会话）
      flog.warn('STREAMING', '后端不可用，降级到本地存储加载会话');
      const saved = await loadItem<Conversation[]>("conversations", []);
      if (saved && saved.length > 0) {
        saved.sort((a, b) => b.updatedAt - a.updatedAt);
        setConversations(saved);
        // 恢复上次活跃的会话
        const savedId = syncStore.getItem<string>("active-conversation-id", "");
        if (savedId && saved.some(c => c.id === savedId)) {
          setActiveConversationId(savedId);
          // 自动加载该会话的消息
          loadConversationMessages(savedId);
        }
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
    })();
  }, []);

  // ===== 会话不缓存到 localStorage（以 Agent 服务器为唯一事实来源） =====

  // ===== 持久化当前对话 ID，页面重载后自动恢复 =====
  useEffect(() => {
    if (activeConversationId) {
      syncStore.setItem("active-conversation-id", activeConversationId);
    }
  }, [activeConversationId]);

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

  // ===== 懒加载单个会话的消息详情（分页：仅加载最后 15 条） =====
  const loadConversationMessages = useCallback(async (convId: string) => {
    if (loadedMessageIds.has(convId) || loadingMessagesFor === convId) {
      flog.debug('STREAMING', `跳过已加载/正在加载的会话`, { convId });
      return;
    }
    setLoadingMessagesFor(convId);
    
    flog.info('STREAMING', `开始加载会话消息`, { convId });
    
    try {
      const result = await fetchSession(convId, { limit: MESSAGES_PAGE_SIZE });
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
        hasMore: sessionData.hasMore,
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
      setHasMoreMessages((prev) => ({ ...prev, [convId]: !!sessionData.hasMore }));
      flog.info('STREAMING', `会话消息加载完成`, {
        convId,
        messageCount: (sessionData.messages || []).length,
        hasMore: sessionData.hasMore,
        cwd: sessionData.cwd || '(none)',
      });
    } finally {
      setLoadingMessagesFor((v) => (v === convId ? null : v));
    }
  }, [loadedMessageIds, loadingMessagesFor]);

  // ===== 加载更早的消息（分页：追加到消息列表前面） =====
  const loadMoreMessages = useCallback(async (convId: string) => {
    if (loadingMessagesFor === convId) return;
    const conv = conversationsRef.current.find(c => c.id === convId);
    if (!conv || conv.messages.length === 0) return;

    // 取当前最早的消息 ID 作为 before 参数
    const oldestMsg = conv.messages[0];
    if (!oldestMsg.id) return;

    setLoadingMessagesFor(convId);
    flog.info('STREAMING', `加载更早消息`, { convId, before: oldestMsg.id });

    try {
      const result = await fetchSession(convId, { limit: MESSAGES_PAGE_SIZE, before: oldestMsg.id });
      if (result.error || !result.data) {
        flog.warn('STREAMING', `加载更早消息失败`, { convId, error: result.error });
        return;
      }

      const olderMessages = (result.data.messages || []) as Message[];
      if (olderMessages.length === 0) {
        setHasMoreMessages((prev) => ({ ...prev, [convId]: false }));
        return;
      }

      setConversations((prev) =>
        prev.map((c) => {
          if (c.id !== convId) return c;
          return {
            ...c,
            messages: [...olderMessages, ...c.messages],
            updatedAt: Date.now(),
          };
        })
      );
      setHasMoreMessages((prev) => ({ ...prev, [convId]: !!result?.data?.hasMore }));
      flog.info('STREAMING', `更早消息加载完成`, {
        convId,
        loadedCount: olderMessages.length,
        hasMore: result?.data?.hasMore,
      });
    } finally {
      setLoadingMessagesFor((v) => (v === convId ? null : v));
    }
  }, [loadingMessagesFor]);

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
    if (!convId || !chunk) {
      flog.warn('STREAMING', 'appendToConversation 被调用但参数无效', { convId, chunk: chunk?.slice(0, 20) });
      return;
    }
    flog.debug('STREAMING', `appendToConversation 调用`, { convId, chunkLength: chunk.length, chunkPreview: chunk.slice(0, 30) });
    
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
      
      // 验证更新是否成功
      const updatedConv = next.find(c => c.id === convId);
      if (updatedConv) {
        flog.debug('STREAMING', `appendToConversation 成功`, { 
          convId, 
          totalMessages: updatedConv.messages.length,
          lastMessageContent: updatedConv.messages[updatedConv.messages.length - 1]?.content.slice(0, 50)
        });
      } else {
        flog.warn('STREAMING', `appendToConversation 失败：会话不存在`, { convId, totalConvs: next.length });
      }
      
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
    (role: "user" | "assistant", content: string, extraFields?: { snapshotId?: string }, targetConvId?: string) => {
      // 使用传入的目标会话ID，或回退到当前活跃会话
      const convId = targetConvId || activeConversationIdRef.current;
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
        source: targetConvId ? 'mobile' : 'desktop',
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
      // 同步标题到后端 .json 元数据文件
      if (newTitle !== undefined) {
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
      regenerate?: boolean,
      targetConvId?: string  // 新增：可选的目标会话ID，用于手机端消息路由
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
        targetConvId: targetConvId || '(none)',
      });
      onLog?.(`sendMessage: content="${content.slice(0, 30)}" useBackend=${useBackend} backendConnected=${backendConnected} hasConfig=${!!modelConfig} configId=${modelConfig?.id || '(none)'} cwd=${cwd || '(none)'} targetConvId=${targetConvId || '(none)'}`);

      // 同步锁：防止 isProcessing 异步状态更新导致的竞态条件
      // isProcessingRef 赋值后立即生效，比 state 更可靠
      if (isProcessingRef.current || isProcessing) {
        flog.warn('STREAMING', '发送跳过：正在处理中');
        return;
      }
      isProcessingRef.current = true;
      setIsProcessing(true);

      const abort = new AbortController();
      abortRef.current = abort;

      // 使用传入的目标会话ID，或回退到当前活跃会话
      const convId = targetConvId || activeConversationIdRef.current;
      if (!convId) {
        flog.error('STREAMING', '发送失败：没有活跃对话');
        setIsProcessing(false);
        return;
      }
      flog.info('STREAMING', `使用会话ID`, { convId, source: targetConvId ? 'mobile' : 'desktop' });

      const effectiveCwd = cwd || conversationsRef.current.find((c) => c.id === convId)?.cwd;
      const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 8)}`;
      flog.info('STREAMING', `发送消息确认`, { convId, effectiveCwd: effectiveCwd || '(none)', requestId });

      // 重新生成时：移除最后一个完整轮次（AI 回复 + 触发它的用户消息）
      // 用户消息将由 handleRegenerate 重新提交，确保不在上下文中重复出现
      if (regenerate) {
        setConversations(prev => prev.map(conv => {
          if (conv.id !== convId) return conv;
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
      // 先把消息加上，让用户立刻看到（snapshotId 后面再补）
      addMessage("user", content, undefined, convId);
      // 空的 assistant 消息不再预先创建，由 appendToConversation 在收到内容时自动创建
      // 这样可以避免发送时同时显示空气泡和 TypingIndicator 的双气泡问题

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
            // 补上 snapshotId（更新用户消息）
            setConversations((prev) =>
              prev.map((conv) => {
                if (conv.id !== convId) return conv;
                const msgs = [...conv.messages];
                // 从后往前找最后一条用户消息补 snapshotId
                for (let i = msgs.length - 1; i >= 0; i--) {
                  if (msgs[i].role === 'user') {
                    msgs[i] = { ...msgs[i], snapshotId };
                    break;
                  }
                }
                return { ...conv, messages: msgs };
              })
            );
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

      try {
        if (useBackend) {
          flog.info('STREAMING', '使用后端模式发送');
          const sseClient = new SSEClient({ baseUrl: agentGatewayUrl });
          sseClientRef.current = sseClient;

          // 预先添加一个空的 assistant 消息，以便后续能在上面显示错误或内容
          // （前面已添加，不再重复）

          await new Promise<void>((resolve, reject) => {
            let hasContent = false;
            let resolved = false;  // 防止多次 resolve
            const safeResolve = () => { if (!resolved) { resolved = true; resolve(); } };

            // 超时保护：防止 SSEClient 内部 AbortError 静默处理导致 Promise 永远不 resolve
            const promiseTimeout = setTimeout(() => {
              if (!resolved) {
                resolved = true;
                flog.warn('STREAMING', `发送消息超时（60秒），强制恢复`, { convId });
                onLog?.(`sendMessage TIMEOUT: convId=${convId} — Promise 60秒未resolve，强制恢复`);
                // 如果 SSE 还在连接中，尝试停止
                sseClientRef.current?.abort();
                resolve();
              }
            }, 60_000);

            const currentConv = conversationsRef.current.find((c) => c.id === convId);
            
            const backendParams = {
              message: content,
              sessionId: convId,
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
              apiKeyLength: backendParams.apiKey?.length || 0,
              messagePreview: content.slice(0, 50),
            });
            onLog?.(`backendParams: sessionId=${backendParams.sessionId} model=${backendParams.model || '(none)'} endpoint=${backendParams.endpoint || '(none)'} apiKeyLen=${backendParams.apiKey?.length || 0} cwd=${backendParams.cwd || '(none)'}`);
            
            sseClient.connect(
              backendParams,
              {
                onText: (text) => {
                  hasContent = true;
                  appendToConversation(convId, text);
                  onStreamEvent?.("text", convId, { text });
                },
                onThinking: (text) => {
                  appendThinkingToConversation(convId, text);
                  onStreamEvent?.("thinking", convId, { text });
                },
                onToolStart: (toolCallId, toolName) => {
                  flog.debug('STREAMING', `工具开始执行`, { toolCallId, toolName });
                  onStreamEvent?.("tool-start", convId, { toolCallId, toolName });
                  if (activeConversationIdRef.current !== convId) return;
                  // 将工具调用状态推进到执行中（后续 onToolEnd 变为 success/error）
                  setConversations((prev) => {
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
                  onStreamEvent?.("tool-end", convId, { toolCallId, toolName, result: result.output || "", error: result.error });
                  // shell 命令结束 → 发射到终端事件总线（在所有会话中都捕获）
                  if (toolName === "shell") {
                    emitShellCommandEnd({
                      toolCallId,
                      stdout: result.output || "",
                      stderr: result.error || "",
                      error: result.error,
                    });
                  }
                  if (activeConversationIdRef.current !== convId) return;
                  setConversations((prev) => {
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
                  // 文件修改工具执行完成后，通知 FileTree 刷新，并广播到手机端
                  if (effectiveCwd && ['write_file', 'create_dir', 'remove', 'shell'].includes(toolName)) {
                    window.dispatchEvent(new CustomEvent('file-tree-refresh', { detail: { cwd: effectiveCwd } }));
                    onStreamEvent?.("file-tree-changed", effectiveCwd, { cwd: effectiveCwd });
                  }
                },
                onToolRequest: (data) => {
                  flog.info('STREAMING', `工具执行请求`, { toolCallId: data.toolCallId, toolName: data.toolName });
                  onStreamEvent?.("tool-request", convId, {
                    toolCallId: data.toolCallId,
                    toolName: data.toolName,
                    args: data.args,
                  });
                  // shell 命令 → 发射到终端事件总线
                  if (data.toolName === "shell") {
                    emitShellCommandStart({
                      toolCallId: data.toolCallId,
                      command: (data.args.command as string) || "",
                      cwd: effectiveCwd,
                      timestamp: Date.now(),
                    });
                  }
                  setPendingToolRequests((prev) => [...prev, data]);
                  const pendingToolCall: ToolCallResult = {
                    toolCallId: data.toolCallId,
                    toolName: data.toolName,
                    args: data.args,
                    status: "pending",
                  };
                  setConversations((prev) =>
                    prev.map((conv): Conversation => {
                      if (conv.id !== convId) return conv;
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
                  onStreamEvent?.("agent-start", convId);
                },
                onTurnStart: () => {
                  flog.debug('STREAMING', '新轮次开始');
                  onStreamEvent?.("turn-start", convId);
                },
                onTurnEnd: (data) => {
                  flog.debug('STREAMING', `轮次结束`, {
                    hasToolResults: data.hasToolResults,
                    hasError: data.hasError,
                    errorMessage: data.errorMessage
                  });
                  onStreamEvent?.("turn-end", convId, {
                    hasToolResults: data.hasToolResults,
                    hasError: data.hasError,
                    errorMessage: data.errorMessage,
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
                    appendToConversation(convId, errorMsg);
                  }
                },
                onMessageStart: (role) => {
                  flog.debug('STREAMING', `消息开始`, { role });
                  onStreamEvent?.("message-start", convId, { role });
                },
                onMessageEnd: (role) => {
                  flog.debug('STREAMING', `消息结束`, { role });
                  onStreamEvent?.("message-end", convId, { role });
                },
                onToolUpdate: (toolCallId, toolName, output) => {
                  flog.debug('STREAMING', `工具部分结果更新`, { toolCallId, toolName, hasOutput: !!output });
                  onStreamEvent?.("tool-update", convId, { toolCallId, toolName, output });
                  // shell 命令增量输出 → 终端事件总线
                  if (toolName === "shell" && output) {
                    emitShellCommandOutput({ toolCallId, output });
                  }
                },
                onUsage: (usage) => {
                  flog.debug('STREAMING', `收到 usage 事件`, {
                    convId,
                    usage,
                  });
                  onStreamEvent?.("usage", convId, usage);
                  // 按对话累积 token、费用和缓存
                  setConversationUsageMap((prev) => {
                    const existing = prev[convId] || { input: 0, output: 0, totalTokens: 0, cost: 0, cacheRead: 0, cacheWrite: 0 };
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
                      [convId]: newUsage,
                    };
                  });
                },
                onDone: () => {
                  clearTimeout(promiseTimeout);
                  flog.info('STREAMING', 'SSE 流正常结束');
                  onStreamEvent?.("done", convId);
                  safeResolve();
                },
                onError: (error, errorDetails) => {
                  clearTimeout(promiseTimeout);
                  console.error(`[StreamError] error="${error}" convId=${convId}`, errorDetails);
                  flog.error('STREAMING', `SSE 流错误`, { error, errorDetails });
                  onStreamEvent?.("error", convId, { error, details: errorDetails });
                  onLog?.(`onError: error="${error}" convId=${convId} hasDetails=${!!errorDetails}`);
                  
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
                  appendToConversation(convId, errorMsg);
                  safeResolve();
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
          appendToConversation(convId, chunk);
        }
        if (!abort.signal.aborted && !assistantContent) {
          appendToConversation(convId, "（模拟回复为空）");
        }
      } catch (err: any) {
        console.error(`[StreamError] 外层异常: "${err.message}"`);
        flog.error('STREAMING', `发送消息异常`, { error: err.message });
      } finally {
        isProcessingRef.current = false;
        setIsProcessing(false);
        abortRef.current = null;
        sseClientRef.current = null;
      }
    },
    [isProcessing, appendToConversation, appendThinkingToConversation, addMessage, agentGatewayUrl, onStreamEvent, onLog]
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
    isProcessingRef.current = false;
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
    onConversationsChanged?.();
    return newConv;
  }, [onConversationsChanged]);

  // ===== 使用外部 ID 确保对话存在（手机端同步用） =====
  const ensureConversation = useCallback((
    id: string,
    title?: string,
    cwd?: string,
  ) => {
    // 防重复创建：同一 ID 在短时间内被重复调用时，跳过
    // 解决手机端新建项目对话后立即发消息导致的时序竞态
    if (ensuringIdsRef.current.has(id)) {
      flog.warn('STREAMING', `跳过重复 ensureConversation: id=${id}（正在创建中）`);
      const existing = conversationsRef.current.find(c => c.id === id);
      if (existing) {
        setActiveConversationId(id);
        return existing;
      }
      return undefined;
    }

    const existing = conversationsRef.current.find(c => c.id === id);
    if (existing) {
      flog.info('STREAMING', `切换到已有外部对话`, { id, title: existing.title });
      setActiveConversationId(id);
      return existing;
    }
    // 标记正在创建，防止并发事件重复创建
    ensuringIdsRef.current.add(id);
    // 2 秒后自动清除标记（确保 React 重渲染完成）
    setTimeout(() => {
      ensuringIdsRef.current.delete(id);
    }, 2000);
    const newConv: Conversation = {
      id,
      title: title || "手机端对话",
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      mode: "chat",
      cwd,
    };
    flog.info('STREAMING', `创建外部对话`, {
      id: newConv.id,
      title: newConv.title,
      cwd: cwd || '(none)',
    });
    setConversations((prev) => [newConv, ...prev]);
    setLoadedMessageIds((prev) => new Set([...prev, id]));
    setActiveConversationId(id);
    saveSession(id, { title: newConv.title, cwd }).catch(() => {});
    onConversationsChanged?.();
    return newConv;
  }, [onConversationsChanged]);

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

      // 不中断 SSE（推通道）：appendToConversation 按 convId 更新指定会话，写通道继续运行
    }
    // 切换对话后恢复输入框状态（原会话的 SSE 仍在后台运行）
    setIsProcessing(false);
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
      onConversationsChanged?.();
    },
    [activeConversationId, conversations, onConversationsChanged]
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
    onConversationsChanged?.();
  }, [onConversationsChanged]);

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
  const renameConversation = useCallback(async (id: string, title: string) => {
    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, title, updatedAt: Date.now() } : c))
    );
    // 先等 saveSession 完成再广播，确保手机端拉取时后端已更新
    await saveSession(id, { title }).catch(() => {});
    // 注意：不广播 onConversationsChanged，因为 session-renamed 已足够通知手机端更新标题
    // 避免手机端 loadSessionList() 全量重拉导致该对话排序跑到最前面
    onStreamEvent?.("session-renamed", id, { title });
  }, [onStreamEvent]);

  // ===== 拷贝对话（完整物理复制） =====
  const copyConversation = useCallback(async (id: string, customTitle?: string) => {
    const source = conversationsRef.current.find(c => c.id === id);
    if (!source) {
      flog.warn('STREAMING', '拷贝对话失败：源对话不存在', { id });
      return;
    }

    flog.info('STREAMING', `拷贝对话`, {
      id,
      title: source.title,
      cwd: source.cwd || '(none)',
      messageCount: source.messages.length,
    });

    const result = await copySession(id, customTitle);
    if (result.error || !result.data) {
      flog.error('STREAMING', '拷贝对话失败', { id, error: result.error });
      return;
    }

    // 构造新 Conversation，以服务端响应为准（避免前端 cwd/mode 分类偏差）
    const newConv: Conversation = {
      id: result.data.id,
      title: result.data.title,
      messages: source.messages,
      createdAt: result.data.createdAt,
      updatedAt: result.data.updatedAt,
      // 服务端返回的 cwd 已做空值过滤，mode 由服务端推断
      mode: (result.data.cwd ? 'code' : (result.data.mode || 'chat')) as ChatMode,
      cwd: result.data.cwd || undefined,
    };

    setConversations((prev) => [newConv, ...prev]);
    setLoadedMessageIds((prev) => new Set([...prev, newConv.id]));

    flog.info('STREAMING', `对话拷贝成功`, {
      sourceId: id,
      newId: newConv.id,
      title: newConv.title,
      mode: newConv.mode,
      cwd: newConv.cwd || '(none)',
    });
    onConversationsChanged?.();
  }, [onConversationsChanged]);

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
    onConversationsChanged?.();
  }, [activeConversationId, onConversationsChanged]);

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
    ensureConversation,
    switchConversation,
    deleteConversation,
    checkBackendConnection,
    handleToolConfirm,
    loadSessionsFromBackend,
    loadConversationMessages,
    loadMoreMessages,
    hasMoreMessages,
    loadedMessageIds,
    loadingMessagesFor,
    rollbackToSnapshot,
    renameConversation,
    copyConversation,
    clearAllProjectConversations,
    /** 按对话累积使用统计（token + 费用） */
    conversationUsageMap,
  };
}