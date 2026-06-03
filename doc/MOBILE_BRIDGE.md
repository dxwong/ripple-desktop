# Mobile Bridge 模块开发文档

> **最后更新**: 2026-05-26  
> **当前状态**: ✅ 双向同步完善：对话列表事件驱动刷新、新建/重命名/删除双向同步、下拉刷新修复

---

## 1. 概述

### 1.1 设计目标

Mobile Bridge 是 Ripple 桌面端（Tauri）的内嵌 HTTP+SSE 服务，实现手机端通过桌面端与 Agent Server 交互的架构。

**核心原则**：
- **手机端 = 桌面端映射**：共享同一个 Agent Server，不直连
- **手机端只抛数据**：模型选择、后端连接等由桌面端决定
- **项目对话强制桌面在线**：cwd 非空的对话，桌面端离线时禁止发送
- **普通对话不受限**：cwd 为空的对话，桌面端离线也可使用
- **双向同步**：对话切换 + LLM 输出 + 用户消息均实时同步
- **事件驱动刷新**：桌面端对话增删改自动广播 `conversations-changed`，手机端不再定时轮询

### 1.2 端口约定

| 服务 | 端口 | 说明 |
|------|------|------|
| Agent Server | 3002 | Node.js 后端，LLM 推理 + 会话管理 |
| Mobile Bridge | 9876（可配置） | 桌面端内嵌 Rust HTTP 服务 |
| 桌面端 WebView | Tauri 默认 | React 前端界面 |

### 1.3 单一出口设计

```
桌面端点击发送 ──┐
                 ├──→ handleSendMessage() ──→ chat.sendMessage(backendConnected, activeConfig, cwd)
手机端消息 ──────┘        ↑                              ↑ 统一参数、统一模型
                    fromMobile 标志              使用桌面端当前激活的模型
```

---

## 2. 系统架构

```
┌──────────────────────────────────────────────────────────┐
│  手机端 (Browser/WebView)                                │
│  ┌──────────────────┐  ┌───────────────────────────────┐ │
│  │ POST /chat/stream │  │ EventSource                    │ │
│  │ 发送消息           │  │ /api/bridge/subscribe          │ │
│  └───────┬────────────┘  │ 被动接收桌面端广播             │ │
└──────────┼───────────────┴──────┬────────────────────────┘
           │ HTTP (9876)          │ HTTP SSE (9876)
           ▼                      ▼
┌──────────────────────────────────────────────────────────┐
│  桌面端 Tauri                                             │
│                                                          │
│  ┌─ Rust: mobile_bridge.rs ────────────────────────────┐ │
│  │ TCP Listener (0.0.0.0:9876)                         │ │
 │  │  ├ GET  /api/health                                 │ │
 │  │  ├ GET  /api/sessions           → proxy → Agent     │ │
 │  │  ├ GET  /api/sessions/:id       → proxy → Agent     │ │
 │  │  ├ POST /api/sessions/:id       → proxy → Agent     │ │
 │  │  ├ DELETE /api/sessions/:id     → proxy → Agent     │ │
 │  │  ├ POST /api/chat/abort         → proxy → Agent     │ │
 │  │  ├ POST /api/chat/:id/confirm   → proxy → Agent     │ │
 │  │  ├ POST /api/chat/stream        → SSE + Tauri事件   │ │
 │  │  ├ GET  /api/bridge/subscribe   → SSE (被动监听)     │ │
 │  │  ├ POST /api/bridge/sync-session→ Tauri事件         │ │
 │  │  ├ POST /api/bridge/new-conversation → Tauri事件    │ │
 │  │  ├ POST /api/bridge/new-project-conversation→ 事件  │ │
 │  │  └ POST /api/bridge/rename-conversation → Tauri事件 │ │
│  └────────────────────────────────────────────────────┘ │
│                                                          │
│  ┌─ JS: mobileBridge.ts ─────────────────────────────┐  │
│  │ Tauri invoke 封装:                                  │  │
│  │  start_mobile_bridge / stop_mobile_bridge           │  │
│  │  broadcast_mobile_event                            │  │
│  │ Tauri listen 封装:                                  │  │
│  │  mobile-chat-request / mobile-bridge-status         │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  ┌─ React: MainApp.tsx ──────────────────────────────┐  │
│  │ handleSendMessage() ← 统一发送出口                   │  │
│  │  ├ 桌面端: broadcastToMobile("user-message")         │  │
│  │  └ chat.sendMessage(backendConnected, activeConfig)  │  │
│  │ handleMobileChatRequest ← 手机消息入口                │  │
│  │  ├ ensureConversation(sessionId) 或 switch           │  │
│  │  └ handleSendMessage(..., {fromMobile:true})         │  │
│  │ mobileConnected 状态 ← mobile-connection-change      │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  ┌─ useStreamingChat ────────────────────────────────┐  │
│  │ sendMessage → Agent SSE → appendToConversation      │  │
│  │  ↓ onStreamEvent → broadcastToMobile (桥→手机)      │  │
│  │  ↓ targetConvId 参数 (手机消息路由)                   │  │
│  │  ↓ backendConnected: SSE健康检测管理                 │  │
│  └────────────────────────────────────────────────────┘  │
└───────────────────────┬──────────────────────────────────┘
                        │ HTTP (localhost:3002)
                        ▼
┌──────────────────────────────────────────────────────────┐
│  Agent Server (Node.js, 端口 3002)                        │
│  - LLM 推理（支持多模型）                                   │
│  - 会话管理（JSONL 持久化）                                  │
│  - 工具调用（文件操作、执行命令）                              │
└──────────────────────────────────────────────────────────┘
```

