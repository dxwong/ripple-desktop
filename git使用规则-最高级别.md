# Git 规则（必读，最高优先级）

## git仓库规则
- git init 初始化仓库，直接运行脚本init.sh
- 创建主分支 master：`git checkout -b master`（不是 orphan）
- master 上只允许一个 init 空提交，master 只接收 release.sh脚本的合并
- 创建开发分支dev：`git checkout -b dev`
- 后续开发都在 dev 上进行，add/commit/push
❌ 禁止在 `master` 分支上 `git commit`

## ⚠️ 开发中及时提交（重要）
- **每完成一个功能点或修复一个 bug，立即 `git add` + `git commit` 到 dev 分支**
- dev 分支就是用来做开发回溯的，频繁提交不会出现任何问题
- 及时提交的好处：代码出问题时可以快速回退到上一个正常节点
- 提交信息格式：简洁描述改动内容，如 `fix: 修复表格保存失真`、`feat: 添加复制按钮`
- ❌ 禁止长时间开发不提交，导致出问题时找不到之前的正常代码节点

## 发布版本
- 用户说"发布版本"时，需运行 release.sh脚本完成发布
- ❌ 禁止自己执行git命令合并操作，发布失败，先询问用户
- **默认**：运行 `./release.sh`不指定版本号时，系统自动使用日期时间作为版本号
- **指定版本号**：用户明确说"发布 v1.0"请运行 `./release.sh v1.0`
- 首次发布时，release.sh 会将 dev 的所有改动合并到 master
- 后续发布会 squash 合并，保持 master 历史整洁
- 执行前先确认目标目录和版本号，遇到冲突/歧义时，停下来询问，而不是擅自决定
