# Checkpoint 深度优化方案

> 基于 `checkpoint-latency-optimization.md` 的排查分析，对 checkpoint 模块做第二轮深度优化。
>
> 编制：2026-06-04
> 涉及项目：agent/packages/agent, agent/packages/server, apps/ripple-desktop
> 预计工时：2h（实施）+ 0.5h（测试）

---

## 一、当前问题

| 问题 | 严重度 | 说明 |
|------|--------|------|
| Git CMD 弹窗 | 🟡 中 | `execAsync` 在 Windows 默认弹出 cmd 窗口，影响用户体验 |
| 无工具调用时仍执行 git | 🟡 中 | 纯聊天场景（"hi"、"今天天气"）0 文件变化，git 白跑，浪费 10-50ms |
| 大项目 git 扫描可优化 | 🟢 低 | 当前 `git diff HEAD --name-only` 不如 `git status --porcelain` 直接，且保留了不必要的 `.lastscan` |
| `isGitRepo()` 重复 stat | 🟢 低 | 每次创建 checkpoint 都调用，无缓存 |

---

## 二、设计原则

1. **Checkpoint 每次都创建（对话快照）** — 确保对话截断/回退功能完整，不影响 session 专家记忆
2. **文件扫描按需执行** — 只有 AI 即将调用文件修改工具时，才执行 git 扫描
3. **非 git 项目不做额外优化** — 小型测试项目直接用全量递归，简单可靠
4. **所有改动向后兼容** — 现有 checkpoint 文件格式不变，回滚逻辑不变

---

## 三、改动清单

### 改动 A：修复 Git CMD 弹窗

**涉及文件：** `agent/packages/agent/src/tools/checkpoint.ts`

**操作：**
- 查找所有 `execAsync` 调用，添加 `windowsHide: true` 和 `timeout: 5000`
- 当前 `execAsync` 是 `promisify(exec)`，创建子进程时会通过 `cmd.exe`
- `windowsHide: true` 让子进程不显示窗口
- `timeout: 5000` 防止 git 卡死导致 checkpoint 永久挂起

**改动点（共 3 处）：**

```typescript
// 位置 1: execAsync('git diff HEAD --name-only', ...) 
//          → 改后替换为 git status --porcelain（见改动 B）

// 位置 2: execAsync('git ls-files --others --exclude-standard', ...)
//          → 加 { windowsHide: true, timeout: 5000 }

// 位置 3: execAsync('git ls-files --deleted', ...)
//          → 加 { windowsHide: true, timeout: 5000 }

// 位置 4: execAsync('git ls-files', ...)  // getGitDirectoryState 中
//          → 加 { windowsHide: true, timeout: 5000 }
```

**风险：** 极低。`windowsHide` 是 stdio 选项，不影响命令执行结果。超时会在 5s 后 reject，caller 已有 try-catch 回退。

---

### 改动 B：Git 扫描改为 git status --porcelain（参考文档 §4.3）

**涉及文件：** `agent/packages/agent/src/tools/checkpoint.ts`

**操作：**
- 新增 `getGitChangedFilesViaStatus(rootDir)` 函数
- 用 `git status --porcelain` 直接获取变更文件列表
- 替换原有的 `getGitChangedFiles()` 调用

**函数签名：**
```typescript
async function getGitChangedFilesViaStatus(rootDir: string): Promise<string[] | null> {
  if (!isGitRepo(rootDir)) return null;
  try {
    const { stdout } = await execAsync('git status --porcelain', {
      cwd: rootDir,
      windowsHide: true,
      timeout: 5000,
    });
    const files: string[] = [];
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const filename = trimmed.slice(3); // 前 2 字符状态码 + 1 空格
      if (filename) files.push(filename);
    }
    return [...new Set(files)]; // 去重
  } catch {
    return null; // 回退到全量扫描
  }
}
```

**git status --porcelain 输出示例：**
```
 M src/index.ts           # 工作区修改（空格+M）
 MM src/types.ts           # 暂存区+工作区都改了
?? new-file.ts             # 未跟踪
 D deleted.ts              # 工作区删除
R  renamed.ts -> new.ts    # 重命名（罕见，保留旧路径）
```

**与旧 `getGitChangedFiles()` 的区别：**