---

## 3. 文件清单

### 桌面端

| 文件 | 路径 | 角色 | 行数 |
|------|------|------|------|
| `mobile_bridge.rs` | `src-tauri/src/mobile_bridge.rs` | Rust 核心：HTTP 服务器 + SSE + 广播 | 861 |
| `lib.rs` | `src-tauri/src/lib.rs` | Tauri 入口：注册命令、启动后端 | 288 |
| `mobileBridge.ts` | `src/services/mobileBridge.ts` | JS 服务层：invoke/listen 封装 | 191 |
| `MainApp.tsx` | `src/components/MainApp.tsx` | 主应用：Bridge 初始化 + 双向同步 | 551 |
| `ChatView.tsx` | `src/components/ChatView.tsx` | 聊天界面：WiFi 图标（mobileConnected prop） | ~450 |
| `useStreamingChat.ts` | `src/hooks/useStreamingChat.ts` | 核心：SSE 流 + sendMessage + ensureConversation | ~1368 |
| `useSettings.ts` | `src/hooks/useSettings.ts` | 设置：mobileBridgePort 默认 9876 | ~50 |
| `SettingsPanel.tsx` | `src/components/SettingsPanel.tsx` | 设置 UI：Bridge 端口配置 | ~500 |
| `types.ts`（共享包） | `packages/ripple-shared/src/types.ts` | AppSettings 类型定义 | ~120 |
| `Cargo.toml` | `src-tauri/Cargo.toml` | 依赖：ureq = "2" | ~40 |

### 手机端

| 文件 | 路径 | 角色 |
|------|------|------|
| `ChatPage.jsx` | `ripple-mobile/src/components/ChatPage.jsx` | 聊天页面：SSE 订阅 + 连接检测 + 离线阻断 + 事件驱动刷新 |
| `ChatHistoryPage.jsx` | `ripple-mobile/src/components/ChatHistoryPage.jsx` | 历史页面：从 Bridge 分页加载 + 下拉刷新 |
| `SettingsPage.jsx` | `ripple-mobile/src/components/SettingsPage.jsx` | 设置：agentGatewayUrl（默认 9876） |
| `usePullToRefresh.js` | `ripple-mobile/src/hooks/usePullToRefresh.js` | 下拉刷新通用 Hook（返回 refreshState） |

---

