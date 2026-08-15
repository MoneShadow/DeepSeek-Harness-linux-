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
#   ./install.sh --uninstall     # 一键卸载（插件挂载/AppImage/桌面入口/图标）
#   ./install.sh --help
#
# 注意：若 DSH Desktop 正在运行，插件安装步骤会跳过并给出提示，
#       退出应用后重跑本脚本即可补齐。
# 安全（HARD_RULES 禁令 9/10）：
#   - dsh 安装一律"先卸载再安装 --force"，禁止在已有安装上增量 npm install -g
#   - 插件挂载失败时同步清理 bundles 声明，绝不留下"声明在、实体无"的半挂状态
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

BUILD_APPIMAGE=1
INSTALL_PLUGIN=1
UNINSTALL=0
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD_APPIMAGE=0 ;;
    --no-plugin) INSTALL_PLUGIN=0 ;;
    --uninstall) UNINSTALL=1 ;;
    --help|-h)
      sed -n '3,22p' "$0" | sed 's/^# \{0,1\}//'
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
ICON_DIR="$HOME_DIR/.local/share/icons/hicolor"

# ============================================================================
# 一键卸载（--uninstall）
# 卸载：插件挂载（web profile）、AppImage、桌面入口、图标缓存。
# 保留：~/.dsh（会话数据/凭据/设置）、dsh CLI、项目源码。
# ============================================================================
if [ "$UNINSTALL" -eq 1 ]; then
  log "卸载 DSH Desktop…"

  # 1. 插件挂载（需 web profile 无引擎在跑——铁律）
  MANIFEST="$HOME_DIR/.dsh/profiles/web/package.json"
  if [ -f "$MANIFEST" ]; then
    if pgrep -af "dsh --profile web " | grep -v bwrap | grep -v install.sh >/dev/null 2>&1; then
      warn "检测到 web profile 引擎正在运行，跳过插件卸载（退出应用后重跑本命令）"
    else
      log "移除视觉插件挂载（web profile）…"
      # 移除 bundles 声明 + dependencies 条目（保持 profile 自洽，禁令 10）
      python3 - "$MANIFEST" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d.setdefault('dsh', {}).setdefault('profile', {}).setdefault('bundles', [])
d['dsh']['profile']['bundles'] = [b for b in d['dsh']['profile']['bundles'] if b != 'dsh-plugin-vision']
d.setdefault('dependencies', {})
d['dependencies'].pop('dsh-plugin-vision', None)
json.dump(d, open(p, 'w'), indent=2, ensure_ascii=False)
print(f"  bundles 移除 dsh-plugin-vision，当前: {d['dsh']['profile']['bundles']}")
PY
      # 删除 profile 软链与全局树实体
      rm -f "$HOME_DIR/.dsh/profiles/web/node_modules/dsh-plugin-vision"
      GLOBAL_NM="$(command -v dsh >/dev/null 2>&1 && { R="$(readlink -f "$(command -v dsh)")"; D="$(dirname "$(dirname "$R")")"; [ -d "$D/node_modules" ] && echo "$D/node_modules" || echo "$D"; } || true)"
      if [ -n "$GLOBAL_NM" ]; then
        rm -rf "$GLOBAL_NM/dsh-plugin-vision" 2>/dev/null || true
      fi
      ok "插件已卸载"
    fi
  fi

  # 2. 桌面入口
  if [ -f "$DESKTOP_FILE" ]; then
    rm -f "$DESKTOP_FILE" && ok "桌面入口已移除"
  fi

  # 3. AppImage
  if [ -f "$APPS_DIR/DSH-Desktop.AppImage" ]; then
    rm -f "$APPS_DIR/DSH-Desktop.AppImage" && ok "AppImage 已移除"
  fi

  # 4. 图标缓存
  if [ -d "$ICON_DIR" ]; then
    find "$ICON_DIR" -name 'dsh-desktop.png' -delete 2>/dev/null || true
    ok "图标缓存已清理"
  fi

  cat <<EOF

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 卸载完成。以下内容**保留**（如需删除请手动）：
   - 会话/凭据/设置：~/.dsh（rm -rf ~/.dsh 可全部清除）
   - 官方 dsh CLI：npm uninstall -g @deepseek-ai/dsh
   - 项目源码：当前目录
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EOF
  exit 0
fi

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

# 探测 dsh：PATH → 常见路径 → npm 全局安装状态
# （PATH 可能不含 ~/.local/bin；若误判"未安装"会在已有安装上跑增量
#   npm install -g → hoist 重排 → 全局树损坏，见 HARD_RULES 禁令 9）
DSH_BIN="$(command -v dsh 2>/dev/null || true)"
if [ -z "$DSH_BIN" ]; then
  for c in "$HOME_DIR/.local/bin/dsh" /usr/local/bin/dsh /usr/bin/dsh; do
    [ -x "$c" ] && DSH_BIN="$c" && break
  done
