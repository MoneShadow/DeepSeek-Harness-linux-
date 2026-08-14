#!/usr/bin/env bash
# ============================================================================
# DSH Desktop 一键安装脚本
#
# 从零到可用的完整安装：
#   1. 检查 Node/npm 环境
#   2. 安装官方 dsh CLI（@deepseek-ai/dsh@next，未安装时）
#   3. 安装本仓库依赖
#   4. 挂载视觉助手插件到 web profile（dsh-plugin-vision）
#   5. 构建 AppImage → ~/Applications/DSH-Desktop.AppImage + 桌面入口
#   6. 同步图标到系统缓存
#
# 用法：
#   ./install.sh                 # 完整安装（推荐）
#   ./install.sh --no-build      # 不打包 AppImage（仅依赖+插件）
#   ./install.sh --no-plugin     # 不装视觉插件（仅依赖+构建）
#   ./install.sh --help
#
# 注意：若 DSH Desktop 正在运行，插件安装步骤会跳过并给出提示，
#       退出应用后重跑本脚本即可补齐。
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

BUILD_APPIMAGE=1
INSTALL_PLUGIN=1
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD_APPIMAGE=0 ;;
    --no-plugin) INSTALL_PLUGIN=0 ;;
    --help|-h)
      sed -n '3,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "未知参数: $arg（--help 查看用法）"; exit 1 ;;
  esac
done

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m ✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m !\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m ✗\033[0m %s\n' "$*"; }

HOME_DIR="${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}"
APPS_DIR="$HOME_DIR/Applications"
DESKTOP_FILE="$HOME_DIR/.local/share/applications/dsh-desktop.desktop"

# ---------- 1. 环境检查 ----------
log "检查环境…"
if ! command -v node >/dev/null 2>&1; then
  fail "未找到 Node.js（要求 ≥ 22）。请先安装：https://nodejs.org"
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  fail "Node.js 版本过低（当前 $(node -v)，要求 ≥ 22）"
  exit 1
fi
ok "Node.js $(node -v)"
command -v npm >/dev/null 2>&1 && ok "npm $(npm -v)" || { fail "未找到 npm"; exit 1; }

# ---------- 2. 官方 dsh CLI ----------
log "检查官方 dsh CLI…"
DSH_BIN="$(command -v dsh 2>/dev/null || true)"
if [ -z "$DSH_BIN" ]; then
  for c in "$HOME_DIR/.local/bin/dsh" /usr/local/bin/dsh /usr/bin/dsh; do
    [ -x "$c" ] && DSH_BIN="$c" && break
  done
fi
if [ -z "$DSH_BIN" ]; then
  warn "未找到 dsh，开始安装 @deepseek-ai/dsh@next（全局）…"
  warn "⚠️  安装期间请勿中断（Ctrl-C / 关终端都会损坏全局依赖树，所有 profile 全崩）"

  # 编译工具检测：dsh 的 node-pty 无预编译产物时需要 make/gcc/g++ 源码编译
  # （Ubuntu 最小安装 / 部分容器镜像常缺失，实测 node-gyp 报 "not found: make"）
  MISSING_TOOLS=""
  for tool in make gcc g++; do
    command -v "$tool" >/dev/null 2>&1 || MISSING_TOOLS="$MISSING_TOOLS $tool"
  done
  if [ -n "$MISSING_TOOLS" ]; then
    warn "缺少编译工具：$MISSING_TOOLS（node-pty 需要源码编译）"
    BUILD_CMD=""
    if [ -f /etc/os-release ]; then
      # shellcheck disable=SC1091
      . /etc/os-release
      case "${ID:-}" in
        ubuntu|debian|linuxmint|pop) BUILD_CMD="sudo apt update && sudo apt install -y build-essential python3" ;;
        fedora|rhel|centos)          BUILD_CMD="sudo dnf groupinstall -y 'Development Tools'" ;;
        arch|manjaro|endeavouros)    BUILD_CMD="sudo pacman -S --noconfirm base-devel" ;;
      esac
    fi
    if [ -n "$BUILD_CMD" ]; then
      warn "自动安装编译工具：$BUILD_CMD"
      eval "$BUILD_CMD" || { fail "编译工具安装失败，请手动执行：$BUILD_CMD 后重跑本脚本"; exit 1; }
    else
      fail "请先安装编译工具（make/gcc/g++），再重跑本脚本"
      exit 1
    fi
  fi

  # 全局前缀可写性检查（npm prefix 目录）
  NPM_PREFIX="$(npm prefix -g)"
  if [ -w "$NPM_PREFIX" ]; then
    npm install -g "@deepseek-ai/dsh@next"
  else
    warn "全局 npm 目录 $NPM_PREFIX 不可写，尝试 sudo…"
    sudo npm install -g "@deepseek-ai/dsh@next"
  fi
  DSH_BIN="$(command -v dsh 2>/dev/null || true)"
  if [ -z "$DSH_BIN" ] || ! "$DSH_BIN" --version >/dev/null 2>&1; then
    fail "dsh 安装失败或依赖树不完整。请勿中断安装；必要时执行：npm install -g @deepseek-ai/dsh@next --force"
    exit 1
  fi
