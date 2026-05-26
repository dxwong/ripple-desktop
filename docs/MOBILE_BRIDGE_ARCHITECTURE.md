# Ripple Mobile Bridge — 架构文档（已更新）

> **文档版本**: 2026-05-26（第二批修复）  
> **当前状态**: ✅ 所有已知 Bug 已修复，双向同步机制完善

---

## 1. 设计原则（已确认）

| 原则 | 说明 |
|------|------|
| **手机端=远程遥控器** | 只采集用户输入和展示结果，不参与计算/存储/AI调用 |
| **单一发送出口** | 桌面端/手机端都走 `handleSendMessage` → `chat.sendMessage` |
| **手机端只抛内容** | 只传 `message` + `sessionId`，不传模型配置（endpoint/apiKey/model） |
| **桌面端用自己配置** | 模型选择、后端连接、工作目录全部用桌面端自身的 |

### 两路发送对比

```
桌面端点击发送:
  ChatView.onSend(text)
    → handleSendMessage(text, false, undefined)
      → chat.sendMessage(text, backendConnected, activeConfig, cwd, false, targetConvId=undefined)

手机端发消息:
  Bridge POST → Tauri事件 → handleMobileChatRequestRef
    → ensureConversation(sessionId, title) [不传cwd，只用桌面端已有cwd]
    → setTimeout 300ms
      → handleSendMessage(msg, false, {fromMobile:true})
        → chat.sendMessage(msg, backendConnected, activeConfig, currentCwd, false, targetConvId=sessionId)
```

**唯一区别**:
- `targetConvId`: 手机端 = 手机sessionId，桌面端 = undefined
- `broadcastToMobile("user-message")`: 手机端跳过（fromMobile=true）

### 对话列表同步机制

```
桌面端操作                     手机端响应
───────────                   ─────────
新建/删除/重命名对话 ──→  conversations-changed → loadSessionList()
重命名对话（额外通道） ──→  session-renamed → loadSessionList()
AI执行文件操作 ──→  file-tree-changed → loadSessionList()
手机端新建对话 ──→  POST /api/bridge/new-conversation → 桌面端 ensureConversation → 双向同步
```

---

## 2. 架构图

```
┌─────────────────────────────────────────────────────────┐
│ 手机端                                                   │
│  SSEClient POST /api/chat → send {message, sessionId}  │
│  EventSource GET /api/bridge/subscribe ← 收广播         │
└─────────────────────┬───────────────────────────────────┘
                      │ HTTP (9876)
                      ▼
┌─────────────────────────────────────────────────────────┐
│ 桌面端 Rust Bridge (mobile_bridge.rs, TCP 9876)          │
│  POST /api/chat → handle_chat_stream                     │
│    → emit mobile-connection-change (通知桌面"手机已连")    │
│    → emit mobile-chat-request (Tauri事件 → React)        │
│    → 进入循环: 收广播事件 → SSE转发给手机                  │
│  GET /api/bridge/subscribe → handle_bridge_subscribe     │
│    → 持久订阅, 转发广播给手机                              │
└─────────────────────┬───────────────────────────────────┘
                      │ Tauri 事件
                      ▼
┌─────────────────────────────────────────────────────────┐
│ 桌面端 React (MainApp.tsx + useStreamingChat.ts)         │
│  handleMobileChatRequestRef(req) ← Tauri listener       │
│    → ensureConversation(sessionId) → 激活对话            │
│    → setTimeout → handleSendMessageRef.current(msg)     │
│      → chat.sendMessage(content, backendConnected,      │
│           activeConfig, cwd, regen, targetConvId)       │
│        → SSEClient → POST Agent Server (:3002)          │
│        → onStreamEvent → broadcastToMobile → Bridge     │
└─────────────────────┬───────────────────────────────────┘
                      │ HTTP
                      ▼
┌─────────────────────────────────────────────────────────┐
│ Agent Server (Node.js, :3002)                            │
│  POST /api/chat → SSE 流 → LLM 推理                      │
└─────────────────────────────────────────────────────────┘
```

---

## 3. 当前 Bug 状态（已全部修复 ✅）

> 所有已知 Bug 已于 2026-05-26 分两批修复完成。

### Bug #1: 手机端消息 → 桌面端 "request was aborted"（已修复 🎉）

**根因分析（多个问题叠加）**:

| # | 问题 | 文件 | 描述 |
|---|------|------|------|
| 1 | **AbortError 被静默吞掉** | `sse.ts` | `catch` 块中 `AbortError` 时直接 `return`，不调用 `onError`，外层 Promise 永久挂起 |
| 2 | **onError 处理器重复定义** | `useStreamingChat.ts` | 对象字面量中重复的 `onError` key，第二个覆盖第一个，`safeResolve()` 无效 |
| 3 | **sendMessage 缺少 agentGatewayUrl 依赖** | `useStreamingChat.ts` | `agentGatewayUrl` 不在 dep 数组中，闭包可能捕获旧 URL |
| 4 | **Listener 重复注册（StrictMode）** | `mobileBridge.ts` | StrictMode 双挂载时嵌套计数为 0，守卫绕过，两个 Listener 同存 |
| 5 | **isProcessing 异步竞态** | `useStreamingChat.ts` | React state 更新异步，两次 `sendMessage` 同时绕过 `isProcessing` 检查 |

**根因 #4 详细时序（列表重复注册）**：

```
Mount 1 → setupListener() → nestCount=1 → await listen() 🕐
Unmount → teardown() → nestCount=0 → unlistenChatRequest=null
Mount 2 → setupListener() → nestCount=1 → 守卫通过 → await listen() 🕐
  → Listen1完成 → 注册Listener A
  → Listen2完成 → 注册Listener B (两个Listener并存!)
  → 手机发消息 → Tauri事件 → A和B都触发 → 两个"hi"气泡 → 两次sendMessage
```

**根因 #5 详细时序（isProcessing 竞态）**：

```
sendMessage #1: isProcessingRef=false → 通过 → isProcessingRef=true | setIsProcessing(true) 🕐
sendMessage #2: isProcessingRef=true(刚设置) → 拦截 ✅
                                ↓ React 还未 re-render，但ref是同步的

旧代码: sendMessage #1: isProcessing(false, state) → 通过 → setIsProcessing(true) 🕐
旧代码: sendMessage #2: isProcessing(false, state, 未更新!) → 通过! → 两个并发SSE ❌
```

**修复内容**：

1. `sse.ts`: AbortError 时调用 `onError(err.message)` 而不是静默返回
2. `useStreamingChat.ts`: 删除重复 `onError`，`agentGatewayUrl` 加入 dep
3. `useStreamingChat.ts`: 添加 `isProcessingRef` 同步锁（ref 赋值即时可见）
4. `mobileBridge.ts`: 嵌套计数 `setupNestCount` 替代布尔守卫
5. `MainApp.tsx`: 手机端消息去重（sessionId+message 在 1 秒窗口内去重）

### Bug #2: 手机在线状态 WiFi 图标（已修复 🎉）

**根因**：Rust Bridge 的 `handle_chat_stream` 和 `handle_bridge_subscribe` 在客户端断开时，仅在所有客户端都断开时才发射 `mobile-connection-change` 事件，未报告当前剩余连接数。

**修复内容**：
1. `mobile_bridge.rs`: 断开时始终发射 `mobile-connection-change`，附带 `connected: remaining > 0` 和 `count: remaining`
2. 添加客户端唯一 ID (`client_id`) 加入所有日志，方便调试追踪
3. `broadcast_event` 中增加广播日志

### Bug #3: 手机端新建项目对话 saveSession 404（已修复 🎉）

**根因**：Rust Bridge 缺少 `POST /api/sessions/:id` 代理路由，手机端 `confirmNewProject()` 调用 `saveSession(id, {title, cwd})` 时报 404，被 `.catch(() => {})` 静默吞掉，导致项目对话无法持久化。

**修复内容**：
1. `mobile_bridge.rs`: 新增 `("POST", path) if path.starts_with("/api/sessions/")` 代理路由，透传到 Agent Server

### Bug #4: 下拉刷新指示器不显示（已修复 🎉）

**根因**：`usePullToRefresh.js` hook 返回值只有 `{ pullDistance, touchHandlers }`，但 3 个调用方（`ChatHistoryPage.jsx`、`SettingsPage.jsx`、`PlazaPage.jsx`）都解构了 `refreshState`，值为 `undefined`，导致下拉指示器从不显示。

**修复内容**：
1. `usePullToRefresh.js`: 新增 `refreshState` state 变量，在触摸生命周期中正确跟踪 `idle → pulling → ready → refreshing → idle` 流转

### Bug #5: 手机端对话列表 30 秒轮询改为事件驱动（已修复 🎉）

**根因**：手机端 `ChatPage.jsx` 每 30 秒轮询 `loadSessionList()`，效率低、延迟高。桌面端的对话和文件变更无法实时同步到手机端。