## 4. Rust 后端详解（mobile_bridge.rs）

### 4.1 数据结构

```rust
struct SseClient {
    sender: Sender<String>,  // mpsc 通道发送端
}

pub struct MobileBridgeState {
    pub running: Arc<Mutex<bool>>,
    pub port: Arc<Mutex<u16>>,
    sse_clients: Arc<Mutex<Vec<SseClient>>>,  // 全局 SSE 广播列表
}
```

`sse_clients` 是所有活跃手机端 SSE 连接的列表。新连接通过 `clients.push(SseClient { sender: tx })` 加入，断开时通过 `__ping__` 检测清理。

### 4.2 HTTP 服务器

- **监听**: `TcpListener::bind("0.0.0.0:9876")`
- **模式**: `set_nonblocking(true)` + `thread::sleep(100ms)` 轮询
- **请求解析**: `parse_http_request` → BufReader 解析 HTTP 请求行、头部、body
- **路由**: `handle_connection` 内的 `match (method, path)` 分发
- **每个连接一个线程**: `thread::spawn(move || handle_connection(stream, clients, app))`

### 4.3 请求代理

对于非 SSE 的 API 请求，Bridge 透明代理到 Agent Server：

```rust
fn proxy_to_agent(method, path, query, body, content_type)
    -> Result<(status, body, url), String>
```

使用 `ureq` crate 发送 HTTP 请求到 `http://127.0.0.1:3002`。

### 4.4 SSE 端点

#### handle_chat_stream（POST /api/chat/stream）

手机端发送消息时的 SSE 流：

1. 解析请求体（message, sessionId, ...）
2. 写入 `HTTP 200 + text/event-stream` 头部
3. 注册 SseClient 到全局列表
4. 发送 `{"type":"connected"}` 确认事件
5. 发射 `mobile-connection-change` 事件（通知桌面端前端连接状态）
6. 发射 `mobile-chat-request` Tauri 事件（触发桌面端发送消息）
7. 进入事件循环：收到前端广播 → 转发 SSE 给手机端；1 秒超时 → 发送 `: heartbeat\n\n`
8. 5 分钟无真实事件 → 断开
9. 断开时如无其他连接 → 发射 `mobile-connection-change {connected: false}`

#### handle_bridge_subscribe（GET /api/bridge/subscribe）

手机端启动时的持久订阅通道：

1. 与 `handle_chat_stream` 类似，但不触发聊天
2. 发送 `{"type":"subscribed"}` 确认订阅
3. 持续监听广播事件并转发
4. 10 分钟无事件 → 断开
5. 连接/断开时同样发射 `mobile-connection-change`

**关键区别**：`chat_stream` 收到 `__done__` 后主动断开，`subscribe` 持续到超时。

### 4.5 广播系统

```rust
fn broadcast_event(sse_clients, event_json) -> usize
```

1. 加锁获取 `sse_clients` 列表
2. 通过 `__ping__` 清理已断开的客户端
3. 向所有存活客户端发送事件
4. 返回发送成功的客户端数

### 4.6 Tauri 命令

| 命令 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `start_mobile_bridge` | `port?: u16` | `u16` | 启动监听线程，如已运行则返回当前端口 |
| `stop_mobile_bridge` | 无 | `bool` | 停止监听 + 断开所有 SSE + 发射 stopped 事件 |
| `broadcast_mobile_event` | `eventJson: String` | `usize` | 向所有手机端 SSE 客户端广播事件 |

### 4.7 Tauri 事件（Rust → JS）

