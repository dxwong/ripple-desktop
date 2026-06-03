# 记忆 & 专家模块开发文档

> 适用版本：ripple-desktop v0.4.0+
> 最后更新：2026-06-03
> 维护人：Ripple Desktop Team

---

## 一、模块概览

桌面端的「记忆管理」和「专家管理」是 v2.0 新增的两个独立模块（顶级视图，与「对话」「设置」平级），通过 Sidebar 入口进入。

| 模块 | 路径 | 数据来源 | 后端 | 复杂度 |
|------|------|---------|------|--------|
| **记忆管理** | 左侧 Sidebar → 「记忆」 | 纯文件系统（无后端） | ❌ 无 | 中 |
| **专家管理** | 左侧 Sidebar → 「专家」 | `agent/agents/*.agent.yaml` + `agent/data/squad/checkpoints.json` | ✅ `/api/squad/agents` | 中高 |

---

## 二、记忆模块

### 2.1 核心原理

**纯文件系统实现，无后端**。这是与「专家模块」最大的区别。

```
┌────────────────────────────────────────────────────────┐
│  桌面端（MemoryPage）                                    │
│                                                        │
│  ┌── 通用记忆 Pane ────────────┐  ┌── 项目记忆 Pane ──┐│
│  │ <appRoot>/memory/            │  │ <projectCwd>/      ││
│  │   ├─ MEMORY.md               │  │   ├─ ripple.md     ││
│  │   └─ hot-topics.md           │  │   ├─ agent.md      ││
│  │                              │  │   └─ README.md     ││
│  │ 来源：Tauri 命令             │  │                    ││
│  │       get_app_root()         │  │ 来源：Sidebar 项目 ││
│  │                              │  │       列表（=      ││
│  │                              │  │       有 cwd 的    ││
│  │                              │  │       对话去重）   ││
│  └──────────────────────────────┘  └────────────────────┘│
│                                                        │
│  IO 通路：                                              │
│   - Tauri 模式：Rust fs 命令                            │
│   - 浏览器 dev：localStorage 兜底（已有 syncStore）      │
└────────────────────────────────────────────────────────┘
```

### 2.2 关键路径

| 路径 | 来源 | 说明 |
|------|------|------|
| `<appRoot>` | Tauri 命令 `get_app_root()` 返回 | dev = `apps/ripple-desktop/`（含 `tauri.conf.json`），prod = `.exe` 所在目录 |
| `<appRoot>/memory/MEMORY.md` | 写死 | 核心画像（**已随代码提交**） |
| `<appRoot>/memory/hot-topics.md` | 写死 | 当前活跃主题（**已随代码提交**） |
| `<projectCwd>/ripple.md` | 写死 | 项目级 Ripple 记忆 |
| `<projectCwd>/agent.md` | 写死 | Agent 行为约束 |
| `<projectCwd>/README.md` | 写死 | 项目说明 |

**重要约定**：
- `<appRoot>/memory/` 目录**必须**随代码提交（已在 `.gitignore` 中确认未排除）
- 缺失文件**首次保存时自动创建**（用代码中写死的 `template` 作为初始内容）
- 浏览器 dev 模式（无 Tauri）下走 localStorage 兜底，刷新会丢失

### 2.3 IO 通路（Rust + 前端封装）

#### Rust 命令（`src-tauri/src/lib.rs`）

| 命令 | 入参 | 出参 | 说明 |
|------|------|------|------|
| `get_app_root()` | — | `String` | 向上找 `tauri.conf.json`，找不到回退到 .exe 父目录 |
| `read_text_file(path)` | `String` | `{ content: String, mtime_ms: u64 }` | 返回内容 + mtime（用于显示最后更新） |
| `write_text_file(path, content)` | `String, String` | `()` | 自动创建父目录 |
| `path_exists(path)` | `String` | `bool` | 文件或目录 |
| `ensure_memory_dir(app_root)` | `String` | `()` | 创建 `<appRoot>/memory/` |

#### 前端封装（`src/services/appPaths.ts`）

```ts
import { getAppRoot, ensureMemoryDir, readTextFile, writeTextFile, pathExists } from '../services/appPaths';

// 返回值
interface FileReadResult {
  content: string;
  mtime_ms: number;  // Unix 毫秒
}
```

