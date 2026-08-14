#!/usr/bin/env bash
# 同步应用图标到系统图标缓存（~/.local/share/icons/hicolor）
#
# 坑（2026-08-14 实测）：electron-builder 重新打包只会更新 AppImage 内嵌图标，
# 不会更新系统已安装的图标文件——dock/任务栏继续显示旧图标。
# 换图标后必须跑本脚本，否则 dock 里看到的还是旧图。
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="${1:-assets/icon.png}"
if [ ! -f "$SRC" ]; then echo "❌ 图标源不存在: $SRC"; exit 1; fi
echo "==> 同步 $SRC → ~/.local/share/icons/hicolor/{16..1024}x*/apps/dsh-desktop.png"
for size in 16 24 32 48 64 128 256 512 1024; do
  dir="$HOME/.local/share/icons/hicolor/${size}x${size}/apps"
  mkdir -p "$dir"
  magick "$SRC" -resize ${size}x${size} "$dir/dsh-desktop.png"
done
gtk-update-icon-cache -f "$HOME/.local/share/icons/hicolor" 2>/dev/null || true
echo "==> 完成。若 dock 仍显示旧图标，重启 dock（或注销重登）刷新缓存。"
