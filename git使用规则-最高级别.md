# Git 规则（必读，最高优先级）

> **版本**：v2.0
> **更新日期**：2026-05-17
> **更新原因**：0117 灾难故障复盘，补充 5 条安全规则 + 2 条遗漏规则
>
> ⚠️ 本文档是 AI 操作 git 的**唯一依据**，违反任何一条都可能导致不可逆的数据丢失。

---

## 一、Git 命令白名单（🔴 最高优先级）

AI **只允许**执行以下 git 命令，其余一律禁止：

### ✅ 允许执行的命令

| 命令 | 说明 | 限制 |
|------|------|------|
| `git add` | 暂存文件 | 无 |
| `git commit` | 提交到本地 | 仅限 dev 分支 |
| `git push origin dev` | 推送到远程 | **仅限 dev 分支** |
| `git pull origin dev` | 拉取远程更新 | **仅限 dev 分支** |
| `git status` | 查看工作区状态 | 无 |
| `git log` | 查看提交历史 | 无 |
| `git diff` | 查看差异 | 无 |
| `git branch` | 查看分支列表 | 无 |
| `git switch dev` | 切回 dev 分支 | **仅限 dev** |

### ❌ 严格禁止的命令

| 命令 | 禁止原因 |
|------|---------|
| `git checkout` | 会丢弃工作区修改（`checkout -- file`），用 `git switch` 代替 |
| `git checkout master` | 切换到 master 分支 |
| `git merge` | 合并操作，仅 release.sh 脚本可执行 |
| `git merge --squash` | squash 合并 |
| `git stash` / `git stash clear` | **本次事故的直接元凶**，不可逆数据丢失 |
| `git reset` | 会丢失提交历史 |
| `git rebase` | 会改写提交历史 |
| `git cherry-pick` | 跨分支操作，风险高 |
| `git push origin master` | 推送到 master 分支 |
| `git checkout -- <file>` | 丢弃工作区修改 |
| `git clean` | 删除未跟踪文件 |
| `git fsck` / `git reflog` | 修复命令，可能加剧损坏 |

### 🔄 需要暂存代码时

**不要用 `git stash`**，改为：
```bash
git add .
git commit -m "chore: 暂存当前进度"
```

---

## 二、.git 目录保护（🔴 最高优先级）

> **本次事故核心**：.git 文件夹被损坏导致所有本地提交历史丢失。

- ❌ **绝对禁止** AI 执行任何涉及 `.git` 目录的操作
- 包括但不限于：删除、移动、重命名、复制、修改 `.git` 目录内的任何文件
- ❌ 禁止执行：`rm -rf .git`、`mv .git`、`xcopy .git`、`del .git` 等
- ❌ 禁止任何可能影响 `.git` 目录完整性的脚本或命令

---

## 三、强制远程推送（🟡 高优先级）

> **原则**：代码必须同时存在于本地 dev 分支 + 远程仓库两个位置。

### 推送规则

每次 commit 到 dev 后，必须执行：
```bash
git pull origin dev    # 先拉取，避免冲突
git push origin dev    # 再推送
```

### 异常处理

| 情况 | 处理方式 |
|------|---------|
| push 成功 | 正常继续 |
| push 失败（网络问题） | 重试一次，仍失败则告知用户 |
| pull 有冲突 | **立即停止**，告知用户，不要尝试自动解决 |
| 远程仓库不存在 | 告知用户，等待用户创建远程仓库 |

---

## 四、代码变更后强制提交（🟡 高优先级）

### 必须立即提交的场景

- 技术人员修改完代码后
- AI review 完代码后
- AI 完成一段独立的、可验证的代码改动后
- 任何文件新增/删除后

### 提交粒度

- ✅ 每完成一个**独立功能点**，立即 commit
- ✅ 修改超过 5 个文件时，至少每 5 个文件提交一次中间节点
- ❌ 禁止长时间开发不提交（超过 30 分钟无提交即违规）

### 提交信息格式

```
feat: 添加用户登录功能
fix: 修复表格保存失真
chore: 保存当前进度
docs: 更新技术文档
refactor: 重构编辑模块
```

---

## 五、发布版本规则

### 正常发布流程

1. 用户说"发布版本"时，运行 `./release.sh` 或 `./release.sh v1.0`
2. **执行前必须确认**：
   - 当前在 dev 分支（`git branch` 确认）
   - 工作区干净（`git status` 无未提交修改）
   - dev 已 push 到远程
   - 以上任一条件不满足，**不执行 release.sh**，先告知用户
3. 执行后确认结果，向用户报告

### 🔴 release.sh 失败时的处理规则

> **本次事故链路**：release.sh 失败 → AI 尝试手动修复 → git stash clear → .git 毁灭

**release.sh 执行失败时，必须严格遵守以下规则**：

1. **立即停止**，不要尝试手动执行脚本中的任何 git 命令
2. 执行 `git switch dev` 确保回到 dev 分支
3. 向用户报告错误信息，等待用户指示
4. ❌ **严禁**在 release 失败后执行以下命令：
   - `git merge`
   - `git stash`
   - `git stash clear`
   - `git checkout master`
   - `git reset`
   - 任何尝试"修复"git 状态的命令

---

## 六、灾难恢复规则（🔴 最高优先级）

> 如果 git 出现任何异常（报错、卡死、状态不一致）：

1. **立即停止所有 git 操作**
2. **不要尝试自行修复**
3. 向用户报告异常信息
4. 等待用户处理

❌ **严禁 AI 尝试以下修复操作**：
- `git fsck`
- `git reflog`
- `git reset --hard`
- `git rebase`
- 手动修改 `.git` 目录中的文件
- 删除并重新 `git init`
- 任何从网上搜到的"git 修复命令"

---

## 七、Git 仓库基础规则

- git init 初始化仓库，直接运行脚本 init.sh（AI 不手动执行 `git init` 或 `git checkout -b`）
- master 和 dev 分支由 init.sh 脚本创建，AI 不手动创建分支
- master 上只允许一个 init 空提交，master 只接收 release.sh 脚本的合并
- 后续开发都在 dev 上进行，add/commit/push
- ❌ 禁止在 `master` 分支上 `git commit`

---

## 八、release.sh 脚本改进建议

> 以下为建议改进项，需要用户评估是否采纳：

1. 脚本开头增加 `set -e`（遇到错误立即退出，防止继续执行后续命令）
2. 用 `git switch` 代替 `git checkout`（语义更清晰，不会误操作文件）
3. `git switch master` 前先确认 dev 已 push 到远程
4. 合并失败时自动 abort 并切回 dev，而不是继续执行
5. 执行前自动打一个 backup tag（如 `pre-release-backup`）

---

## 事故复盘记录

### 0117 灾难故障

**事故链路**：
```
release.sh 执行失败（Windows bash 不可用）
  → AI 尝试手动执行脚本中的 git 命令
    → git checkout master
      → git merge --squash dev（报错）
        → git stash clear
          → .git 目录损坏
            → 所有本地提交历史丢失
```

**最终结果**：用户从回收站恢复 .git 文件夹后，发现 git 实际已提交成功，0 代码损失。

**教训**：
1. AI 不应该执行白名单之外的 git 命令
2. release 失败后不应该尝试手动修复
3. 代码应该及时推送到远程
4. .git 目录是生命线，任何操作都需要极度谨慎
