# ripple-desktop 前端开发计划

> **目标**：将 ripple-desktop-Tauri 前端从 OpenCode CLI + Python Bridge 架构切换为直接对接 ripple-agent 后端，最终产品形态对标 Claude Desktop。  
> **创建日期**：2026-05-17  
> **负责人**：前端同事  
> **后端支持**：ripple-agent 团队

---

## 一、后端可运行性分析结论

### 结论：✅ 可以运行，有一个小问题需处理

ripple-agent 后端已构建完成（dist 产物齐全），依赖已安装，.env 已配置 DEEPSEEK_API_KEY。

**唯一问题**：`.env` 文件位于项目根目录，但 `npm start` 会 `cd packages/server`，导致 dotenv 找不到 `.env`。

**推荐启动方式**（在根目录执行）：
```bash
cd E:\MyBrain\dev\other\pi-mono\ripple-agent
node packages/server/dist/index.js
```
或复制 `.env` 到 `packages/server/` 后用 `npm start`。

**验证清单**：
- [ ] 服务器启动成功，监听 3002 端口
- [ ] `GET http://localhost:3002/api/models` 返回模型列表
- [ ] `POST http://localhost:3002/api/chat` 能正常流式对话
- [ ] `GET http://localhost:3002/api/sessions` 返回会话列表

> **需要协调的事项**：确认 DEEPSEEK_API_KEY 是否仍然有效。如果失效，需要后端同事提供新的 Key。

---

## 二、产品形态对标：Claude Desktop

ripple-desktop 的最终形态对标 Claude Desktop，核心 UI 特征：

| 特征 | Claude Desktop | ripple-desktop 现状 | 差距 |
|------|---------------|---------------------|------|
| 三栏布局（侧边栏+聊天+输入） | ✅ | ✅ 已有 | 无 |
| 流式 Markdown 渲染 | ✅ | ✅ 已有 | 无 |
| 代码块高亮+复制 | ✅ | ✅ 已有 | 无 |
| 浅色/深色主题 | ✅ | ✅ 已有 | 无 |
| 思考过程折叠展示 | ✅ | ⚠️ 基础实现 | 需优化动画 |
| 工具调用卡片展示 | ✅ | ❌ 缺失 | **需新增** |
| 文件/图片上传 | ✅ | ❌ 缺失 | **需新增** |
| Artifacts 分屏预览 | ✅ | ❌ 缺失 | **需新增** |
| 对话时间分组 | ✅ | ❌ 缺失 | 需新增 |
| 停止生成按钮 | ✅ | ❌ 缺失 | 需新增 |
| 快捷键系统 | ✅ | ⚠️ 仅 Enter | 需补充 |

---

## 三、开发阶段规划

### Phase 1：后端对接（P0 — 基础可用）

**目标**：前端能通过 HTTP/SSE 与 ripple-agent 通信，完成基本对话功能。

#### 1.1 新建 HTTP/SSE 通信层

- **新建** `src/services/api.ts` — HTTP 客户端封装
  - 封装 fetch 请求（GET/POST/DELETE）
  - 配置 baseURL（从 settings 读取，默认 `http://localhost:3002`）
  - 请求/响应拦截器（错误处理、超时）
  - Tauri 环境下的 CORS 处理

- **新建** `src/services/sse.ts` — SSE 流式客户端
  - 封装 `fetch` + `ReadableStream` 解析 SSE 事件
  - 支持 abort（AbortController）
  - 自动重连机制
  - 事件分发器（EventEmitter 模式）

- **新建** `src/services/sessionApi.ts` — 会话管理 API
  - `getSessions()` — 获取会话列表
  - `getSession(id)` — 获取会话详情
  - `deleteSession(id)` — 删除会话
  - `updateSessionTitle(id, title)` — 更新标题

- **新建** `src/services/modelApi.ts` — 模型管理 API
  - `getModels()` — 获取可用模型列表

#### 1.2 重构 useStreamingChat Hook

