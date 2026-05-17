# Ripple Desktop 前端开发计划 v1.0

> **版本**：1.0
> **更新日期**：2026-05-18
> **负责角色**：前端开发（本人）
> **后端团队**：ripple-agent 团队（不可擅自修改后端代码）
> **聚焦范围**：Phase 1 — 会话持久化 + 编程链路就绪
> **文档定位**：立项讨论稿，非执行方案。关键决策点需团队讨论后再推进编码。

---

## 目录

- [一、现状：核心编程链路可用吗？](#一现状核心编程链路可用吗)
- [二、关键发现：会话存储机制深度调查](#二关键发现会话存储机制深度调查)
- [三、需要立项讨论的决策点](#三需要立项讨论的决策点)
- [四、Phase 1 聚焦目标：让会话不丢](#四phase-1-聚焦目标让会话不丢)
- [五、向后端团队提出的问题](#五向后端团队提出的问题)
- [六、开发纪律](#六开发纪律)

---

## 一、现状：核心编程链路可用吗？

### 1.1 一句话结论

**能用，但有两条命门**：
1. 刷新页面所有对话丢失（会话纯内存，无持久化）
2. 后端重启后已有会话无法恢复（有 bug）

### 1.2 当前用户完整体验链路

```
用户打开 Ripple Desktop
  │
  ├─ 启动检测 backend → 有 DeepSeek API Key → 已连接
  │
  ├─ 点击"新建对话" → conversations[] 加一条，activeConversationId 指向它
  │
  ├─ 输入消息 "帮我创建一个 React 组件"
  │    │
  │    ├─ sendMessage(content, useBackend=true, modelConfig, cwd)
  │    │    │
  │    │    ├─ addMessage("user", content)            ← 用户消息追加到内存
  │    │    ├─ SSEClient.connect({ message, sessionId: 前端genId(), ... })
  │    │    │    │
  │    │    │    └─ POST /api/chat → SSE 流返回
  │    │    │         ├─ thinking 增量 → appendThinkingToConversation()
  │    │    │         ├─ text 增量     → appendToConversation()
  │    │    │         ├─ tool-request  → 弹出确认横幅
  │    │    │         ├─ tool-start    → appendToConversation("🔧 工具名...")
  │    │    │         ├─ tool-end      → appendToConversation("✅ 工具名 完成")
  │    │    │         └─ done          → 结束
  │    │    │
  │    │    └─ 所有消息仅存于 useState(conversations) 内存中
  │    │
  │    └─ 用户看到流式回复
  │
  └─ 用户 F5 刷新 → 💥 conversations = []，全部丢失
```

### 1.3 当前架构核心缺陷

| 缺陷 | 影响 | 严重程度 |
|------|------|:--------:|
| 会话 ID 由前端 `genId()` 随机生成 | 切换对话时后端 Agent 上下文对不上 | 🔴 |
| conversations 仅存 useState 内存 | 刷新即丢 | 🔴 |
| Server `.json` 与 Agent `.jsonl` 不同步 | 前端想存没处存，后端存了前端读不到 | 🔴 |
| 后端重启后 `.jsonl` 被 `create()` 覆盖 | 已有会话永久丢失 | 🔴 |
| 前端从未调用 `POST /api/sessions/:id` | Server `.json` 文件始终为空 | 🟡 |

---

## 二、关键发现：会话存储机制深度调查

> 以下结论基于对后端源代码的逐行审查，非推测。

### 2.1 整体架构：两套存储系统，各自独立，互不同步

```
┌──────────────────────────────────────────────────────────┐
│  Server 层 (packages/server/src/index.ts)                │
│                                                          │
│  存储格式: .json 文件（单一文件，平面结构）               │
│  路径:     data/sessions/<sessionId>.json                │
│  模型:     SessionData { id, title, model, messages[],   │
│                          createdAt, updatedAt }          │
│  写入:     仅通过 POST /api/sessions/:id 手动写入        │
│  读取:     前端 GET /api/sessions → 列表                │
│                   GET /api/sessions/:id → 详情           │
│  用途:     UI 展示（会话列表、历史消息）                  │
│  数据完整: 当前始终为空（前端从未调 POST 保存）           │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│  Agent 层 (packages/agent/src/harness/session/)          │
│                                                          │
│  存储格式: .jsonl 文件（JSON Lines，树形结构）            │
│  路径:     data/sessions/<sessionId>.jsonl                │
│  模型:     SessionTreeEntry（9 种节点类型，链表链接）      │
│           包含: message / thinking_level_change           │
│                 model_change / compaction / branch_summary│
│                 custom / custom_message / label / session_info  │
│  写入:     message_end / turn_end / agent_end 事件自动追加│
│  读取:     Agent 内部方法：getPathToRoot() / getBranch()  │
│  用途:     Agent 运行时状态恢复、上下文构建、对话树导航   │
│  数据完整: 实时最新（每次 message_end 立即写入）           │
└──────────────────────────────────────────────────────────┘

        ⚠  中间隔了一堵墙——Server 不读 .jsonl，
           Agent 不写 .json。两者各自为政。
```

### 2.2 完整数据模型（每个字段都有来源依据）

#### Server 层 SessionData

```typescript
// 文件: packages/server/src/index.ts :301-308
interface SessionData {
  id: string;
  title: string;
  model: string;
  messages: unknown[];    // AgentMessage[] — 见下文
  createdAt: number;
  updatedAt: number;
}
```

#### AgentMessage 消息结构（消息体）

消息体由 3 种标准类型 + 4 种扩展类型组成。以下是 `/api/chat` SSE 流中实际产生的数据结构：

**UserMessage**（用户消息）：
```typescript
{
  role: "user",
  content: string | (TextContent | ImageContent)[],
  timestamp: number
}
```

**AssistantMessage**（助手消息）—— **这是核心消息类型，包含 thinking/toolCalls/usage**：
```typescript
{
  role: "assistant",
  content: (TextContent | ThinkingContent | ToolCall)[],
  // content 数组示例:
  // [
  //   { type: "thinking", thinking: "用户想让我创建一个组件..." },
  //   { type: "text", text: "好的，我来创建这个组件。" },
  //   { type: "toolCall", id: "call_xxx", name: "write_file",
  //     arguments: { path: "src/Button.tsx", content: "..." } }
  // ]
  api: string,              // 如 "openai-completions"
  provider: string,          // 如 "deepseek"
  model: string,             // 如 "deepseek-v4-flash"
  usage: {                   // Token 消耗
    input: number,
    output: number,
    cacheRead: number,
    cacheWrite: number,
    totalTokens: number,
    cost: { input, output, cacheRead, cacheWrite, total }
  },
  stopReason: string,        // "stop" | "length" | "toolUse" | "error" | "aborted"
  errorMessage?: string,
  timestamp: number
}
```

**ToolResultMessage**（工具执行结果）—— **注意：此消息的 content 不包含在 tool-end SSE 事件中**：
```typescript
{
  role: "toolResult",
  toolCallId: string,
  toolName: string,
  content: (TextContent | ImageContent)[],   // 工具的输出结果
  isError: boolean,
  details?: any,
  timestamp: number
}
```

#### ContentBlock 内容块类型（4 种）

这是 `content: [...]` 数组中每个块的结构：

| 类型 | type 字段 | 核心字段 | 用途 |
|------|-----------|---------|------|
| **TextContent** | `"text"` | `text: string` | 常规回复文本 |
| **ThinkingContent** | `"thinking"` | `thinking: string` | **AI 思考过程**（此前端 `thinking` 字段的来源） |
| **ToolCall** | `"toolCall"` | `id, name, arguments` | **工具调用信息**（此前端缺失的 toolCalls 数据） |
| **ImageContent** | `"image"` | `data, mimeType` | 图片内容（暂未使用） |

**关键发现：thinking 的存在方式**
- AI 的思考过程并不独立存在"thinking 字段"，而是作为 `AssistantMessage.content` 数组中的 `ThinkingContent` 块
- 后端 Server（index.ts :492-498）在 SSE 流中实时提取 `part.type === 'thinking'` 的增量，推送为独立的 `thinking` 事件
- 但在保存到 `.json` 时，thinking 是 content 数组的一部分，不是一个独立顶层字段

#### Agent 层 SessionTreeEntry（9 种节点）

```typescript
// 文件: packages/agent/src/harness/types.ts :176-250
// 所有节点共享基础:
{
  type: string,       // 节点类型标识
  id: string,         // 8 位 hex ID
  parentId: string | null,  // 父节点 ID，null 表示根
  timestamp: string   // ISO 8601
}
```

| type 值 | 含义 | 额外字段 |
|---------|------|---------|
| `"message"` | **消息节点**（最核心） | `message: AgentMessage` |
| `"thinking_level_change"` | 思维等级变更 | `thinkingLevel: "off"\|"low"\|"medium"\|"high"` |
| `"model_change"` | 模型切换 | `provider, modelId` |
| `"compaction"` | 上下文压缩记录 | `summary, firstKeptEntryId, tokensBefore` |
| `"branch_summary"` | 分支摘要 | `fromId, summary` |
| `"custom"` | 自定义 | `customType, data?` |
| `"custom_message"` | 自定义消息 | `customType, content, display` |
| `"label"` | 标签 | `targetId, label` |
| `"session_info"` | 会话名称 | `name?` |

### 2.3 会话的完整生命周期（代码级验证）

**新建会话时**（Server index.ts :111-156 `AgentManager.getOrCreate()`）：

```
1. agentManager.getOrCreate(sessionId, modelId, options)
2.    → JsonlSessionStorage.create(path, { sessionId, cwd })
3.        → 写入 JSONL 首行：{"type":"session","version":3,"id":"xxx",...}
4.    → toSession(storage) → new Session(storage)
5.    → createAgentHarness({ session, model, tools, ... })
6.    → new EnhancedAgentHarness(...)
7.    → agents Map 缓存
```

**发送消息时**（Agent 内部事件链）：

```
agent.prompt("用户消息")
  → runAgentLoop()
    → emit("message_start")
    → emit("message_update")   ← 流式增量 *N 次
    → emit("message_end")      ← 每次消息完成
        → session.appendMessage(event.message)
        → JSONL 追加一行 {"type":"message", "message":{...}}
    → emit("tool_execution_request")  ← 请求确认
    → emit("tool_execution_start")     ← 开始执行
    → emit("tool_execution_end")       ← 执行完成
    → emit("turn_end")
    → 循环...
  → emit("agent_end")
    → flushPendingSessionWrites()     ← 刷入所有未写入变更
```

**验证结论：**

| 节点 | 是否写入 JSONL | 写入时机 |
|------|:-------------:|---------|
| 用户消息 | ✅ | message_end |
| 助手消息（含 thinking/toolCalls/usage） | ✅ | message_end |
| 工具结果消息 | ✅ | message_end |
| 思考过程（ThinkingContent） | ✅ | 作为 assistant message content 的一部分 |
| 工具调用（ToolCall） | ✅ | 作为 assistant message content 的一部分 |
| 模型切换 | ✅ | model_change 事件 |
| 压缩记录 | ✅ | compaction 事件 |
| **Server `.json` 文件** | ❌ | 前端从未调用 POST /api/sessions/:id |

### 2.4 后端重启恢复问题

当前代码（Server index.ts :135-138）：

```typescript
// 始终使用 create()，即使文件已存在
const sessionStorage = await JsonlSessionStorage.create(
  join(this.sessionsDir, `${sessionId}.jsonl`),
  { sessionId, cwd: projectCwd }
);
```

`JsonlSessionStorage.create()` 的内部实现（jsonl.ts）会**截断已存在的文件并重新写入 header**，导致：

```
重启前: data/sessions/abc.jsonl  (3 条 message entry)
重启后: data/sessions/abc.jsonl  (仅 1 条 session header)
         ↑ 之前的消息全部丢失！
```

正确的做法是检测文件是否存在，存在则用 `open()` 恢复：
```typescript
let sessionStorage;
const filePath = join(this.sessionsDir, `${sessionId}.jsonl`);
try {
  await access(filePath);  // 或 stat
  sessionStorage = await JsonlSessionStorage.open(filePath);
} catch {
  sessionStorage = await JsonlSessionStorage.create(filePath, { sessionId, cwd });
}
```

**这是一个后端 bug，当前阻塞了"会话持久化"目标的实现。**

---

## 三、需要立项讨论的决策点

> 以下问题**不可直接编码**，需要团队讨论达成一致后再执行。

### 决策 1：会话持久化走哪条路？

前端要实现"刷新不丢对话"，有两种架构路径：

| 方案 | 描述 | 优势 | 劣势 | 后端改动 |
|:----:|------|------|------|:--------:|
| **A** | 前端通过 Server REST API（.json）管理会话 | API 已存在、简单直接 | 消息模型简化（无 thinking/toolCall 细节）；前端需主动手动保存每轮消息 | ❌ 无需改动 |
| **B** | 前端通过 Server REST API + 后端补齐 .json 与 .jsonl 同步 | 数据完整，thinking/toolCall 全量保留 | 需后端在 `/api/chat` 结束时自动写入 .json | ✅ 需要：Server 自动同步 .json |
| **C** | 放弃 Server .json，前端直接从 .jsonl 文件读 | 数据最完整 | 需新增 REST API 读取 .jsonl；路径暴露问题 | ✅ 需要：新增 .jsonl 读取 API |

**建议讨论方向**：方案 A 最快，但数据不完整（缺失 thinking/toolCall）。能否先在方案 A 基础上快速上线，再过渡到方案 B？

### 决策 2：重启恢复 bug 谁来修？

当前 `JsonlSessionStorage.create()` 覆盖已有文件的问题，直接影响"会话持久化"的可用性。

**建议**：前端提交 Issue 给后端团队，由后端同事修复。前端可以先在本地做临时绕过（每次启动时检测 `.jsonl` 是否存在），但不建议长期依赖。

### 决策 3：sessionId 由谁生成？

| 方案 | 当前做法 | 问题 | 建议 |
|:----:|---------|------|------|
| 前端 genId() | `Math.random().toString(36).substring(2, 10)` | 8 位随机，碰撞风险；后端被动接受 | 改为前端生成 UUID（如 `crypto.randomUUID()`） |
| 后端返回 | POST /api/chat 不带 sessionId → 后端自动创建并返回 | 需要前端等待 session_id SSE 事件 | 需要确认后端是否真的发送此事件（文档有写但代码未发现） |

**建议讨论方向**：先统一用前端 UUID 方案（改动最小），后续如需后端管理再迁移。

### 决策 4：文件树用哪种方案？

| 方案 | 实现路径 | 优势 | 劣势 |
|:----:|---------|------|------|
| **Tauri IPC** | Rust `fs::read_dir` → IPC 命令 | 快、不依赖后端 | 浏览器模式不可用；需改 Rust 代码 |
| **后端 API** | 后端新增 `GET /api/projects/:id/tree` | 跨环境一致 | 需要后端新增路由 |
| **前端直接读** | Tauri 下用 `@tauri-apps/plugin-fs` | 纯前端、跨环境 | 插件依赖；安全限制 |

**建议讨论方向**：优先评估 Tauri `@tauri-apps/plugin-fs` 的可行性，如果可用则纯前端解决。

---

## 四、Phase 1 聚焦目标：让会话不丢

> 基于上述调查，Phase 1 聚焦**唯一目标**：会话持久化。文件树、ToolCallCard 等后续再议。

### 4.1 Phase 1 范围

**做**：
1. 会话持久化（刷新不丢）
2. sessionId 规范生成
3. 向后端团队报告重启恢复 bug

**不做**：
- ❌ 文件树浏览（Phase 2）
- ❌ ToolCallCard（Phase 2）
- ❌ Diff 预览（Phase 3）
- ❌ 模型列表动态对接（Phase 2）

### 4.2 方案预研：四种持久化策略对比

在等待后端讨论期间（决策 1），前端可以先做"本地持久化"作为保底方案：

| 策略 | 存储位置 | 数据范围 | 优点 | 缺点 |
|:----:|---------|---------|------|------|
| **① 纯本地** | `localStorage` / Tauri Store 插件 | 全部 conversations | 离线可用、无依赖 | 不跨设备；后端不可见 |
| **② Server REST API** | Server `.json` 文件 | 平面 messages | 后端可见、可恢复 | 数据不完整（缺 thinking/toolCall） |
| **③ 混合（推荐）** | 本地 Store + Server API | 两者皆有 | 本地保底 + 后端同步 | 需处理冲突 |
| **④ Agent JSONL** | 直接读 Agent `.jsonl` | 完整数据 | 最完整 | 需新增 API（后端工作） |

**建议**：先做**策略 ① + ② 的混合模式**——
- 本地 Tauri Store 作为主要存储（保证刷新不丢）
- 后端 Server API 作为辅助同步（让后端也知道会话存在）
- 等后端修复 bug 并补齐数据后，再过渡到策略 ③

### 4.3 Phase 1 任务细分

#### 任务 1.1：本地持久化层

**目标**：将 conversations 从纯内存改为 Store 持久化。

**技术选型**：
- Tauri 环境 → `@tauri-apps/plugin-store`（已安装 v2.4.3）
- 浏览器环境 → `localStorage`（已有 `useStore.ts` 封装）

**改造点**：

| 文件 | 改动 |
|------|------|
| `hooks/useStreamingChat.ts` | 每次 conversations 变化时自动保存到 Store；启动时从 Store 加载 |
| `hooks/useStore.ts` | 扩展 Tauri Store 支持（当前仅支持 JSON） |
| `types/index.ts` | 扩展 Conversation 类型，增加 `backendSynced` 标记 |

**数据流**：

```
启动时: useStore.load("conversations") → setConversations(loaded)
运行时: setConversations(...) → useEffect → useStore.save("conversations", ...)
关闭/刷新前: 数据已在 Store 中，即时可用
```

**无需后端协助**。

---

#### 任务 1.2：Server API 同步层

**目标**：可选同步到后端 Server `.json`，使会话在后端可见。

**改造点**：

| 文件 | 改动 |
|------|------|
| `hooks/useStreamingChat.ts` | `sendMessage()` 完成后调 `saveSession()` |
| `services/api.ts` | `saveSession()` 已有，无需改动 |

**同步时机**：
- 每轮对话完成（收到 `done` 事件后）
- 切换对话时
- 删除对话时

**数据转换**（前端 Message → 后端 SessionData.messages）：

```
前端 Message:
{
  id, role, content, thinking, timestamp
}

后端 AgentMessage:
{
  role: "user" | "assistant" | "toolResult",
  content: [
    { type: "text", text: content } |          ← content 映射
    { type: "thinking", thinking: thinking } |  ← thinking 映射
    { type: "toolCall", id, name, arguments }   ← 暂缺
  ],
  timestamp
}
```

**⚠️ 映射问题**：
- 当前前端 `Message` 类型将 `thinking` 作为独立字段，而后端 `AssistantMessage` 将 `ThinkingContent` 作为 `content[]` 数组中的一个块
- 当前前端无 `ToolCall` 字段，而后端有 `ToolCall` 块
- 同步到后端时，需要做格式转换

**需要讨论**：这个映射转换在前端做还是后端做？

---

#### 任务 1.3：sessionId 规范生成

**现状**：`genId() = Math.random().toString(36).substring(2, 10)`（8 位，碰撞风险）

**改造**：改为 `crypto.randomUUID()`（标准 UUID v4）

**涉及文件**：
- `hooks/useStreamingChat.ts`：替换 `genId()` 实现
- `types/index.ts`：无需改动

**无需后端协助**。

---

#### 任务 1.4：向后端报告重启恢复 bug

**bug 详情**：

| 项目 | 内容 |
|------|------|
| 位置 | `packages/server/src/index.ts` 第 135-138 行（`AgentManager.getOrCreate()`） |
| 问题 | 始终调用 `JsonlSessionStorage.create()`，会截断已有 `.jsonl` 文件 |
| 修复方案 | 改用 `fs.access` 检测文件存在性，存在则调 `JsonlSessionStorage.open()` |
| 影响范围 | 所有已有会话在重启后端后丢失 |
| 优先级 | 🔴 阻塞 Phase 1 目标 |

---

### 4.4 Phase 1 验收标准

- [ ] 创建对话后 F5 刷新页面，对话仍在
- [ ] 多轮对话内容（含 thinking）在刷新后完整恢复
- [ ] sessionId 使用 UUID v4 标准格式
- [ ] 切换对话不会丢失上下文
- [ ] 删除对话本地和远端同步
- [ ] 后端重启恢复 bug 已报告（或已修复）

---

## 五、向后端团队提出的问题

> 以下问题需要后端同事确认，前端方可推进对应工作。

### Q1：Server .json 文件的定位是什么？

当前 Server 层维护了一套 `.json` 文件的 `SessionData` 存储，并提供了完整的 REST API（GET/POST/DELETE）。但：
- 这套数据与 Agent 内部的 `.jsonl` **没有任何同步机制**
- 前端从未通过 API 写入，所有 `.json` 文件始终为空
- 即使前端写入，消息格式也需要前端做转换（缺少 ToolCall 字段）

**问题**：Server 的 `.json` 存储是否应该废弃？还是应该让它成为 Agent `.jsonl` 的"读视图"？

### Q2：能否让 /api/chat 结束时自动写入 .json？

当前 `/api/chat` 处理完请求后不做任何持久化。如果能让它在 `agent_end` / `done` 后自动将本轮对话写入 `data/sessions/<sessionId>.json`，前端就不需要主动调用 `POST /api/sessions/:id` 了。

**问题**：后端团队是否愿意在 Server 层增加这个自动保存逻辑？

### Q3：create() 覆盖 bug 何时修复？

`JsonlSessionStorage.create()` 在 session 已存在时覆盖文件的问题（详见 2.4 节），**直接阻止了"刷新不丢会话"这个核心目标的达成**。

**问题**：后端团队能否排期修复？我们前端可以先在本地做 localStorage 保底，但这不是长久之计。

### Q4：session_id SSE 事件是否已实现？

工作空间说明文档（第 137 行）提到 SSE 事件包含 `session_id` 类型，但后端 Server 代码（index.ts :469-539）中未发现该事件的发送逻辑。确认：
- 如果已实现 → 前端可以直接用
- 如果未实现 → 前端继续用自己生成的 sessionId

---

## 六、开发纪律

1. **不改后端代码**：所有后端需求通过[第五节](#五向后端团队提出的问题)提出，后端同事确认后方可修改
2. **先讨论再编码**：本节提出的四个决策点，需与后端团队讨论达成一致后再开始 Phase 1
3. **改前读文档**：修改核心文件前，先阅读 `开发进展与交接文档.md`（doc/）和 `经验教训.md`（doc/）
4. **一次只改一个 Bug**：每次提交聚焦单一改动
5. **及时推送**：每次修改代码后 `git add + commit + push`

---

## 附录：关键文件速查

| 文件 | 作用 | 前端开发关注点 |
|------|------|---------------|
| `packages/server/src/index.ts` | 后端 Server，REST API + SSE | 所有前端 API 的对应端 |
| `packages/agent/src/harness/session/storage/jsonl.ts` | JSONL 存储实现 | `.jsonl` 格式定义 |
| `packages/agent/src/harness/session/session.ts` | Session 类（对话树操作） | 理解 appendMessage 流程 |
| `packages/agent/src/harness/types.ts` | Session 相关类型 | SessionTreeEntry 9 种节点 |
| `packages/agent/src/harness/messages.ts` | 自定义消息 + 消息转换 | AgentMessage → ContentBlock 映射 |
| `node_modules/@ripple/ai/src/types.ts` | AI 核心类型 | ContentBlock / Usage / Model |
| `src/services/api.ts` （前端） | HTTP API 客户端 | 已有，Phase 1 可能扩展 |
| `src/services/sse.ts` （前端） | SSE 流式客户端 | 已有，无需改动 |
| `src/hooks/useStreamingChat.ts` （前端） | 流式对话 Hook | Phase 1 核心改造点 |
| `src/hooks/useStore.ts` （前端） | 统一存储层 | Phase 1 扩展 Tauri Store 支持 |
| `src/types/index.ts` （前端） | 类型定义 | Phase 1 扩展消息映射类型 |

---

> **下一阶段（Phase 2）方向预告**（仅记录，不展开）：
> - 文件树浏览
> - ToolCallCard 结构化展示
> - 模型列表动态对接
> - 停止生成按钮
> - 对话时间分组 / 重命名
