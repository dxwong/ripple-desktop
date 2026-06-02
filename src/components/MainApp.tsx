import { useState, useCallback, useEffect, useRef } from "react";
import Sidebar from "./Sidebar";
import ChatView from "./ChatView";
import FileTree from "./FileTree";
import FilePreview from "./FilePreview";
import CheckpointPanel from "./CheckpointPanel";
import SettingsPanel from "./SettingsPanel";
import LogPanel from "./LogPanel";
import { StartupLoading } from "./StartupLoading";
import { ErrorModal } from "./ErrorModal";
import { ExpertsPage } from "./ExpertsPage";
import { MemoryPage } from "./MemoryPage";
import { useStreamingChat } from "../hooks/useStreamingChat";
import { useSettings } from "../hooks/useSettings";
import { useFolderPicker } from "../hooks/useFolderPicker";
import { syncStore } from "../hooks/useStore";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { ChatMode } from "../types";
import { fetchModels, setBaseUrl } from "../services/api";
import { logger } from "./LogPanel";
import { isTauri } from "../hooks/useTauri";
import { healthSSEClient } from "../services/healthSSEClient";
import { setLogApiUrl } from "../services/frontendLogger";
import {
  startBridge,
  stopBridge,
  broadcastToMobile,
  setupMobileChatListener,
  teardownMobileChatListener,
  type MobileChatRequest,
  type MobileBridgeEventType,
} from "../services/mobileBridge";

// 调试日志：写入磁盘文件 + 控制台，用于排查 Bridge 链路问题
const debugLog = async (msg: string) => {
  console.log(`[DEBUG] ${msg}`);
  try {
    if (isTauri()) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("write_debug_log", { message: `[MainApp] ${msg}` });
    }
  } catch { /* 调试日志失败不影响主流程 */ }
};