| 事件名 | payload | 发射时机 | 消费方 |
|--------|---------|----------|--------|
| `mobile-bridge-status` | `{status, port}` | 服务启停 | `mobileBridge.ts` 管理 `bridgeState` |
| `mobile-connection-change` | `{connected, count}` | 手机端连接/断开 | `MainApp.tsx` 管理 `mobileConnected` |
| `mobile-chat-request` | `{message, sessionId, ...}` | 手机端发来消息 | `MainApp.tsx` → `handleMobileChatRequest` |
| `mobile-sync-session` | `{sessionId, title}` | 手机端切换对话 | `MainApp.tsx` → `switchConversation` |
| `mobile-new-conversation` | `{sessionId, title, mode, cwd}` | 手机端新建普通对话 | `MainApp.tsx` → `ensureConversation` |
| `mobile-new-project-conversation` | `{name, directory}` | 手机端新建项目对话 | `MainApp.tsx` → `newConversation("chat", name, directory)` |
| `mobile-rename-conversation` | `{sessionId, title}` | 手机端重命名对话 | `MainApp.tsx` → `renameConversation` |

### 4.8 Cargo 依赖

```toml
[dependencies]
ureq = "2"       # HTTP 客户端
serde_json = "1" # JSON 序列化
```

---

## 5. JS 服务层详解（mobileBridge.ts）

### 5.1 类型定义

```typescript
interface MobileBridgeState { running: boolean; port: number; }

interface MobileChatRequest {
  message: string; sessionId: string; modelId: string;
  model?: string; endpoint?: string; apiKey?: string;
  cwd?: string; title?: string; regenerate?: boolean;
}

type MobileBridgeEventType =
  "text" | "thinking" | "tool-start" | "tool-end" | "tool-request"
  | "tool-update" | "agent-start" | "turn-start" | "turn-end"
  | "message-start" | "message-end" | "usage" | "done" | "error"
  | "user-message" | "session-changed" | "conversations-changed"
  | "session-renamed" | "file-tree-changed";

interface MobileBridgeEvent {
  type: MobileBridgeEventType;
  sessionId: string;
  data?: Record<string, unknown>;
}
```

### 5.2 函数参考

| 函数 | 作用 | 内部调用 |
|------|------|----------|
| `startBridge(port?)` | 启动 Rust 桥接服务 | `invoke("start_mobile_bridge", { port })` |
| `stopBridge()` | 停止服务 | `invoke("stop_mobile_bridge")` |
| `broadcastToMobile(type, sessionId, data?)` | 广播事件给手机端 | `invoke("broadcast_mobile_event", { eventJson })` |
| `setupMobileChatListener(handler)` | 监听手机消息 + 状态变更 | `listen("mobile-chat-request")` + `listen("mobile-bridge-status")` |
| `teardownMobileChatListener()` | 注销所有监听 | 调用 unlisten 函数 |
| `getBridgeState()` | 获取桥接状态缓存 | 返回 `bridgeState` 副本 |

### 5.3 模块级单例状态

```typescript
let bridgeState: MobileBridgeState = { running: false, port: 0 };
let chatRequestHandler: ((req: MobileChatRequest) => void) | null = null;
let unlistenChatRequest: (() => void) | null = null;
let unlistenStatus: (() => void) | null = null;
```

**注意**：`bridgeState` 由 `setupMobileChatListener` 中的 `mobile-bridge-status` 事件更新（端口号从 `start_mobile_bridge` 获取），不与 `mobile-connection-change` 混淆。

---

## 6. 桌面端集成详解（MainApp.tsx）

### 6.1 初始化流程

在 `useEffect([], [])` 中执行（仅 Tauri 环境）：

```typescript
// 1. 启动 Bridge 服务
startBridge(settings.mobileBridgePort || 9876);

// 2. 注册手机端消息监听（mobile-chat-request + mobile-bridge-status）
setupMobileChatListener(req => handleMobileChatRequestRef.current(req));

// 3. 监听手机端连接状态（mobile-connection-change）
setupStatusListener() → setMobileConnected(true/false);

// cleanup: 注销监听器，不停止 Bridge（避免 StrictMode 双挂载杀死线程）
```

### 6.2 统一发送出口