**降级策略**：`isTauri()` 为 false 时所有方法抛错，调用方需走 localStorage 兜底。

### 2.4 数据流（保存路径）

```typescript
// MemoryPage.tsx:GeneralMemoryPane.handleSave
1. Tauri 模式：writeTextFile(path, content) → 写盘
2. 成功后 re-readTextFile 拿真实 mtime
3. setState 更新 content/saved/mtimeMs
4. logger.success() 通过 LogPanel 输出
5. 失败：logger.error() + 降级 localStorage 暂存

// Q4 决策：保存后调 GET 重新拉取（即时一致性）
```

### 2.5 UI 行为细节

| 状态 | 右侧显示 | 备注 |
|------|---------|------|
| 文件脏 | `未保存` (橙) | 触发条件：`content !== saved` |
| 文件未创建 | `等待创建` | 触发条件：`exists === false` |
| 文件已存（磁盘有 mtime） | `最后更新 2026-06-03 14:25:30` (绿) | 从 `read_text_file` 返回的 mtime 格式化 |
| 文件已存（localStorage 兜底） | `已是最新` | 兜底场景 |

**警告条样式**：使用既有 `.file-warn` 组件（与「文件不存在」同款），用于显示：
- 初始化失败（已降级本地暂存）
- 浏览器模式的「本地暂存」提示
- 项目 tab 下的「暂无项目」提示

### 2.6 项目列表数据源

```
MainApp.tsx
  └─ const projects = useMemo<ProjectInfo[]>(() => {
       // conversations.filter(c => c.cwd) → 按 cwd 去重
       // label = 路径末段 basename
     }, [chat.conversations]);
  └─ <MemoryPage projects={projects} />
```

- **不自动扫描目录**
- 加新项目 = 在 Sidebar 点「+ 新建项目」→ 选目录 → 创建带 cwd 的对话
- 记忆页只读 `conversations.cwd` 的去重结果

### 2.7 关键代码位置

| 关注点 | 文件 | 行号 |
|--------|------|------|
| Tauri 命令 | `apps/ripple-desktop/src-tauri/src/lib.rs` | L305-375 |
| invoke_handler 注册 | `apps/ripple-desktop/src-tauri/src/lib.rs` | L390-396 |
| 前端 fs 封装 | `apps/ripple-desktop/src/services/appPaths.ts` | 全文件 |
| MemoryPage 入口 | `apps/ripple-desktop/src/components/MemoryPage.tsx` | L120-180 |
| 通用 Pane 数据层 | `apps/ripple-desktop/src/components/MemoryPage.tsx` | L202-360 |
| 项目 Pane 数据层 | `apps/ripple-desktop/src/components/MemoryPage.tsx` | L378-560 |
| `formatMtime` 工具 | `apps/ripple-desktop/src/components/MemoryPage.tsx` | L623-633 |
| FileEditor（状态文案） | `apps/ripple-desktop/src/components/MemoryPage.tsx` | L643-740 |
| projects 派生 + 注入 | `apps/ripple-desktop/src/components/MainApp.tsx` | L432-446 |
| 默认文件 | `apps/ripple-desktop/memory/MEMORY.md` 等 | — |

---

## 三、专家模块

### 3.1 核心原理

**后端已就绪**（`agent/packages/server` 提供 `/api/squad/agents` 全套 CRUD），前端从 localStorage + mock 数据迁到真实 API。

#### 两类专家的本质区别

| 类型 | 英文标识 | 数据形态 | 存储位置 | 创建方式 |
|------|---------|---------|---------|---------|
| **提示词专家** | agent | 1 个 `.agent.yaml` + 1 个 `prompt.md` | `agent/agents/*.agent.yaml` + `agent/prompts/*-prompt.md` | **手动写 yaml + md**（手工文件，非 API 创建） |
| **会话专家** | session | 1 个 `.agent.yaml`（带 checkpoint 引用） | `agent/agents/*.agent.yaml` + `agent/data/squad/checkpoints.json` | **对话蒸馏**（二期开发） |

**关键事实**：
- 专家 yaml 引用外部 md：`system_prompt_ref: ../prompts/xxx-prompt.md`
- 本期前端**只能改 md**（= 改 systemPrompt），不能改 yaml 字段
- 理由：直接编辑 yaml 易引发解析错误，md 单独抽出来是为了简化编辑

