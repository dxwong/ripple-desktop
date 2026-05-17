# 开发进展

> 版本: 0.3.0 | 更新: 2026-05-14

---

## v0.2.0 里程碑

### ✅ 已解决

#### 核心框架
- [x] Tauri 2.x + React 18 + TypeScript + Vite 6 项目搭建
- [x] Tailwind CSS 样式体系 + 自定义配色方案
- [x] 浅色/深色双主题切换
- [x] 自定义 Monaco 编辑器双主题（匹配应用配色）

#### 对话系统
- [x] 流式对话（逐块追加，无闪烁）
- [x] Markdown 渲染（表格/列表/引用/代码块）
- [x] 代码块 Monaco 编辑器预览（流式用轻量 pre，完成用 Monaco）
- [x] 对话历史管理（新建/切换/删除/搜索）
- [x] 编程开发模式对话 & 普通对话模式
- [x] **OpenCode CLI 流式输出支持**（实时显示执行结果）

#### 输入框
- [x] 发送按钮始终显示（无文字时置灰）
- [x] 自适配高度 textarea
- [x] 双模型选择器：对话模型 + OpenCode 开发模型
- [x] OpenCode 模型选择器仅代码模式显示
- [x] 选中 OC 模型时对话模型禁用（二选一逻辑）
- [x] 手动输入 OpenCode 模型名称
- [x] **模型选择器传递模型 ID 而非显示名称**

#### 模型配置管理
- [x] 多模型配置保存/编辑/删除/切换
- [x] JSON 文件持久化（Tauri 写入 config.json）
- [x] 浏览器环境 localStorage 自动降级
- [x] 旧版 localStorage 数据自动迁移
- [x] 设置面板：配置列表 + 字段重排

#### 项目管理
- [x] 项目列表（侧边栏上半部分）
- [x] 项目折叠/展开
- [x] 添加本地文件夹作为项目（Tauri 原生文件夹选择器）
- [x] 点击项目名称直接打开关联对话
- [x] 删除项目确认弹窗
- [x] 项目数据 JSON 持久化

#### 侧边栏
- [x] 三区域布局：顶部(Logo/搜索/状态) | 上半(项目) | 下半(对话)
- [x] 搜索过滤对话
- [x] 窗口拖拽区域（titlebar-drag）
- [x] 桥接状态指示器

#### 窗口管理
- [x] 移除独立 Titlebar，消除双 Logo
- [x] 窗口控制按钮移至聊天区右上角
- [x] 侧边栏顶部设为拖拽区域

#### 桥接服务
- [x] Python WebSocket 服务（bridge_server.py）
- [x] `execute_opencode` 支持 `--model` 参数
- [x] **`execute_opencode_streaming` 流式执行（实时输出）**
- [x] `get_opencode_config` 读取 OpenCode 配置
- [x] 文件读写（read_file / write_file / list_dir）
- [x] Tauri IPC 桥接命令注册
- [x] **超时时间优化（300秒）**

#### Rust 后端
- [x] `save_config` / `load_config` JSON 配置读写
- [x] `read_opencode_config` OpenCode 配置直读
- [x] `connect_bridge` / `disconnect_bridge` / `send_to_bridge`
- [x] **`send_to_bridge_no_wait` 不等待响应的发送（流式专用）**
- [x] WebSocket 事件循环转发 `bridge-message` 事件
- [x] 对话框插件（文件夹选择器）

#### UI 优化
- [x] 全局基础字号 14px → 15px
- [x] 代码块背景色白天/夜间一致
- [x] 对话区域宽度 max-w-3xl → max-w-5xl
- [x] 全面审查并提升所有组件文字大小

### 🐛 已知问题

#### 问题 1：项目点击后下方新建普通对话 ✅ 已修复

**现象**：点击左侧项目名称，侧边栏对话列表下方会多出一条普通对话。

