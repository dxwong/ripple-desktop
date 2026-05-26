# Ripple Mobile Bridge — 架构文档（已更新）

> **文档版本**: 2026-05-26  
> **当前状态**: 手机→Bridge→桌面端链路已通，SSE连接Agent时"request was aborted"

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

## 3. 当前 Bug 状态

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