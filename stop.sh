#!/bin/bash
# 停止 runner 和 server（不重启），用于数据清空等需要先停进程的场景
# 用独立脚本避免 pkill -f 自杀陷阱：pattern 会匹配发出命令的 shell 自身
for p in $(pgrep -f "node src/runner.js" 2>/dev/null); do
  if readlink "/proc/$p/cwd" 2>/dev/null | grep -q "polymarket-crypto-bot$"; then kill "$p"; fi
done
for p in $(pgrep -f "node src/server.js" 2>/dev/null); do
  if readlink "/proc/$p/cwd" 2>/dev/null | grep -q "polymarket-crypto-bot$"; then kill "$p"; fi
done
sleep 2
echo "stopped. runner/server remaining:"
pgrep -f "node src/(runner|server).js" 2>/dev/null | wc -l
