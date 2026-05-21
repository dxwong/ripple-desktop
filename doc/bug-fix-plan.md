# Bug 修复方案文档

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
- 前端 `onError` 回调中已调用 `resolve()`，所以不会永久卡死，但协议有缺口

**工具确认流程：**
- `permissionMode` 有 3 档：`"auto"`（自动批）、`"confirm"`（手动确认）、`"read-only"`（只读）
- 前端 `handleToolConfirm()` **未检查** `permissionMode`，read-only 模式下无法阻止程序化调用
- `autoConfirm` 的 `useEffect` 无互斥锁，多个 tool-request 快速到达时可能批准错误的请求

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

### B8: read-only 不强制执行 🔵 ⚠️ 需增强

| 项目 | 内容 |
|------|------|
| **优先级** | P3 - 低（当前仅能防 UI 操作，无法防程序化绕过） |
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
- `F12` 控制台可绕过：`window.__RIpPLE_CHAT?.handleToolConfirm(xxx, true)`
- 未来其他代码路径调用 `handleToolConfirm` 时会无意绕过

#### 修复方案

在 `handleToolConfirm` 函数体开头加入权限检查：

```
修改文件：src/hooks/useStreamingChat.ts → 函数 handleToolConfirm

在 const sessionId = activeConversationIdRef.current; 之前插入：
  if (approved && permissionMode === "read-only") {
    flog.warn('STREAMING', 'read-only 模式下拒绝了工具执行', { toolCallId });
    setPendingToolRequests((prev) => prev.filter((t) => t.toolCallId !== toolCallId));
    return;
  }
```

另外可选：将 `permissionMode` 也作为参数传给后端 `confirmToolCall` API，让后端也做一层防护（`POST /confirm` 中拒绝 read-only 请求），但涉及后端改动较大，暂不纳入本次修复。

#### 验证方法

1. 设置 `permissionMode = "read-only"`
2. 发起需要工具调用的请求
3. 在控制台调用 `handleToolConfirm(toolCallId, true)`
4. 确认工具未被执行（pending 队列清空，backend 无调用）
5. 正常 UI 按钮在 read-only 下已 disabled，无需额外验证

#### 影响范围

- 仅 `handleToolConfirm` 函数
- 无状态机变动
- 无 API 协议变动

---

### B7: auto-confirm 竞态 🟡 ⚠️ 需修复

| 项目 | 内容 |
|------|------|
| **优先级** | P2 - 中 |
| **影响文件** | `useStreamingChat.ts` |
| **修复类型** | 新增互斥锁 |

#### 根因

第 864-872 行的 auto-confirm useEffect：

```typescript
useEffect(() => {
  if (!autoConfirm || pendingToolRequests.length === 0) return;
  const req = pendingToolRequests[0];
  const timer = setTimeout(() => {
    handleToolConfirm(req.toolCallId, true);  // 可能批准了"过期"的请求
  }, 100);
  return () => clearTimeout(timer);
}, [pendingToolRequests, autoConfirm, handleToolConfirm]);
```

竞态场景：
1. T1 时刻：`pendingToolRequests = [A, B]`，auto-confirm 取 A（下标 0）
2. T1+1ms：B 已在后端被手动拒绝（`pendingToolRequests` 变 `[A]`）——数组位移导致 A 仍是正确项，此例无问题
3. **真正的问题**：T1 时队列 `[A]`，auto-confirm 延迟 100ms 后开始执行 `handleToolConfirm(A.id, true)`，但在这 100ms 内：
   - 前端 UI 用户手动拒绝了 A（`handleToolConfirm(A.id, false)`）
   - A 从 `pendingToolRequests` 移除
   - 新的请求 C 到达，队列变 `[C]`
   - auto-confirm 的 100ms 定时器到期 → `req.toolCallId` 仍指向 A
   - A 在 conversation toolCalls 中的 status 已被改为 `denied`
   - `confirmToolCall(A.id, true)` 发送到后端 → **服务端收到的是 approve，但前端已显示 deny**

影响：前后端状态不一致，工具在前端显示已拒绝但实际上被后端执行了。

#### 修复方案

**方案：为 auto-confirm 添加确认前的状态二次验证**