| | 旧：`git diff HEAD --name-only` | 新：`git status --porcelain` |
|---|---|---|
| 未跟踪文件 | 需再跑 `ls-files --others` | ✅ 自带（`??` 前缀） |
| 已删除文件 | 需再跑 `ls-files --deleted` | ✅ 自带（` D` 前缀） |
| 子进程数 | 3 次（diff + others + deleted） | **1 次** |
| 解析复杂度 | 3 个输出需去重合并 | 1 个输出 slice(3) |

**风险：** 低。`git status --porcelain` 是 git 的稳定输出格式（自 git 1.7.0+ 起），不做本地化，格式固定。

---

### 改动 C：isGitRepo() 加 Map 缓存

**涉及文件：** `agent/packages/agent/src/tools/checkpoint.ts`

**操作：**
- 声明模块级 `const gitRepoCache = new Map<string, boolean>()`
- `isGitRepo()` 先查缓存，命中直接返回
- 缓存上限 50 条，通过 LRU 清理

```typescript
const GIT_REPO_CACHE_MAX = 50;
const gitRepoCache = new Map<string, boolean>();

function isGitRepo(dir: string): boolean {
  // 使用路径中最近的上层目录作为 key（统一不同子路径的缓存）
  const key = resolve(dir);
  const cached = gitRepoCache.get(key);
  if (cached !== undefined) return cached;

  let current = key;
  while (true) {
    const gitDir = join(current, '.git');
    try {
      const stat = fs.statSync(gitDir);
      if (stat.isDirectory() || stat.isFile()) {
        gitRepoCache.set(key, true);
        // LRU 清理
        if (gitRepoCache.size > GIT_REPO_CACHE_MAX) {
          const firstKey = gitRepoCache.keys().next().value;
          if (firstKey) gitRepoCache.delete(firstKey);
        }
        return true;
      }
    } catch { /* 继续向上 */ }
    const parent = dirname(current);
    if (parent === current) break; // 到根了
    current = parent;
  }

  gitRepoCache.set(key, false);
  if (gitRepoCache.size > GIT_REPO_CACHE_MAX) {
    const firstKey = gitRepoCache.keys().next().value;
    if (firstKey) gitRepoCache.delete(firstKey);
  }
  return false;
}
```

> **为什么向上查找？** 项目的 `.git` 可能在父目录中（monorepo 子目录运行时），向上查找保证找到真正的 git 根。

**风险：** 低。缓存只在进程生命周期内有效，重启自动刷新。

---

### 改动 D：删除 git 路径的 .lastscan 和 getGitDirectoryState()

**涉及文件：** `agent/packages/agent/src/tools/checkpoint.ts`

**改动项：**

| 删除项 | 位置 | 原因 |
|--------|------|------|
| `getGitDirectoryState()` | ~30 行函数 | git 路径改用 `git status --porcelain`，不再需要全量文件列表 |
| `loadLastScanState()` + `saveScanState()` 在 git 路径的调用 | `create()` 方法中 | git 路径不再依赖 mtime 缓存，增量信息由 `git status` 直接提供 |
| `.lastscan` 文件名常量 | ~5 行引用 | git 路径不再读写此文件 |

**保留逻辑：** 非 git 路径不受影响，`loadLastScanState()` / `saveScanState()` 仍然为全量递归 scan 服务。

**create() 方法新流程：**
```
create() 入口
  ├─ specificFiles 已指定 → 直接用（快速路径，不变）
  ├─ isGitRepo(rootDir)
  │    ├─ true  → git status --porcelain
  │    │           ├─ 成功 → filesToSnapshot = changedFiles
  │    │           └─ 失败 → fallback 全量递归（非 git 回退路径）
  │    └─ false → 全量递归扫描（保留 .lastscan）
  └─ 读取文件内容 + 写入 index.json（不变）
```

**风险：** 中。需确保非 git 路径的 `.lastscan` 逻辑不误删。实施后需手工测试非 git 项目的增量 checkpoint 是否正常工作。

---

### 改动 E：前端 sendMessage() 跳过 git 扫描

**涉及文件：** `apps/ripple-desktop/src/hooks/useStreamingChat.ts`

**操作：**
- createCheckpoint 调用时不传 `files` 参数，服务端识别为"仅创建对话快照，跳过文件扫描"
- 或新增参数 `skipFileScan: true`

