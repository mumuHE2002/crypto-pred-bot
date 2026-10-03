#!/bin/bash
# polymarket-crypto-5m-bot 秒级自重启守护
# 每 5 秒检查 runner/server，挂了立刻拉起（崩溃到恢复 <10 秒）。
# 本守护自己由看门狗 watchdog.sh 保活（10 分钟兜底）；整机被换后看门狗会把它拉起来。
# 手动重启/停止请用 restart-*.sh / stop.sh（它们会写 .restart-hold 抑制本守护抢跑）。
DIR=~/workspace/polymarket-crypto-5m-bot
cd "$DIR" || exit 1
HOLD="$DIR/.restart-hold"

alive() { # $1=pattern：cwd 在本目录且命令行匹配的 node 进程数（与 watchdog.sh 同逻辑）
  local pat="$1" n=0
  for p in $(pgrep -f "$pat" 2>/dev/null); do
    if readlink "/proc/$p/cwd" 2>/dev/null | grep -q "polymarket-crypto-5m-bot$"; then n=$((n+1)); fi
  done
  echo "$n"
}

echo "[supervise] 启动 $(date '+%F %T')"
while true; do
  # 抑制窗口：手动重启/停止后 90 秒内不抢跑
  if [ ! -f "$HOLD" ] || [ $(( $(date +%s) - $(stat -c %Y "$HOLD" 2>/dev/null || echo 0) )) -gt 90 ]; then
    # 先去重：单次误判导致多拉起时，只留最老的（PID 最小），清掉其余
    for pat in 'node src/runner.js' 'node src/server.js'; do
      list=$(for p in $(pgrep -f "$pat" 2>/dev/null); do
        if readlink "/proc/$p/cwd" 2>/dev/null | grep -q "polymarket-crypto-5m-bot$"; then echo "$p"; fi
      done | sort -n)
      if [ -n "$list" ] && [ "$(echo "$list" | wc -l)" -gt 1 ]; then
        echo "[supervise] $(date '+%F %T') $pat 重复 $(echo "$list" | wc -l) 个，保留最老 $(echo "$list" | head -1)"
        echo "$list" | tail -n +2 | while read -r p; do kill "$p" 2>/dev/null; done
        sleep 2
      fi
    done
    if [ "$(alive 'node src/runner.js')" -eq 0 ]; then
      echo "[supervise] $(date '+%F %T') runner 挂了，秒级重启"
      nohup node src/runner.js >> logs/runner.log 2>&1 &
    fi
    if [ "$(alive 'node src/server.js')" -eq 0 ]; then
      echo "[supervise] $(date '+%F %T') server 挂了，秒级重启"
      nohup node src/server.js >> logs/server.log 2>&1 &
    fi
  fi
  sleep 5
done
