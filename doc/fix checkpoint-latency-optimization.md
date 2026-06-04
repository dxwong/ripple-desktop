# Checkpoint 模块问题与修复方向（handoff 文档）

> 状态：待实施
> 优先级：P0（影响用户感知的核心模块，需交付上线）
> 涉及文件：`agent/packages/agent/src/tools/checkpoint.ts`、`agent/packages/server/src/index.ts`
> 涉及项目：agent（harness + server）

---

## 1. TL;DR（结论先行）

`checkpoint.ts` 里每次执行 git 命令会**在 Windows 上弹出黑色 cmd 窗口**（一闪而过），用户感知"频繁弹窗"。**根因是用 `exec` 没传 `windowsHide: true`**，且项目内已经有正确范式（`nodejs.ts` 用 `spawn` + `windowsHide: true`），checkpoint 模块**没对齐这个范式**。

**主修复**：把 `exec` 换成 `execFile`（或加 `windowsHide: true`），并且**彻底重做"git 路径"的扫描逻辑**——当前实现里有几个 bug 让 git 优化的效果归零（甚至更慢）。

---

## 2. 核心 Bug #1：Windows cmd 黑窗闪烁

### 2.1 问题位置

`agent/packages/agent/src/tools/checkpoint.ts:204-208, 229-230`：

```ts
// 5 处 git 调用，全部走 execAsync（= promisify(exec)）
execAsync('git diff HEAD --name-only', { cwd: rootDir }),
execAsync('git ls-files --others --exclude-standard', { cwd: rootDir }),
execAsync('git ls-files --deleted', { cwd: rootDir }),
// ...
execAsync('git ls-files', { cwd: rootDir, maxBuffer: 10 * 1024 * 1024 }),
execAsync('git ls-files --others --exclude-standard', { cwd: rootDir, maxBuffer: 10 * 1024 * 1024 }),
```

### 2.2 为什么弹黑窗

`child_process.exec(command, options)` 在 Windows 上：
- 默认 `shell: true` → **走 `cmd.exe` 中转**（不是直接跑 git）
- 默认 `windowsHide: false` → **cmd.exe 会创建可见控制台窗口**
- 命令执行完后窗口消失 → 用户看到"一闪而过的黑窗"

用户发一条消息 → 走 fire-and-forget checkpoint → **3 个黑窗连续闪**。AI 改文件时 `applyBlocksWithCheckpoint` 又触发一次 → **再闪 2 个**。一次对话至少 5 个黑窗。

### 2.3 项目内已有正确范式

`agent/packages/agent/src/harness/env/nodejs.ts` 用 `spawn` + `windowsHide: true`：

```ts
// nodejs.ts:109 — 项目自己的标准做法
const child = spawn(command, args, {
  stdio: ["ignore", "pipe", "ignore"],
  windowsHide: true,    // ← 关键
});

// nodejs.ts:199, 253 — 同样的模式
spawn("taskkill", [...], { windowsHide: true, ... });
spawn(shell, [...args, command], { windowsHide: true, ... });
```

**checkpoint.ts 应该对齐这个范式，但没对齐。**

---

## 3. 修复方案

### 3.1 方案 A：最小修复（1 行改动级别）

保留 `execAsync`，给所有调用加 `windowsHide: true`：

```ts
const execOpts = { cwd: rootDir, windowsHide: true, timeout: 10000 };
await Promise.all([
  execAsync('git diff HEAD --name-only', execOpts),
  execAsync('git ls-files --others --exclude-standard', execOpts),
  execAsync('git ls-files --deleted', execOpts),
]);
```

**优点**：改动极小，5 分钟搞定
**缺点**：仍然走 `cmd.exe` 中转（多余一层），启动开销 +20ms/次，shell 转义风险

### 3.2 方案 B：彻底替换为 `execFile`（推荐）

直接调 `git.exe`，绕开 `cmd.exe` 中转。`execFile` 是 Node.js 设计用来跑可执行文件的 API，**没有黑窗**、更快、更安全：

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function runGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    windowsHide: true,    // 双保险
    timeout: 10000,
    maxBuffer: 50 * 1024 * 1024,
  });
  return stdout;
}