fi
if [ -z "$DSH_BIN" ] && npm ls -g "@deepseek-ai/dsh" >/dev/null 2>&1; then
  warn "npm 全局已安装 @deepseek-ai/dsh，但 PATH 中找不到 dsh 命令"
  warn "（npm 全局目录未加入 PATH？请检查后把 $(npm prefix -g)/bin 加入 PATH）"
  warn "跳过安装（避免在已有安装上增量重装）"
fi
if [ -z "$DSH_BIN" ] && ! npm ls -g "@deepseek-ai/dsh" >/dev/null 2>&1; then
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
        ubuntu|debian|linuxmint|pop|elementary|deepin|neon|zorin|kali)
          BUILD_CMD="sudo apt update && sudo apt install -y build-essential python3" ;;
        fedora)
          BUILD_CMD="sudo dnf groupinstall -y 'Development Tools'" ;;
        rhel|centos|almalinux|rocky|ol|amzn)
          # 现代版用 dnf，RHEL/CentOS 7 及以下用 yum
          if command -v dnf >/dev/null 2>&1; then
            BUILD_CMD="sudo dnf groupinstall -y 'Development Tools'"
          else
            BUILD_CMD="sudo yum groupinstall -y 'Development Tools'"
          fi ;;
        arch|manjaro|endeavouros|garuda|artix)
          BUILD_CMD="sudo pacman -S --noconfirm base-devel python" ;;
        opensuse*|sles)
          BUILD_CMD="sudo zypper install -y -t pattern devel_basis" ;;
        alpine)
          BUILD_CMD="sudo apk add --no-cache build-base python3" ;;
        void)
          BUILD_CMD="sudo xbps-install -Suy && sudo xbps-install -y base-devel" ;;
        mageia)
          BUILD_CMD="sudo urpmi --auto gcc gcc-c++ make python3" ;;
        *)
          # ID_LIKE 兜底：Deepin/KDE neon/Elementary 等派生发行版
          case "${ID_LIKE:-}" in
            *debian*) BUILD_CMD="sudo apt update && sudo apt install -y build-essential python3" ;;
            *fedora*|*rhel*|*centos*) BUILD_CMD="sudo dnf groupinstall -y 'Development Tools'" ;;
            *arch*)   BUILD_CMD="sudo pacman -S --noconfirm base-devel python" ;;
            *suse*)   BUILD_CMD="sudo zypper install -y -t pattern devel_basis" ;;
          esac ;;
      esac
    fi
    if [ -n "$BUILD_CMD" ]; then
      warn "自动安装编译工具：$BUILD_CMD"
      eval "$BUILD_CMD" || { fail "编译工具安装失败，请手动执行：$BUILD_CMD 后重跑本脚本"; exit 1; }
    else
      fail "未识别的发行版，请先手动安装编译工具（make/gcc/g++），再重跑本脚本"
      exit 1
    fi
  fi

  # 全局前缀可写性检查（npm prefix 目录）
  NPM_PREFIX="$(npm prefix -g)"
  # 先卸载再安装（禁令 9：禁止在已有安装上增量重装；--force 兜底残余）
  if [ -w "$NPM_PREFIX" ]; then
    npm uninstall -g "@deepseek-ai/dsh" >/dev/null 2>&1 || true
    npm install -g --force "@deepseek-ai/dsh@next"
  else
    warn "全局 npm 目录 $NPM_PREFIX 不可写，尝试 sudo…"
    sudo npm uninstall -g "@deepseek-ai/dsh" >/dev/null 2>&1 || true
    sudo npm install -g --force "@deepseek-ai/dsh@next"
  fi
  # 验证：优先 PATH/常见路径，其次 npm 全局目录（PATH 可能不含）
  DSH_BIN="$(command -v dsh 2>/dev/null || true)"
  if [ -z "$DSH_BIN" ]; then
    for c in "$HOME_DIR/.local/bin/dsh" /usr/local/bin/dsh /usr/bin/dsh; do
      [ -x "$c" ] && DSH_BIN="$c" && break
    done
  fi
  if [ -z "$DSH_BIN" ] && [ -x "$NPM_PREFIX/bin/dsh" ]; then DSH_BIN="$NPM_PREFIX/bin/dsh"; fi
  if [ -z "$DSH_BIN" ] || ! "$DSH_BIN" --version >/dev/null 2>&1; then
    fail "dsh 安装失败或依赖树不完整。请勿中断安装；必要时手动执行："
    fail "  npm uninstall -g @deepseek-ai/dsh && npm install -g --force @deepseek-ai/dsh@next"
    exit 1
  fi
