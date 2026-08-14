#!/usr/bin/env bash
# 同步应用图标到系统图标缓存（~/.local/share/icons/hicolor）
#
# 坑（2026-08-14 实测）：electron-builder 重新打包只会更新 AppImage 内嵌图标，
# 不会更新系统已安装的图标文件——dock/任务栏继续显示旧图标。
# 换图标后必须跑本脚本，否则 dock 里看到的还是旧图。
#
# 缩放后端自动选择：magick（IM7）→ convert（IM6）→ python3+PIL → 直接复制
# （最小系统可能没有 ImageMagick/PIL，直接复制原图保证图标可见，仅尺寸非精确）。
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="${1:-assets/icon.png}"
if [ ! -f "$SRC" ]; then echo "❌ 图标源不存在: $SRC"; exit 1; fi
echo "==> 同步 $SRC → ~/.local/share/icons/hicolor/{16..1024}x*/apps/dsh-desktop.png"

# 选后端
RESIZE=""
if command -v magick >/dev/null 2>&1; then
  RESIZE="magick"
elif command -v convert >/dev/null 2>&1; then
  RESIZE="convert"
elif python3 -c 'import PIL' >/dev/null 2>&1; then
  RESIZE="pil"
fi
if [ -z "$RESIZE" ]; then
  echo "==> 未找到 magick/convert/PIL，直接复制原图（尺寸不精确，功能可用）"
  echo "    提示：安装 ImageMagick 可获得精确尺寸（Ubuntu: sudo apt install imagemagick）"
fi

for size in 16 24 32 48 64 128 256 512 1024; do
  dir="$HOME/.local/share/icons/hicolor/${size}x${size}/apps"
  mkdir -p "$dir"
  case "$RESIZE" in
    magick)  magick "$SRC" -resize ${size}x${size} "$dir/dsh-desktop.png" ;;
    convert) convert "$SRC" -resize ${size}x${size} "$dir/dsh-desktop.png" ;;
    pil)     python3 -c "
from PIL import Image
im = Image.open('$SRC').convert('RGBA')
im.thumbnail(($size, $size), Image.LANCZOS)
im.save('$dir/dsh-desktop.png')" ;;
    *)       cp "$SRC" "$dir/dsh-desktop.png" ;;
  esac
done
gtk-update-icon-cache -f "$HOME/.local/share/icons/hicolor" 2>/dev/null || true
echo "==> 完成（后端: ${RESIZE:-cp}）。若 dock 仍显示旧图标，重启 dock（或注销重登）刷新缓存。"
