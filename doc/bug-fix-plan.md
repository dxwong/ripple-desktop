# Bug 修复方案文档（修正版）

> 项目：ripple-desktop-Tauri + ripple-agent
> 日期：2026-05-21
> 状态：待审批

---

## 一、前后端架构概要

```
用户输入 → useStreamingChat.sendMessage()
  → SSEClient → POST /api/chat (SSE 流)
    → AgentManager.getOrCreate() → EnhancedAgentHarness
    → agent.subscribe() 注册 SSE 事件响应
    → agent.prompt(message) → Agent 主循环
      → agent_start, turn_start, message_start
      → message_update → SSE text/thinking (流式)
      → tool_execution_request → SSE tool-request
        → 前端: autoConfirm ? 自动100ms后批准 : 用户UI操作
        → confirmToolCall() → POST /confirm
      → tool_execution_start/end → SSE tool-start/end
      → turn_end → SSE turn-end (含 hasError)
    → agent_end → SSE done (唯一来源)
  → onDone / onError → resolve Promise → 结束流
```

**SSE 事件协议——done 的唯一来源：**
- **正常路径**：`agent_end` 事件 → 发送 `{ type: 'done' }` → `unsubscribe()`
- **错误路径（catch 块）**：发送 `{ type: 'error' }` → `res.end()` → **不发送 done**
- 前端 `onError` 回调中已调用 `resolve()`，**不会永久卡死**，但协议有缺口

**工具确认流程：**
- `permissionMode` 有 3 档：`"auto"`（自动批）、`"confirm"`（手动确认）、`"read-only"`（只读）
- 前端 `handleToolConfirm()` **未检查** `permissionMode`，read-only 模式下无法阻止程序化调用
- `autoConfirm` 的 `useEffect` 无互斥锁，多个 tool-request 快速到达时可能批准错误的请求

**修复管线 beforeToolCall 数据通路：**
- `agent-loop.ts` 调用 `config.beforeToolCall()` 时传入完整 `BeforeToolCallContext`：
  ```typescript
  interface BeforeToolCallContext {
    assistantMessage: AssistantMessage;  // 包含 content: (TextContent | ThinkingContent | ToolCall)[]
    toolCall: AgentToolCall;
    args: Record<string, unknown>;
    context: AgentContext;
  }
  ```
- `enhanced-agent-harness.ts` 当前只解构了 `{ toolCall, args }`，**丢弃了 `assistantMessage`**
- 从 `assistantMessage.content` 可提取：
  - `TextContent.type === "text"` → `text` → rawResponse
  - `ThinkingContent.type === "thinking"` → `thinking` → reasoningContent
- `AgentState` **没有 `lastResponse`、`rawResponse`、`reasoningContent` 字段**

---

## 二、Bug 修复方案

### B1: sse.ts 空 reader 崩溃 🔵 ✅ 已修复

| 项目 | 内容 |
|------|------|
| **当前状态** | 已修复，无需改动 |
| **根因** | `response.body` 为 null 时 `getReader()` 抛出 TypeError；`abort()` 并发将 `currentReader` 置 null 后 while 循环继续执行 `null.read()` |
| **修复内容** | 双层 null 守卫：① 第 178 行 getReader 后 `if (!this.currentReader)` 提前 return；② 第 202 行 while 入口 `if (!this.currentReader) break` |
| **风险** | 无 |

---

### B5: 重新生成不清旧消息 🔵 ✅ 已修复

| 项目 | 内容 |
|------|------|
| **当前状态** | 已修复，无需改动 |
| **根因** | `sendMessage()` 未清理旧 AI 回复，新回复追加后消息列表重复累积 |
| **修复内容** | `sendMessage()` 第 407-412 行在添加用户消息前，检查最后一条消息是否为 `assistant`，是则用 `slice(0, -1)` 移除 |
| **风险** | 无 |

---

### B6: sessionsLoadedRef 不刷新 🔵 ✅ 已修复

