# Ripple Desktop

**AI 编程助手桌面端** — 基于 Tauri + React 构建，支持双模式对话（普通对话/编程开发）、多模型配置管理、Ripple-Agent 后端集成。

![版本](https://img.shields.io/badge/version-0.4.0-orange)
![平台](https://img.shields.io/badge/platform-Windows-blue)
![技术栈](https://img.shields.io/badge/stack-Tauri_2_|_React_18_|_TypeScript_|_Rust-blue)

---

## 功能特性

### 💬 双模式对话
- **普通对话模式**：无需关联项目，直接与 AI 问答
- **编程开发模式**：关联本地项目文件夹，执行代码操作
- 两种模式自由切换，对话历史按模式分类管理

### 🧠 多模型配置管理
- 支持保存多组大模型配置（OpenAI / 自定义兼容 API）
- 输入框一键切换模型，无需进入设置
- 配置以 JSON 格式持久化到本地磁盘
- 设置面板内可新建/编辑/删除/切换配置

### 📁 项目管理
- 侧边栏项目列表，支持折叠/展开
- 添加本地文件夹作为项目目录（Tauri 原生文件夹选择器）
- 点击项目名称直接打开关联的编程开发对话
- 项目数据持久化到本地 JSON

### 🔌 Ripple-Agent 后端集成
- 流式对话支持，通过 SSE 实时接收 AI 回复
- 会话管理 API，支持多会话切换
- 模型列表自动获取
- 思考过程 + 工具调用展示

### 🎨 双主题
- 浅色/深色模式一键切换
- 代码块背景色与流式渲染保持一致
- 自定义 Monaco 编辑器主题，匹配应用配色

### 🎯 EditBlock 智能预览
- AI 输出代码编辑时自动检测 EditBlock 格式
- 集成 DiffPreview 组件，显示行级差异对比
- 支持模糊匹配警告，应用前可预览变更

### ⏹️ AI 停止按钮
- 流式输出期间可随时停止 AI 生成
- 避免等待时间过长或不需要的回复

### 💬 流式对话
- 实时显示 AI 回复
- Markdown 渲染（表格、列表、引用等）
- 代码块自动高亮 + Monaco 编辑器预览
- 对话历史管理（新建/切换/删除/搜索）

---

## 快速开始

### 环境要求

| 工具 | 版本 |
|------|------|
| Node.js | ≥ 18 |
| Rust | ≥ 1.77 |
| VS Build Tools | 含 Windows SDK |
| Python | ≥ 3.8（桥接服务需要） |
| Ripple-Agent | 后端服务已启动 |

### 安装 & 运行

```bash
# 1. 安装前端依赖
npm install

# 2. 安装 Python 桥接服务依赖
pip install -r bridge/requirements.txt

# 3. 开发模式运行（浏览器）
npm run dev

# 4. 启动桥接服务（另一终端）
npm run bridge

# 5. 或 Tauri 桌面模式运行（自动管理桥接）
npm run tauri:dev
```

浏览器开发模式访问 `http://localhost:1420`，AI 回复使用模拟数据。

### 构建打包

```bash
npm run tauri:build
```

---

## 项目结构

```
ripple-desktop/
├── src/                      # 前端源码（React + TypeScript）
│   ├── components/
│   │   ├── ChatMessage.tsx   # 消息气泡（集成 EditBlock 预览）
│   │   ├── ChatView.tsx      # 主聊天视图（含窗口控制）
│   │   ├── CodeEditor.tsx    # Monaco 代码编辑器（自定义主题）
│   │   ├── EditBlockPreview.tsx # EditBlock 差异预览组件
│   │   ├── MessageInput.tsx  # 消息输入框（停止按钮）
│   │   ├── SettingsPanel.tsx # 设置面板（多模型配置管理）
│   │   ├── Sidebar.tsx       # 侧边栏（项目+对话列表）
│   │   └── ErrorBoundary.tsx # 全局错误边界
│   ├── hooks/
│   │   ├── useSettings.ts    # 设置管理
│   │   ├── useStore.ts       # 统一存储层（JSON/localStorage）
│   │   ├── useStreamingChat.ts # 流式对话管理（支持停止）
│   │   ├── useBridge.ts      # WebSocket 桥接
│   │   ├── useEditBlockDetector.ts # EditBlock 检测 Hook
│   │   ├── useProjects.ts    # 项目管理
│   │   ├── useFolderPicker.ts # 文件夹选择器
│   │   └── useTauri.ts       # Tauri 环境检测
│   ├── services/
│   │   ├── api.ts            # HTTP API 客户端
│   │   └── sse.ts            # SSE 流式客户端
│   ├── types/                # TypeScript 类型定义
│   │   └── index.ts
│   ├── styles/
│   │   └── globals.css
│   ├── App.tsx
│   └── main.tsx
├── src-tauri/                # Tauri Rust 后端
│   ├── src/
│   │   ├── lib.rs            # IPC 命令
│   │   ├── main.rs
│   │   └── ws_client.rs      # WebSocket 客户端
│   └── tauri.conf.json
├── bridge/                   # Python 桥接服务
│   ├── bridge_server.py      # WebSocket 服务
│   └── requirements.txt
├── doc/                      # 开发文档
│   ├── DEVELOPMENT-01.md     # 开发进展记录
│   ├── 经验教训.md           # 踩坑记录
│   └── 开发计划-前端对接ripple-agent.md
├── .gitignore
├── package.json
├── tailwind.config.js
└── vite.config.ts
```

---

## 配置说明

### 模型配置管理

应用支持保存多组大模型配置，以 JSON 格式持久化。

| 模式 | 存储位置 | 说明 |
|------|---------|------|
| Tauri 桌面 | `{app_data_dir}/config.json` | JSON 文件持久化 |
| 浏览器开发 | `localStorage` | 自动降级 |

### 配置文件结构

```json
{
  "app_settings": {
    "activeModelId": "cfg_abc123",
    "modelConfigs": [
      {
        "id": "cfg_abc123",
        "name": "我的 OpenAI",
        "provider": "custom",
        "endpoint": "https://api.openai.com/v1",
        "apiKey": "sk-...",
        "model": "gpt-4o",
        "createdAt": 1712345678000
      }
    ],
    "darkMode": false
  },
  "projects": [
    {
      "id": "proj_xxx",
      "name": "我的项目",
      "directory": "C:\\projects\\my-app",
      "createdAt": 1712345678000
    }
  ]
}
```

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | [Tauri 2.x](https://v2.tauri.app/) |
| 前端框架 | [React 18](https://react.dev/) + [TypeScript](https://www.typescriptlang.org/) |
| 构建工具 | [Vite 6](https://vitejs.dev/) |
| 样式方案 | [Tailwind CSS 3](https://tailwindcss.com/) |
| 代码编辑器 | [Monaco Editor](https://microsoft.github.io/monaco-editor/) |
| Markdown | [react-markdown](https://github.com/remarkjs/react-markdown) + remark-gfm |
| 图标库 | [lucide-react](https://lucide.dev/) |
| 后端语言 | Rust（IPC 命令 + WebSocket 客户端） |
| 桥接服务 | Python（WebSocket 服务） |
| 文件选择器 | @tauri-apps/plugin-dialog |
| 后端 API | Ripple-Agent（HTTP + SSE） |

---

## UI 配色方案

| Token | 浅色 | 深色 |
|------|------|------|
| 主背景 `surface` | `#F7F7F5` | `#141416` |
| 卡片背景 `surface-secondary` | `#FFFFFF` | `#1C1C1F` |
| 强调色 `accent` | `#D97757` | `#D97757` |
| 主文字 `content` | `#1A1A1A` | `#E8E8E8` |
| 用户消息 | `#FFFFFF` | `#262629` |
| AI 消息 | `#F0F0EB` | `#18181B` |
| 代码块背景 | `#F5F5F5` | `#1A1A1E` |
| 边框 | `#E8E8E5` | `#2C2C30` |