#### 双文件结构

```
agent/agents/code-writer.agent.yaml         ← 元数据（本期只读）
   │
   ├─ name: code-writer
   ├─ display_name: code-writer
   ├─ description: ...
   ├─ system_prompt_ref: ../prompts/code-writer-prompt.md   ← 引用
   ├─ config: { provider, model, thinkingLevel }
   ├─ tools: [...]
   └─ triggers: [...]
                      ↓
agent/prompts/code-writer-prompt.md         ← 真正的 system prompt（本期可编辑）
```

### 3.2 后端 API 速查（`/api/squad/agents`）

| 方法 | 路径 | 用途 | 本期使用 |
|------|------|------|---------|
| GET | `/api/squad/agents` | 列表（含 useCount / lastUsedAt / hasCheckpoint） | ✅ |
| GET | `/api/squad/agents/:name` | 详情（含 systemPrompt = md 内容、triggers、tools、config） | ✅ |
| POST | `/api/squad/agents` | 创建专家 | ❌ 二期 |
| PUT | `/api/squad/agents/:name` | 更新（本期只传 systemPrompt） | ✅ |
| DELETE | `/api/squad/agents/:name?deleteSession=true` | 删除专家 | ❌ 二期 |

`PUT` 请求体（本期）：
```json
{ "systemPrompt": "新的 md 内容" }
```

后端会：
1. 找到 yaml 中的 `system_prompt_ref` 对应的 md 文件
2. 把新内容写回
3. 保持 yaml 不动

### 3.3 前端数据流

```
ExpertsPage 挂载
  └─ fetchExperts() 拿列表
       ├─ 成功：渲染 Agent tab 卡片（带 useCount / lastUsedAt）
       └─ 失败：logger.warn + 降级 localStorage

点编辑（Agent）
  └─ fetchExpert(name) 拿详情
       └─ 把 systemPrompt/triggers/tools/content 合并到 agentExperts state
  └─ 打开 modal：yaml 字段全 disabled，仅 systemPrompt textarea 可改
  └─ 点保存：updateExpert(name, { systemPrompt })
       └─ 成功后 loadAgentExperts() 重新拉取（Q4 决策：保存后 GET 重新拉取）
```

### 3.4 Modal 字段行为

| 字段 | Agent 编辑 | Session 编辑 | 新建（二期） |
|------|------------|--------------|--------------|
| name | disabled | 可编辑 | 可编辑 |
| type | disabled | 可编辑 | 可编辑 |
| status | disabled | 可编辑 | 可编辑 |
| description | disabled | 可编辑 | 可编辑 |
| iconKey | disabled | 可编辑 | 可编辑 |
| systemPrompt | **可编辑** | 可编辑 | 可编辑 |
| tools | disabled | 可编辑 | 可编辑 |

按钮文案：
- Agent 编辑 → 「保存到 .md」
- Session 编辑 → 「保存修改」
- 新建 → 「创建专家」（本期不出新建 modal）

### 3.5 卡片底部「已用 N 次 · 最近 X」

格式规则（`formatLastUsed` + `buildUsageLine`）：

| useCount | lastUsedAt | 显示 |
|----------|-----------|------|
| 0 | — | `尚未使用` |
| > 0 | < 1 min | `已用 N 次 · 最近 刚刚` |
| > 0 | < 1 hour | `已用 N 次 · 最近 X 分钟前` |
| > 0 | < 1 day | `已用 N 次 · 最近 X 小时前` |
| > 0 | < 30 day | `已用 N 次 · 最近 X 天前` |
| > 0 | > 30 day | `已用 N 次 · 最近 X 个月前` |

### 3.6 Session 专家说明

- **本期完全不动**：tab 保留、2 条 mock 数据（my-expert / ui-designer）、localStorage 行为保留
- 卡片底部不显示使用统计（避免误导）
- 维护理由：会话专家是未来「对话蒸馏」功能的占位，UI 框架先搭好

### 3.7 关键代码位置