```
修改文件：src/hooks/useStreamingChat.ts

改动一：autoConfirm useEffect 中增加二次检查
  useEffect(() => {
    if (!autoConfirm || pendingToolRequests.length === 0) return;
    const req = pendingToolRequests[0];
    
    // [新增] 验证：确认当前 toolCallId 在 conversations 中仍是 pending 状态
    const currentConv = conversationsRef.current.find(c => c.id === activeConversationIdRef.current);
    if (!currentConv) return;
    const lastMsg = currentConv.messages[currentConv.messages.length - 1];
    if (lastMsg?.role === 'assistant') {
      const targetTc = lastMsg.toolCalls?.find(tc => tc.toolCallId === req.toolCallId);
      if (targetTc && targetTc.status !== 'pending') {
        // 状态已被手动变更（拒绝/批准），跳过自动确认
        return;
      }
    }
    
    const timer = setTimeout(() => {
      handleToolConfirm(req.toolCallId, true);
    }, 100);
    return () => clearTimeout(timer);
  }, [pendingToolRequests, autoConfirm, handleToolConfirm]);
```

改动二：handleToolConfirm 中的去重保护（避免重复确认）
```
修改文件：src/hooks/useStreamingChat.ts → 函数 handleToolConfirm

改动：在同名函数中添加幂等性检查
  // [新增] 幂等检查：避免同一 toolCallId 被确认多次
  const existingConv = conversationsRef.current.find(c => c.id === sessionId);
  if (existingConv) {
    for (const msg of existingConv.messages) {
      if (msg.role !== 'assistant') continue;
      const existingTc = msg.toolCalls?.find(tc => tc.toolCallId === toolCallId);
      if (existingTc && existingTc.status !== 'pending') {
        flog.warn('STREAMING', `工具 ${toolCallId} 已被确认/拒绝，跳过重复操作`, { status: existingTc.status });
        setPendingToolRequests((prev) => prev.filter((t) => t.toolCallId !== toolCallId));
        return;
      }
    }
  }
```

#### 验证方法

1. 切换到 `auto` 模式
2. 发送一个需要多次工具调用的请求
3. 在 100ms 窗口内手动拒绝某个工具
4. 确认该工具状态仍为 `denied`，后端也未执行
5. 其它工具正常自动批准

#### 影响范围

- 仅 `useStreamingChat.ts` 内部
- 不影响 SSE 协议
- 不影响 handleToolConfirm 的外部调用者

---

### B3: 激活修复管线 🟡 🔧 需激活（附带安全措施）

| 项目 | 内容 |
|------|------|
| **优先级** | P2 - 中（需与 B4 一同激活） |
| **影响文件** | `ripple-agent/packages/server/src/index.ts` |
| **修复类型** | 修改 createAgentHarness 配置 |

#### 根因

Server 端创建 Agent 时未传入修复管线配置：

```typescript
const harness = createAgentHarness({
  env, session, model, systemPrompt, tools, getApiKeyAndHeaders,
  // ❌ 缺少: strategies: { toolRepair: "pipeline" }
});
```

`createAgentHarness` 默认使用 `DEFAULT_STRATEGY_CONFIG`（config.ts 第 160-166 行），其中 `toolRepair: "default"` → 走 `NoOpToolCallRepair`

#### 修复方案

需要解决两个前置问题才能安全激活：

**前置条件 A1：先修复 B4 中的参数问题**

（详见 B4 方案，需要修正 `rawResponse`、`recentToolCalls` 参数）

**前置条件 A2：添加 Scavenge 的 reasoningContent 获取通路**

B4 修复了 `rawResponse` 参数后，Scavenge 还依赖 `reasoningContent`（DeepSeek 的思考内容）。当前 `beforeToolCall` 回调中没有获取 `reasoningContent` 的途径。需在 `EnhancedAgentHarness` 中暴露 Agent 最近一次响应的原始内容。

**激活步骤：**

```
修改文件：ripple-agent/packages/server/src/index.ts

第 373-384 行，将：
  const harness = createAgentHarness({
    env, session, model, systemPrompt, tools, getApiKeyAndHeaders,
  });

改为：
  const harness = createAgentHarness({
    env, session, model, systemPrompt, tools, getApiKeyAndHeaders,
    strategies: {
      toolRepair: "pipeline",
    },
  });
```

**安全措施（必须同时实施）：**

1. 添加 feature flag 环境变量 `RIPPLE_ENABLE_REPAIR_PIPELINE`，默认关闭：
   ```typescript
   const enableRepairPipeline = process.env.RIPPLE_ENABLE_REPAIR_PIPELINE === '1';
   const harness = createAgentHarness({
     ...,
     strategies: {
       toolRepair: enableRepairPipeline ? "pipeline" : "default",
     },
   });
   ```

2. 添加管线运行时指标（日志），每次 repair 执行时记录修复类型和调用次数，以便问题回滚时追溯

3. 先灰度 10% 请求，观察 24 小时后再全量开启