- **重构** `src/hooks/useStreamingChat.ts`
  - 移除对 useBridge 的依赖
  - 改用 `api.ts` + `sse.ts` 发送消息和接收流
  - 适配 SSE 事件格式（session_id / text / thinking / tool-start / tool-end / done / error）
  - text 事件增量累加拼接
  - thinking 事件收集到 thinking 字段
  - tool-start / tool-end 收集到 toolCalls 数组
  - done 事件触发消息完成
  - error 事件触发错误展示
  - 支持 abort（停止生成）

#### 1.3 适配会话管理

- **重构** `src/hooks/useProjects.ts`（或新建 `useSessions.ts`）
  - 启动时加载会话列表（GET /api/sessions）
  - 新建对话：不传 sessionId，后端自动创建
  - 切换对话：GET /api/sessions/:id 加载历史消息
  - 删除对话：DELETE /api/sessions/:id
  - 对话标题：从 session_id 事件的 title 字段获取

#### 1.4 适配模型列表

- **重构** `src/hooks/useSettings.ts`
  - 启动时从 GET /api/models 获取模型列表
  - 替换硬编码的模型配置
  - 保留本地模型偏好设置（默认模型等）

#### 1.5 新增 ThinkingBlock 组件

- **新建** `src/components/ThinkingBlock.tsx`
  - 可折叠区块，默认折叠
  - 折叠态：显示"思考过程"标签 + Brain 图标 + 展开箭头
  - 展开态：显示完整推理文本，浅色文字
  - 流式思考中：脉冲加载动画
  - 最大高度限制 + 滚动条

#### 1.6 新增 ToolCallCard 组件

- **新建** `src/components/ToolCallCard.tsx`
  - 工具调用卡片，嵌入消息流中
  - 显示：工具名称、执行状态（运行中/完成/错误）
  - 运行中：旋转加载动画
  - 完成：显示结果摘要，可展开查看详情
  - 错误：红色错误提示

#### 1.7 更新类型定义

- **更新** `src/types/index.ts`
  - 扩展 Message 类型（role / content / thinking / toolCalls / usage）
  - 新增 Session 类型
  - 新增 Model 类型
  - 新增 SSEEvent 联合类型
  - 新增 ToolCall 类型

#### 1.8 更新 ChatMessage 组件

- **更新** `src/components/ChatMessage.tsx`
  - 集成 ThinkingBlock 组件
  - 集成 ToolCallCard 组件
  - 适配新的 Message 类型

**Phase 1 验收标准**：
- [ ] 前端能发送消息并收到流式响应
- [ ] 思考过程正确折叠展示
- [ ] 工具调用正确展示状态
- [ ] 会话列表能加载、切换、删除
- [ ] 模型列表从后端获取
- [ ] 停止生成功能正常

---

### Phase 2：UI 增强（P1 — 体验提升）

**目标**：对标 Claude Desktop 的核心交互体验。

#### 2.1 停止生成按钮

- **更新** `src/components/MessageInput.tsx`
  - 流式输出时，发送按钮变为停止按钮（Square 图标）
  - 点击停止按钮调用 abort
  - 快捷键 `Escape` 停止生成

#### 2.2 对话时间分组

- **更新** `src/components/Sidebar.tsx`
  - 会话列表按时间分组：今天 / 昨天 / 过去 7 天 / 更早
  - 分组标题使用浅色小字

#### 2.3 对话重命名

- **更新** `src/components/Sidebar.tsx`
  - 双击对话标题进入编辑模式
  - Enter 确认，Escape 取消
  - 调用 POST /api/sessions/:id/title

#### 2.4 消息操作按钮

- **更新** `src/components/ChatMessage.tsx`
  - hover 时显示操作按钮组：复制 / 重新生成
  - 复制按钮：复制 AI 回复的纯文本
  - 快捷键 `Ctrl+Shift+C` 复制最后一条回复

#### 2.5 快捷键系统

- **新建** `src/hooks/useHotkeys.ts`
  - `Ctrl+N` — 新建对话
  - `Ctrl+K` — 搜索对话
  - `Escape` — 停止生成
  - `Ctrl+Shift+C` — 复制最后回复
  - `Alt+T` — 切换 Thinking 开关

#### 2.6 错误处理增强

- **更新** `src/services/api.ts`
  - 网络断连检测 + 自动重连提示
  - API 错误统一处理（toast 提示）
  - 请求超时处理（默认 30s）
  - 后端未启动时的友好提示