| 关注点 | 文件 | 行号 |
|--------|------|------|
| 后端 CRUD | `agent/packages/server/src/index.ts` | L3583-3917 |
| 共享 API 封装 | `packages/ripple-shared/src/api.ts` | L513-572 |
| 工具函数（formatLastUsed / buildUsageLine） | `apps/ripple-desktop/src/components/ExpertsPage.tsx` | L151-185 |
| ExpertsPage 入口 | `apps/ripple-desktop/src/components/ExpertsPage.tsx` | L195-460 |
| ExpertCard 渲染（含 usageLine） | `apps/ripple-desktop/src/components/ExpertsPage.tsx` | L487-540 |
| ExpertFormModal（含 isReadOnly） | `apps/ripple-desktop/src/components/ExpertsPage.tsx` | L546-700 |
| 专家数 useEffect | `apps/ripple-desktop/src/components/MainApp.tsx` | L640-660 |
| 后端专家 yaml 源文件 | `agent/agents/*.agent.yaml` | — |
| 后端提示词 md 源文件 | `agent/prompts/*-prompt.md` | — |

---

## 四、Sidebar 徽章

`MainApp.tsx` 派生并注入：

| 徽章 | 数据源 | 刷新时机 |
|------|--------|----------|
| `expertCount` | `fetchExperts().data.length` | `useEffect` 依赖 `currentView`（切到 experts 页时重拉） |
| `memoryCount` | `projects.length`（= `conversations.cwd` 去重数） | 派生自 `chat.conversations` |

---

## 五、当前开发状态

### ✅ 已完成（v0.4.0）

| Phase | 内容 | 验证 |
|-------|------|------|
| 0 | Tauri 5 个 fs 命令 + 前端 `appPaths.ts` 封装 + 共享 experts API | tsc clean |
| 1 | 通用记忆 Pane 接 fs + mtime 显示 + 状态文案 | tsc clean |
| 2 | 项目记忆 Pane 接 fs + `projects` prop 注入 | tsc clean |
| 3 | Agent 专家只读 yaml + 只改 md + 卡片 usageLine | tsc clean |
| 4 | Sidebar 徽章真实化 | tsc clean |
| 5 | 默认 memory 文件创建 + 全量验证 | tsc clean + 65/65 tests pass |

### 🔲 二期（用户标记为"维持不动"）

- 「添加专家」按钮真正打通 POST `/api/squad/agents`
- Agent 专家删除（DELETE）
- Session 专家真实化（对话蒸馏 → checkpoint）
- `status` 状态真正同步到 yaml（当前仅 UI 展示）
- Agent 专家 yaml 字段编辑（如需放开）
- 项目列表「重命名 / 移除」操作（当前依赖对话管理）

### ⚠️ 已知风险

1. **`get_app_root()` 在 prod 模式**：
   - 当前实现：dev 模式向上找 `tauri.conf.json`，找不到回退到 .exe 父目录
   - prod 模式（NSIS 安装）下 `tauri.conf.json` 不在 .exe 旁，会回退到安装目录
   - 用户已确认「prod 返回 .exe 目录」，符合预期

2. **localStorage 兜底的数据持久性**：
   - 浏览器 dev 模式下数据存在 localStorage，刷新即丢
   - 用户已确认接受此限制

3. **专家 PUT 接口原子性**：
   - 后端先写 md 文件，再写 yaml，理论上 yaml 不动但 md 改动期间可能不一致
   - 当前未做事务，依赖后端 `CONFIG_MUTEX` 模式（参考 `save_config`），如有需求可补

4. **后端 `tauri dev` 启动**：
   - 修改了 `lib.rs` 后需要 `pnpm tauri:dev` 触发 Rust 重新编译
   - 仅改前端 `.tsx` 不需要重编 Rust

---

## 六、开发指南（如何扩展）

### 6.1 新增一个记忆文件

1. 在 `MemoryPage.tsx` 顶部的 `GENERAL_FILES` 或 `PROJECT_FILES` 数组添加一项
2. 提供 `name` / `desc` / `template`
3. UI 自动出现新 tab，无需改其他代码

### 6.2 改造专家 yaml 字段为可编辑

1. 在 `ExpertFormModal` 中找到 `disabled={isReadOnly}` 的字段
2. 移除 disabled
3. 在 `handleSubmit` 中把字段值传给 `onSubmit`
4. 后端 PUT 当前已支持任意字段（参考 `agent/packages/server/src/index.ts:3785-3854`）

### 6.3 接入 Tauri fs 之外的命令

