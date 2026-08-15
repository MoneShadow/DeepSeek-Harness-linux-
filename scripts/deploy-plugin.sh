#!/usr/bin/env bash
# dsh-plugin-vision 部署脚本
#
# 事故背景（2026-08-14 二次事故）：`dsh plugin add file:<dir>` 用 pnpm 把插件
# 复制进 profile，同时把 @deepseek-ai/dsh-tools 等依赖副本也装进 profile 的
# node_modules——副本遮蔽了 healProfilesModuleFallback 建的全局软链层
# （~/.dsh/profiles/node_modules），造成 dsh-tools 双实例（模块私有 Symbol
# TOOL_RUNTIME_SCHEDULER 分裂），任何工具调用都会崩：
#   Cannot read properties of undefined (reading 'prepare')
#
# 本脚本采用正确挂载方式：
#   1. 插件实体复制到全局 dsh 依赖树（与官方 bundle 同锚点，realpath 在全局树，
#      其 import 的 dsh-tools/schemastery 与官方工具解析到同一实例）
#   2. 目标 profile 的 node_modules 里建软链指向全局树实体
#      （Loader 以 profile 为基准 import 包名，必须能在 profile 链上解析到）
#   3. 清除 profile 里 pnpm 留下的依赖副本，让解析回落到 heal 软链层
#   4. manifest 的 bundles 加名（dependencies 不写 file: 条目，杜绝 pnpm 重建副本）
#
# 用法：./scripts/deploy-plugin.sh [profile] [插件源码目录]   # 默认 web / 本仓库 plugins/
# 铁律：目标 profile 不能被任何引擎占用（先退出 DSH Desktop / 停掉相关引擎）！
set -euo pipefail

PROFILE="${1:-web}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_SRC="${2:-$SCRIPT_DIR/../plugins/dsh-plugin-vision}"
PLUGIN_NAME="dsh-plugin-vision"
HOME_DIR="${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}"

# 自动探测 dsh 安装位置：从 dsh 可执行文件 realpath 向上找全局依赖树
detect_dsh_dir() {
  local bin=""
  bin="$(command -v dsh 2>/dev/null || true)"
  if [ -z "$bin" ]; then
    for c in "$HOME_DIR/.local/bin/dsh" /usr/local/bin/dsh /usr/bin/dsh; do
      [ -x "$c" ] && bin="$c" && break
    done
  fi
  if [ -z "$bin" ]; then
    echo "❌ 找不到 dsh 可执行文件（请先安装 @deepseek-ai/dsh 或把 dsh 加入 PATH）" >&2
    exit 1
  fi
  # ~/.local/bin/dsh -> .../@deepseek-ai/dsh/lib/bin.js：取 lib/ 上两级的包目录
  local real dir
  real="$(readlink -f "$bin" 2>/dev/null || echo "$bin")"
  dir="$(dirname "$(dirname "$real")")"
  if [ -d "$dir/node_modules" ]; then echo "$dir/node_modules"; else echo "$dir"; fi
}
DSH_NODE_MODULES="$(detect_dsh_dir)"
PROFILE_DIR="$HOME_DIR/.dsh/profiles/$PROFILE"
PROFILE_NM="$PROFILE_DIR/node_modules"
HEAL_NM="$HOME_DIR/.dsh/profiles/node_modules"

if [ ! -d "$PLUGIN_SRC" ]; then echo "❌ 插件源码不存在：$PLUGIN_SRC"; exit 1; fi
if [ ! -f "$PROFILE_DIR/package.json" ]; then echo "❌ profile 不存在：$PROFILE_DIR"; exit 1; fi

echo "==> 部署 dsh-plugin-vision → profile [$PROFILE]"
echo "==> dsh 依赖树：$DSH_NODE_MODULES"

# 0. 安全提示：目标 profile 不应有引擎在跑
RUNNING=$(pgrep -af "dsh --profile $PROFILE " | grep -v bwrap | grep -v deploy-plugin || true)
if [ -n "$RUNNING" ]; then
  echo "⚠️  检测到 [$PROFILE] profile 的引擎正在运行："
  echo "$RUNNING"
  echo "    铁律：禁止在运行中修改 profile！请先退出 DSH Desktop 再执行。"
  exit 1
