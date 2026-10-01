#!/bin/bash
# 有新增成交/结算/错误才输出通知；无新增保持安静
LEDGER=~/workspace/polymarket-crypto-bot/data/ledger.json
WM=~/workspace/goals/polymarket/hidden_files/notify_watermark_crypto15m.json
[ -f "$LEDGER" ] || exit 0
mkdir -p "$(dirname "$WM")"
python3 - "$LEDGER" "$WM" << 'EOF'
import json, sys
ledger_path, wm_path = sys.argv[1], sys.argv[2]
l = json.load(open(ledger_path))
try: wm = json.load(open(wm_path))
except: wm = {"trades": 0, "settlements": 0, "errors": 0}
nt, ns, ne = len(l.get("trades", [])), len(l.get("settlements", [])), len(l.get("errors", []))
msgs = []
if nt > wm["trades"]:
    for t in l["trades"][wm["trades"]:nt]:
        action = {"buy": "开仓", "sell": "平仓", "settle": "结算"}.get(t["side"], t["side"])
        msgs.append(f"🪙 {action} {t.get('outcome','').upper()} {t.get('slug','')} 价格{t.get('price')} 金额${t.get('stake')}（{t.get('reason','')}）")
if ns > wm["settlements"]:
    for s in l["settlements"][wm["settlements"]:ns]:
        msgs.append(f"{'✅' if s['win'] else '❌'} 结算 {s['coin']} {s['windowLabel']} {s['side'].upper()} {'命中' if s['win'] else '归零'} 盈亏${s['pnl']:.2f}")
if ne > wm["errors"]:
    for e in l["errors"][wm["errors"]:ne]:
        msgs.append(f"⚠️ 错误 [{e['where']}] {e['message'][:120]}")
json.dump({"trades": nt, "settlements": ns, "errors": ne}, open(wm_path, "w"))
for m in msgs: print(m)
EOF