#### 验证方法

1. 设置 `RIPPLE_ENABLE_REPAIR_PIPELINE=1`
2. 发送一个 LLM 会生成截断 JSON 参数的消息（如超长文件路径）
3. 确认工具参数被正确修复（Truncation）
4. 确认日志中记录了 `repairsApplied: ['truncation']`
5. 不设置环境变量时，确认仍走 NoOp 路径

#### 影响范围

- 后端 Server 配置
- 需重启后端进程
- 需前端无感知

---

### B4: 修复管线回传参数 🔴 ⚠️ 需修复

| 项目 | 内容 |
|------|------|
| **优先级** | P1 - 高（激活 B3 的前置条件） |
| **影响文件** | `ripple-agent/packages/agent/src/harness/enhanced-agent-harness.ts` |
| **修复类型** | 修正参数传递 |

#### 根因

`beforeToolCall` 回调中传递了错误的上下文参数：

| 参数 | 当前值 | 问题 | 应改为 |
|------|--------|------|--------|
| `rawResponse` | `''`（空字符串） | Scavenge 需要用 LLM 原始响应正则匹配丢失的工具调用 | Agent 最后一条响应的原始文本 |
| `turn` | `0`（硬编码） | 不影响核心逻辑 | Agent 的当前轮次计数 |
| `recentToolCalls` | `[]`（空数组） | StormBreaker 需要累计历史来检测重复模式 | 累计的工具调用历史 |

#### 修复方案

```
修改文件：ripple-agent/packages/agent/src/harness/enhanced-agent-harness.ts

在第 336-347 行的 beforeToolCall 回调中，将：

  const repairResult = await this.strategies.toolRepair.process(
    [{ type: "toolCall", id: toolCall.id, name: toolCall.name, arguments: args }],
    {
      rawResponse: '',                          // ❌
      messages: this.agent.state.messages,
      tools: this.agent.state.tools,
      turn: 0,                                  // ❌
      recentToolCalls: [],                      // ❌
    },
  );

改为：

  // [新增] 获取最近一次 LLM 响应的原始文本和 reasoningContent
  const lastRawResponse = this.agent.state.lastResponse?.rawText ?? '';
  const lastReasoningContent = this.agent.state.lastResponse?.reasoningContent;
  
  // [新增] 维护一个内存中的调用历史列表
  this.recentToolCallsHistory ??= [];
  
  const repairResult = await this.strategies.toolRepair.process(
    [{ type: "toolCall", id: toolCall.id, name: toolCall.name, arguments: args }],
    {
      rawResponse: lastRawResponse,             // ✅
      reasoningContent: lastReasoningContent,   // ✅ 新增
      messages: this.agent.state.messages,
      tools: this.agent.state.tools,
      turn: this.currentTurn ?? 0,              // ✅ 使用实际轮次
      recentToolCalls: [...this.recentToolCallsHistory],  // ✅ 传入历史
    },
  );

  // [新增] 将当前调用记录到历史中（用于后续的 StormBreaker 检测）
  this.recentToolCallsHistory.push({
    name: toolCall.name,
    arguments: JSON.stringify(args),
    timestamp: Date.now(),
  });
```

**注意：** 该修复依赖 Agent 内部状态 `this.agent.state.lastResponse` 的可用性。如果 Agent 类型定义中没有该字段，需要：
- 在 `Agent` 类中添加 `lastResponse` 字段以保存最近一次 LLM 响应的原始文本
- 或在 Agent 的回调中注入一个 record 机制来保存原始响应

需要检查 `@ripple/agent` 的 Agent 类型定义来确认最佳的原始响应获取方式。

#### 验证方法

1. 激活修复管线后（B3），发送一个会产生重复工具调用的请求
2. 确认 StormBreaker 能正确检测并抑制（日志中有 stormbreaker 修复记录）
3. 确认 Scavenge 只在有 reasoning_content 时尝试抢救
4. 回滚到 `"default"` 配置确认不影响原有行为

#### 影响范围

- 仅 `enhanced-agent-harness.ts` 内部
- 需要与 B3 同时上线
- 依赖 Agent 状态的扩展

---

### B2: 错误路径 done 🔴 ❌ 需修复

| 项目 | 内容 |
|------|------|
| **优先级** | P1 - 高 |
| **影响文件** | `ripple-agent/packages/server/src/index.ts` |
| **修复类型** | 协议补齐 |

#### 根因

第 1445-1493 行 catch 块中，发生错误后发送 `{ type: 'error' }` 但不发送 `{ type: 'done' }` 就直接 `res.end()`。

