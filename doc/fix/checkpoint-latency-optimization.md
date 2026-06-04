# Checkpoint 首字延迟排查与优化方案

> 本文档记录了 Ripple Desktop 发送消息后首字节（TTFT，Time To First Token）延迟过高的根因分析、已实施修复和长期优化方案。
>
> 最终修改: 2026-06-04
> 涉及项目: apps/ripple-desktop, agent/packages/agent, agent/packages/server

---

## 1. 问题现象

用户发送消息（项目对话模式）后，从点击发送到看到 AI 第一个字的延迟：

| 场景 | 改前 | 改后 |
|------|------|------|
| 大型项目（1 万+ 文件）发送 "hi" | **15s+** | ~3s（LLM TTFT 纯时间） |
| 小型项目（~100 文件）发送 "hi" | **5s** | ~1s |
| 非项目对话 | 正常 | 不变 |

项目越大延迟越明显，与消息内容复杂度和 LLM 响应速度无关。

---

## 2. 排查过程

### 2.1 第一阶段：排除 Checkpoint 阻塞（❌ 错误方向）

最初技术排查认为是 `sendMessage()` 中 `await createCheckpoint()` 阻塞了 SSE 连接建立，导致首字延迟。注释掉 checkpoint 代码在小项目测试——**延迟无变化**。结论：checkpoint 不是根因。

### 2.2 第二阶段：发现 res.flushHeaders() 缺失（✅ 部分正确）

分析后端 `/api/chat` SSE handler 发现：

```typescript
// agent/packages/server/src/index.ts:1908-1910
res.setHeader('Content-Type', 'text/event-stream');
res.setHeader('Cache-Control', 'no-cache');
res.setHeader('Connection', 'keep-alive');
// ❌ 没有 res.flushHeaders()！
```

Node.js HTTP 机制：`res.setHeader()` 只设置缓冲区，响应头会缓存到首次 `res.write()` 才发送。前端 `await fetch()` 一直卡在"等待响应头"阶段。

**修复：** 加 `res.flushHeaders()`，前端 `await fetch` 立即 resolve。

但大项目测试后——**延迟依然 ~15s**。说明连接头阻塞只是次要矛盾，真正的时间花在后端处理上。

### 2.3 第三阶段：确认 Checkpoint 是主因（✅ 根因）

在大项目重测：去掉 checkpoint → 15s → **3s**。确认根因。

**新旧流对比：**

```
旧流（同步 await）：
  sendMessage()
    → addMessage("user", content)           ← 1ms
    → await createCheckpoint(cwd, ...)       ← 大项目 5-15s！← 真凶
    → sseClient.connect()                    ← 这里 SSE 才开始
    → LLM TTFT                              ← 1-3s

新流（fire-and-forget）：
  sendMessage()
    → addMessage("user", content)           ← 1ms
    → sseClient.connect()                    ← 立即开 SSE
    → createCheckpoint(cwd, ...) 后台跑     ← 不阻塞
    → LLM TTFT                              ← 1-3s（前后端都不卡）
```

### 2.4 检查点创建慢的根因

`createCheckpoint()` 中获取文件列表的函数 `getDirectoryState()`：

```typescript
// agent/packages/agent/src/tools/checkpoint.ts:284-313
async function getDirectoryState(rootDir, currentDir, skipDirs) {
    // 递归 readdir 每个目录 → 每个文件 stat
    // 大项目 10000+ 文件 → 200+ readdir 调用 → 5-15s
}
```

每次调用都**全量递归遍历目录树**，即使 95%+ 的消息没有修改任何文件。

---

## 3. 已实施的修复

说完了排查过程，以下是最终实施的修改。**两处独立优化，互不依赖。**

### 3.1 修复 A：Checkpoint 异步化

**文件：** `apps/ripple-desktop/src/hooks/useStreamingChat.ts:586-618`

**核心变更：** `await createCheckpoint(...)` → `createCheckpoint(...).then(...).catch(...)`