fi
DSH_VER="$("$DSH_BIN" --version 2>/dev/null | head -1 || echo 未知)"
ok "dsh $DSH_VER ($DSH_BIN)"

# ---------- 3. 仓库依赖 ----------
log "安装项目依赖（npm install）…"
npm_install() {
  npm install --no-audit --no-fund
}
if npm_install; then
  ok "依赖就绪"
else
  # Electron 二进制从 GitHub 下载，网络不稳时常见失败（Fetch terminated）
  warn "npm install 失败（常见原因：Electron 二进制下载被网络中断），重试一次…"
  rm -rf node_modules/electron   # 清掉半成品，强制重下
  if npm_install; then
    ok "依赖就绪（重试成功）"
  else
    warn "仍失败，改用国内镜像（ELECTRON_MIRROR）重试…"
    rm -rf node_modules/electron
    if ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" npm_install; then
      ok "依赖就绪（镜像源）"
    else
      fail "依赖安装失败。可手动重试："
      fail "  npm install"
      fail "或走镜像："
      fail "  export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ && npm install"
      exit 1
    fi
  fi
fi

# ---------- 4. 视觉插件 ----------
# 探测 dsh 全局依赖树（与 scripts/deploy-plugin.sh 同逻辑）
detect_dsh_dir() {
  local bin="" real dir
  bin="$(command -v dsh 2>/dev/null || true)"
  if [ -z "$bin" ]; then
    for c in "$HOME_DIR/.local/bin/dsh" /usr/local/bin/dsh /usr/bin/dsh; do
      [ -x "$c" ] && bin="$c" && break
    done
  fi
  if [ -z "$bin" ]; then echo ""; return; fi
  real="$(readlink -f "$bin" 2>/dev/null || echo "$bin")"
  dir="$(dirname "$(dirname "$real")")"
  if [ -d "$dir/node_modules" ]; then echo "$dir/node_modules"; else echo "$dir"; fi
}
GLOBAL_DSH_NM="$(detect_dsh_dir)"

if [ "$INSTALL_PLUGIN" -eq 1 ]; then
  log "挂载视觉助手插件（dsh-plugin-vision）…"
  if [ ! -f "$HOME_DIR/.dsh/profiles/web/package.json" ]; then
    log "web profile 尚未初始化，先用 dsh 触发初始化…"
    PATH="$PATH:$HOME_DIR/.local/bin" "$DSH_BIN" plugin --profile web --help >/dev/null 2>&1 || true
  fi
  if ./scripts/deploy-plugin.sh web; then
    ok "插件已挂载到 web profile（重启 DSH Desktop 后生效）"
  else
    # 禁令 10：deploy 失败时必须保证 profile 自洽——区分两种失败：
    #   a) 引擎在跑（实体完好，声明保留，提示重跑）
    #   b) 实体缺失（dsh 重装清了全局树）→ 移除 bundles 声明，否则引擎 boot 失败
    MANIFEST="$HOME_DIR/.dsh/profiles/web/package.json"
    if [ -f "$MANIFEST" ] && grep -q 'dsh-plugin-vision' "$MANIFEST"; then
      if [ -z "$GLOBAL_DSH_NM" ] || [ ! -d "$GLOBAL_DSH_NM/dsh-plugin-vision" ]; then
        warn "检测到半挂状态：profile 声明了插件但全局树实体缺失（可能 dsh 重装清了实体）"
        warn "从 profile bundles 移除声明以保持自洽…"
        python3 - "$MANIFEST" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d.setdefault('dsh', {}).setdefault('profile', {}).setdefault('bundles', [])
before = len(d['dsh']['profile']['bundles'])
d['dsh']['profile']['bundles'] = [b for b in d['dsh']['profile']['bundles'] if b != 'dsh-plugin-vision']
json.dump(d, open(p, 'w'), indent=2, ensure_ascii=False)
print(f'bundles: {before} → {len(d["dsh"]["profile"]["bundles"])}（已移除 dsh-plugin-vision）')
PY
        warn "退出应用后重跑 ./install.sh 可重新挂载插件"
      else
        warn "插件挂载被跳过：可能引擎正在运行（实体完好，声明保留）。退出应用后重跑：./install.sh --no-build"
      fi
    else
      warn "插件挂载被跳过：可能引擎正在运行。退出应用后重跑：./install.sh --no-build"
    fi
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