**改动点：**
```typescript
// 改前（当前代码）
createCheckpoint(cpCwd, label, desc, "auto")

// 改后
createCheckpoint(cpCwd, label, desc, "auto", { skipFileScan: true })
```

**服务端对应改动（改动 F）：** 后端识别 `skipFileScan` 标记，仅创建 index.json 条目（空 `files:[]`），不执行文件扫描。

**收益：** checkpoint 创建从 5-15s 降到 1-2ms（纯写 index.json，无文件 I/O）。

**风险：** 极低。空 `files` 的 checkpoint 回滚时不恢复文件（`restore()` 中 `files.length === 0` 时跳过文件写入），对话截断功能不受影响。

---

### 改动 F：后端 beforeToolCall 触发文件扫描

**涉及文件：** `agent/packages/server/src/index.ts`

**设计思路：**
- 在 `setupReflectionHook` 附近新增一个钩子
- 监听 `beforeToolCall` 事件，检测到**第一个文件修改工具**（write_file、edit_block、rename_file、delete_file、shell 等）时触发文件扫描
- 扫描完成后通过 SSE 事件 `checkpoint-updated` 下发 `snapshotId`

**实现细节：**

```typescript
// 注册：文件修改工具列表
const FILE_MODIFYING_TOOLS = new Set([
  'write_file', 'edit_block', 'rename_file', 'delete_file',
  'shell',       // shell 可能执行 rm/mv 等
]);

// 每个会话跟踪"是否已补过文件扫描"
const fileScanCompleted = new Map<string, boolean>();

// 在 AgentManager.getOrCreate() 创建 harness 时注册
harness.on('beforeToolCall', async (event) => {
  const { toolName, sessionId } = event;
  if (!sessionId) return;

  // 非文件修改工具 → 跳过
  if (!FILE_MODIFYING_TOOLS.has(toolName)) return;

  // 已扫描过 → 跳过
  if (fileScanCompleted.get(sessionId)) return;

  // 标记已扫描（防止后续工具重复扫描）
  fileScanCompleted.set(sessionId, true);

  // 异步执行文件扫描（不阻塞工具执行）
  // 注意：在 beforeToolCall 中同步执行会阻塞 AI，这里用 fire-and-forget
  const cwd = getCwdForSession(sessionId);
  if (!cwd) return;

  try {
    const manager = await getCheckpointManagerForSession(cwd, sessionId);
    const checkpoint = await manager.create({
      name: `工具执行前文件快照: ${toolName}`,
      source: 'auto',
      maxSnapshots: 20,
      // 不传 files → 走内部 git status / 全量扫描
    });
    // 通知前端更新 snapshotId
    sendSseCheckpointEvent(sessionId, checkpoint.id);
  } catch (err) {
    log.warn('CHECKPOINT', '工具触发文件扫描失败', { error: String(err) });
    // 不阻断工具执行
  }
});
```

**SSE 事件格式：**
```json
{
  "type": "checkpoint-updated",
  "snapshotId": "cp_xxxxx"
}
```

**前端处理：** 收到此事件后，将 snapshotId 补到当前消息的 metadata 中。

**完整时序：**
```
User 发 "帮我改 src/index.ts"
  1. sendMessage()
     → addMessage()                                     ← 1ms
     → createCheckpoint(skipFileScan:true)               ← 1ms (只记对话快照)
     → SSE connect                                       ← 立即
  2. AI 决定调 write_file
  3. beforeToolCall 触发
     → createCheckpoint(执行 git status)                  ← 10-50ms
     → SSE 事件: {"type":"checkpoint-updated","snapshotId":"..."}
  4. write_file 执行
  5. 用户想回滚 → 有完整的文件快照可用
```

**风险：** 中。主要风险点：
- 并发：两个工具同时触发，需用 `fileScanCompleted` 做幂等
- 时序：`beforeToolCall` 中 fire-and-forget 不阻塞工具，但 `write_file` 执行时扫描可能没完成。解决方案：在 `beforeToolCall` 中**同步 await** 扫描（10-50ms 可接受，不影响用户体验），完成后再让工具继续
- 内存泄漏：会话结束时清理 `fileScanCompleted` Map

---

### 改动 G：非 git 项目支持 .checkpointignore

**涉及文件：** `agent/packages/agent/src/tools/checkpoint.ts`