**根因**：项目被设计为"先添加项目实体，点击时再创建对话"，但实际上**项目本身就应该是一条对话**。添加项目时没有同时创建聊天记录，导致点击项目时创建的新对话与项目列表中的项目实体重复展示。

**核心设计**：
```
项目 = 一条聊天记录（带 projectId 的 chat 对话）
项目列表中的条目 = 对话列表的快捷入口（不是独立实体）
```
- 添加项目时**立即创建一条 chat 对话**，标题=项目名，关联 projectId
- 对话列表**过滤掉有关联项目的对话**（避免重复展示）
- 项目列表中的条目点击时直接切换到内部对话
- 有 projectId 的对话，输入框自动显示 OC 模型选择器

#### 问题 2：OpenCode 模型选择后发送，UI 无数据显示

**现象**：
1. 桥接服务日志显示命令成功执行并返回数据
2. 但前端聊天 UI 不显示任何内容（无新消息气泡）

**桥接日志**：
```
[Bridge] 执行 OpenCode（流式）: hi (model=opencode/minimax-m2.5-free)
[Bridge] 执行（流式）: opencode run --model opencode/minimax-m2.5-free "hi"
[Bridge] 客户端连接已断开
[Bridge] ERROR: Task exception... keepalive ping timeout
```

**根因分析**（已发现两个关键问题）：

1. **WebSocket keepalive 超时断连**
   - Tauri Rust 端 WebSocket 默认 keepalive ping 约 10 秒
   - OpenCode CLI 首次执行耗时较长（下载模型等），期间无数据返回
   - 桥接无数据返回 → 无 WebSocket 消息 → ping 超时 → 连接断开
   - **临时修复**：已降级为同步 `execute_opencode`（非流式），但仍需验证

2. **流式回调竞态条件**
   - `useStreamingChat.sendMessage` 中先 `sendStreamingMessage` 后 `setMessageCallback`
   - 桥接响应可能在回调注册前到达，导致数据丢失
   - **临时修复**：已调整为先注册回调再发送消息，但仍需验证

3. **可能的 `activeConversationId` 不匹配**
   - `appendToLastAssistant` 依赖 `activeConversationId`
   - 回调函数捕获的 `activeConversationId` 可能与当前活跃对话不一致
   - 需要确认消息追加到正确的对话

**待修复方向**：
- 在桥接 `execute_opencode_streaming` 中添加定时心跳，防止 keepalive 超时
- 或增加 Rust 端 WebSocket ping 超时时间
- 使用 ref 而非 state 管理回调，确保闭包始终指向最新值
- 添加日志追踪消息流转路径（前端→IPC→Rust→WS→Python→WS→Rust→事件→前端）

### ✅ 已修复

#### 问题 1：项目点击后下方新建普通对话

**修复**（v0.2.0）：

**核心逻辑修正**：项目本身就是一条聊天记录，不是"先加项目再为它创建对话"。

**改动**：
1. **`handleAddProject` 添加时立即创建对话**：`projects.addProject` 后立即 `chat.newConversation("chat", projectId, projectName)`，项目名就是对话标题。
2. **`Sidebar` 对话列表过滤掉项目对话**：`conversations.filter(c => !c.projectId && ...)`，避免项目在下方对话列表重复出现。
3. **`handleSelectProjectConversation` 只切换不创建**：点击项目名直接 `find` 已有对话 → `switchConversation`，仅兼容旧数据时兜底创建。
4. **OC 选择器按 `hasProject` 显示**：`MessageInput.isCodeMode = chatMode==="code" || hasProject`，使有项目的 chat 对话也能出现 OC 模型选择器。
5. **`ChatView` UI 条件扩展**：头部徽标、空状态、快捷建议统一改为 `chatMode === "code" || project`。

**涉及文件**：
- `src/App.tsx`：`handleAddProject` 添加时创建对话；`handleSelectProjectConversation` 仅切换
- `src/components/Sidebar.tsx`：对话列表过滤 `!c.projectId`
- `src/components/MessageInput.tsx`：新增 `hasProject` prop
- `src/components/ChatView.tsx`：UI 条件扩展

