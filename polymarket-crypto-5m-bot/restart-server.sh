#!/bin/bash
# 重启 server（独立脚本，避免 pkill -f 自杀陷阱）
for p in $(pgrep -f "node src/server.js" 2>/dev/null); do
  if readlink "/proc/$p/cwd" 2>/dev/null | grep -q "polymarket-crypto-5m-bot$"; then kill "$p"; fi
done
sleep 2
cd ~/workspace/polymarket-crypto-5m-bot || exit 1
nohup node src/server.js >> logs/server.log 2>&1 &
echo "server restarted pid $!"
