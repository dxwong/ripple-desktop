#!/bin/bash
# git脚本使用方法(1.2): 
#   ./release.sh              # 自动使用当前时间作为版本号
#   ./release.sh v1.0         # 使用指定版本号
#   ./release.sh v1.0 -f      # 强制覆盖已存在的标签

set -e

# 解析参数
FORCE_TAG=false
if [ "$2" = "-f" ] || [ "$1" = "-f" ]; then
    FORCE_TAG=true
    if [ "$1" = "-f" ]; then
        shift
    fi
fi

# 检查1：是否在 Git 仓库内
if ! git rev-parse --git-dir > /dev/null 2>&1; then
    echo "❌ 错误：当前目录不是 Git 仓库"
    exit 1
fi

# 检查2：当前分支是否为 dev
CURRENT_BRANCH=$(git branch --show-current)
if [ "$CURRENT_BRANCH" != "dev" ]; then
    echo "❌ 错误：当前在 '$CURRENT_BRANCH' 分支，请先切换到 dev 分支"
    echo "   提示：git checkout dev"
    exit 1
fi

# 确定版本号
if [ -z "$1" ]; then
    VERSION="v$(date +%Y%m%d-%H%M%S)"
    echo "📅 使用自动生成的时间戳版本号: $VERSION"
else
    VERSION="$1"
    echo "🏷️  使用指定版本号: $VERSION"
fi

# 检查 tag 是否已存在（非强制模式）
if [ "$FORCE_TAG" = false ] && git rev-parse "$VERSION" > /dev/null 2>&1; then
    echo "❌ 错误：标签 $VERSION 已存在"
    echo "   提示：使用 $0 $VERSION -f 强制覆盖"
    exit 1
fi

# 如果强制模式且标签已存在，删除旧标签
if [ "$FORCE_TAG" = true ] && git rev-parse "$VERSION" > /dev/null 2>&1; then
    echo "⚠️  警告：标签 $VERSION 已存在，将强制覆盖"
    git tag -d "$VERSION" > /dev/null 2>&1
fi

# 确保工作区干净
if [ -n "$(git status --porcelain)" ]; then
    echo "❌ 错误：dev 分支有未提交的改动，请先提交后再执行发布"
    echo "   提示：git add . && git commit -m 'your message'"
    exit 1
fi

# 保存 dev 最新提交的 hash（用于日志）
DEV_COMMIT=$(git rev-parse --short dev)

# 发布流程 - 使用 commit-tree 创建独立版本节点
echo "🚀 开始发布流程..."

# 切换到 master 分支
git checkout master > /dev/null 2>&1

# 获取 dev 最新代码的 tree 对象
TREE_HASH=$(git rev-parse dev^{tree})

# 创建新的提交对象（基于当前 master 作为父节点，形成版本链）
# 如果 master 是空的（首次发布），则创建无父节点的根提交
if git rev-parse master^{commit} > /dev/null 2>&1; then
    # master 已有历史，关联父节点
    NEW_COMMIT=$(git commit-tree -m "Release: $VERSION" -p HEAD "$TREE_HASH")
else
    # master 为空仓库或首次发布，创建根提交
    NEW_COMMIT=$(git commit-tree -m "Release: $VERSION" "$TREE_HASH")
fi

# 将 master 指向新创建的提交
git reset --hard "$NEW_COMMIT" > /dev/null 2>&1

# 打上版本标签
git tag "$VERSION"

# 切回 dev 分支
git checkout dev > /dev/null 2>&1

# 显示发布信息
echo "✅ 发布 $VERSION 完成！"
echo ""
echo "📊 发布信息："
echo "   - 版本标签: $VERSION"
echo "   - 基于 dev 提交: $DEV_COMMIT"
echo "   - master 提交: $(git rev-parse --short master)"
echo "   - master 历史节点数: $(git rev-list master --count)"
echo ""
echo "💡 提示："
echo "   - master 分支只包含版本节点，不包含 dev 开发历史"
echo "   - 查看版本历史: git log master --oneline"
echo "   - 查看 dev 完整历史: git log dev --oneline"

# 推送到远程（根据需要开启）
# echo ""
# echo "📤 推送到远程仓库（如需推送请取消注释）："
# echo "   git push origin master --force --tags"
# echo "   git push origin dev"

# 可选：自动推送（取消注释以下代码启用）
# echo "🔄 正在推送到远程..."
# git push origin master --force --tags
# git push origin dev
# echo "✅ 推送完成"