#### 问题 2：OpenCode 命令结果在前端显示

**修复**（v0.2.0）：

**① Rust 后端死锁修复（根因）**：
`send_to_bridge` 原实现持有 `SharedWsClient` 锁等待响应 → `ws_event_loop` 无法读取 WebSocket 回包和 ping → 桥接超时断开。
- 改为**两阶段执行**：
  ```
  阶段一：持锁 → 插入 pending 记录 → 发送消息 → 释放锁
  阶段二：无锁等待 oneshot 响应（ws_event_loop 可正常读消息和响应 ping）
  ```
- 后台事件循环在等待期间可正常接收数据、响应 WebSocket ping

**② 简化前端逻辑**：
- 放弃复杂的流式路径，统一使用**同步路径**（`bridge.sendMessage` + `send_to_bridge`）
- 同步路径最稳定，加上锁修复后无死锁问题
- 所有路径使用 `appendToConversation(targetConvId, result)` 显式指定目标对话

**③ Python 桥接：关闭 stdin 防止 CLI 进入交互模式**：
OpenCode CLI 执行完命令后因 stdin 未关闭而进入交互 shell（显示 `$` 提示符），`proc.communicate()` 永远不返回，直到超时。
- `execute_opencode`、`execute_opencode_streaming`、`execute_shell` 均添加 `stdin=subprocess.DEVNULL`
- CLI 执行完单条命令后自动退出，不再等待输入

**④ Rust 双锁架构（彻底消除死锁）**：
**根因**：`ws_event_loop` 和 `send_to_bridge`/`send_to_bridge_no_wait` 共用一把 `SharedWsClient` 的 `Mutex`。当 `ws_event_loop` 持有锁等待 WebSocket 消息时，任何发送操作都无法获取锁 → 死锁。

**方案**：将 WebSocket 流从 `WebSocketClient` 中分离，使用两把独立锁：

| 锁 | 保护对象 | 谁持有 |
|------|---------|-------|
| `client` 锁 | `state`（连接状态）+ `pending_requests` | 短暂持锁设/取 pending |
| `ws_stream` 锁 | WebSocket 流（收发消息） | 发消息或读消息时持锁 |

**各路径的锁行为**：
```
ws_event_loop:       ws_stream锁(读消息) → client锁(路由) → 释放 → 循环
send_to_bridge:      client锁(设pending) → ws_stream锁(发消息) → 释放两锁 → 无锁等响应
send_to_bridge_no_wait: ws_stream锁(发消息) → 释放
```

两路径只在各自需要的瞬间持锁，`ws_event_loop` 读消息时 `send_to_bridge` 可自由设 pending 和发消息，互不阻塞。

**涉及文件**：
- `src-tauri/src/lib.rs`：适配新架构，命令简化
- `src-tauri/src/ws_client.rs`：`SharedWsClient` 重构为双锁，移除旧 `WebSocketClient` 中的 stream
- `bridge/bridge_server.py`：三个子进程函数加 `stdin=subprocess.DEVNULL`
- `src/hooks/useStreamingChat.ts`：简化同步路径

### ⚠️ 已知限制

#### `opencode run` 非逐 token 流式（已解决 ✅）
改用 `opencode serve` HTTP/SSE 方案替代 `opencode run`：
- 桥接通过 `POST /session/{id}/message` 获取 SSE 流
- 逐 token 解析 `event: message.part.delta` 中的 `part.content`
- 实时转发到前端，实现打字机效果
- 依赖新增 `aiohttp`

#### bridge_server.py 的 import re
`_strip_ansi` 函数使用 `re.sub()`，文件顶部必须有 `import re`（曾漏掉导致崩溃）。