| 项目 | 内容 |
|------|------|
| **当前状态** | 已修复，无需改动 |
| **根因** | `sessionsLoadedRef` 设为 `true` 后在断开连接时未重置，重连后不会重新加载后端会话 |
| **修复内容** | MainApp.tsx 第 140-144 行：新增独立 `useEffect`，监听 `chat.backendConnected` 变化，`false` 时重置 `sessionsLoadedRef.current = false` |
| **风险** | 无 |

---

### B8: read-only 不强制执行 🔵 ✅ 批准，立即执行

| 项目 | 内容 |
|------|------|
| **优先级** | P1 - 低风险高确定性，建议本批执行 |
| **影响文件** | `useStreamingChat.ts` |
| **修复类型** | 增强防护 |

#### 根因

`handleToolConfirm()` 未对 `permissionMode` 做任何检查：

```typescript
const handleToolConfirm = useCallback(
  async (toolCallId: string, approved: boolean, reason?: string) => {
    // ❌ 缺少：if (permissionMode === "read-only" && approved) return;
    const result = await confirmToolCall(sessionId, toolCallId, approved, reason);
  }, []
);
```

当前只在 UI 层禁用了按钮（`ToolConfirmBanner.tsx` 第 91 行 `disabled={readOnly}`），但：
- `F12` 控制台可绕过
- 未来其他代码路径调用 `handleToolConfirm` 时会无意绕过

#### 修复方案

在 `handleToolConfirm` 函数体开头加入权限检查：

**修改文件：** `src/hooks/useStreamingChat.ts` → 函数 `handleToolConfirm`

在 `const sessionId = activeConversationIdRef.current;` 之前插入：

```typescript
if (approved && permissionMode === "read-only") {
  flog.warn('STREAMING', 'read-only 模式下拒绝了工具执行', { toolCallId });
  setPendingToolRequests((prev) => prev.filter((t) => t.toolCallId !== toolCallId));
  return;
}
```

#### 验证方法

1. 设置 `permissionMode = "read-only"`
2. 发起需要工具调用的请求
3. 在控制台调用 `handleToolConfirm(toolCallId, true)`
4. 确认工具未被执行（pending 队列清空，backend 无调用）

#### 影响范围

- 仅 `handleToolConfirm` 函数，5 行代码
- 无状态机变动，无 API 协议变动
- **0 风险**

---

### B7: auto-confirm 竞态 🟡 ✅ 批准，立即执行

| 项目 | 内容 |
|------|------|
| **优先级** | P1 - 中风险，二段防护设计经审批确认正确 |
| **影响文件** | `useStreamingChat.ts` |
| **修复类型** | 二段防护：auto-confirm 前二次验证 + handleToolConfirm 幂等去重 |

#### 根因

第 864-872 行的 auto-confirm useEffect 中，100ms 延迟窗口内用户可能手动拒绝工具：

- T1：`pendingToolRequests = [A]`，auto-confirm 启动 100ms 定时器
- T1+50ms：用户手动拒绝 A，A 从队列移除，新请求 C 到达 → 队列变 `[C]`
- T1+100ms：定时器到期，`req.toolCallId` 仍指向 A
- `confirmToolCall(A.id, true)` 发送到后端 → **前端显示 deny，后端收到 approve**

#### 修复方案

**改动一：autoConfirm useEffect 中增加二次检查**

```typescript
useEffect(() => {
  if (!autoConfirm || pendingToolRequests.length === 0) return;
  const req = pendingToolRequests[0];

  // [新增] 验证 toolCallId 在 conversations 中仍是 pending 状态
  const currentConv = conversationsRef.current.find(
    c => c.id === activeConversationIdRef.current
  );
  if (!currentConv) return;
  const lastMsg = currentConv.messages[currentConv.messages.length - 1];
  if (lastMsg?.role === 'assistant') {
    const targetTc = lastMsg.toolCalls?.find(tc => tc.toolCallId === req.toolCallId);
    if (targetTc && targetTc.status !== 'pending') {
      return; // 状态已被手动变更，跳过
    }
  }

  const timer = setTimeout(() => {
    handleToolConfirm(req.toolCallId, true);
  }, 100);
  return () => clearTimeout(timer);
}, [pendingToolRequests, autoConfirm, handleToolConfirm]);
```

