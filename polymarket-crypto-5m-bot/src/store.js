// 账本：钱包 / 持仓 / 成交 / 判断 / 退出复核 / 结算 / 净值曲线，原子写入
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const LEDGER = path.join(cfg.DATA_DIR, 'ledger.json');

function blank() {
  return {
    startedAt: new Date().toISOString(),
    wallet: cfg.BANKROLL_USD,
    positions: [],      // open：{id, coin, coinName, slug, windowLabel, eventUrl, side, buyPrice, shares, stake, buyTime, lastExitReviewAt, buyPUp}
    trades: [],         // {time, slug, side:'buy'|'sell', outcome, price, shares, stake, reason}
    judgments: [],      // 每次评估记录（保留300）
    exitReviews: [],    // 退出复核记录（保留200）
    settlements: [],    // {time, slug, side, win, shares, payout, pnl}
    equityCurve: [],    // {t, equity}
    errors: [],         // {time, where, message} 保留100
    mg: { btc: 0, eth: 0 }, // 马丁格档位（MG_STAKES 下标），BTC/ETH 各自独立
  };
}

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
    const b = blank();
    return { ...b, ...d };
  } catch {
    return blank();
  }
}

// 单进程写 + 原子 rename；runner 是唯一写者
function save(ledger) {
  fs.mkdirSync(cfg.DATA_DIR, { recursive: true });
  const tmp = LEDGER + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 1));
  fs.renameSync(tmp, LEDGER);
}

function pushCapped(arr, item, cap) {
  arr.push(item);
  if (arr.length > cap) arr.splice(0, arr.length - cap);
}

function equity(ledger) {
  // 净值 = 钱包 + 持仓按中间价估值（面板展示用；结算以实际为准）
  return ledger.wallet;
}

function recordEquity(ledger) {
  const last = ledger.equityCurve[ledger.equityCurve.length - 1];
  const e = Math.round(equity(ledger) * 100) / 100;
  if (!last || last.e !== e) ledger.equityCurve.push({ t: Date.now(), e });
  if (ledger.equityCurve.length > 2000) ledger.equityCurve.splice(0, ledger.equityCurve.length - 2000);
}

module.exports = { LEDGER, blank, load, save, pushCapped, recordEquity };