#### Rust 后端锁架构（已修复）
WebSocket 事件循环独占 stream，通过 mpsc channel 接收发送命令，`tokio::select!` 同时处理收发。详见上方修复记录。

### ✅ v0.3.0 已修复

#### Bug：流式输出重叠词 ✅ 已修复 (2026-05-14)

**现象**：UI 显示 "有什么有什么 我可以我可以 帮你帮你"，每个 token 出现两次，相邻拼接。

**根因**：`useBridge.ts` 的 `useEffect` 中 `setupListeners` 是 async 函数（`await import` + `await listen`），但 React cleanup 同步执行。React StrictMode 触发 `挂载→清理→挂载` 时，第一个 `setupListeners` 的 `await` 还没完成，cleanup 就执行了（此时 `unlistenRef` 为空，无监听器可清理）。第一个 `await` 完成后注册的监听器"泄漏"下来，与第二个 `setupListeners` 注册的监听器叠加 → 两个 `bridge-message` 监听器 → 每个 token 被 `appendToConversation` 两次。

**修复**：在 `setupListeners` 中加 `cancelled` 标志，cleanup 时设 `cancelled=true`，每个 `await` 后检查并清理。

**涉及文件**：
- `src/hooks/useBridge.ts` — 添加 `cancelled` 竞态防护 + 监听器数量日志

**为什么第一次修复失败**：此前尝试相同修复时，同时改了 `ChatMessage.tsx`（加了 `{message.content && (` 条件渲染），导致 content 为空的 AI 消息不渲染，被误认为"UI 无输出"。实际是条件渲染的副作用，不是 cancelled 标志的问题。

### ❌ 未解决 / 待办

#### ⚠️ 架构笔记（2026-05-14 调试记录，部分已过时）

以下是在调试流式输出重叠词 bug 过程中确认的事实：

1. **POST /session/{id}/message 响应是 JSON，不是 SSE** ✅ 已确认
   - content-type: `application/json`
   - SSE 流只能从 `/event` 端点获取

2. **bridge_server.py 使用 `_listen_events` + `/event` + `readline()` 解析 SSE** ✅ 已确认
   - 直连测试 35 token，零连续重复
   - 不要改成从 POST 响应体读 token

3. **`经验教训.md` 第 3 条已过时**
   - 原来说"POST 响应体是 SSE 流"——那是设计假设，实测是 JSON
   - 已在经验教训 #9 中纠正

4. **`useEffect` async cleanup 竞态 → 双重监听 → token 重复** ✅ 已修复
   - 根因在 `useBridge.ts`，不在 bridge、不在 Rust、不在 token 拼接
   - 详见经验教训 #8

5. **前端 `conversations` 闭包过期** ✅ 已修复
   - `sendMessage` 改用 `conversationsRef` 替代闭包变量
   - `addMessage` 使用 `activeConversationIdRef` 确保写到正确对话

6. **ChatMessage 条件渲染** ⚠️ 曾导致误判
   - `{message.content && (` 包裹消息气泡会导致 content 为空时不渲染
   - 已移除该条件，保持与原始代码一致

1. **POST /session/{id}/message 响应是 JSON，不是 SSE**
   - content-type: `application/json`
   - 响应体示例：`{"info":{"parentID":"msg_xxx","role":"assistant",...}`
   - SSE 流只能从 `/event` 端点获取
   - **不要**试图从 POST 响应体读 token

2. **bridge_server.py 当前使用 `readline()` 解析 /event SSE**
   - 不用手写 buffer + `\n\n` 分割
   - 直连测试证明输出干净无重复

3. **`经验教训.md` 第 3 条关于 "POST 响应体是 SSE 流" 的说法是错的**
   - 那是设计假设，不是实测结论
   - 已在经验教训第 8 条中纠正

4. **Python `__pycache__` 可能导致旧代码运行**
   - 改了 `.py` 但 `.pyc` mtime 更新 → Python 优先加载缓存
   - 务必删除 `bridge/__pycache__/` 后重启