**改动二：handleToolConfirm 中的去重保护**

```typescript
// handleToolConfirm 内部，在 setConversations 乐观更新之前插入：
// [新增] 幂等检查：避免同一 toolCallId 被确认多次
if (sessionId) {
  const existingConv = conversationsRef.current.find(c => c.id === sessionId);
  if (existingConv) {
    for (const msg of existingConv.messages) {
      if (msg.role !== 'assistant') continue;
      const existingTc = msg.toolCalls?.find(tc => tc.toolCallId === toolCallId);
      if (existingTc && existingTc.status !== 'pending') {
        flog.warn('STREAMING', `工具 ${toolCallId} 已被确认/拒绝，跳过`, { status: existingTc.status });
        setPendingToolRequests((prev) => prev.filter((t) => t.toolCallId !== toolCallId));
        return;
      }
    }
  }
}
```

#### 影响范围

- 仅 `useStreamingChat.ts` 内部，~15 行
- 不影响 SSE 协议，不影响 handleToolConfirm 的外部调用者

---

### B4: 修复管线回传参数 🔴 ⛔ 方案重写

| 项目 | 内容 |
|------|------|
| **优先级** | P2 - 高（激活 B3 的前置条件） |
| **影响文件** | `ripple-agent/packages/agent/src/harness/enhanced-agent-harness.ts` |
| **修复类型** | 修正参数传递（基于 `BeforeToolCallContext.assistantMessage`） |

#### 根因

`beforeToolCall` 回调中传递了错误的上下文参数，且原方案错误地假设 `AgentState` 有 `lastResponse` 字段。

**源码验证结果：**
- `AgentState`（types.ts:353-378）：**没有** `lastResponse`、`rawResponse`、`reasoningContent` 字段
- `BeforeToolCallContext`（types.ts:94-100）：**已有** `assistantMessage: AssistantMessage` 字段
- `agent-loop.ts:693-700`：`beforeToolCall` 传入的是**完整** `BeforeToolCallContext`
- `enhanced-agent-harness.ts:336`：只解构了 `{ toolCall, args }`，**丢弃了 `assistantMessage`**
- `AssistantMessage.content` 包含 `(TextContent | ThinkingContent | ToolCall)[]`，其中：
  - `TextContent.type === "text"` 携带 `text: string` → rawResponse 来源
  - `ThinkingContent.type === "thinking"` 携带 `thinking: string` → reasoningContent 来源

| 参数 | 当前值 | 问题 | 正确获取方式 |
|------|--------|------|-------------|
| `rawResponse` | `''`（空字符串） | Scavenge 无法匹配丢失的工具调用 | 从 `assistantMessage.content` 中提取所有 `type === "text"` 的 `text` 拼接 |
| `reasoningContent` | 未传入 | Scavenge 无法从推理内容中抢救 | 从 `assistantMessage.content` 中提取所有 `type === "thinking"` 的 `thinking` 拼接 |
| `turn` | `0`（硬编码） | 不影响核心逻辑 | Harness 内部维护计数器 |
| `recentToolCalls` | `[]`（空数组） | StormBreaker 失效 | Harness 内部维护累加数组 |

#### 修复方案

需要 3 处改动：

**改动一：回调签名增加 `assistantMessage` 解构**

```typescript
// 文件：enhanced-agent-harness.ts 第 336 行
// 当前：
this.agent.beforeToolCall = async ({ toolCall, args }) => {
// 改为：
this.agent.beforeToolCall = async ({ toolCall, args, assistantMessage }) => {
```

**改动二：从 `assistantMessage.content` 提取 rawResponse 和 reasoningContent**

```typescript
const rawResponse = (assistantMessage.content || [])
  .filter((c): c is TextContent => c.type === 'text')
  .map(c => c.text)
  .join('');

const reasoningContent = (assistantMessage.content || [])
  .filter((c): c is { type: 'thinking'; thinking: string } => c.type === 'thinking')
  .map(c => c.thinking)
  .join('');
```

**改动三：harness 内部维护 turn 计数和 toolCall 历史**