**修复内容**：
1. `mobileBridge.ts`: 新增事件类型 `"conversations-changed"`、`"session-renamed"`、`"file-tree-changed"`
2. `useStreamingChat.ts`: 对话增删改时通过 `onConversationsChanged` 广播 `conversations-changed`；AI 工具执行文件操作时通过 `onStreamEvent` 广播 `file-tree-changed`；重命名时额外广播 `session-renamed`
3. `ChatPage.jsx` (手机): 移除 `setInterval(loadSessionList, 30000)` 轮询，通过 `handleBridgeEvent` 监听上述事件驱动刷新
4. 保留初始加载、SSE done 事件、visibilitychange 等即时刷新时机

### Bug #6: 手机端新建对话 → 桌面端列表不刷新（已修复 🎉）

**根因**：`handleNewChat()` 只创建本地 ID，未通知桌面端。首次发消息时 `ensureConversation` 才创建，桌面端无法即时同步。

**修复内容**：
1. `ChatPage.jsx` (手机): `handleNewChat()` 中调用 `POST /api/bridge/new-conversation` 并传入 `sessionId`
2. `mobile_bridge.rs`: 解析并透传 `sessionId` 字段到 Tauri 事件
3. `MainApp.tsx`: 新增 `ensureConvRef`，收到 `sessionId` 时使用 `ensureConversation` 保持 ID 一致

### Bug #7: 桌面端重命名对话 → 手机端标题不同步（已修复 🎉）

**根因**：`renameConversation` 调用 `onConversationsChanged?.()` 广播 `conversations-changed`，但无显式的重命名事件通知。

**修复内容**：
1. `useStreamingChat.ts`: `renameConversation` 中新增 `onStreamEvent?.("session-renamed", id, { title })`，添加 `onStreamEvent` 到 dep 数组
2. `mobileBridge.ts`: 事件类型新增 `"session-renamed"`
3. `ChatPage.jsx` (手机): `handleBridgeEvent` 新增 `case 'session-renamed'` → `loadSessionList()`

### Bug #8: 手机端新建项目对话选中了别的会话（已修复 🎉）

**根因**：`useEffect`（依赖 `historyChats`）从 localStorage 读取旧的会话 ID 并调用 `setCurrentChatId`，覆盖了新项目对话的选择。因 `confirmNewProject()` 虽设置了 `setCurrentChatId(newId)`，但 `localStorage.setItem` 由另一个 useEffect 异步触发，此时 localStorage 中仍为旧 ID。

**修复内容**：
1. `ChatPage.jsx` (手机): `confirmNewProject()` 中 `setCurrentChatId(id)` 后同步写入 `localStorage.setItem('ripple_current_chat_id', id)`，防止 useEffect 恢复旧会话

---

## 4. 关键代码路径

### handleMobileChatRequestRef（手机消息入口）

```typescript
handleMobileChatRequestRef.current = (req: MobileChatRequest) => {
    const conv = conversationsRef.current.find(c => c.id === req.sessionId);
    // 只取桌面端已有的 cwd，不用手机的
    const cwd = conv?.cwd;

    if (!conv) {
        // 新建对话时不传 cwd（手机端不决定工作目录）
        chat.ensureConversation(req.sessionId, req.title || req.message.slice(0, 30), undefined);
    } else if (chat.activeConversationId !== req.sessionId) {
        chat.switchConversation(req.sessionId);
    }

    setTimeout(() => {
        handleSendMessageRef.current(req.message, req.regenerate, { fromMobile: true });
    }, 300);
};
```

### handleSendMessage（统一发送出口）

```typescript
const handleSendMessage = useCallback(async (content, regenerate, options) => {
    const convId = chat.activeConversationId;
    const targetConvId = options?.fromMobile ? convId : undefined;

    await chat.sendMessage(content, chat.backendConnected, activeConfig, currentCwd, regenerate, targetConvId);
}, [chat.sendMessage, chat.backendConnected, activeConfig, currentCwd, chat.activeConversationId]);
```

### sendMessage（useStreamingChat 内部）

```typescript
const convId = targetConvId || activeConversationIdRef.current;
// ← convId = 手机sessionId (targetConvId) 或 桌面端的当前会话

const backendParams = {
    message: content,
    sessionId: convId,
    modelId: modelConfig?.model || "deepseek-v4-flash",
    model: modelConfig?.model,
    endpoint: modelConfig?.endpoint,
    apiKey: modelConfig?.apiKey,
    cwd: effectiveCwd,
    title: currentConv?.title,
    requestId,
};

// SSE 连接 Agent Server
await new Promise<void>((resolve, reject) => {
    sseClient.connect(backendParams, {
        onDone: () => { resolve(); },
        onError: (error) => {
            // 显示错误到聊天
            appendToConversation(convId, `❌ ${error}`);
            resolve();
        },
    });
});
```

---

## 5. 修复记录（2026-05-26）

以下修复已应用并验证：