5. **前端 `conversations` 闭包过期已修复**
   - `sendMessage` 改用 `conversationsRef` 替代闭包变量
   - `activeModeRef` 替代 `activeConversation?.mode`
   - 依赖数组不再包含 `activeConversation?.mode`

#### 高优先级
- [ ] 桥接服务与 Tauri 自动联动
  - 目前需手动启动 `npm run bridge`
  - 期望 Tauri 启动时自动拉起 Python 桥接进程

#### 中优先级
- [ ] Python 桥接服务对接真实 AI API（非 OpenCode）
  - 跳过 opencode CLI，前端直接调大模型 API，可获真实流式效果
- [ ] OpenCode CLI 版本检测与兼容性检查
- [ ] 流式输出期间显示"思考中……"提示（目前 20-30 秒静默，用户无反馈）

#### 低优先级 / 未来规划
- [ ] 系统托盘
- [ ] 快捷键支持
- [ ] 多语言 i18n
- [ ] 对话导出功能
- [ ] 自定义 prompt 模板
- [ ] MCP 服务对接
- [ ] 代码审查与 diff 对比
- [ ] 单元测试 + E2E 测试

---

## 版本历史

| 版本 | 日期 | 主要变更 |
|------|------|---------|
| v0.2.0 | 2026-05-14 | 双模式对话、项目管理、OpenCode 集成、侧边栏重构、输入框双模型选择、流式输出 |
| v0.3.0 | 2026-05-14 | opencode serve SSE 流式集成（真实逐 token 打字机效果） |
| v0.2.1 | 2026-05-14 | Bug 修复：项目即对话、Rust 锁死锁（channel+select! 架构）、桥接流式清洗输出 |
| v0.1.0 | - | 初始版本：基础聊天、多模型配置、双主题、流式对话 |

---

## 架构说明

```
┌─ 前端 (React) ─────────────────────────────────┐
│  App.tsx                                        │
│  ├── Sidebar.tsx    (项目列表 + 对话列表)       │
│  ├── ChatView.tsx   (聊天消息 + 顶部栏)         │
│  │   └── MessageInput.tsx (双模型选择器)        │
│  ├── SettingsPanel.tsx (多模型配置管理)          │
│  └── hooks/                                     │
│      ├── useStreamingChat.ts → 流式对话管理      │
│      ├── useBridge.ts      → Tauri IPC 桥接      │
│      │   ├── sendMessage()          → 同步请求    │
│      │   ├── sendStreamingMessage() → 流式请求    │
│      │   └── setMessageCallback()   → 响应回调    │
│      ├── useSettings.ts    → 设置+模型持久化     │
│      └── useProjects.ts    → 项目持久化          │
├── Tauri (Rust) ─────────────────────────────────┤
│  lib.rs: IPC 命令                                │
│  │   ├── send_to_bridge          → 等待响应      │
│  │   └── send_to_bridge_no_wait  → 不等待响应    │
│  ws_client.rs: WebSocket → Python 桥接           │
│  │   ├── send_request()   → 等待响应            │
│  │   └── send_no_wait()   → 不等待响应          │
├── Python ───────────────────────────────────────┤
│  bridge_server.py: WebSocket 服务 + OpenCode CLI │
│  │   ├── execute_opencode()           → 同步执行  │
│  │   └── execute_opencode_streaming() → 流式执行  │
└─────────────────────────────────────────────────┘
```

### 数据流（编程开发模式 - 同步）

```
用户输入 → MessageInput → App.handleSendMessage
  → useStreamingChat.sendMessage(opencode模型)
  → useBridge.sendMessage("execute_opencode", {command, cwd, model})
  → Tauri IPC invoke("send_to_bridge")
  → Rust WebSocket send_request() → Python Bridge
  → opencode run [--model <id>] "<command>"
  → 完整结果返回 → 追加到对话
```

### 数据流（编程开发模式 - 流式）

