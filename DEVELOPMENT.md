# 开发进展

> 版本: 0.2.0 | 更新: 2026-05-14

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

#### 问题 1：项目点击后下方新建普通对话（项目对话模型待澄清）

**现象**：点击左侧项目名称，侧边栏对话列表下方会多出一条普通（chat 模式）对话。

**根因分析**：`Sidebar.handleSelectProjectConversation` 调用 `chat.newConversation("code", projectId)` 创建开发对话。但此操作与其他对话创建逻辑可能存在冲突，导致额外生成一条 mode="chat" 的普通对话。

**核心设计澄清**：
```
项目对话 ≠ 特殊实体
项目对话 = 普通对话 + 可选的 OpenCode 执行能力
```

即项目本身就是一个聊天记录，和普通对话完全一样，唯一区别在于：
- 输入框底部多一个 **OpenCode 模型选择器**
- 选中 OC 模型后发送的消息走 `opencode run --model <id> "<command>"` 执行
- 不选 OC 模型时和普通对话行为完全一致

**当前表现与预期差异**：
| 预期 | 当前 |
|------|------|
| 点击项目 → 打开该项目的聊天（已有则切换，无则新建） | 会额外生成普通对话 |
| 项目对话列表只显示一条记录 | 显示多条（普通 + 开发） |
| 项目对话的输入框底部有 OC 模型选择器 | 有 ✅ |

**待修复方向**：
- 排查 `handleSelectProjectConversation` 与 `chat.conversations` 的交互
- 确保 `chat.newConversation("code", projectId)` 不触发副作用创建普通对话
- 考虑改用 find-or-create 模式：只在没有关联对话时新建

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

### ❌ 未解决 / 待办

#### 高优先级
- [ ] **问题 1 修复**：项目点击不产生多余普通对话
  - 排查 `handleSelectProjectConversation` 的副作用
  - 确保 projectId 关联正确
- [ ] **问题 2 修复**：OpenCode 命令结果在前端显示
  - 解决 WebSocket keepalive 超时
  - 修复回调时序与 activeConversationId 匹配
- [ ] 桥接服务与 Tauri 自动联动
  - 目前需手动启动 `npm run bridge`
  - 期望 Tauri 启动时自动拉起 Python 桥接进程

#### 中优先级
- [ ] Python 桥接服务对接真实 AI API（非 OpenCode）
- [ ] 文件编辑与代码执行结果展示
- [ ] 对话上下文管理与记忆
- [ ] OpenCode CLI 版本检测与兼容性检查

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
