#!/bin/bash
# polymarket-crypto-bot 看门狗：面板 :3200 + 主循环保活（pattern 写在脚本里，避免 pkill 自杀）
DIR=~/workspace/polymarket-crypto-bot
cd "$DIR" || exit 1

alive() { # $1=pattern：cwd 在本目录且命令行匹配的 node 进程数
  local pat="$1" n=0
  for p in $(pgrep -f "$pat" 2>/dev/null); do
    if readlink "/proc/$p/cwd" 2>/dev/null | grep -q "polymarket-crypto-bot$"; then n=$((n+1)); fi
  done
  echo "$n"
}

if [ "$(alive 'node src/runner.js')" -eq 0 ]; then
  echo "[watchdog] runner 挂了，重启"
  nohup node src/runner.js >> logs/runner.log 2>&1 &
else echo "[watchdog] runner 存活"; fi

if [ "$(alive 'node src/server.js')" -eq 0 ]; then
  echo "[watchdog] server 挂了，重启"
  nohup node src/server.js >> logs/server.log 2>&1 &
else echo "[watchdog] server 存活"; fi

if ! curl -s -m 5 -o /dev/null http://localhost:3200/; then
  echo "[watchdog] 面板 :3200 无响应"
else echo "[watchdog] 面板 :3200 正常"; fi
