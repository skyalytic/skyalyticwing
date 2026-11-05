#!/bin/bash
set -euo pipefail
edition="community"
case "$edition" in
  community) product='skyalyticwing'; identifier='com.skyalyticwing.community' ;;
  enterprise) product='SkyalyticWing Enterprise'; identifier='com.skyalyticwing.enterprise' ;;
  legacy) product='SkyalyticWing'; identifier='com.skyalyticwing.desktop' ;;
  *) echo 'Unknown edition'; exit 1 ;;
esac
app="${1:-/Applications/$product.app}"
if [[ ! -d "$app" && -d "$HOME/Applications/$product.app" ]]; then app="$HOME/Applications/$product.app"; fi
if [[ ! -d "$app/Contents" ]] || [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist")" != "$identifier" ]]; then
  echo '未找到 Wing。自定义安装位置请将应用路径作为参数传入。'; exit 1
fi
echo "请先保存文档并退出 $product。按回车卸载此版本与它的 CLI 命令；Ctrl+C 取消。"
read -r answer
"$app/Contents/MacOS/node" "$app/Contents/Resources/_up_/packages/web/bin/uninstall.cjs"
/usr/bin/osascript - "$app" <<'APPLESCRIPT'
on run argv
  tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)
end run
APPLESCRIPT
echo 'Wing 已移到废纸篓，CLI 环境已清理。用户文档和会话数据保留。'