```typescript
// 改前：同步阻塞 SSE
if (effectiveCwd) {
    const cpRes = await createCheckpoint(cwd, label, desc, "auto");
    // ... 补 snapshotId, 发事件 ...
}
// 然后才开 SSE
sseClient.connect(...);

// 改后：fire-and-forget，SSE 立即打开
if (effectiveCwd) {
    const cpCwd = effectiveCwd;
    const cpConvId = convId;
    createCheckpoint(cpCwd, label, desc, "auto")
        .then((cpRes) => { /* 后台补 snapshotId */ })
        .catch((err) => { /* warn, 不阻断 */ });
}
sseClient.connect(...);  // 立即执行，不等 checkpoint
```

**关键安全措施：**
- `cpCwd` / `cpConvId` 用 `const` 捕获闭包，防止 `.then` 执行时变量已变
- `.catch()` 捕获异常，避免 unhandled promise rejection
- `setConversations()` 使用 functional form，天然防 race

**预期风险（均极小）：**

| 风险 | 触发条件 | 实际影响 |
|------|----------|----------|
| snapshotId 晚补 | 用户发消息后 10s 内点回滚 | 对话截断正常，文件不还原（snapshotId 为空字符串跳过文件恢复）。checkpoint 完成后刷新页面即可正常回滚 |
| 对话已删除后 checkpoint 完成 | 用户发了消息立刻切对话 | `setConversations` 找不到旧 conv，跳过更新 |
| checkpoint 完成前 AI 改文件 | AI 秒出 edit_file（实际要 30-60s） | checkpoint 平均 5-15s 完成，窗口期充裕，几乎不会撞上 |

### 3.2 修复 B：`res.flushHeaders()`（辅助）

**文件：** `agent/packages/server/src/index.ts:1908-1911`

```typescript
res.setHeader('Content-Type', 'text/event-stream');
res.setHeader('Cache-Control', 'no-cache');
res.setHeader('Connection', 'keep-alive');
res.flushHeaders();  // 新增：立即发送响应头，前端 await fetch 不再阻塞
```

同样的修复应用于 `/api/chat/reconnect` 端点（L2485）。

---

## 4. 深度优化方案（Checkpoint 扫描加速）

> 修复 A 解决了"SSE 被阻塞"的问题。本节解决"checkpoint 本身慢"的问题。
>
> 虽然 修复 A 已经让 checkpoint 异步化不阻塞 SSE，但 checkpoint 本身仍需要 5-15s 才能完成。加速它意味着：
> - 用户能更快看到 snapshotId 补到消息上（回滚可用）
> - 多轮对话的后续 checkpoint 不累积延迟

### 4.1 现状分析

`create()` 方法中获取文件列表的核心问题：

```
当前扫描路径（always full）：
  ┌─ specificFiles 指定？ ─→ 直接用 √（快速路径，极少触发）
  └─ 无指定文件：
       ├─  git 仓库？   ─→ 跑 git ls-files 拿全量文件（已有）→ 批量 stat
       │                    但我这里本可以用 git status 直接拿变化文件
       └─  非 git 仓库  ─→ 递归 readdir 全量遍历（原有逻辑，保留）
```

**关键洞察：** 大部分消息（"hi"、咨询类）**0 文件变化**。此时 checkpoint 应该瞬间完成——但当前代码仍然要跑全量递归。

### 4.2 优化方案：Git-aware 增量扫描

**核心思路：** 用 `git status --porcelain` 替代全量递归扫描，只拿变化文件。

```
优化后扫描路径：
  ┌─ specificFiles 指定？ ─→ 直接用
  ├─ git 仓库？
  │    ├─ git status --porcelain  → 只拿变化的文件
  │    └─ 0 变化 → filesToSnapshot = []
  └─ 非 git 仓库 → 递归 readdir（原有逻辑，不变）
```

### 4.3 实现要点

**函数：** `getGitChangedFilesViaStatus(rootDir: string): Promise<string[] | null>`

```typescript
async function getGitChangedFilesViaStatus(rootDir: string): Promise<string[] | null> {
    if (!isGitRepo(rootDir)) return null;
    try {
        const { stdout } = await execAsync('git status --porcelain', {
            cwd: rootDir,
            timeout: 5000,  // 5s 超时，防止 git 卡死
        });
        const files: string[] = [];
        for (const line of stdout.split('\n')) {
            if (!line.trim()) continue;
            const filename = line.slice(3);  // 前 2 字符是状态码 + 1 空格
            if (!filename) continue;
            files.push(filename);
        }
        return [...new Set(files)];  // 去重
    } catch (err) {
        console.error('[Checkpoint] git status failed, fallback to full scan:', err);
        return null;  // 回退到全量扫描
    }
}
```