### ✅ 修复1: SSEClient AbortError 不再静默吞错误
- **文件**: `packages/ripple-shared/src/sse.ts`
- **改动**: `catch` 块中 `AbortError` 由 `return` 改为调用 `callbacks.onError?.(err.message || "请求被中止") + this._status = "error"`
- **效果**: Promise 不再挂起，错误能正常传播到 ChatView

### ✅ 修复2: 删除重复的 onError 处理器
- **文件**: `src/hooks/useStreamingChat.ts`
- **改动**: 对象字面量中重复的第二个 `onError` 被删除，保留第一个含 `safeResolve()` 的版本
- **效果**: 消除重复注册，`promiseTimeout` 能正确被 clear

### ✅ 修复3: sendMessage 依赖补全
- **文件**: `src/hooks/useStreamingChat.ts`
- **改动**: `agentGatewayUrl`, `onStreamEvent`, `onLog` 加入 `sendMessage` 的 `useCallback` dep 数组
- **效果**: 闭包不再捕获过期值

### ✅ 修复4: StrictMode 防重复注册（最关键的修复）
- **文件**: `src/services/mobileBridge.ts`
- **改动**: 布尔守卫 `isSettingUpChatListener` → 嵌套计数 `setupNestCount`。`setup` 时 +1，`teardown` 时 -1，仅当计数从 0→1 时才真正注册，1→0 时才真正注销
- **效果**: StrictMode 双挂载下 Listener 不会重复注册，手机端消息不会触发两次

### ✅ 修复5: 手机端消息去重
- **文件**: `src/components/MainApp.tsx`
- **改动**: `handleMobileChatRequestRef` 头部添加基于 `sessionId:message` 的 1 秒去重窗口
- **效果**: 即使 Listener 意外重复，同一消息也不会被处理两次

### ✅ 修复6: isProcessing 同步锁
- **文件**: `src/hooks/useStreamingChat.ts`
- **改动**: 新增 `isProcessingRef` 同步锁。`sendMessage` 入口先检查 ref（同步），通过后立即设置 ref，再异步 `setIsProcessing(true)`
- **效果**: 彻底消除两次 `sendMessage` 同时绕过 `isProcessing` 检查的竞态条件

---

## 6. 第二批修复记录（2026-05-26）

### ✅ 修复7: Bridge 新增 POST /api/sessions/:id 代理路由
- **文件**: `src-tauri/src/mobile_bridge.rs`
- **改动**: 添加 `("POST", path) if path.starts_with("/api/sessions/")` 代理，透传到 Agent Server
- **效果**: 手机端 `saveSession()` 调用通过 Bridge 正常持久化，项目对话不再 404

### ✅ 修复8: 下拉刷新 refreshState 补全
- **文件**: `ripple-mobile/src/hooks/usePullToRefresh.js`
- **改动**: 新增 `refreshState` 状态变量，跟踪 `idle → pulling → ready → refreshing → idle` 流转
- **效果**: ChatHistoryPage/SettingsPage/PlazaPage 的下拉指示器正常显示

### ✅ 修复9: 对话列表事件驱动刷新（移除轮询）
- **文件**: 涉及 3 端 4 个文件
- **改动**:
  - `mobileBridge.ts`: 事件类型加 `"conversations-changed"` / `"session-renamed"` / `"file-tree-changed"`
  - `useStreamingChat.ts`: 对话操作后广播 `conversations-changed`，文件操作后广播 `file-tree-changed`，重命名额外广播 `session-renamed`
  - `ChatPage.jsx` (手机): 添加 3 个事件 handler，移除 30 秒轮询 `setInterval`
- **效果**: 桌面端对话增删改和文件操作实时同步到手机端

### ✅ 修复10: 手机端新建对话同步到桌面端
- **文件**: `ChatPage.jsx` / `mobile_bridge.rs` / `MainApp.tsx`
- **改动**: `handleNewChat()` 调用 Bridge API 传 `sessionId`，Rust 透传，桌面端用 `ensureConversation` 保持 ID 一致
- **效果**: 手机端点"新对话"后桌面端列表即时刷新

### ✅ 修复11: 桌面端重命名同步到手机端
- **文件**: `useStreamingChat.ts` / `mobileBridge.ts` / `ChatPage.jsx`
- **改动**: `renameConversation` 发 `onStreamEvent?.("session-renamed", ...)` 广播
- **效果**: 桌面端重命名后手机端列表标题即时更新

### ✅ 修复12: 手机端新建项目对话不跳转
- **文件**: `ChatPage.jsx` (手机)
- **改动**: `confirmNewProject()` 中 `setCurrentChatId(id)` 后同步写 `localStorage`
- **效果**: 新建项目对话后默认选中新会话，不会跳回旧会话