#!/bin/bash
# init.sh - 初始化 git 仓库（新项目首次使用）
# 使用方法：在项目根目录下执行
#   bash /path/to/init.sh

set -e

# 检查是否已在 Git 仓库中
if git rev-parse --git-dir > /dev/null 2>&1; then
    echo "❌ 错误：当前目录已是 Git 仓库"
    exit 1
fi

# 1. 初始化仓库
echo "📦 git init..."
git init

# 2. 创建空 master 分支（orphan + 空提交，否则 release.sh 合并会失败）
echo "🔨 创建 master 分支..."
git checkout --orphan master
git commit --allow-empty -m "init"

# 3. 创建 dev 分支
echo "🔨 创建 dev 分支..."
git checkout -b dev

echo ""
echo "✅ 初始化完成！当前在 dev 分支"
