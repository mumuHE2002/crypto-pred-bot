// 主循环：每币种独立评估循环（上次结束后 30s 再评估）+ 结算轮询（60s）
const cfg = require('./config');
const { load, save, pushCapped, recordEquity } = require('./store');
const pm = require('./polymarket');
const spot = require('./spot');
const ds = require('./deepseek');
const jev = require('./jev');
const brain = require('./brain');
const { buildReport } = require('./report');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const usd = n => (n >= 0 ? '+' : '') + '$' + n.toFixed(2);

function windowLabel(startSec, endSec) {
  const f = s => {
    const d = new Date(s * 1000);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  };
  return `${f(startSec)}–${f(endSec)}`;
}

function logError(ledger, where, e) {
  const msg = String((e && e.message) || e);
  console.error(`[${where}] ${msg}`);
  pushCapped(ledger.errors, { time: nowIso(), where, message: msg.slice(0, 300) }, 100);
}

let ledger = load();
function persist() { recordEquity(ledger); save(ledger); }

/** 单盘一次评估：退出复核 →（无持仓时）新开仓判断 */
async function evaluateMarket(coin) {
  const coinName = pm.COIN_NAME[coin];
  const mkt = await pm.fetchCurrentMarket(coin);
  if (!mkt) { console.log(`[${coin}] 本轮无盘口（slug 未创建），跳过`); return; }
  if (mkt.error) { logError(ledger, `eval-${coin}`, mkt.error); persist(); return; }
  const label = windowLabel(mkt.start, mkt.end);
  const t0 = Date.now();

  // 可成交价
  let upBuy, downBuy, upMid, downMid, upSell, downSell;
  try {
    [upBuy, downBuy] = await Promise.all([pm.clobPrice(mkt.upToken, 'buy'), pm.clobPrice(mkt.downToken, 'buy')]);
    [upSell, downSell] = await Promise.all([pm.clobPrice(mkt.upToken, 'sell'), pm.clobPrice(mkt.downToken, 'sell')]);
    [upMid, downMid] = await Promise.all([pm.clobMid(mkt.upToken), pm.clobMid(mkt.downToken)]);
    if (!Number.isFinite(upMid)) upMid = mkt.upLast;
    if (!Number.isFinite(downMid)) downMid = mkt.downLast;
    savePriceSnap(mkt.slug, { upBuy, downBuy, upSell, downSell, upMid, downMid });
  } catch (e) { logError(ledger, `eval-${coin}-price`, e); persist(); return; }

  // 1) 退出复核：本窗口有持仓才做
  const pos = ledger.positions.find(p => p.slug === mkt.slug);
  if (pos) await reviewExit(coin, mkt, pos, label);

  // 2) 新开仓判断（本窗口无持仓才考虑）
  const judgment = {
    time: nowIso(), coin, coinName, slug: mkt.slug, windowLabel: label,
    eventUrl: mkt.eventUrl, secondsLeft: mkt.secondsLeft,
    upBuy: r4(upBuy), downBuy: r4(downBuy), upMid: r4(upMid), downMid: r4(downMid),
  };
  const hasPos = ledger.positions.some(p => p.slug === mkt.slug);
  if (!hasPos && mkt.secondsLeft >= cfg.MIN_SECONDS_LEFT && ledger.wallet >= cfg.MIN_BET_USD) {
    try {
      const candles = await spot.fetchCandles(coin, 30);
      const feat = spot.features(candles);
      const candleText = spot.candlesText(candles, 15);
      const dsr = await ds.analyze({
        coin, coinName, windowLabel: label, secondsLeft: mkt.secondsLeft,
        feat, candleText, upBuy, downBuy, upMid, downMid,
      });
      const j = await jev.calibrateUp({
        coinName, windowLabel: label, secondsLeft: mkt.secondsLeft,
        feat, ds: dsr, upBuy, downBuy, upMid, downMid,
      });
      const d = brain.decide({
        pUp: j.pUp, buyUp: upBuy, buyDown: downBuy,
        secondsLeft: mkt.secondsLeft, wallet: ledger.wallet, hasPosition: hasPos,
      });
      Object.assign(judgment, {
        pUp: r4(j.pUp), edgeUp: r4(d.edgeUp), edgeDown: r4(d.edgeDown),
        dsDirection: dsr.direction, dsConfidence: r4(dsr.confidence), dsReason: dsr.reason,
        bet: d.bet, side: d.side, stake: d.stake, reason: d.reason,
        driftBps: feat.driftBps, rsi14: feat.rsi14,
      });
      if (d.bet) {
        const buyPrice = d.price;
        const id = `${mkt.slug}-${d.side}-${Date.now()}`;
        ledger.wallet = round2(ledger.wallet - d.stake);
        ledger.positions.push({
          id, coin, coinName, slug: mkt.slug, windowLabel: label, eventUrl: mkt.eventUrl,
          side: d.side, buyPrice: r4(buyPrice), shares: round2(d.stake / buyPrice),
          stake: d.stake, buyTime: nowIso(), pUp: r4(j.pUp), lastExitReviewAt: 0,
        });
        ledger.trades.push({
          time: nowIso(), slug: mkt.slug, side: 'buy', outcome: d.side,
          price: r4(buyPrice), shares: round2(d.stake / buyPrice), stake: d.stake,
          reason: `edge ${(d.edge * 100).toFixed(1)}%`,
        });
        console.log(`[${coin} ${label}] 开仓 ${d.side.toUpperCase()} $${d.stake} @${buyPrice.toFixed(3)}（edge ${(d.edge * 100).toFixed(1)}%）`);
      } else {
        console.log(`[${coin} ${label}] 跳过：${d.reason}`);
      }
    } catch (e) {
      // Jev/DS 失败 → 不下单（铁律），只记录
      judgment.error = String(e.message || e).slice(0, 200);
      judgment.bet = false; judgment.reason = '模型失败，不下单：' + judgment.error;
      logError(ledger, `eval-${coin}-model`, e);
    }
  } else if (!hasPos) {
    judgment.bet = false;
    judgment.reason = mkt.secondsLeft < cfg.MIN_SECONDS_LEFT
      ? `剩余${mkt.secondsLeft}s不足${cfg.MIN_SECONDS_LEFT}s，不开新仓`
      : `钱包$${ledger.wallet.toFixed(2)}不足最小下注`;
  } else {
    judgment.bet = false; judgment.reason = '本窗口已有持仓';
  }
  judgment.ms = Date.now() - t0;
  pushCapped(ledger.judgments, judgment, 300);
  persist();
  try { buildReport(); } catch (e) { console.error('[report]', e.message); }
}

