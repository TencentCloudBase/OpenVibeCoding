#!/bin/sh
# scripts/install-skills.sh
# 安装 CloudBase Skills 到项目目录
# 在 Dockerfile 构建时或本地初始化时调用
#
# 用法:
#   sh scripts/install-skills.sh
#
# 环境变量:
#   SKILLS_REGISTRY  npm registry（默认腾讯镜像）
#   SKIP_SKILLS      设为 "true" 跳过安装

set -e

WORKDIR="$(cd "$(dirname "$0")/.." && pwd)"
SKILLS_DIR="$WORKDIR/.agents/skills"
SERVER_SKILLS_DIR="$WORKDIR/packages/server/skills"
REGISTRY="${SKILLS_REGISTRY:-https://mirrors.tencent.com/npm/}"

echo "[skills] Installing CloudBase Skills..."
echo "[skills] Target: $SKILLS_DIR"

# 跳过开关
if [ "$SKIP_SKILLS" = "true" ]; then
  echo "[skills] SKIP_SKILLS=true, skipping."
  exit 0
fi

# 已安装则跳过（cloudbase 作为存在性标志）
if [ -d "$SKILLS_DIR/cloudbase" ]; then
  echo "[skills] Skills already installed. (delete .agents/ to reinstall)"
  exit 0
fi

# 检查 npx 是否可用
if ! command -v npx > /dev/null 2>&1; then
  echo "[skills] ERROR: npx not found, cannot install skills."
  exit 1
fi

mkdir -p "$SKILLS_DIR"
mkdir -p "$SERVER_SKILLS_DIR"

cd "$WORKDIR"

echo "[skills] Running: npx skills add tencentcloudbase/cloudbase-skills --yes"
npm_config_registry="$REGISTRY" npx --yes --registry "$REGISTRY" skills add tencentcloudbase/cloudbase-skills --yes

# 软链接到 packages/server/skills/cloudbase，供 CODEBUDDY_BUNDLED_SKILLS_DIR 读取
if [ ! -e "$SERVER_SKILLS_DIR/cloudbase" ]; then
  ln -s "$SKILLS_DIR/cloudbase" "$SERVER_SKILLS_DIR/cloudbase"
  echo "[skills] Symlinked: packages/server/skills/cloudbase -> .agents/skills/cloudbase"
fi

echo "[skills] Done. Installed skills:"
ls "$SKILLS_DIR" | sed 's/^/  - /'