**操作：**
- 全量递归扫描前，尝试读取 `{rootDir}/.checkpointignore`
- 格式：每行一个 glob 模式，跳过匹配路径
- 使用 `minimatch` 库（已存在于 agent 依赖中）做 glob 匹配

**实现：**
```typescript
const DEFAULT_IGNORE_PATTERNS = [
  'node_modules/**',
  '.git/**',
  'dist/**',
  '.next/**',
  '.turbo/**',
  'target/**',      // Rust
  '__pycache__/**',
  '.venv/**',
  'venv/**',
  '.mypy_cache/**',
  '.pytest_cache/**',
];

async function loadCheckpointIgnore(rootDir: string): Promise<string[]> {
  try {
    const content = await readFile(join(rootDir, '.checkpointignore'), 'utf-8');
    return content
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'));
  } catch {
    return [];
  }
}

// 在 scanDirectory 中使用：
const ignorePatterns = [...DEFAULT_IGNORE_PATTERNS, ...userIgnorePatterns];
function shouldSkip(name: string): boolean {
  return ignorePatterns.some(p => minimatch(name, p));
}
```

**风险：** 低。文件不存在时回退到默认忽略列表。纯新增功能，不修改现有行为。

---

## 四、改动汇总

| 改动 | 文件 | 增量 | 类型 | 依赖 |
|------|------|------|------|------|
| **A** 修复 Git CMD 弹窗 | `checkpoint.ts` | +3 行选项 | 修复 | 无 |
| **B** git status --porcelain | `checkpoint.ts` | +30 行新函数 | 优化 | A |
| **C** isGitRepo() 缓存 | `checkpoint.ts` | +30 行 | 优化 | 无 |
| **D** 删除旧函数 | `checkpoint.ts` | -60 行 | 清理 | B |
| **E** 前端 skipFileScan | `useStreamingChat.ts` | +1 行参数 | 优化 | F |
| **F** 后端 beforeToolCall | `index.ts` | +60 行 | 核心 | E |
| **G** .checkpointignore | `checkpoint.ts` | +30 行 | 体验 | 无 |

**推荐执行顺序：** A → C → B → D → G → E → F

---

## 五、安全与回退

### 5.1 每次改动的回退策略

| 改动 | 回退方式 | 回退成本 |
|------|----------|----------|
| A | 去掉 `{ windowsHide, timeout }` | 1 分钟 |
| B | 切回 `getGitChangedFiles()`，保留旧函数不删 | 1 分钟 |
| C | 清空缓存，或删除 Map 声明 | 1 分钟 |
| D | 恢复 `getGitDirectoryState()` 和 `.lastscan` 调用 | 2 分钟 |
| E | 去掉 `skipFileScan` 参数 | 1 分钟 |
| F | 去掉 `beforeToolCall` 监听 | 3 分钟 |
| G | 删除 `.checkpointignore` 相关代码 | 1 分钟 |

### 5.2 边界情况

| 场景 | 预期行为 |
|------|----------|
| git 路径但 `git status` 失败（超大 repo、权限不够） | 回退到全量递归 |
| 非 git 路径且无 `.checkpointignore` | 使用默认忽略列表 + 全量递归 |
| 多个 AI 调用同时触发 `beforeToolCall` | `fileScanCompleted Map` 保证只扫描一次 |
| 用户频繁发"hi"（纯聊天） | 0 次 git 调用，0 额外延迟 |
| checkpoing 创建中途崩溃 | index.json 可能不一致，但 .wal 已持久化对话快照 |

---

## 六、验证要点

实施后验证以下场景：

1. **Git 项目 + 纯聊天**：发"hi"，检查是否无 cmd 弹窗，SSE 首字延迟 < 2s
2. **Git 项目 + 改文件**：发"修改 src/index.ts"，检查 checkpoint 是否在工具执行前创建
3. **非 git 项目**：发任意消息，检查全量递归是否正常，回滚是否可用
4. **非 git 项目 + .checkpointignore**：创建 `.checkpointignore`，检查大型目录是否跳过
5. **对话回退**：发多条消息后回退，检查文件状态是否正确恢复

---

## 七、变更记录

| 日期 | 版本 | 编制 | 描述 |
|------|------|------|------|
| 2026-06-04 | v1.0 | AI | 初始方案 |