export function MainApp() {
  // 启动状态管理
  const [startupState, setStartupState] = useState<"loading" | "error" | "ready">("loading");
  const [startupMessage, setStartupMessage] = useState("正在加载配置，请稍后...");
  const [errorMessage, setErrorMessage] = useState("");
  
  const [showSettings, setShowSettings] = useState(false);
  const [backendModels, setBackendModels] = useState<{ id: string; name: string }[]>([]);
  // 手机端连接状态
  const [mobileConnected, setMobileConnected] = useState(false);
  // 文件树状态 - 默认折叠，从持久化存储读取上次状态
  const [fileTreeExpanded, setFileTreeExpanded] = useState(() => 
    syncStore.getItem("file-tree-expanded", false)
  );
  
  // 监听文件树展开状态变化，持久化保存
  useEffect(() => {
    syncStore.setItem("file-tree-expanded", fileTreeExpanded);
  }, [fileTreeExpanded]);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  // 快照面板状态（与文件预览互斥）
  const [showCheckpointPanel, setShowCheckpointPanel] = useState(false);
  const {
    settings,
    updateSettings,
    resetSettings,
    activeConfig,
    saveModelConfig,
    deleteModelConfig,
    setActiveModel,
  } = useSettings();
  const chat = useStreamingChat(
    settings.permissionMode,
    settings.agentGatewayUrl,
    (eventType: string, sessionId: string, data?: Record<string, unknown>) => {
      broadcastToMobile(eventType as MobileBridgeEventType, sessionId, data);
    },
    (message: string) => {
      debugLog(`[StreamChat] ${message}`);
    },
    // 对话列表变更时通知手机端刷新
    () => {
      const convId = chat.activeConversationId;
      broadcastToMobile("conversations-changed", convId || "", { refresh: true });
      debugLog(`广播对话列表变更通知: convId=${convId}`);
    },
    settings,  // v1.1: 传递风险配置到 SSE 请求
  );

  // 当 gateway URL 变化时，更新所有服务
  useEffect(() => {
    setBaseUrl(settings.agentGatewayUrl);
    healthSSEClient.setBaseUrl(settings.agentGatewayUrl);
    setLogApiUrl(settings.agentGatewayUrl);
  }, [settings.agentGatewayUrl]);
  const { pickFolder } = useFolderPicker();

  // 用 ref 持有 chat 中的稳定方法，避免 [chat] 对象引用变化导致 effect 反复执行
  const checkBackendConnectionRef = useRef(chat.checkBackendConnection);
  checkBackendConnectionRef.current = chat.checkBackendConnection;
  const loadSessionsFromBackendRef = useRef(chat.loadSessionsFromBackend);
  loadSessionsFromBackendRef.current = chat.loadSessionsFromBackend;

  // 启动完成后初始化（仅执行一次：空依赖 + startedRef 确保 StrictMode 下也只跑一次）
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const init = async () => {
      try {
        // 检查后端连接（带超时重试）
        logger.info("正在检查后端连接...");
        const MAX_RETRY = 5;
        const RETRY_DELAY = 300;
        let connected = false;

        for (let i = 0; i < MAX_RETRY; i++) {
          await new Promise(r => requestAnimationFrame(r));
          connected = await Promise.race([
            checkBackendConnectionRef.current(),
            new Promise<false>(r => setTimeout(() => r(false), 2000))
          ]);
          if (connected) break;
          if (i < MAX_RETRY - 1) {
            await new Promise(r => setTimeout(r, RETRY_DELAY));
          }
        }

        if (connected) {
          logger.success("后端服务已连接 (localhost:3002)");
          const result = await fetchModels();
          if (result.data) {
            setBackendModels(result.data);
            logger.info(`获取到 ${result.data.length} 个模型: ${result.data.map(m => m.name).join(", ")}`);
          }
          // 启动完成，切换到 ready 状态
          setStartupState("ready");
        } else {
          logger.warn("后端服务未连接，请检查 pm2 服务是否已启动");
          // 后端未连接，也进入 ready 状态（允许离线使用）
          setStartupState("ready");
        }
      } catch (e) {
        const errorMsg = `启动过程中发生错误: ${(e as Error).message || String(e)}`;
        logger.error(`启动失败: ${e}`);
        setErrorMessage(errorMsg);
        setStartupState("error");
      }
    };
    queueMicrotask(init);
  }, []);

  // P2: 桌面端切换对话时广播给手机端
  const prevActiveConvIdRef = useRef(chat.activeConversationId);
  useEffect(() => {
    const prevId = prevActiveConvIdRef.current;
    const newId = chat.activeConversationId;
    prevActiveConvIdRef.current = newId;
    if (prevId && newId && prevId !== newId) {
      const conv = chat.conversations.find(c => c.id === newId);
      broadcastToMobile("session-changed", newId, {
        title: conv?.title || "",
        cwd: conv?.cwd || "",
        usage: chat.conversationUsageMap[newId] || null,
      });
      logger.info(`广播会话切换: ${prevId} → ${newId}`);
    }
  }, [chat.activeConversationId, chat.conversations]);

  // P2: 手机端切换对话时桌面端同步
  const conversationsRef2 = useRef(chat.conversations);
  conversationsRef2.current = chat.conversations;
  const switchConvRef = useRef(chat.switchConversation);
  switchConvRef.current = chat.switchConversation;

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | null = null;
    import("@tauri-apps/api/event").then(({ listen }) => {
      listen<{ sessionId: string; title: string }>("mobile-sync-session", (event) => {
        const { sessionId, title } = event.payload;
        logger.info(`手机端请求切换对话: ${sessionId} (${title})`);
        const conv = conversationsRef2.current.find(c => c.id === sessionId);
        if (conv) {
          switchConvRef.current(sessionId);
        } else {
          logger.warn(`对话 ${sessionId} 不存在，无法切换`);
        }
      }).then(fn => { unlisten = fn; });
    });
    return () => { unlisten?.(); };
  }, []);

  // 手机端新建/重命名对话
  const newConvRef = useRef(chat.newConversation);
  newConvRef.current = chat.newConversation;
  const ensureConvRef = useRef(chat.ensureConversation);
  ensureConvRef.current = chat.ensureConversation;
  const renameConvRef = useRef(chat.renameConversation);
  renameConvRef.current = chat.renameConversation;
  const deleteConvRef = useRef(chat.deleteConversation);
  deleteConvRef.current = chat.deleteConversation;

  // 防重复注册守卫：解决 StrictMode 双挂载导致 listener 泄漏/重复的问题
  const listenersReadyRef = useRef(false);
  const unlistenFnsRef = useRef<(() => void)[]>([]);

  useEffect(() => {
    if (!isTauri()) return;
    // 利用 ref 同步标记防止 StrictMode 下 import() 异步时序导致双注册
    if (listenersReadyRef.current) return;
    listenersReadyRef.current = true;

    const localUnlisteners: (() => void)[] = [];
    import("@tauri-apps/api/event").then(({ listen }) => {
      // 二次检查：防止 StrictMode 卸载后重新挂载时老 promise 仍然注册
      if (!listenersReadyRef.current) {
        localUnlisteners.forEach(fn => fn());
        return;
      }

      // 新建普通对话
      listen<{ sessionId?: string; title?: string; mode?: string; cwd?: string }>("mobile-new-conversation", (event) => {
        const { sessionId, title, mode, cwd } = event.payload;
        logger.info(`手机端请求新建对话: sessionId=${sessionId} title=${title} mode=${mode}`);
        if (sessionId) {
          // 有 sessionId 时使用 ensureConversation，保持与手机端 ID 一致
          ensureConvRef.current(sessionId, title || undefined, cwd || undefined);
        } else {
          // 向后兼容：无 sessionId 时走原来的新建逻辑
          newConvRef.current(mode as any || "chat", title || undefined, cwd || undefined);
        }
      }).then(fn => localUnlisteners.push(fn));

      // 新建项目对话（手机端带上 sessionId 时，保持两端 ID 一致）
      listen<{ sessionId?: string; name: string; directory: string }>("mobile-new-project-conversation", (event) => {
        const { sessionId, name, directory } = event.payload;
        logger.info(`手机端请求新建项目对话: name=${name} directory=${directory} sessionId=${sessionId || '(无)'}`);
        if (sessionId) {
          // 有 sessionId 时使用 ensureConversation，保持与手机端 ID 一致
          ensureConvRef.current(sessionId, name, directory);
        } else {
          // 向后兼容
          newConvRef.current("chat", name, directory);
        }
      }).then(fn => localUnlisteners.push(fn));

      // 重命名对话
      listen<{ sessionId: string; title: string }>("mobile-rename-conversation", (event) => {
        const { sessionId, title } = event.payload;
        logger.info(`手机端请求重命名对话: sessionId=${sessionId} title=${title}`);
        renameConvRef.current(sessionId, title);
      }).then(fn => localUnlisteners.push(fn));

      // 删除对话（手机端通过 Bridge DELETE 代理删除后，Rust 通知桌面端）
      listen<{ sessionId: string }>("mobile-delete-conversation", (event) => {
        const { sessionId } = event.payload;
        logger.info(`手机端请求删除对话: sessionId=${sessionId}`);
        deleteConvRef.current(sessionId);
      }).then(fn => localUnlisteners.push(fn));

      unlistenFnsRef.current = localUnlisteners;
    });

    return () => {
      listenersReadyRef.current = false;
      unlistenFnsRef.current.forEach(fn => fn());
      unlistenFnsRef.current = [];
    };
  }, []);

  // 后端连接就绪后加载历史会话（仅执行一次）
  const sessionsLoadedRef = useRef(false);
  useEffect(() => {
    if (!chat.backendConnected || sessionsLoadedRef.current) return;
    sessionsLoadedRef.current = true;
    logger.info("正在恢复后端历史会话...");
    loadSessionsFromBackendRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.backendConnected]);

  // 后端断开连接时重置加载标记，下次重连后重新加载
  useEffect(() => {
    if (!chat.backendConnected) {
      sessionsLoadedRef.current = false;
    }
  }, [chat.backendConnected]);

  // Tauri 环境下监听后端日志事件
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | null = null;

    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        unlisten = await listen<{ level: string; message: string }>("backend-log", (event) => {
          const { level, message } = event.payload;
          switch (level) {
            case "error": logger.error(message); break;
            case "warn": logger.warn(message); break;
            case "success": logger.success(message); break;
            default: logger.info(message);
          }
        });
      } catch (e) {
        console.warn("监听后端日志失败:", e);
      }
    })();

    return () => {
      unlisten?.();
    };
  }, []);

  const conversationsRef = useRef(chat.conversations);
  conversationsRef.current = chat.conversations;

  // 手机端消息去重：防止 StrictMode 或重复 listener 导致同一条消息被处理两次
  // key = sessionId + message 的简单哈希，1秒窗口内重复则跳过
  const lastMobileRequestRef = useRef<{ key: string; time: number }>({ key: "", time: 0 });
  // Bridge 初始化 StrictMode 守卫（与 startedRef 相同模式：cleanup 不重置）
  const bridgeStartedRef = useRef(false);
  // 手机端连接状态监听器的清理函数（用 ref 持有，避免 async timing 问题）
  const statusUnlistenRef = useRef<(() => void) | null>(null);

  // Mobile Bridge: 接收手机端消息（统一通过 handleSendMessage 出口）
  const handleMobileChatRequestRef = useRef<(req: MobileChatRequest) => void>(() => {});
  handleMobileChatRequestRef.current = (req: MobileChatRequest) => {
    // 去重检查：同一 sessionId + message 在 1 秒内重复收到则跳过
    const dedupKey = `${req.sessionId}:${req.message}`;
    const now = Date.now();
    if (dedupKey === lastMobileRequestRef.current.key && now - lastMobileRequestRef.current.time < 1000) {
      logger.warn(`跳过重复的手机端消息: ${req.message.slice(0, 30)}`);
      debugLog(`跳过重复的手机端消息: key=${dedupKey}`);
      return;
    }
    lastMobileRequestRef.current = { key: dedupKey, time: now };

    const conv = conversationsRef.current.find(c => c.id === req.sessionId);
    // 手机端只传内容，不传配置。cwd 只用桌面端已有的（避免手机端覆盖桌面端工作目录）
    const cwd = conv?.cwd;
    logger.info(`收到手机端消息: ${req.message.slice(0, 30)}...`);
    debugLog(`收到手机端消息: sessionId=${req.sessionId} message="${req.message.slice(0, 50)}" cwd=${cwd || '(none)'} title=${req.title || '(none)'}`);

    // 确保对话存在并激活（使用手机端的 sessionId）
    if (!conv) {
      chat.ensureConversation(req.sessionId, req.title || req.message.slice(0, 30), cwd);
    } else if (chat.activeConversationId !== req.sessionId) {
      chat.switchConversation(req.sessionId);
    }

    // 延时等待 React 状态更新，然后通过统一出口发送
    setTimeout(() => {
      handleSendMessageRef.current(req.message, req.regenerate, { fromMobile: true });
    }, 300);
  };

  useEffect(() => {
    if (!isTauri()) return;
    // StrictMode 守卫：防止 effect 跑两次导致 async listener 注册时序问题
    if (bridgeStartedRef.current) return;
    bridgeStartedRef.current = true;

    const port = settings.mobileBridgePort || 9876;
    logger.info(`正在启动 Mobile Bridge (端口 ${port})...`);
    startBridge(port).then((state) => {
      logger.success(`Mobile Bridge 已启动 (端口 ${state.port})`);
    }).catch((err) => {
      // 端口可能已被占用（StrictMode 重挂载或前次未清理），尝试启动
      if (String(err).includes("bind") || String(err).includes("占用")) {
        logger.info(`Mobile Bridge 可能已在运行 (端口 ${port})`);
      } else {
        logger.warn(`Mobile Bridge 启动失败: ${err}`);
      }
    });
    setupMobileChatListener((req) => {
      handleMobileChatRequestRef.current(req);
    });

    // 监听手机端连接状态变化（用 ref 持有清理函数，避免 StrictMode async 时序误删）
    const setupStatusListener = async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const unlisten = await listen<{ connected: boolean; count: number }>(
        "mobile-connection-change",
        (event) => {
          const { connected, count } = event.payload;
          logger.info(`手机端连接状态变更: ${connected ? '已连接' : '已断开'} (在线数: ${count})`);
          if (connected) {
            setMobileConnected(true);
            if (count === 1) {
              logger.success("手机端已连接");
            }
          } else {
            setMobileConnected(false);
            logger.info("手机端已断开");
          }
        }
      );
      statusUnlistenRef.current = unlisten;
    };
    setupStatusListener();

    return () => {
      teardownMobileChatListener();
      // 清理手机端连接状态监听器
      // 注意：bridgeStartedRef 不重置 → StrictMode 第二次 mount 时跳过
      // 避免 async setupListener 在 cleanup 后才完成的时序问题
      if (statusUnlistenRef.current) {
        statusUnlistenRef.current();
        statusUnlistenRef.current = null;
      }
    };
  }, []);

  // 当前会话的目录（有 cwd 表示是项目对话，文件树等面板可显示）
  const currentCwd = chat.activeConversation?.cwd;
  const currentMode = chat.activeConversation?.mode || "chat";

  // 发送消息（桌面端和手机端的统一出口）
  const handleSendMessage = useCallback(async (content: string, regenerate?: boolean, options?: { fromMobile?: boolean }) => {
    const convId = chat.activeConversationId;
    if (!options?.fromMobile) {
      broadcastToMobile("user-message", convId, { text: content });
    }
    // 手机端消息必须传递 targetConvId，确保 SSE 流输出追加到正确的会话
    // 避免依赖 activeConversationIdRef 在 setTimeout(300ms) 后的闭包值
    const targetConvId = options?.fromMobile ? convId : undefined;
    debugLog(`handleSendMessage: content="${content.slice(0, 30)}" convId=${convId} fromMobile=${!!options?.fromMobile} targetConvId=${targetConvId} activeConfig=${activeConfig?.id || '(none)'} backendConnected=${chat.backendConnected}`);
    logger.info(`发送消息: "${content.slice(0, 30)}" convId=${convId} fromMobile=${!!options?.fromMobile} targetConvId=${targetConvId}`);
    await chat.sendMessage(content, chat.backendConnected, activeConfig, currentCwd, regenerate, targetConvId);
  }, [chat.sendMessage, chat.backendConnected, activeConfig, currentCwd, chat.activeConversationId]);

  const handleSendMessageRef = useRef(handleSendMessage);
  handleSendMessageRef.current = handleSendMessage;

  // 切换对话
  const handleSwitchConversation = useCallback((id: string) => {
    // v2.0: 切换对话时自动回到 chat 视图
    setCurrentView("chat");
    chat.switchConversation(id);
  }, [chat.switchConversation]);

  // 回滚到指定用户消息（撤销后续 AI 操作）
  const handleRollbackToSnapshot = useCallback(async (messageId: string) => {
    if (!currentCwd || !chat.activeConversationId) return;
    const conv = chat.activeConversation;
    if (!conv) return;
    const msg = conv.messages.find((m) => m.id === messageId);
    if (!msg) return;
    // 无快照时仅截断对话，不恢复文件
    const result = await chat.rollbackToSnapshot(
      msg.snapshotId || '', messageId, conv.id, msg.snapshotId ? currentCwd : undefined
    );
    if (result.success) {
      logger.success(`已回滚到步骤「${msg.content.slice(0, 20)}...」`);
    } else {
      logger.error(`回滚失败: ${result.error}`);
    }
  }, [currentCwd, chat.activeConversation, chat.activeConversationId, chat.rollbackToSnapshot]);

  // 新建普通对话（无 cwd）
  const handleNewConversation = (mode: ChatMode = "chat") => {
    chat.newConversation(mode, undefined, undefined);
  };

  // 新建项目对话 = 创建一条带 cwd 的对话
  const handleNewProjectConversation = (name: string, directory: string) => {
    chat.newConversation("chat", name, directory);
  };

  // 重试启动流程
  const handleRetryStartup = () => {
    setStartupState("loading");
    setErrorMessage("");
    window.location.reload();
  };

  // ========== 侧边栏响应式状态 ==========
  // 移动端（≤ 768px）检测
  const isMobile = useMediaQuery("(max-width: 768px)");

  // 移动端：drawer 是否打开（React state，不写 localStorage）
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // 桌面端：sidebar 是否折叠（localStorage 记忆，跨会话保留）
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() =>
    syncStore.getItem("sidebar-collapsed", false)
  );

  // 持久化桌面端折叠状态
  useEffect(() => {
    syncStore.setItem("sidebar-collapsed", sidebarCollapsed);
  }, [sidebarCollapsed]);

  // 跨断点清理：避免 mobile-open 与 desktop-hidden 叠加
  // - 切到 mobile：清掉 desktop-collapsed（mobile 下用 drawer，不需要它）
  // - 切到 desktop：清掉 mobile-open（desktop 下 sidebar 始终展示，无需 drawer）
  useEffect(() => {
    if (isMobile) {
      setSidebarCollapsed(false);
    } else {
      setSidebarOpen(false);
    }
  }, [isMobile]);

  // 移动端 drawer 打开时锁定 body 滚动
  useEffect(() => {
    if (isMobile && sidebarOpen) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => { document.body.style.overflow = prev; };
    }
  }, [isMobile, sidebarOpen]);

  // 切换桌面端 sidebar 折叠
  const handleToggleSidebarCollapse = useCallback(() => {
    setSidebarCollapsed(prev => !prev);
  }, []);

  // 切换移动端 drawer（仅在 mobile 下被调用）
  const handleToggleSidebarOpen = useCallback(() => {
    setSidebarOpen(prev => !prev);
  }, []);

  // 关闭移动端 drawer
  const handleCloseSidebar = useCallback(() => {
    setSidebarOpen(false);
  }, []);

  // ========== v2.0 视图路由 ==========
  // 当前主区显示的页面：chat / experts / memory
  const [currentView, setCurrentView] = useState<"chat" | "experts" | "memory">(() =>
    syncStore.getItem("current-view", "chat") as "chat" | "experts" | "memory"
  );

  // 持久化当前视图（用于刷新后恢复）
  useEffect(() => {
    syncStore.setItem("current-view", currentView);
  }, [currentView]);

  // 跳转到非对话页（专家 / 记忆）
  const handleNavigate = useCallback((view: "experts" | "memory") => {
    setCurrentView(view);
    // 移动端：跳转后关闭 drawer
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);

  return (
    <div className={[
      syncStore.getItem("dark-mode", false) ? "dark" : "",
      // 桌面端折叠：给 body 加 collapsed 类（CSS 控制 sidebar 宽度）
      !isMobile && sidebarCollapsed ? "sidebar-collapsed" : "",
    ].filter(Boolean).join(" ")}>
      {/* 启动 Loading */}
      {startupState === "loading" && (
        <StartupLoading message={startupMessage} />
      )}

      {/* 错误弹窗 */}
      {startupState === "error" && (
        <ErrorModal
          title="启动失败"
          message={errorMessage}
          onRetry={handleRetryStartup}
        />
      )}

      {/* 主应用界面（启动完成后显示） */}
      {startupState === "ready" && (
        <div className="h-screen flex flex-col bg-surface dark:bg-surface-dark text-content dark:text-content-dark">
          {/* 主内容区：侧边栏 + 聊天区 + 文件树 */}
          <div className="flex flex-1 min-h-0 overflow-hidden">
            {/* 左侧边栏 */}
            <Sidebar
              darkMode={settings.darkMode}
              onToggleDarkMode={() => updateSettings({ darkMode: !settings.darkMode })}
              conversations={chat.conversations}
              activeConversationId={chat.activeConversationId}
              onNewConversation={handleNewConversation}
              onSwitchConversation={handleSwitchConversation}
              onDeleteConversation={chat.deleteConversation}
              onOpenSettings={() => setShowSettings(true)}
              onNewProjectConversation={handleNewProjectConversation}
              onRenameConversation={chat.renameConversation}
              onCopyConversation={chat.copyConversation}
              onPickFolder={pickFolder}
              // v1.4 新增：移动端 drawer + 桌面端折叠
              isOpen={sidebarOpen}
              onClose={handleCloseSidebar}
              isCollapsed={isMobile ? false : sidebarCollapsed}
              expertCount={7}
              memoryCount={3}
              // v2.0 新增：视图路由
              activeView={currentView}
              onNavigate={handleNavigate}
            />

            {/* 中间：主区（按 currentView 路由） */}
            <div className="flex-1 flex min-h-0">
              {currentView === "chat" ? (
                <>
                  <ChatView
                    conversationId={chat.activeConversationId}
                    messages={chat.activeConversation?.messages || []}
                    onSendMessage={handleSendMessage}
                    isProcessing={chat.isProcessing}
                    onStop={chat.stopStreaming}
                    darkMode={settings.darkMode}
                    activeConfig={activeConfig}
                    modelConfigs={settings.modelConfigs}
                    onSwitchModel={setActiveModel}
                    chatMode={currentMode}
                    cwd={currentCwd}
                    backendConnected={chat.backendConnected}
                    backendModels={backendModels}
                    mobileConnected={mobileConnected}
                    pendingToolRequests={chat.pendingToolRequests}
                    onToolConfirm={chat.handleToolConfirm}
                    permissionMode={settings.permissionMode}
                    onPermissionModeChange={(mode) => updateSettings({ permissionMode: mode })}
                    onRollbackToSnapshot={handleRollbackToSnapshot}
                    conversationUsageMap={chat.conversationUsageMap}
                    hasMore={chat.hasMoreMessages?.[chat.activeConversationId]}
                    onLoadMore={chat.activeConversationId ? () => chat.loadMoreMessages(chat.activeConversationId) : undefined}
                    // v1.4 新增：顶栏 menu 按钮
                    onMenuClick={isMobile ? handleToggleSidebarOpen : handleToggleSidebarCollapse}
                    sidebarOpen={isMobile ? sidebarOpen : sidebarCollapsed}
                  />

                  {/* 右侧：文件树 + 文件预览/快照面板（只有项目对话才显示） */}
                  {currentCwd && (
                    <div className="flex shrink-0">
                      <FileTree
                        directory={currentCwd}
                        onFileClick={(path) => {
                          setSelectedFilePath(path);
                          setShowCheckpointPanel(false);
                        }}
                        onClose={() => setFileTreeExpanded(false)}
                        isExpanded={fileTreeExpanded}
                        onToggleExpand={() => setFileTreeExpanded(!fileTreeExpanded)}
                        showPanel={!!currentCwd}
                        onToggleCheckpointPanel={() => setShowCheckpointPanel(v => !v)}
                        isCheckpointPanelActive={showCheckpointPanel}
                        agentGatewayUrl={settings.agentGatewayUrl}
                      />

                      {/* 文件预览面板 / 快照面板（互斥） */}
                      {showCheckpointPanel ? (
                        <CheckpointPanel
                          cwd={currentCwd}
                          sessionId={chat.activeConversationId}
                          onClose={() => setShowCheckpointPanel(false)}
                        />
                      ) : (
                        <FilePreview
                          filePath={selectedFilePath}
                          onClose={() => setSelectedFilePath(null)}
                          agentGatewayUrl={settings.agentGatewayUrl}
                        />
                      )}
                    </div>
                  )}
                </>
              ) : currentView === "experts" ? (
                <ExpertsPage
                  onMenuClick={isMobile ? handleToggleSidebarOpen : handleToggleSidebarCollapse}
                />
              ) : (
                <MemoryPage
                  onMenuClick={isMobile ? handleToggleSidebarOpen : handleToggleSidebarCollapse}
                />
              )}
            </div>
          </div>

      {/* 移动端 sidebar drawer 打开时的背景遮罩 */}
      {isMobile && sidebarOpen && (
        <div
          className="sidebar-backdrop"
          onClick={handleCloseSidebar}
          aria-hidden="true"
        />
      )}

      {/* 底部日志面板 */}
      <LogPanel />

      {/* 设置面板 */}
            {showSettings && (
              <SettingsPanel
                settings={settings}
                onUpdate={updateSettings}
                onReset={resetSettings}
                onClose={() => setShowSettings(false)}
                onSaveModelConfig={saveModelConfig}
                onDeleteModelConfig={deleteModelConfig}
                onSetActiveModel={setActiveModel}
              />
            )}
          </div>
        )}
      </div>
  );
}
