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

function pushCapped(arr, item, cap, archiveKind) {
  arr.push(item);
  if (arr.length > cap) arr.splice(0, arr.length - cap);
  if (archiveKind) archive(archiveKind, item); // 归档在裁剪/io清理之前，快照完整
}

// 训练归档：只追加不删除，按天分文件存 JSONL（data/archive/YYYY-MM-DD.jsonl）
// 热账本照旧裁剪，归档永久保留，供后续训练用；失败不阻断主流程
const ARCHIVE_DIR = path.join(cfg.DATA_DIR, 'archive');
function archiveDay(d = new Date()) {
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }); // YYYY-MM-DD
}
function archive(kind, obj) {
  try {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    const line = JSON.stringify({ kind, archivedAt: new Date().toISOString(), ...obj });
    fs.appendFileSync(path.join(ARCHIVE_DIR, `${archiveDay()}.jsonl`), line + '\n');
  } catch { /* 归档失败不阻断交易主流程 */ }
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

module.exports = { LEDGER, blank, load, save, pushCapped, recordEquity, archive, archiveDay };
