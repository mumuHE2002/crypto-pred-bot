#!/bin/bash
# 重启 runner（独立脚本，避免 pkill -f 自杀陷阱）
# 先写抑制标记，防止 supervise.sh 秒级守护在 kill/start 的空档抢跑
touch ~/workspace/polymarket-crypto-5m-bot/.restart-hold
for p in $(pgrep -f "node src/runner.js" 2>/dev/null); do
  if readlink "/proc/$p/cwd" 2>/dev/null | grep -q "polymarket-crypto-5m-bot$"; then kill "$p"; fi
done
sleep 2
cd ~/workspace/polymarket-crypto-5m-bot || exit 1
nohup node src/runner.js >> logs/runner.log 2>&1 &
echo "runner restarted pid $!"