#### 2.7 输入体验优化

- **更新** `src/components/MessageInput.tsx`
  - textarea 自适应高度
  - 发送后自动聚焦
  - 流式输出中禁止发送（或排队）
  - 输入框 placeholder 根据状态变化

**Phase 2 验收标准**：
- [ ] 停止生成功能流畅
- [ ] 对话列表按时间分组
- [ ] 对话可重命名
- [ ] 消息可复制
- [ ] 快捷键正常工作
- [ ] 网络异常有友好提示

---

### Phase 3：高级功能（P2 — 差异化）

**目标**：补充 Claude Desktop 的差异化功能。

#### 3.1 文件/图片上传

- **更新** `src/components/MessageInput.tsx`
  - 添加附件按钮（Paperclip 图标）
  - 支持拖拽上传文件
  - 支持 Ctrl+V 粘贴图片
  - 上传预览卡片（文件名、大小、类型图标、移除按钮）
  - 需要后端配合：multipart/form-data 或 base64 内嵌

#### 3.2 Artifacts 分屏预览

- **新建** `src/components/ArtifactsPanel.tsx`
  - 右侧分屏面板（可关闭/展开）
  - 支持代码预览（Monaco Editor 只读模式）
  - 支持文档预览（Markdown 渲染）
  - 支持图表/SVG 预览
  - 需要后端配合：识别 Artifacts 内容并标记

#### 3.3 统计面板

- **新建** `src/components/StatsPanel.tsx`
  - Token 消耗统计（输入/输出/缓存）
  - 费用统计
  - 缓存命中率
  - 按模型分组统计
  - 数据来源：GET /api/stats/summary

#### 3.4 对话固定（Pin）

- **更新** `src/components/Sidebar.tsx`
  - 右键菜单支持"固定对话"
  - 固定对话显示在列表顶部
  - 需要后端配合或本地存储

#### 3.5 代码编辑器增强

- **更新** `src/components/CodeEditor.tsx`
  - 代码块支持一键复制
  - 代码块支持语言切换显示
  - 长代码块折叠

**Phase 3 验收标准**：
- [ ] 文件上传功能正常
- [ ] Artifacts 面板可预览代码和文档
- [ ] 统计面板数据准确
- [ ] 对话可固定

---

### Phase 4：清理与优化（P1 — 收尾）

**目标**：移除废弃代码，优化性能。

#### 4.1 移除 Python Bridge

- **删除** `bridge/` 目录（bridge_server.py、requirements.txt、test_sse.py）
- **删除** `src/hooks/useBridge.ts`
- **删除** `src-tauri/src/ws_client.rs`
- **清理** `src-tauri/src/lib.rs` 中 WebSocket 相关 IPC 命令
- **清理** `package.json` 中无用的依赖

#### 4.2 简化 Rust 后端

- **更新** `src-tauri/src/lib.rs`
  - 移除 WebSocket 相关代码
  - 仅保留必要的 IPC 命令（文件对话框、窗口控制等）
  - 如需要，添加 HTTP 代理功能（解决 CORS）

#### 4.3 性能优化

- 虚拟滚动（长对话列表）
- 消息列表懒加载
- Markdown 渲染缓存
- 代码块懒加载

#### 4.4 构建优化

- Tauri 生产构建配置
- 代码分割
- 资源压缩

**Phase 4 验收标准**：
- [ ] Python Bridge 代码完全移除
- [ ] Rust 后端精简
- [ ] 无 TypeScript 编译警告
- [ ] 生产构建正常

---

## 四、技术方案要点

### 4.1 SSE 客户端实现方案

```typescript
// src/services/sse.ts 核心逻辑
async function* streamChat(params: ChatRequest, signal?: AbortSignal) {
  const response = await fetch(`${BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal,
  });

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = JSON.parse(line.slice(6));
        yield data; // { type: 'text'|'thinking'|'done'|... }
      }
    }
  }
}
```

### 4.2 Tauri 环境 CORS 处理

Tauri 2.x 中前端运行在 `tauri://localhost` 协议下，直接 fetch 外部 HTTP API 可能遇到 CORS 问题。解决方案：