```
用户输入 → MessageInput → App.handleSendMessage
  → useStreamingChat.sendMessage(opencode模型)
  → useBridge.setMessageCallback(handler)  // 设置响应回调
  → useBridge.sendStreamingMessage("execute_opencode_streaming", {command, cwd, model})
  → Tauri IPC invoke("send_to_bridge_no_wait")  // 不等待响应
  → Rust WebSocket send_no_wait() → Python Bridge
  → opencode run [--model <id>] "<command>"
  → Python 逐行读取输出 → send_response(status="stream", data={chunk})
  → Rust 事件循环 → app.emit("bridge-message")
  → 前端事件监听 → callback → appendToLastAssistant(chunk)
  → 执行完成 → send_response(status="ok")
```

### 关键技术要点

#### 模型选择器
- 模型列表结构：`{ id: string, name: string, provider?: string }`
- 显示给用户的是 `name`（友好名称）
- 传递给 OpenCode CLI 的是 `id`（完整模型标识，如 `opencode/deepseek-v4-flash-free`）

#### 流式输出设计
- **避免超时断开**：使用 `send_to_bridge_no_wait` 命令，发送后立即返回
- **实时响应**：Python 端按行读取命令输出，逐行发送 `stream` 状态消息
- **事件驱动**：Rust 端将所有非 pending 消息转发为 `bridge-message` 事件
- **回调处理**：前端通过 `setMessageCallback` 注册回调，处理流式数据

#### 超时配置
- Python 命令执行超时：300 秒（可配置）
- Rust WebSocket 响应超时：120 秒
- Tauri invoke 超时：180 秒（流式请求不适用）

### 配置持久化

```
Tauri 环境:  useStore → Rust save_config → {app_data_dir}/config.json
浏览器环境:  useStore → localStorage → key: ripple-*
```

---

## 快速开始

### 前置条件
- Node.js >= 20
- Python >= 3.10
- OpenCode CLI 已安装并配置

### 启动开发

```bash
# 安装依赖
npm install

# 启动桥接服务（新开终端）
npm run bridge

# 启动开发服务器
npm run tauri dev
```

### 构建生产版本

```bash
npm run tauri build
```

---

## 命令参考

### IPC 命令

| 命令 | 功能 | 参数 | 返回 |
|------|------|------|------|
| `connect_bridge` | 连接桥接服务 | - | `void` |
| `disconnect_bridge` | 断开桥接服务 | - | `void` |
| `get_bridge_status` | 获取连接状态 | - | `"connected" \| "disconnected" \| "connecting" \| "error"` |
| `send_to_bridge` | 发送消息并等待响应 | `msgType: string, data: any` | `{ status: string, data: any }` |
| `send_to_bridge_no_wait` | 发送消息不等待响应 | `msgType: string, data: any` | `"消息已发送"` |
| `save_config` | 保存配置 | `config: string` | `void` |
| `load_config` | 加载配置 | - | `string` |
| `read_opencode_config` | 读取 OpenCode 配置 | - | `string` |

### Python 桥接消息类型

| 类型 | 功能 | 参数 | 响应 |
|------|------|------|------|
| `ping` | 心跳检测 | - | `{ pong: number }` |
| `execute_opencode` | 执行 OpenCode（同步） | `command, model?, cwd?` | `{ stdout, stderr, returncode }` |
| `execute_opencode_streaming` | 执行 OpenCode（流式） | `command, model?, cwd?` | 多个 `stream` + 一个 `ok`/`error` |
| `get_opencode_config` | 获取 OpenCode 配置 | - | `{ models, config }` |
| `execute_shell` | 执行 Shell 命令 | `command` | `{ stdout, stderr, returncode }` |
| `read_file` | 读取文件 | `path` | `{ path, content }` |
| `write_file` | 写入文件 | `path, content` | `{ path, written }` |
| `list_dir` | 列出目录 | `path` | `{ path, entries }` |