```typescript
// [新增] 类级别维护
private repairTurnCounter: number = 0;
private recentToolCallsHistory: RecentToolCall[] = [];

// 在 beforeToolCall 中使用
const repairResult = await this.strategies.toolRepair.process(
  [{ type: "toolCall", id: toolCall.id, name: toolCall.name, arguments: args }],
  {
    rawResponse,
    reasoningContent,
    messages: this.agent.state.messages,
    tools: this.agent.state.tools,
    turn: this.repairTurnCounter++,
    recentToolCalls: [...this.recentToolCallsHistory],
  },
);

// 记录当前调用到历史
this.recentToolCallsHistory.push({
  name: toolCall.name,
  arguments: JSON.stringify(args),
  timestamp: Date.now(),
});
```

**注意：** 需要导入 `TextContent` 类型。`ThinkingContent` 上面使用了内联类型标注，也可考虑导入类型以保持一致性：

```typescript
import type { TextContent, ThinkingContent } from '@ripple/ai';
```

#### 验证方法

1. 激活修复管线后（B3），发送一个会产生重复工具调用的请求
2. 确认 StormBreaker 能正确检测并抑制（日志中有 `repairsApplied: ['stormbreaker']`）
3. 确认 Scavenge 在 DeepSeek 模型产生 `reasoning_content` 时能正确抢救丢失的工具调用
4. 回滚到 `"default"` 配置确认不影响原有行为

#### 回滚方式

单纯 revert `enhanced-agent-harness.ts` 即可，无需改其他文件。

---

### B3: 激活修复管线 🟡 ✅ 有条件批准

| 项目 | 内容 |
|------|------|
| **优先级** | P2 - 依赖 B4 完成后才能激活 |
| **影响文件** | `ripple-agent/packages/server/src/index.ts` |
| **修复类型** | 修改 createAgentHarness 配置 + feature flag |

#### 根因

Server 端创建 Agent 时未传入修复管线配置，走默认 `NoOpToolCallRepair`：

```typescript
const harness = createAgentHarness({
  env, session, model, systemPrompt, tools, getApiKeyAndHeaders,
  // ❌ 缺少: strategies: { toolRepair: "pipeline" }
});
```

#### 前置条件

- **必须等 B4 修完并验证通过**后才能激活（B4 提供正确的 rawResponse/reasoningContent/turn/recentToolCalls）
- 默认关闭，通过环境变量控制

#### 修复方案

**修改文件：** `ripple-agent/packages/server/src/index.ts` 第 373-384 行

```typescript
const enableRepairPipeline = process.env.RIPPLE_ENABLE_REPAIR_PIPELINE === '1';

const harness = createAgentHarness({
  env, session, model, systemPrompt, tools, getApiKeyAndHeaders,
  strategies: {
    toolRepair: enableRepairPipeline ? "pipeline" : "default",
  },
});
```

**安全措施：**
1. `RIPPLE_ENABLE_REPAIR_PIPELINE` 环境变量控制，默认关闭
2. 运行时日志记录每次 repair 动作（修复类型、调用次数），便于问题追溯
3. 桌面端无灰度机制，建议：默认关闭 → 加日志 → 下个版本默认开启

#### 验证方法

1. 不设置环境变量时，确认走 NoOp 路径（日志无 `repairsApplied`）
2. 设置 `RIPPLE_ENABLE_REPAIR_PIPELINE=1`，确认管线被激活
3. 发送一个会产生重复工具调用的请求，确认 StormBreaker 生效

#### 回滚方式

直接关掉环境变量，0 影响，立即生效。

---

### B2: 错误路径 done 🔵 ✅ 方案正确但优先级低

| 项目 | 内容 |
|------|------|
| **优先级** | P3 - 协议完整性优化，当前代码不会崩溃 |
| **影响文件** | `ripple-agent/packages/server/src/index.ts` |
| **修复类型** | 协议补齐 |

#### 根因

第 1445-1493 行 catch 块中，发生错误后发送 `{ type: 'error' }` 但不发送 `{ type: 'done' }` 就直接 `res.end()`。

```
正常路径: agent_end → type:done → unsubscribe → res.end()
错误路径: catch    → type:error                  → res.end()  ← 没有 done
```

