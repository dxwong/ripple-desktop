#!/bin/bash
# git脚本使用方法(1.1): 
#   ./release.sh              # 自动使用当前时间作为版本号
#   ./release.sh v1.0      # 使用指定版本号

set -e

# 检查1：是否在 Git 仓库内
if ! git rev-parse --git-dir > /dev/null 2>&1; then
    echo "❌ 错误：当前目录不是 Git 仓库"
    exit 1
fi

# 检查2：当前分支是否为 dev
CURRENT_BRANCH=$(git branch --show-current)
if [ "$CURRENT_BRANCH" != "dev" ]; then
    echo "❌ 错误：当前在 '$CURRENT_BRANCH' 分支，请先切换到 dev 分支 git checkout dev"
    exit 1
fi

# 检查3：tag 是否已存在
if [ -n "$1" ]; then
    if git rev-parse "$1" > /dev/null 2>&1; then
        echo "❌ 错误：标签 $1 已存在，请使用其他版本号"
        exit 1
    fi
fi

# 确定版本号
if [ -z "$1" ]; then
    VERSION="v$(date +%Y%m%d-%H%M%S)"
    echo "使用自动生成的时间戳版本号: $VERSION"
else
    VERSION="$1"
    echo "使用指定版本号: $VERSION"
fi

# 确保工作区干净
if [ -n "$(git status --porcelain)" ]; then
    echo "⚠️ 警告：dev 有未提交的改动，已自动提交"
    git add .
    git commit -m "WIP: 发布前的未保存改动"
fi

# 发布流程
git checkout master                     # 切换到主分支
# 合并 dev 的所有改动（压缩成一个提交）
# 使用 --allow-unrelated-histories 支持首次发布（不共享历史的分支）
# 冲突（add/add）是预期的，后续强制取 dev 版本即可
git merge --squash dev --allow-unrelated-histories 2>&1 || echo "⚠️ 合并冲突自动处理中..."
# 自动解决所有冲突：以 dev（--theirs）为准，覆盖 master 的全部文件状态
git checkout --theirs . 2>/dev/null || true
git reset HEAD -- . 2>/dev/null || true
git add .
git commit -m "Release: $VERSION"       # 提交并标注版本号
git tag "$VERSION"                      # 打上版本标签
git checkout dev                        # 切回 dev 分支（dev 保持不动，提交历史完整保留）

# 推送到远程（根据需要开启）
# git push origin master --tags
# git push origin dev

echo "✅ 发布 $VERSION 完成，dev 分支提交历史已完整保留"