/** 退出复核：浮盈亏 |≥15%| 且冷静期过 → 问 Jev；持有更优 <45% 则真实卖出 */
async function reviewExit(coin, mkt, pos, label) {
  const token = pos.side === 'up' ? mkt.upToken : mkt.downToken;
  let sellPrice;
  try { sellPrice = await pm.clobPrice(token, 'sell'); }
  catch (e) { logError(ledger, `exit-${coin}-price`, e); return; }
  const unreal = pos.shares * sellPrice - pos.stake;
  const unrealPct = unreal / pos.stake;
  const skipReason =
    Math.abs(unrealPct) < cfg.EXIT_UNREAL_PCT ? `浮盈亏 ${(unrealPct * 100).toFixed(1)}% 未达 ±${cfg.EXIT_UNREAL_PCT * 100}%` : null;
  // 2026-10-01 用户拍板：去掉冷静期。每轮评估（约30-60s）只要 |浮盈亏|≥15% 就问 Jev，
  // 触发器本身就是节流阀；15分钟盘里 3 分钟盲区太长。
  const base = {
    time: nowIso(), coin, slug: mkt.slug, windowLabel: label, eventUrl: mkt.eventUrl,
    side: pos.side, buyPrice: pos.buyPrice, sellPrice: r4(sellPrice),
    unreal: round2(unreal), unrealPct: round4(unrealPct), secondsLeft: mkt.secondsLeft,
  };
  if (skipReason) {
    // 跳过只在原因变化时记一条，免刷屏
    const last = [...ledger.exitReviews].reverse().find(r => r.slug === mkt.slug && r.side === pos.side);
    if (!last || last.decision !== 'skip' || last.reason !== skipReason) {
      pushCapped(ledger.exitReviews, { ...base, decision: 'skip', reason: skipReason }, 200);
      persist();
    }
    return;
  }
  try {
    const { probHoldBetter } = await jev.askExit({ pos, curSellPrice: sellPrice, secondsLeft: mkt.secondsLeft });
    pos.lastExitReviewAt = Date.now();
    if (probHoldBetter < cfg.EXIT_HOLD_PROB) {
      const proceeds = round2(pos.shares * sellPrice);
      ledger.wallet = round2(ledger.wallet + proceeds);
      ledger.positions = ledger.positions.filter(p => p.id !== pos.id);
      ledger.trades.push({
        time: nowIso(), slug: mkt.slug, side: 'sell', outcome: pos.side,
        price: r4(sellPrice), shares: pos.shares, stake: proceeds,
        reason: `持有更优 ${(probHoldBetter * 100).toFixed(0)}%<${cfg.EXIT_HOLD_PROB * 100}%，锁定 ${usd(unreal)}`,
      });
      pushCapped(ledger.exitReviews, { ...base, decision: 'sell', probHoldBetter: r4(probHoldBetter), reason: `卖出锁定 ${usd(unreal)}` }, 200);
      console.log(`[${coin} ${label}] 止盈/止损卖出 ${pos.side.toUpperCase()}：${usd(unreal)}（持有更优 ${(probHoldBetter * 100).toFixed(0)}%）`);
    } else {
      pushCapped(ledger.exitReviews, { ...base, decision: 'hold', probHoldBetter: r4(probHoldBetter), reason: `持有更优 ${(probHoldBetter * 100).toFixed(0)}%≥${cfg.EXIT_HOLD_PROB * 100}%，继续持有` }, 200);
      console.log(`[${coin} ${label}] 复核：继续持有（持有更优 ${(probHoldBetter * 100).toFixed(0)}%，浮盈亏 ${usd(unreal)}）`);
    }
    persist();
  } catch (e) {
    logError(ledger, `exit-${coin}-jev`, e);
    persist();
  }
}

