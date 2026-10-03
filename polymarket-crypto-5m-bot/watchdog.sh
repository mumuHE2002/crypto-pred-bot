#!/bin/bash
# polymarket-crypto-5m-bot 看门狗：面板 :3201 + 主循环保活（pattern 写在脚本里，避免 pkill 自杀）
DIR=~/workspace/polymarket-crypto-5m-bot
cd "$DIR" || exit 1

# 单实例锁：cron worker 延迟/重叠时，上一轮没跑完本轮直接跳过，避免两轮同时判死各拉起一对
exec 9>/tmp/poly-crypto-5m-watchdog.lock
flock -n 9 || { echo "[watchdog] 上一轮还在跑，跳过"; exit 0; }

pids_of() { # $1=pattern：cwd 在本目录且命令行匹配的 node 进程 PID，一行一个
  local pat="$1" p
  for p in $(pgrep -f "$pat" 2>/dev/null); do
    if readlink "/proc/$p/cwd" 2>/dev/null | grep -q "polymarket-crypto-5m-bot$"; then echo "$p"; fi
  done
}

dedup() { # $1=pattern：超过 1 个只留最老的（PID 最小，在内存态最全），清掉其余
  local pat="$1" list keep p n
  list=$(pids_of "$pat" | sort -n)
  [ -z "$list" ] && return 0
  n=$(echo "$list" | wc -l)
  if [ "$n" -gt 1 ]; then
    keep=$(echo "$list" | head -1)
    echo "[watchdog] $pat 重复 $n 个，保留最老 $keep，清掉其余"
    echo "$list" | tail -n +2 | while read -r p; do kill "$p" 2>/dev/null; done
    sleep 2
  fi
}

dedup 'node src/runner.js'
dedup 'node src/server.js'

if [ -z "$(pids_of 'node src/runner.js')" ]; then
  echo "[watchdog] runner 挂了，重启"
  nohup node src/runner.js >> logs/runner.log 2>&1 9>&- &
else echo "[watchdog] runner 存活"; fi

if [ -z "$(pids_of 'node src/server.js')" ]; then
  echo "[watchdog] server 挂了，重启"
  nohup node src/server.js >> logs/server.log 2>&1 9>&- &
else echo "[watchdog] server 存活"; fi

if ! curl -s -m 5 -o /dev/null http://localhost:3201/; then
  echo "[watchdog] 面板 :3201 无响应"
else echo "[watchdog] 面板 :3201 正常"; fi

# 秒级守护 supervise.sh 保活（它每 5 秒检查 runner/server；本看门狗 1 分钟兜底）
# pattern 用 supervise.sh 全路径，watchdog 自身命令行不含该串，无自杀风险
dedup_supervise() {
  local list keep p n
  list=$(pgrep -f "polymarket-crypto-5m-bot/supervise.sh" 2>/dev/null | sort -n)
  [ -z "$list" ] && return 0
  n=$(echo "$list" | wc -l)
  if [ "$n" -gt 1 ]; then
    keep=$(echo "$list" | head -1)
    echo "[watchdog] supervise 重复 $n 个，保留最老 $keep，清掉其余"
    echo "$list" | tail -n +2 | while read -r p; do kill "$p" 2>/dev/null; done
    sleep 2
  fi
}
dedup_supervise

if ! pgrep -f "polymarket-crypto-5m-bot/supervise.sh" >/dev/null 2>&1; then
  echo "[watchdog] supervise 守护挂了，重启"
  rm -f "$DIR/.restart-hold"  # 整机被换/守护意外死时清掉过期抑制标记
  nohup bash "$DIR/supervise.sh" >> logs/supervise.log 2>&1 9>&- &
else echo "[watchdog] supervise 守护存活"; fi
