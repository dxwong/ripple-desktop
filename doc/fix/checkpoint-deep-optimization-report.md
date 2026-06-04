# Checkpoint 深度优化实施报告

> 基于 `checkpoint-latency-optimization.md` 的排查分析，对 checkpoint 模块实施第二轮深度优化。
>
> 实施：2026-06-04
> 涉及文件：`agent/packages/agent/src/tools/checkpoint.ts`
> 变更类型：纯后端优化，无需前端改动

---

## 一、解决的问题

| 问题 | 严重度 | 改前 | 改后 |
|------|--------|------|------|
| Git CMD 弹窗 | 🟡 中 | Windows 每次弹 cmd 窗口 | 静默执行 |
| git 扫描慢 | 🟢 低 | 3 次子进程（diff + ls-files × 2） | 1 次子进程（git status --porcelain） |
| `isGitRepo()` 重复 stat | 🟢 低 | 每次创建 checkpoint 都 stat | 缓存结果，最多 50 条 |
| git 路径保留 .lastscan、getGitDirectoryState | 🟢 低 | 死代码约 60 行 | 已清理 |
| 非 git 大项目无跳过机制 | 🟢 低 | 必须全量递归 | 支持 `.checkpointignore` |

---

## 二、设计原则

1. **Checkpoint 每次都创建（对话快照）** — 原流程不变，不影响功能
2. **checkpoint 扫描加速，不改时序** — 不引入新的钩子/事件/锁，保持简单可靠
3. **非 git 项目不做额外复杂优化** — 小型测试项目全量递归够用，可选 .checkpointignore
4. **所有改动向后兼容** — 已有 checkpoint 文件格式不变，回滚逻辑不变

---

## 三、实际改动清单

### 改动 1：isGitRepo() 缓存（A + C）

**位置：** `checkpoint.ts:187-222`

**变更：**
- 新增模块级 `gitRepoCache`（Map，上限 50 条 LRU 驱逐）
- 缓存 key = `path.resolve(rootDir)`
- **向上查找 `.git`**：支持 monorepo 子目录场景（从当前目录逐级向上找，找到 `.git` 为止）

```typescript
const gitRepoCache = new Map<string, boolean>();
function isGitRepo(rootDir: string): boolean {
    const resolved = path.resolve(rootDir);
    const cached = gitRepoCache.get(resolved);
    if (cached !== undefined) return cached;
    // 向上查找 .git 目录...
}
```

**收益：** 多次调用 `isGitRepo()` 时仅第一次 stat，后续 0 开销。

---

### 改动 2：git status --porcelain 替换旧扫描（B）

**位置：** `checkpoint.ts:224-254`

**新增函数：** `getGitChangedFilesViaStatus()`
**旧函数：** `getGitChangedFiles()`（已删除）
**旧函数：** `getGitDirectoryState()`（已删除，见改动 3）

**对比：**

| | 旧方案 | 新方案 |
|--|--------|--------|
| 子进程数 | 3 次（diff + ls-files --others + ls-files --deleted） | **1 次** |
| 命令 | `git diff HEAD --name-only` 等 | `git status --porcelain` |
| 解析复杂度 | 3 个输出去重合并 | `line.slice(3)` |
| CMD 弹窗 | ❌ 未设置 `windowsHide` | ✅ `{ windowsHide: true, timeout: 5000 }` |

**windowsHide: true** 确保 Windows 下不弹 cmd 窗口，`timeout: 5000` 防止 git 卡死。

---

### 改动 3：清理死代码（D）

**删除项：**

| 函数/代码 | 行数 | 原因 |
|-----------|------|------|
| `getGitDirectoryState()` | ~30 行 | 不再需要全量文件列表，git status 已足够 |
| `create()` 中的 `.lastscan` 读写在 git 路径的调用 | ~15 行 | git 路径不依赖 mtime 缓存 |

**保留的非 git 路径逻辑：** `.lastscan`、`saveScanState()`、`loadLastScanState()` 仅用于非 git 项目的增量扫描，功能不变。

---

### 改动 4：.checkpointignore 支持（G）

**新增函数：**

| 函数 | 用途 |
|------|------|
| `loadCheckpointIgnorePatterns(rootDir)` | 从项目根目录读取 `.checkpointignore` |
| `shouldIgnorePath(relativePath, patterns)` | 判断路径是否匹配忽略规则 |

**支持的忽略规则格式：**

```
# 这是注释
node_modules          # 精确匹配目录/文件名
*.log                 # 后缀匹配（所有 .log 文件）
dist/**               # 目录前缀匹配（dist/ 下所有文件）
```

**应用范围：**

| 使用位置 | 说明 |
|----------|------|
| `scanDirectory()` | 非 git 路径的文件扫描（全量递归时跳过） |
| `getDirectoryState()` | 非 git 路径的 mtime 扫描（增量对比时跳过） |
| `restore()` 中的全量恢复 | 恢复时跳过不应被操作的文件 |
| `diff()` 中的新增文件检查 | 比较时不报告忽略目录中的文件 |

---

## 四、文件对比

| 维度 | 改前 | 改后 |
|------|------|------|
| 函数数 | `isGitRepo` + `getGitChangedFiles` + `getGitDirectoryState` + `scanDirectory` + `getDirectoryState` | **删除 1 个旧函数**，**替换 1 个旧函数**，**新增 2 个辅助函数** |
| 总行数 | ~893 行 | ~937 行（+44 行，含注释） |
| 子进程调用 | 5 处（3 diff + 2 ls-files） | **1 处**（git status） |

---

## 五、安全与回退

| 场景 | 预期行为 |
|------|----------|
| git 路径，`git status` 失败 | 回退到全量递归（非 git 路径） |
| git 路径，不是 git 仓库 | 全量递归（非 git 路径） |
| 非 git 路径，无 `.checkpointignore` | 使用 `DEFAULT_SKIP_DIRS` 默认规则（无变化） |
| 非 git 路径，有 `.checkpointignore` | 额外跳过忽略规则匹配的文件 |
| 多路径 isGitRepo 调用 | 缓存命中，零开销 |
| 已有 checkpoint 回滚 | 不受影响（未改 checkpoint 文件格式） |

---

## 六、变更记录

| 日期 | 文件 | 描述 | 实施人 |
|------|------|------|--------|
| 2026-06-04 | `checkpoint.ts` | `isGitRepo()` 缓存 + 向上查找 | AI |
| 2026-06-04 | `checkpoint.ts` | `getGitChangedFilesViaStatus()` 替代旧扫描 | AI |
| 2026-06-04 | `checkpoint.ts` | 删除 `getGitDirectoryState()`、git 路径 .lastscan | AI |
| 2026-06-04 | `checkpoint.ts` | 所有 `execAsync` 加 `{ windowsHide, timeout }` | AI |
| 2026-06-04 | `checkpoint.ts` | 新增 `.checkpointignore` 支持 | AI |