**为什么不会崩溃：** 前端 `onError` 回调（useStreamingChat.ts:665）中已调用 `resolve()`，Promise 会被正确解决，流程不会卡死。当前代码不修也不会出功能性问题。

#### 修复方案

**修改文件：** `ripple-agent/packages/server/src/index.ts` 第 1492-1493 行间

```typescript
// catch 块末尾，在 res.write(errorEvent) 之后、catch 块闭合之前插入：
try {
  res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
} catch { /* 连接已关闭，忽略 */ }

if (!unsubscribed) {
  unsubscribed = true;
  unsubscribe();
}
```

5 行代码，无风险，但不急。

---

## 三、修复优先级和排期（修正版）

| 优先级 | Bug ID | 工作量 | 风险 | 依赖 | 建议排期 |
|--------|--------|--------|------|------|---------|
| P0 | B1/B5/B6 | 0（已修复） | 无 | 无 | ✅ 已完成 |
| **第1批** | **B8** read-only 增强 | 5 行 | 0 | 无 | **立即执行** |
| **第1批** | **B7** auto-confirm 竞态 | ~15 行 | 低 | 无 | **立即执行** |
| **第2批** | **B4** 管线参数回传 | ~30 行 | 中 | 需理解 assistantMessage | **先做** |
| **第2批** | **B3** 激活管线 | 3 行 + feature flag | 低 | B4 必须完成 | **等 B4** |
| **第3批** | **B2** 错误路径 done | 5 行 | 低 | 无 | 不急，当前不修也不崩溃 |

**分批策略：**
- **第1批（立即执行，不涉及后端）**：B8 + B7，集中在 `useStreamingChat.ts`，无后端依赖
- **第2批（后端核心修复）**：B4（修正参数）→ B3（激活管线），串行执行
- **第3批（锦上添花）**：B2（协议补齐）

---

## 四、回滚策略

| Bug | 回滚方式 | 影响 |
|-----|---------|------|
| B8 | revert `useStreamingChat.ts` 中 permission 检查 | 回到 UI 层仅防护 |
| B7 | revert `useStreamingChat.ts` 中 auto-confirm 二段防护 | 回到有轻微竞态的当前状态 |
| B4 | revert `enhanced-agent-harness.ts` | 管线回退到 NoOp |
| B3 | 关掉 `RIPPLE_ENABLE_REPAIR_PIPELINE` 环境变量 | 0 影响，立即生效 |
| B2 | revert `server/index.ts` 修改 | 回到当前状态（前端仍能 work） |

---

## 五、相关文件清单

| 文件 | 需修改 | 归属 Bug |
|------|--------|----------|
| `ripple-agent/packages/agent/src/harness/enhanced-agent-harness.ts` | 是 | B4 |
| `ripple-agent/packages/server/src/index.ts` | 是 | B3, B2 |
| `ripple-desktop-Tauri/src/hooks/useStreamingChat.ts` | 是 | B7, B8 |
| `ripple-desktop-Tauri/src/services/sse.ts` | 否（已修复） | B1 |
| `ripple-desktop-Tauri/src/components/MainApp.tsx` | 否（已修复） | B6 |

---

## 附录：B4 数据通路验证记录

```
agent-loop.ts:693-700
  config.beforeToolCall({
    assistantMessage,    ← 包含 content: (TextContent | ThinkingContent | ToolCall)[]
    toolCall,            ← AgentToolCall
    args,                ← 已验证参数
    context,             ← AgentContext
  }, signal)

enhanced-agent-harness.ts:336
  this.agent.beforeToolCall = async ({ toolCall, args }) => {
    // ❌ 没有解构 assistantMessage
  }

AssistantMessage.content (ai/types.ts:385):
  (TextContent | ThinkingContent | ToolCall)[]

TextContent (ai/types.ts:287):
  { type: "text"; text: string }

ThinkingContent (ai/types.ts:299):
  { type: "thinking"; thinking: string }

AgentState (agent/types.ts:353):
  - 无 lastResponse 字段  ← 原方案错误假设
  - 无 rawResponse 字段
  - 无 reasoningContent 字段
```