1. 在 `src-tauri/src/lib.rs` 加新 `#[tauri::command]`
2. 在 `run()` 函数的 `tauri::generate_handler![...]` 中注册
3. 在 `src/services/appPaths.ts` 加 TS 封装
4. 调用方使用，参考 `readTextFile` 用法

### 6.4 添加新专家类型

需要在后端做较大改动：
1. 扩展 yaml schema（如加 `category: prompt | session | workflow`）
2. 后端 `GET /api/squad/agents` 解析新字段
3. 前端 type 定义（`ExpertType`）加新值
4. ExpertsPage tab 增加

### 6.5 调试技巧

| 问题 | 排查方法 |
|------|---------|
| Tauri 命令调用失败 | 看 `apps/ripple-desktop/data/debug-bridge.log`（`write_debug_log` 写入的） |
| 后端 API 失败 | 看 `LogPanel` 底部日志（`logger.error` / `logger.warn`） |
| 文件未创建 | 检查 `<appRoot>/memory/` 目录是否存在、权限 |
| mtime 显示 1970 | Rust `metadata().modified()` 失败，文件可能被其他进程占用 |

---

## 七、变更日志

### v0.4.0 (2026-06-03)

**新增**：
- Tauri fs 命令：`get_app_root` / `read_text_file` / `write_text_file` / `path_exists` / `ensure_memory_dir`
- 前端 `src/services/appPaths.ts`
- `packages/ripple-shared/src/api.ts` 新增 `fetchExperts` / `fetchExpert` / `updateExpert` 及 `ExpertSummary` / `ExpertDetail` 类型
- `apps/ripple-desktop/memory/MEMORY.md`、`hot-topics.md` 默认文件

**改造**：
- `MemoryPage.tsx` — 完整重写数据层，UI 保持
- `ExpertsPage.tsx` — Agent 专家接后端，Session 维持 mock
- `MainApp.tsx` — 派生 `projects`、`expertCount`，注入 Sidebar / MemoryPage

**未改动**：
- `Sidebar.tsx`（项目新建已存在）
- `useSettings.ts`、所有 CSS、所有其他模块

---

## 八、相关文档

- `agent/agents/README.md` — 专家 yaml 编写指南
- `agent/ARCHITECTURE.md` — Agent 引擎架构（含 ExpertRegistry / invoke_expert 工具）
- `doc/DEVELOPMENT-01.md` — 整体开发历史
- `brain/brain/MEMORY.md` — 用户核心画像（与本模块的「MEMORY.md」无关）
- `brain/README.md` — 跨项目知识库结构

---

## 九、FAQ

**Q: 为什么「记忆」模块无后端？**
A: 记忆是文件级别的简单读写，没必要起一个后端服务。Tauri 的 Rust 命令直接调 std::fs 最简单。

**Q: Agent 专家的 yaml 字段为什么不能编辑？**
A: 直接编辑 yaml 易引发解析错误（缩进、特殊字符、类型），后端解析失败会导致整个专家系统崩溃。md 文本相对自由，单文件写坏也不影响 yaml 加载。

**Q: Session 专家为什么是 mock？**
A: 真实会话专家依赖「对话蒸馏」流程（从 .jsonl 提取训练数据 → 生成 checkpoint），是二期功能。本期先把 UI 框架搭起来占位。

**Q: 为什么用 `useEffect(..., [currentView])` 触发专家数刷新？**
A: 切到 experts 页时重新拉取，确保用户编辑后回到对话页能看到最新徽章。比用 callback 或事件总线简单。

**Q: 浏览器 dev 模式为什么 localStorage 数据会丢？**
A: localStorage 是浏览器 tab 级别的，重开即清。本期接受此限制；如未来要兜底更稳，可改用 `tauri-plugin-store` 或 `IndexedDB`。

**Q: prod 模式（`pnpm tauri:build`）下 `<appRoot>` 是什么？**
A: 返回 .exe 所在目录（即 NSIS 安装目录的根）。`memory/` 目录在用户首次启动时由 `ensure_memory_dir` 命令自动创建。

**Q: 如果用户改了 `apps/ripple-desktop/memory/` 下的默认文件，会被覆盖吗？**
A: 不会。前端只读不写默认文件（首次保存时如果文件不存在会用 `template` 写入，但已存在就用磁盘内容）。