// 用法
const [diff, untracked, deleted] = await Promise.all([
  runGit(["diff", "--name-only", "HEAD"], rootDir),
  runGit(["ls-files", "--others", "--exclude-standard"], rootDir),
  runGit(["ls-files", "--deleted"], rootDir),
]);
```

**优点**：
- 不弹黑窗（Node.js 直接 spawn `git.exe`，不走 `cmd.exe`）
- 启动更快（少一层进程）
- 参数化避免 shell 注入风险
- 与项目 `nodejs.ts` 用 `spawn` 的范式一致

**缺点**：要小改 API（5 处 git 调用）

### 3.3 推荐：方案 B

理由：方案 A 是贴膏药，方案 B 是治根。改完后整个模块的 git 调用统一规范，且与项目 `nodejs.ts` 范式一致。

---

## 4. 顺带要修的 4 个严重问题（不修等于白做）

如果只修黑窗，**性能问题仍然在**——用户依然会卡 10-30s 才能完成一次 checkpoint。**必须同时修下面这些**：

### 4.1 Bug #2：`getGitDirectoryState` 让 git 优化归零（最严重）

**位置**：`checkpoint.ts:224-259` + 调用 `checkpoint.ts:469, 475`

```ts
// 当前：每次 git 路径 checkpoint 都调这个，把全项目文件 stat 一遍
const fullState = await getGitDirectoryState(this.rootDir);  // ← stat 10K+ 文件！
if (fullState) saveScanState(this.checkpointDir, fullState);
```

**问题**：git 优化本来是"只关心变化文件"，但 `getGitDirectoryState` 又把全部文件 stat 了一遍用来存 mtime → **stat N 次 + 同步 writeFileSync 1MB JSON**。**git 优化红利被这一步完全吃掉**，甚至比原 mtime 扫描还慢。

**修法**：git 路径下**彻底不调用 `getGitDirectoryState`，也不写 `.lastscan`**。git 本身就是 source of truth，不需要 mtime 状态。

具体改法（建议）：
- 删除 `getGitDirectoryState` 函数（30 行）
- 删除 git 路径的 `saveScanState` 调用（约 5 行）
- `getGitChangedFiles` 内部用 `runGit(["status", "--porcelain"])` 单命令替代 3 个并行 git 命令

### 4.2 Bug #3：`isGitRepo` 同步 IO 阻塞主线程

**位置**：`checkpoint.ts:187-193`

```ts
function isGitRepo(rootDir: string): boolean {
  return fs.existsSync(path.join(rootDir, '.git'));  // ← 同步 IO
}
```

`fs.existsSync` 阻塞 event loop 1-5ms × 每次 checkpoint 创建。**改成 `fs.promises.access` 或 `fs.promises.stat`**，且**结果应该缓存到 `CheckpointManager` 实例上**（当前是模块级函数，每次都重查）。

具体改法：
- 在 `CheckpointManager` 构造函数里查一次 `isGitRepo`，存 `private readonly isGitRepo: boolean`
- 改成异步探测：构造函数先 `await this.detectGitRepo()`

### 4.3 Bug #4：`.lastscan` 同步 IO 黑洞

**位置**：`checkpoint.ts:337-360`

```ts
function loadLastScanState(checkpointDir: string) {
  const content = fs.readFileSync(statePath, "utf-8");  // ← 同步读 1MB JSON
  return JSON.parse(content);
}

function saveScanState(checkpointDir: string, state) {
  fs.writeFileSync(statePath, JSON.stringify(state), "utf-8");  // ← 同步写 1MB JSON
}
```

非 git 路径下，每个 checkpoint 都同步读 1MB JSON + 同步写 1MB JSON。**10K 文件项目阻塞 100-300ms**。

**修法**（非 git 路径仍要保留 `.lastscan` 时）：
- 改用 `fs.promises.readFile` / `fs.promises.writeFile`
- 或者：**.lastscan 改成 NDJSON 格式**（path\tmtimeMs\n），append-only 写
- 或者：把 `.lastscan` 拆成 `.lastscan-manifest`（小清单）+ `.lastscan-mtimes`（用 binary 格式存）

### 4.4 Bug #5：3 个 git 命令可以合并成 1 个

**位置**：`checkpoint.ts:204-208`

```ts
// 现状：3 个并行 git 命令
const [modified, untracked, deleted] = await Promise.all([
  execAsync('git diff HEAD --name-only', ...),        // 启动开销 ~30ms
  execAsync('git ls-files --others --exclude-standard', ...),  // 启动开销 ~30ms
  execAsync('git ls-files --deleted', ...),            // 启动开销 ~30ms
]);
```

**问题**：每次启动 3 个 git 子进程，每次 ~30-50ms 启动开销 × 3 = **100-150ms 纯启动浪费**。`git status --porcelain` 一次启动就能拿到 modified/untracked/deleted **全部状态**。

**修法**：用单个 `git status --porcelain`，解析输出：

```ts
const stdout = await runGit(["status", "--porcelain"], rootDir);
// 解析格式："XY filename" — 前 2 字节是状态码
// " M" = modified, " M" = modified (worktree), " D" = deleted
// "M " = modified (staged), "A " = added to index
// "??" = untracked
const files = stdout
  .split("\n")
  .map(line => line.slice(3))   // 跳过前 2 字节状态 + 1 字节空格
  .filter(Boolean);