```typescript
const handleSendMessage = useCallback(async (
  content: string,
  regenerate?: boolean,
  options?: { fromMobile?: boolean }
) => {
  // 桌面端发送 → 广播 user-message 给手机端
  if (!options?.fromMobile) {
    broadcastToMobile("user-message", chat.activeConversationId, { text: content });
  }
  // 统一调用（使用桌面端当前模型和后端连接状态）
  await chat.sendMessage(content, chat.backendConnected, activeConfig, currentCwd, regenerate);
}, [chat.sendMessage, chat.backendConnected, activeConfig, currentCwd, chat.activeConversationId]);

// Ref 模式：避免 setTimeout 中的闭包陈旧
const handleSendMessageRef = useRef(handleSendMessage);
handleSendMessageRef.current = handleSendMessage;
```

**设计要点**：
- `fromMobile: true` → 手机端消息不走 `broadcastToMobile("user-message")`，避免重复
- `fromMobile: false/undefined` → 桌面端消息自动同步给手机
- 通过 ref 模式确保 300ms setTimeout 后拿到最新闭包

### 6.3 手机端消息入口

```typescript
handleMobileChatRequestRef.current = (req: MobileChatRequest) => {
  const conv = conversationsRef.current.find(c => c.id === req.sessionId);
  const cwd = req.cwd || conv?.cwd;

  // 确保对话存在并激活
  if (!conv) {
    chat.ensureConversation(req.sessionId, req.title || req.message.slice(0, 30), cwd);
  } else if (chat.activeConversationId !== req.sessionId) {
    chat.switchConversation(req.sessionId);
  }

  setTimeout(() => {
    handleSendMessageRef.current(req.message, req.regenerate, { fromMobile: true });
  }, 300);
};
```

---

## 7. 事件驱动刷新机制

手机端对话列表不再使用定时轮询，改为桌面端事件驱动刷新。

### 7.1 广播事件类型

| 事件类型 | 触发时机 | 发送方 |
|---------|----------|--------|
| `conversations-changed` | 桌面端新建/删除/重命名对话时 | `useStreamingChat.ts` → `onConversationsChanged` → `MainApp.tsx` |
| `session-renamed` | 桌面端重命名对话时（双通道保障） | `useStreamingChat.ts` → `onStreamEvent` → `MainApp.tsx` |
| `file-tree-changed` | AI 工具执行 write_file/create_dir/remove/shell 后 | `useStreamingChat.ts` → `onStreamEvent` → `MainApp.tsx` |

### 7.2 事件流向

```
桌面端 新建/删除/重命名对话
  → onConversationsChanged?.()
    → broadcastToMobile("conversations-changed", convId)
      → Bridge SSE → 手机端 handleBridgeEvent
        → loadSessionList() ✅

桌面端 重命名对话（额外通道）
  → onStreamEvent?.("session-renamed", id, { title })
    → broadcastToMobile("session-renamed", id, { title })
      → Bridge SSE → 手机端 handleBridgeEvent
        → loadSessionList() ✅

桌面端 AI 执行文件操作
  → onStreamEvent?.("file-tree-changed", cwd, { cwd })
    → broadcastToMobile("file-tree-changed", cwd, { cwd })
      → Bridge SSE → 手机端 handleBridgeEvent
        → loadSessionList() ✅
```

### 7.3 新建对话双向同步

手机端点"新对话"时调用 Bridge API，桌面端使用 `ensureConversation` 保持 ID 一致：

```
手机端 handleNewChat()
  → 生成本地 ID mobile-xxx
  → setCurrentChatId(mobile-xxx)
  → POST /api/bridge/new-conversation { sessionId, title, mode }
    → Rust 透传 sessionId → Tauri 事件 mobile-new-conversation
      → MainApp.tsx: ensureConversation(sessionId, title, cwd)
        → 桌面端同步创建相同 ID 的对话
        → onConversationsChanged?.() → 广播到手机端刷新 ✅
```

### 7.4 保留的刷新时机

- 初始加载（挂载时执行一次）
- 每次 SSE `done` 事件后（500ms）
- App 从后台恢复时（visibilitychange）
- 用户主动点击刷新按钮
- 发消息/删除/保存/重命名后的即时刷新（setTimeout 0.5-1s）
