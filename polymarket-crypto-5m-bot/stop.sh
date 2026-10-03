#!/bin/bash
# 停止 runner、server 和秒级守护 supervise.sh（不重启），用于数据清空等需要先停进程的场景
# 用独立脚本避免 pkill -f 自杀陷阱：pattern 会匹配发出命令的 shell 自身
# 先写抑制标记，防止 supervise.sh 在停止过程中抢跑重启
touch ~/workspace/polymarket-crypto-5m-bot/.restart-hold
for p in $(pgrep -f "polymarket-crypto-5m-bot/supervise.sh" 2>/dev/null); do kill "$p"; done
for p in $(pgrep -f "node src/runner.js" 2>/dev/null); do
  if readlink "/proc/$p/cwd" 2>/dev/null | grep -q "polymarket-crypto-5m-bot$"; then kill "$p"; fi
done
for p in $(pgrep -f "node src/server.js" 2>/dev/null); do
  if readlink "/proc/$p/cwd" 2>/dev/null | grep -q "polymarket-crypto-5m-bot$"; then kill "$p"; fi
done
sleep 2
echo "stopped. runner/server remaining:"
pgrep -f "node src/(runner|server).js" 2>/dev/null | wc -l