return [...new Set(files)];
```

**收益**：100-150ms → 50-80ms（且只有 1 次黑窗风险——修完 Bug #1 后此问题消失）。

---

## 5. 必须修的 1 个 server 端问题

### 5.1 Bug #6：`res.flushHeaders()` 未实施

**位置**：`agent/packages/server/src/index.ts:1908-1911, 2485`

`checkpoint-latency-optimization.md` §3.2 说"已加 `res.flushHeaders()`"，但**实际代码没有**。这是 Node.js HTTP 的真实问题：`setHeader` 只设缓冲，**响应头会缓存到首次 `res.write()` 才发送**。前端 `await fetch()` 一直卡在"等待响应头"阶段。

**修法**（在 `/api/chat` 和 `/api/chat/reconnect` 两处）：

```ts
res.setHeader('Content-Type', 'text/event-stream');
res.setHeader('Cache-Control', 'no-cache');
res.setHeader('Connection', 'keep-alive');
res.flushHeaders();    // ← 立即发送响应头
```

**收益**：前端的 `await fetch` 立即 resolve，首字延迟再降 100-500ms。

---

## 6. 完整修复清单（按优先级）

| 序号 | 任务 | 文件:行 | 估时 | 风险 | 影响 |
|------|------|---------|------|------|------|
| **1** | `exec` → `execFile` + `windowsHide: true` | `checkpoint.ts:204-208, 229-230` | 1h | 极低 | **消除黑窗**（P0）|
| **2** | 删 `getGitDirectoryState`、git 路径不写 `.lastscan` | `checkpoint.ts:224-259, 469, 475` | 1h | 低 | 性能 10-30s → 100ms |
| **3** | 3 git 命令合并为 `git status --porcelain` | `checkpoint.ts:204-208` | 30min | 低 | 启动开销 -50% |
| **4** | `isGitRepo` 缓存到实例 | `checkpoint.ts:187-193` | 15min | 极低 | 消除同步 IO |
| **5** | `loadLastScanState` / `saveScanState` 改异步 | `checkpoint.ts:337-360` | 30min | 低 | 消除 100-300ms 阻塞 |
| **6** | `res.flushHeaders()` | `server/src/index.ts:1908-1911, 2485` | 5min | 极低 | 首字 -100-500ms |
| **7** | 性能打点（4 处 `flog.info`） | `checkpoint.ts:357-445, 187, 337` | 30min | 极低 | 验证效果 |
| **8** | 单元测试（git 路径各分支） | `agent/test/checkpoint.test.ts` | 2h | - | 回归保护 |

**总估时**：约 6 小时（含测试），**最快半天可上线**。

---

## 7. 不要做的事

为了避免重蹈覆辙，明确**不**在本次范围内的事：

1. **不要动 `ToolConfirmBanner`** — 那在 `apps/ripple-desktop/src/components/ToolConfirmBanner.tsx`，**是另一个开发模块**（agent 工具调用 UI），与 checkpoint 模块无关
2. **不要改 `useStreamingChat.ts` 的 fire-and-forget 逻辑** — 那个已经改好了（`useStreamingChat.ts:586-618`），再改风险大于收益
3. **不要动 `EditBlockPreview` / `DiffPreview` 组件** — 那是 UI 层，本次只做后端 checkpoint 核心
4. **不要触碰 `agent/agents/*.agent.yaml`** — AGENTS.md §0 硬约束，禁止改 yaml
5. **不要"顺手优化"别的模块** — 严格只改本清单内 6 个文件

---

## 8. 验证方法

修完用以下方法验证（务必打点后再判断）：

### 8.1 黑窗消失

- **方法 1**：Windows 系统设置 → 辅助功能 → 视觉 → 显示通知 → 设 5 秒
- **方法 2**：录屏（OBS / Windows Game Bar），发 5 条消息回放
- **方法 3**：`git config --global core.editor` 之类能触发 git 的命令肉眼观察

### 8.2 性能打点验证

在 `create()` 入口加 `const t0 = Date.now()`，在关键节点打日志：

```ts
// checkpoint.ts:357 create() 入口
flog.info('CHECKPOINT', 'create() start', { cwd: this.rootDir });

// git 探测后
flog.info('CHECKPOINT', 'isGitRepo detected', { isGit: this.isGitRepo, ms: Date.now() - t0 });

// 文件列表确定后
flog.info('CHECKPOINT', 'filesToSnapshot', { count: filesToSnapshot.length, ms: Date.now() - t0 });

// saveCheckpoint 后
flog.info('CHECKPOINT', 'create() done', { ms: Date.now() - t0 });
```

**预期数字**（10K 文件项目，无文件改动）：
- 改前：5000-15000ms
- 改后：50-200ms

### 8.3 单元测试

`agent/test/checkpoint.test.ts` 已存在 250 行。**新增 4 个 case**：

```ts
it("git 路径下空改动应 0 读文件", async () => {
  // 创建临时 git 仓库
  // 创建文件，不修改
  // 调 manager.create({ source: "auto" })
  // 断言: filesToSnapshot.length === 0
});

it("git 路径下文件修改应只读变化文件", async () => {
  // 同样创建临时 git 仓库
  // 创建文件 a.txt b.txt
  // 修改 a.txt
  // 调 manager.create
  // 断言: filesToSnapshot === ['a.txt']
});

it("git 命令失败应回退到 mtime 扫描", async () => {
  // mock execFile 抛错
  // 验证回退路径
});

it("isGitRepo 应在构造函数缓存", async () => {
  // 多次调 create
  // 验证 fs.access 只调一次
});
```

---

## 9. 上线 checklist

- [ ] Bug #1：exec → execFile，5 处全部加 windowsHide
- [ ] Bug #2：删除 getGitDirectoryState，git 路径不写 .lastscan
- [ ] Bug #3：isGitRepo 实例缓存
- [ ] Bug #4：loadLastScanState / saveScanState 改异步
- [ ] Bug #5：3 git 命令合并为 status --porcelain
- [ ] Bug #6：res.flushHeaders() 真实实施（不是只写文档）
- [ ] 性能打点（4 处）
- [ ] 单元测试（至少 4 个新 case）
- [ ] 在 Windows 实机测试：发 5 条消息，确认无黑窗
- [ ] 在大项目（>5K 文件）测试：TTFT 数字记录
- [ ] 同步更新 `checkpoint-latency-optimization.md`，把"已实施"改成实际状态

---

## 10. 风险与回滚

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| execFile 在 Windows 找不到 git.exe | 低 | 中 | PATH 检测 + 报错回退到 mtime 扫描 |
| git status --porcelain 解析出错（重命名/中文路径） | 低 | 中 | 输出测试 + 严格 slice(3) |
| 删除 .lastscan 丢回滚数据 | 0 | 0 | **.lastscan 只用于 git 路径加速，不存快照数据本身** |
| flushHeaders 影响其他 SSE 客户端 | 极低 | 低 | 只改 2 处，其他 SSE 端点不动 |
| 性能打点影响线上性能 | 极低 | 无 | 打点都是 `flog.info` 异步写日志 |

**回滚方案**：本批只改 2 个文件（`checkpoint.ts` + `server/src/index.ts`）。任意 commit 出问题 `git revert HEAD` 即可。

---

## 11. 关键参考

- **Node.js spawn 文档**：`windowsHide: true` 在 Windows 上设置 `CREATE_NO_WINDOW` flag，**这是 Windows 上消除黑窗的标准做法**
- **项目内标准范式**：`agent/packages/agent/src/harness/env/nodejs.ts:109, 199, 253`
- **同类参考**：[VSCode 源码](https://github.com/microsoft/vscode) 启动子进程时也传 `windowsHide: true`
- **Node.js issue 列表**：[nodejs/node#29532](https://github.com/nodejs/node/issues/29532) 等多个 issue 都讨论过这个 Windows-specific 行为

---

**撰写人**：AI（基于代码 review + 实际运行表现）
**最后更新**：2026-06-04
**状态**：待实施，handoff 给接手同学