```
正常路径: agent_end → type:done → unsubscribe → res.end()
错误路径: catch    → type:error                  → res.end()  ← 没有 done
```

当前之所以没发生永久卡死，是因为前端 [useStreamingChat.ts#L641-L666](file:///e:/MyBrain/dev/other/pi-mono/ripple-desktop-Tauri/src/hooks/useStreamingChat.ts#L641-L666) 的 `onError` 中调用了 `resolve()`。但这依赖于前端的善意实现——如果把 `onError` 和 `onDone` 分开处理，就会出问题。**协议完整性不应依赖消费端的容错。**

#### 修复方案

**方案 A（推荐——最小改动，协议完备）：**

```
修改文件：ripple-agent/packages/server/src/index.ts

在第 1492 行（res.write(errorEvent)）之后、第 1494 行 catch 块闭合之前，插入：

  // [新增] 链式发送 done 事件，确保协议完整性
  // 无论正常或异常结束，前端都期望收到一个明确的终止事件
  try {
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
  } catch { /* 连接已关闭，忽略 */ }

  // [新增] 确保取消订阅
  if (!unsubscribed) {
    unsubscribed = true;
    unsubscribe();
  }
```

同时，在 `res.on('close')` 处理中也确保 `done` 的语义一致性：
```
修改文件：ripple-agent/packages/server/src/index.ts → res.on('close') 回调

当前在第 1427-1437 行的 close 处理中已正确处理了 unsubscribed，但缺少 rejectAllPending 后的 done 发送。
由于 close 时连接已断开，不需要发送 done（写了也发不出去）。保持现有逻辑即可。
```

**方案说明：** 这套改动最小，只在 catch 块末尾补发了 `done` 事件，使 SSE 协议在正常和异常路径上保持一致。前端无需额外修改。

#### 验证方法

1. 模拟后端异常（如网络断开、API Key 错误、模型不存在）
2. 确认前端能收到 `error` 事件
3. 确认前端能收到 `done` 事件
4. 确认 Promise 正常 resolve
5. 确认 `unsubscribed` 标记正确设置（不会重复 unsubscribe）

#### 影响范围

- 仅 server 端 catch 块
- 前端无需改动
- 不影响正常路径

---

## 三、修复优先级和排期建议

| 优先级 | Bug ID | 工作量 | 依赖 | 建议排期 |
|--------|--------|--------|------|---------|
| P0 | B1/B5/B6 | 0（已修复） | 无 | 已完成，确认即可 |
| P1 | **B2** 错误路径 done | 小（~5行） | 无 | **第1批** |
| P1 | **B4** 管线回传参数 | 中（~20行） | Agent 类型检查 | **第1批**（与B3同批次） |
| P2 | **B3** 激活修复管线 | 小（~3行+安全措施） | B4 必须先修复 | **第1批**（带 feature flag） |
| P2 | **B7** auto-confirm 竞态 | 中（~15行） | 无 | **第2批** |
| P3 | **B8** read-only 增强 | 小（~5行） | 无 | **第2批** |

**分批策略：**
- **第1批（核心稳定）**：B2（协议修复） + B4（参数修复） + B3（带 feature flag 激活管线）
- **第2批（健壮性增强）**：B7（竞态修复） + B8（防护增强）

---

## 四、回滚策略

| Bug | 回滚方式 | 影响 |
|-----|---------|------|
| B2 | revert server/index.ts 修改 | 恢复到当前状态（前端仍能 work） |
| B3 | 关掉 `RIPPLE_ENABLE_REPAIR_PIPELINE` 环境变量即可 | 0 影响，立即生效 |
| B4 | revert enhanced-agent-harness.ts 修改 + 重新 B3 关闭 | 管线回退到 NoOp |
| B7 | revert useStreamingChat.ts 中 auto-confirm 部分 | 恢复到有轻微竞态的当前状态 |
| B8 | revert useStreamingChat.ts 中 permission 检查 | 恢复到 UI 层只防护 |

---

## 五、相关文件清单

| 文件 | 需修改 | 归属 Bug |
|------|--------|----------|
| `ripple-agent/packages/server/src/index.ts` | 是 | B2, B3 |
| `ripple-agent/packages/agent/src/harness/enhanced-agent-harness.ts` | 是 | B4 |
| `ripple-desktop-Tauri/src/hooks/useStreamingChat.ts` | 是 | B7, B8 |
| `ripple-desktop-Tauri/src/services/sse.ts` | 否（已修复） | B1 |
| `ripple-desktop-Tauri/src/components/MainApp.tsx` | 否（已修复） | B6 |