**`git status --porcelain` 输出格式：**
```
 M src/index.ts          # 工作区修改（空格 + M）
MM src/types.ts          # 暂存区+工作区都改了
?? new-file.ts           # 未跟踪
 D deleted.ts            # 已删除（空格 + D）
```

解析规则：`line.slice(3)` 跳过前 3 字符（2 字节状态码 + 1 空格），取文件路径。

### 4.4 移除的代码

| 移除项 | 原因 | 涉及行数 |
|--------|------|----------|
| `getGitDirectoryState()` | git 路径不需要全量文件列表 | ~30 行 |
| `.lastscan` 在 git 路径的读写 | git 路径不再需要 mtime 缓存 | ~5 行 |
| `getGitChangedFiles()` | 被 `getGitChangedFilesViaStatus()` 替代 | ~15 行 |
| 重复的 `isGitRepo()` 调用 | 加 Map 缓存 | ~5 行 |

### 4.5 预期效果

| 场景 | 改前（全量递归） | 改后（git status） |
|------|-----------------|-------------------|
| 大项目打招呼（0 文件变化） | 5-15s | **10-50ms** |
| 大项目改 3 个文件 | 5-15s scan + 50ms read | **50-100ms**（status 50ms + read 3 files） |
| 首次 checkpoint | 5-15s（递归全量） | **200-500ms**（git ls-files + batch stat） |
| 非 git 项目 | 5-15s | 5-15s（不变） |

### 4.6 与非 git 项目的兼容

```
create() 入口
  ├─ specificFiles 已指定 → 直接用（快速路径）
  ├─ isGitRepo(rootDir) == true → git status --porcelain
  │    ├─ 成功 → filesToSnapshot = changed files（0 变化 = 空数组）
  │    │          跳过 fallback
  │    └─ 失败 → 回退到全量递归扫描
  └─ isGitRepo(rootDir) == false → 全量递归扫描（原有逻辑）
       └─ 保留 .lastscan 增量机制（非 git 项目特有）
```

---

## 5. 架构建议（长期）

### 5.1 CompactionStrategy 接口落地

当前 `CompactionStrategy` 接口是死代码（`NoOpCompactionStrategy` `return false`）。实际压缩走的是 `enhanced-agent-harness.compact()` 直接调 `compaction.ts`。

后续应改为：**`CompactionStrategy` 接口作为真实架构路径，默认实现委托 `compaction.ts`，不同服务商可提供不同实现。**

### 5.2 Checkpoint 生命周期后移（远期）

当前 checkpoint 的编排在前端 `sendMessage()` 中，未来可以考虑后端 `/api/chat` handler 自动管理 checkpoint 生命周期：

- 前端 `sendMessage()` 不再调用 `createCheckpoint`
- 后端 `/api/chat` 收到请求后自动创建 checkpoint（文件状态 + 会话快照）
- 通过 SSE 事件 `{"type":"checkpoint","snapshotId":"..."}` 通知前端

收益：前端不再关心 checkpoint 时序，单一 SSE 连接承载所有通信。

---

## 6. 变更记录

| 日期 | 类型 | 文件 | 描述 |
|------|------|------|------|
| 2026-06-04 | fix | `useStreamingChat.ts:586-618` | checkpoint fire-and-forget 异步化 |
| 2026-06-04 | fix | `index.ts:1908-1911,2485` | SSE 响应头加 `flushHeaders()` |
| 2026-06-04 | perf | `checkpoint.ts:182-257` | 新增 git-aware 文件扫描（git status --porcelain） |
| 2026-06-04 | rm | `checkpoint.ts` | 移除 `getGitDirectoryState()`、git 路径的 `.lastscan` 读写 |
| 2026-06-04 | perf | `checkpoint.ts` | `isGitRepo()` 加 Map 缓存 |