/** 结算轮询：closed 的盘按 1/0 结算 */
async function settleOnce() {
  if (ledger.positions.length === 0) return;
  for (const pos of [...ledger.positions]) {
    let s;
    try { s = await pm.fetchSettlement(pos.slug); }
    catch (e) { logError(ledger, 'settle-fetch', e); continue; }
    if (!s.found || !s.closed) continue;
    const win = (pos.side === 'up' && s.upWon) || (pos.side === 'down' && s.downWon);
    const payout = win ? round2(pos.shares * 1) : 0;
    const pnl = round2(payout - pos.stake);
    ledger.wallet = round2(ledger.wallet + payout);
    ledger.positions = ledger.positions.filter(p => p.id !== pos.id);
    ledger.trades.push({
      time: nowIso(), slug: pos.slug, side: 'settle', outcome: pos.side,
      price: win ? 1 : 0, shares: pos.shares, stake: payout,
      reason: win ? `结算命中 ${usd(pnl)}` : `结算归零 ${usd(pnl)}`,
    });
    ledger.settlements.push({
      time: nowIso(), slug: pos.slug, windowLabel: pos.windowLabel, eventUrl: pos.eventUrl,
      coin: pos.coin, side: pos.side, win, shares: pos.shares, payout, pnl,
    });
    console.log(`[settle ${pos.coin} ${pos.windowLabel}] ${pos.side.toUpperCase()} ${win ? '命中' : '归零'} ${usd(pnl)}`);
  }
  persist();
  try { buildReport(); } catch (e) { console.error('[report]', e.message); }
}

async function marketLoop(coin) {
  console.log(`[${coin}] 评估循环启动：上次结束后 ${cfg.EVAL_COOLDOWN_MS / 1000}s 再评估`);
  while (true) {
    try { await evaluateMarket(coin); }
    catch (e) { logError(ledger, `loop-${coin}`, e); persist(); }
    await sleep(cfg.EVAL_COOLDOWN_MS); // 上一次思考结束后计时 30s
  }
}

async function settleLoop() {
  while (true) {
    try { await settleOnce(); }
    catch (e) { logError(ledger, 'loop-settle', e); persist(); }
    await sleep(60000);
  }
}

function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }
function r4(n) { return Number.isFinite(n) ? round4(n) : n; }

// 价格快照：持仓浮盈亏 / 面板现价用（每轮刷新，不会冻住）
const fs = require('fs');
const path = require('path');
const PRICES = path.join(cfg.DATA_DIR, 'prices.json');
function savePriceSnap(slug, q) {
  let all = {};
  try { all = JSON.parse(fs.readFileSync(PRICES, 'utf8')); } catch {}
  all[slug] = { ...q, t: Date.now() };
  try { fs.writeFileSync(PRICES, JSON.stringify(all)); } catch {}
}
function loadPrices() {
  try { return JSON.parse(fs.readFileSync(PRICES, 'utf8')); } catch { return {}; }
}

// ---- 单轮调试：node src/runner.js once [btc|eth]
async function once(coin) {
  await evaluateMarket(coin);
  await settleOnce();
  console.log('done. wallet:', ledger.wallet, 'positions:', ledger.positions.length);
}

if (require.main === module) {
  const arg = process.argv[2];
  if (arg === 'once') {
    once(process.argv[3] || 'btc').then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
  } else {
    console.log(`polymarket-crypto-bot 启动（PAPER_MODE=${cfg.PAPER_MODE}，本金 $${cfg.BANKROLL_USD}）`);
    cfg.COINS.forEach(marketLoop);
    settleLoop();
  }
}

module.exports = { evaluateMarket, settleOnce, loadPrices };