**方案 A（推荐）**：在 ripple-agent 后端添加 CORS 中间件
```typescript
// ripple-agent packages/server/src/index.ts
app.use(cors({ origin: '*' }));
```

**方案 B**：通过 Tauri Rust 层转发请求
```rust
// src-tauri/src/lib.rs
#[tauri::command]
async fn proxy_request(url: String, body: String) -> Result<String, String> {
    // 转发 HTTP 请求到 ripple-agent
}
```

**方案 C**：使用 Tauri HTTP 插件（绕过 CORS）
```rust
// tauri.conf.json
{ "plugins": { "http": { "scope": ["http://localhost:3002/**"] } } }
```

### 4.3 状态管理方案

采用 React Context + useReducer 的轻量方案，不引入额外状态管理库：

```
AppContext
├── SessionContext    — 会话列表、当前会话、消息列表
├── SettingsContext   — 模型配置、主题、后端地址
└── UIContext         — 侧边栏状态、面板状态、加载状态
```

---

## 五、文件变更清单

### 新建文件

| 文件 | 说明 | Phase |
|------|------|:-----:|
| `src/services/api.ts` | HTTP 客户端封装 | 1 |
| `src/services/sse.ts` | SSE 流式客户端 | 1 |
| `src/services/sessionApi.ts` | 会话管理 API | 1 |
| `src/services/modelApi.ts` | 模型管理 API | 1 |
| `src/components/ThinkingBlock.tsx` | 思考过程折叠组件 | 1 |
| `src/components/ToolCallCard.tsx` | 工具调用卡片组件 | 1 |
| `src/hooks/useSessions.ts` | 会话管理 Hook | 1 |
| `src/hooks/useHotkeys.ts` | 快捷键 Hook | 2 |
| `src/components/StatsPanel.tsx` | 统计面板 | 3 |
| `src/components/ArtifactsPanel.tsx` | Artifacts 分屏面板 | 3 |

### 重构文件

| 文件 | 变更内容 | Phase |
|------|---------|:-----:|
| `src/hooks/useStreamingChat.ts` | 移除 useBridge，改用 api+sse | 1 |
| `src/hooks/useSettings.ts` | 模型列表从后端获取 | 1 |
| `src/types/index.ts` | 扩展类型定义 | 1 |
| `src/components/ChatMessage.tsx` | 集成 ThinkingBlock + ToolCallCard | 1 |
| `src/components/MessageInput.tsx` | 停止按钮、文件上传、快捷键 | 2-3 |
| `src/components/Sidebar.tsx` | 时间分组、重命名、固定 | 2-3 |
| `src/App.tsx` | 适配新的数据流 | 1 |

### 删除文件（Phase 4）

| 文件 | 说明 |
|------|------|
| `bridge/` 目录 | Python Bridge 服务 |
| `src/hooks/useBridge.ts` | Tauri IPC 桥接 Hook |
| `src-tauri/src/ws_client.rs` | WebSocket 客户端 |

---

## 六、风险与依赖

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| DEEPSEEK_API_KEY 失效 | 无法对话 | 协调后端同事提供新 Key |
| CORS 问题 | 前端无法请求后端 | 后端添加 CORS 中间件 |
| 后端 API 变更 | 前端适配工作 | 约定 API 版本管理 |
| Tauri 2.x HTTP 限制 | 跨域请求失败 | 使用 Rust 层代理或 HTTP 插件 |
| SSE 连接不稳定 | 流式中断 | 自动重连 + 断点续传 |

---

## 七、里程碑时间线

| 里程碑 | 内容 | 预计工作量 |
|--------|------|-----------|
| **M1** | Phase 1 完成：后端对接 + 基本对话 | 3-5 天 |
| **M2** | Phase 2 完成：UI 增强 + 交互优化 | 2-3 天 |
| **M3** | Phase 3 完成：高级功能 | 3-5 天 |
| **M4** | Phase 4 完成：清理 + 优化 | 1-2 天 |

**总预计**：9-15 个工作日

---

## 八、下一步行动

1. **立即**：验证 ripple-agent 后端能否正常运行（按第一节启动方式）
2. **协调**：确认 DEEPSEEK_API_KEY 有效性，确认后端 CORS 策略
3. **开始**：Phase 1.1 — 新建 HTTP/SSE 通信层