fi
DSH_VER="$("$DSH_BIN" --version 2>/dev/null | head -1 || echo 未知)"
ok "dsh $DSH_VER ($DSH_BIN)"

# ---------- 3. 仓库依赖 ----------
log "安装项目依赖（npm install）…"
npm install --no-audit --no-fund
ok "依赖就绪"

# ---------- 4. 视觉插件 ----------
if [ "$INSTALL_PLUGIN" -eq 1 ]; then
  log "挂载视觉助手插件（dsh-plugin-vision）…"
  if [ ! -f "$HOME_DIR/.dsh/profiles/web/package.json" ]; then
    log "web profile 尚未初始化，先用 dsh 触发初始化…"
    PATH="$PATH:$HOME_DIR/.local/bin" "$DSH_BIN" plugin --profile web --help >/dev/null 2>&1 || true
  fi
  if ./scripts/deploy-plugin.sh web; then
    ok "插件已挂载到 web profile（重启 DSH Desktop 后生效）"
  else
    warn "插件挂载被跳过：可能引擎正在运行。退出应用后重跑：./install.sh --no-build"
  fi
else
  log "跳过插件安装（--no-plugin）"
fi

# ---------- 5. 构建 + 桌面入口 ----------
if [ "$BUILD_APPIMAGE" -eq 1 ]; then
  log "构建 AppImage（首次需下载 Electron，请耐心等待）…"
  npx electron-builder --linux AppImage
  mkdir -p "$APPS_DIR"
  APPIMAGE_SRC="$(ls -t dist/*.AppImage 2>/dev/null | head -1 || true)"
  if [ -z "$APPIMAGE_SRC" ]; then fail "未找到构建产物"; exit 1; fi
  cp -f "$APPIMAGE_SRC" "$APPS_DIR/DSH-Desktop.AppImage"
  chmod +x "$APPS_DIR/DSH-Desktop.AppImage"
  ok "AppImage → $APPS_DIR/DSH-Desktop.AppImage"

  if [ ! -f "$DESKTOP_FILE" ]; then
    log "创建桌面入口…"
    mkdir -p "$(dirname "$DESKTOP_FILE")"
    cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=DSH Desktop
Name[zh_CN]=DSH 桌面端
GenericName=DeepSeek Harness Client
Comment=DeepSeek Harness 桌面客户端
Exec=$APPS_DIR/DSH-Desktop.AppImage
Icon=dsh-desktop
Terminal=false
Categories=Development;Utility;
StartupWMClass=dsh-desktop
StartupNotify=true
EOF
    ok "桌面入口已创建"
  fi

  # ---------- 6. 图标 ----------
  log "同步图标到系统缓存…"
  ./scripts/sync-icons.sh >/dev/null
  ok "图标已同步"

  # ---------- 7. FUSE 检测（AppImage 运行依赖） ----------
  if ! ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then
    warn "未检测到 FUSE（libfuse2）——AppImage 无法直接运行，请安装："
    warn "  Ubuntu/Debian: sudo apt install libfuse2"
    warn "  Fedora:        sudo dnf install fuse"
    warn "  Arch:          sudo pacman -S fuse2"
    warn "临时绕过（不装 FUSE）：$APPS_DIR/DSH-Desktop.AppImage --appimage-extract-and-run"
  fi
else
  log "跳过构建（--no-build）"
fi

# ---------- 完成 ----------
cat <<EOF

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 安装完成！

 启动方式：
   npm start                                # 开发模式运行
   $APPS_DIR/DSH-Desktop.AppImage           # 打包版（若已构建）

 视觉助手（可选）：
   ⚙ 设置面板 →「视觉助手」填入 baseURL/apiKey/model 即可
   （任意 OpenAI 兼容视觉服务；DeepSeek 官方 API 暂无视觉模型）

 注意：
   - 官方 dsh 凭据放 ~/.dsh/.credentials.yaml（DEEPSEEK_API_KEY）
   - 若本脚本曾因引擎运行跳过插件挂载，退出应用后重跑：
     ./install.sh --no-build
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EOF