fi

# 1. 插件实体 → 全局 dsh 依赖树（rsync 同步，含删除，保证与源码一致）
#    dsh 装在系统目录（sudo npm install -g）时全局树不可写——自动用 sudo，
#    并保留用户 HOME（sudo 默认把 HOME 指到 /root，profile 路径会错）
echo "==> 同步插件到全局依赖树：$DSH_NODE_MODULES/$PLUGIN_NAME"
if [ -w "$DSH_NODE_MODULES" ]; then
  mkdir -p "$DSH_NODE_MODULES/$PLUGIN_NAME"
  rsync -a --delete \
    --exclude 'node_modules' --exclude '.git' --exclude 'tests' \
    "$PLUGIN_SRC/" "$DSH_NODE_MODULES/$PLUGIN_NAME/"
else
  echo "==> 全局依赖树不可写（dsh 装在系统目录），改用 sudo…"
  sudo env "HOME=$HOME_DIR" mkdir -p "$DSH_NODE_MODULES/$PLUGIN_NAME"
  sudo env "HOME=$HOME_DIR" rsync -a --delete \
    --exclude 'node_modules' --exclude '.git' --exclude 'tests' \
    "$PLUGIN_SRC/" "$DSH_NODE_MODULES/$PLUGIN_NAME/"
fi

# 2. profile node_modules 软链 → 全局树实体
echo "==> profile 软链：$PROFILE_NM/$PLUGIN_NAME"
mkdir -p "$PROFILE_NM"
rm -rf "$PROFILE_NM/$PLUGIN_NAME"   # 清掉 pnpm 旧副本（实体目录或旧软链）
ln -s "$DSH_NODE_MODULES/$PLUGIN_NAME" "$PROFILE_NM/$PLUGIN_NAME"

# 3. 清除 pnpm 依赖副本（遮蔽 heal 层的元凶），让解析回落到 heal 软链
#    ⚠️ 事故教训（2026-08-15）：若 profile 的 @deepseek-ai 是指向全局树的
#    符号链接（单实例修复），rm -rf 会穿过软链删掉全局包（dsh-tools/
#    schemastery/cosmokit），导致引擎 boot 失败。仅当 @deepseek-ai 是
#    真实目录（pnpm 副本）时才清理。
echo "==> 清除 pnpm 依赖副本（@deepseek-ai/{dsh-tools,schemastery,cosmokit}、@standard-schema）"
if [ -L "$PROFILE_NM/@deepseek-ai" ]; then
  echo "==> @deepseek-ai 是指向全局树的符号链接，跳过副本清理（解析已回落全局）"
elif [ -d "$PROFILE_NM/@deepseek-ai" ]; then
  for pkg in dsh-tools schemastery cosmokit; do
    rm -rf "$PROFILE_NM/@deepseek-ai/$pkg"
  done
  rm -rf "$PROFILE_NM/@standard-schema"
else
  echo "==> profile 无 @deepseek-ai 目录（解析走 heal 软链层），跳过副本清理"
fi

# 4. manifest：bundles 追加插件名；dependencies 移除 file: 条目
echo "==> 更新 manifest bundles"
python3 - "$PROFILE_DIR/package.json" "$PLUGIN_NAME" <<'PY'
import json, sys
path, name = sys.argv[1], sys.argv[2]
d = json.load(open(path))
d.setdefault('dsh', {}).setdefault('profile', {}).setdefault('bundles', [])
if name not in d['dsh']['profile']['bundles']:
    d['dsh']['profile']['bundles'].append(name)
d.setdefault('dependencies', {})
d['dependencies'].pop(name, None)  # 删掉 file: 条目，防止 pnpm 重建副本
json.dump(d, open(path, 'w'), indent=2, ensure_ascii=False)
print(f"bundles = {d['dsh']['profile']['bundles']}")
PY

echo "==> 部署完成。验证："
echo "    dsh --profile $PROFILE --dump-config | grep -A8 'id: vision'"
echo "    工具调用级回归（headless profile 示例）："
echo "    dsh --profile vision-dev \"用 bash 工具执行 pwd，只报告输出\""
