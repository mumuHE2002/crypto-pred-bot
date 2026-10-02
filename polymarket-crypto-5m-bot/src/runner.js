// 5m 盘主循环：每币种独立评估循环（上次结束后 30s 再评估）+ 结算轮询（60s）
// 规则（2026-10-02 用户拍板）：
// - 当前盘剩余 ≤50s 时，预测「下一个」5m 窗口
// - 双模型确认：DeepSeek V4.1 Flash + Muse Spark 1.3 Contributor，方向一致才下单
// - 输入：Coinbase 30 根 1m K 线及动量特征 + 当前盘及前 6 个盘的窗口数据
// - 只买 0.48–0.52 价格的，价格不合适不买；中途不卖出，持有到期
// - 注额按双模型置信度较低者分档：0.57–0.60 → $1，0.61–0.70 → $2，≥0.71 → $3；<0.57 不下单
const cfg = require('./config');
const { load, save, pushCapped, recordEquity } = require('./store');
const pm = require('./polymarket');
const spot = require('./spot');
const wh = require('./windowhist');
const ds = require('./deepseek');
const fillMod = require('./fill');
const { buildReport } = require('./report');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const usd = n => (n >= 0 ? '+' : '') + '$' + n.toFixed(2);

function windowLabel(startSec, endSec) {
  // 固定东八区，不依赖进程 TZ（历史曾混入 UTC 标签）
  const f = s => {
    const d = new Date((s + 8 * 3600) * 1000);
    return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
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

/** 单币种一次评估：只在「当前盘剩余≤120s」时预测下一个窗口 */
async function evaluateMarket(coin) {
  const coinName = pm.COIN_NAME[coin];
  const nowSec = Math.floor(Date.now() / 1000);
  const curStart = pm.bucketStart(nowSec, cfg.WINDOW_SEC);
  const curEnd = curStart + cfg.WINDOW_SEC;
  const secLeftCur = curEnd - nowSec;
  const curLabel = windowLabel(curStart, curEnd);
  const t0 = Date.now();

  const nextStart = curStart + cfg.WINDOW_SEC;
  const nextSlug = pm.slugFor(coin, nextStart, cfg.WINDOW_SEC);
  const nextLabel = windowLabel(nextStart, nextStart + cfg.WINDOW_SEC);

  // 只记录预测区的判断；未到时间不记，免刷屏
  const inZone = secLeftCur <= cfg.PREDICT_AHEAD_SEC && nextStart > nowSec;

  const judgment = {
    id: `${nextSlug}-${Date.now()}`, time: nowIso(), coin, coinName,
    curWindowLabel: curLabel, secLeftCur,
    slug: nextSlug, windowLabel: nextLabel,
    eventUrl: pm.eventUrl(nextSlug),
    secToNextStart: nextStart - nowSec,
  };

  const finish = (skip) => {
    if (skip) return;
    judgment.ms = Date.now() - t0;
    pushCapped(ledger.judgments, judgment, 300);
    // 模型 io 只保留最近 100 条，免账本膨胀
    const jWithIo = ledger.judgments.filter(x => x.io);
    for (let k = 0; k < jWithIo.length - 100; k++) delete jWithIo[k].io;
    persist();
    try { buildReport(); } catch (e) { console.error('[report]', e.message); }
  };

  if (!inZone) return; // 未到预测窗口：不记录

  // 同一窗口只买一次
  const already = ledger.positions.some(p => p.slug === nextSlug)
    || ledger.trades.some(t => t.side === 'buy' && t.slug === nextSlug);
  if (already) {
    judgment.bet = false; judgment.reason = '本窗口已下注，跳过';
    console.log(`[${coin} ${nextLabel}] 已下注，跳过`);
    return finish();
  }

  // 取下个窗口盘口
  let nmkt;
  try { nmkt = await pm.fetchMarketAt(coin, nextStart, cfg.WINDOW_SEC); }
  catch (e) { nmkt = { error: String(e.message || e) }; }
  if (!nmkt) {
    judgment.bet = false; judgment.reason = '下个窗口盘口尚未创建，稍后重试';
    console.log(`[${coin} ${nextLabel}] 盘口未创建，稍后重试`);
    return finish();
  }
  if (nmkt.error) {
    judgment.bet = false; judgment.reason = '取盘口失败：' + String(nmkt.error).slice(0, 120);
    logError(ledger, `eval-${coin}-mkt`, nmkt.error);
    return finish();
  }
  judgment.eventUrl = nmkt.eventUrl;

  // 可成交价
  let upBuy, downBuy, upMid, downMid;
  try {
    [upBuy, downBuy] = await Promise.all([pm.clobPrice(nmkt.upToken, 'buy'), pm.clobPrice(nmkt.downToken, 'buy')]);
    [upMid, downMid] = await Promise.all([pm.clobMid(nmkt.upToken), pm.clobMid(nmkt.downToken)]);
    if (!Number.isFinite(upMid)) upMid = nmkt.upLast;
    if (!Number.isFinite(downMid)) downMid = nmkt.downLast;
    savePriceSnap(nextSlug, { upBuy, downBuy, upMid, downMid });
  } catch (e) {
    judgment.bet = false; judgment.reason = '取 CLOB 价格失败：' + String(e.message || e).slice(0, 120);
    logError(ledger, `eval-${coin}-price`, e);
    return finish();
  }
  Object.assign(judgment, {
    upBuy: r4(upBuy), downBuy: r4(downBuy), upMid: r4(upMid), downMid: r4(downMid),
  });

  // 双模型给方向：DeepSeek V4.1 Flash + Muse Spark 1.3 Contributor，方向一致才下单（用户拍板 2026-10-02）
  let dsr, muser, feat;
  try {
    const candles = await spot.fetchCandles(coin, 45);
    const c30 = candles.slice(-30);
    feat = spot.features(c30);
    const candleText = spot.candlesText(c30, 15);
    let histText = '';
    try { histText = wh.windowHistoryText(candles, curStart, cfg.WINDOW_SEC, cfg.HISTORY_WINDOWS); }
    catch (he) { console.error(`[${coin}] 历史窗口数据失败，继续：${he.message}`); }
    const modelArgs = {
      coin, coinName, windowLabel: nextLabel, secondsLeft: nextStart - nowSec,
      feat, candleText, windowHistoryText: histText, upBuy, downBuy, upMid, downMid,
    };
    const [dsRes, museRes] = await Promise.allSettled([ds.analyze(modelArgs), ds.analyzeMuse(modelArgs)]);
    if (dsRes.status === 'rejected') {
      const e = dsRes.reason;
      if (e._io && !judgment.io) judgment.io = { failed: e._io };
      judgment.bet = false;
      judgment.reason = 'DeepSeek 失败，不下单：' + String(e.message || e).slice(0, 150);
      logError(ledger, `eval-${coin}-ds`, e);
      return finish();
    }
    if (museRes.status === 'rejected') {
      const e = museRes.reason;
      if (e._io) judgment.io = { ...(judgment.io || {}), museFailed: e._io };
      judgment.bet = false;
      judgment.reason = 'Muse 失败，不下单：' + String(e.message || e).slice(0, 150);
      logError(ledger, `eval-${coin}-muse`, e);
      return finish();
    }
    dsr = dsRes.value; muser = museRes.value;
    judgment.io = { ds: dsr.io, muse: muser.io };
    Object.assign(judgment, {
      dsDirection: dsr.direction, dsConfidence: r4(dsr.confidence), dsReason: dsr.reason,
      museDirection: muser.direction, museConfidence: r4(muser.confidence), museReason: muser.reason,
      driftBps: feat.driftBps, volBps: feat.volBps, rangeBps: feat.rangeBps, rsi14: feat.rsi14,
    });
  } catch (e) {
    if (e._io && !judgment.io) judgment.io = { failed: e._io };
    judgment.bet = false;
    judgment.reason = '取 K 线失败，不下单：' + String(e.message || e).slice(0, 150);
    logError(ledger, `eval-${coin}-spot`, e);
    return finish();
  }

  const dirName = d => d === 'up' ? '涨' : d === 'down' ? '跌' : '中性';
  if (dsr.direction === 'neutral' || muser.direction === 'neutral') {
    judgment.bet = false;
    judgment.reason = `有模型中性（DS${dirName(dsr.direction)} / Muse${dirName(muser.direction)}），无明确方向，不下注`;
    console.log(`[${coin} ${nextLabel}] 有模型中性，跳过`);
    return finish();
  }
  if (dsr.direction !== muser.direction) {
    judgment.bet = false;
    judgment.reason = `双模型方向不一致（DS看${dirName(dsr.direction)} / Muse看${dirName(muser.direction)}），不下注`;
    console.log(`[${coin} ${nextLabel}] 双模型方向不一致，跳过`);
    return finish();
  }

  const side = dsr.direction;
  const price = side === 'up' ? upBuy : downBuy;
  judgment.side = side;

  // 置信度门槛：取双模型置信度较低者，< 57% 不下单（用户拍板 2026-10-02 双模型确认）
  const confR = r4(Math.min(dsr.confidence, muser.confidence));
  if (!(confR >= cfg.DS_MIN_CONF)) {
    judgment.bet = false;
    judgment.reason = `双模型看${side === 'up' ? '涨' : '跌'}（DS ${(r4(dsr.confidence) * 100).toFixed(1)}% / Muse ${(r4(muser.confidence) * 100).toFixed(1)}%），取较低者 ${(confR * 100).toFixed(1)}% < 57%，不下注`;
    console.log(`[${coin} ${nextLabel}] 双模型较低置信度 ${(confR * 100).toFixed(1)}% < 57%，跳过`);
    return finish();
  }

  // 价格过滤：只买 0.48–0.52
  if (!(price >= cfg.PRICE_MIN && price <= cfg.PRICE_MAX)) {
    judgment.bet = false;
    judgment.reason = `双模型看${side === 'up' ? '涨' : '跌'}(较低置信度${(confR * 100).toFixed(0)}%)，但${side.toUpperCase()}买入价 ${price.toFixed(3)} 不在 0.48–0.52，不买`;
    console.log(`[${coin} ${nextLabel}] 价格 ${price.toFixed(3)} 不在区间，跳过`);
    return finish();
  }

  // 置信度分档注额（用户拍板 2026-10-02）：0.57–0.60 → $1，0.61–0.70 → $2，≥0.71 → $3
  const confTier = confR <= 0.60 ? 1 : confR <= 0.70 ? 2 : 3;
  const targetStake = confTier;
  if (ledger.wallet < cfg.MIN_BET_USD) {
    judgment.bet = false; judgment.reason = `钱包 $${ledger.wallet.toFixed(2)} 不足 $1，停止下注`;
    logError(ledger, `eval-${coin}`, new Error('钱包不足 $1'));
    return finish();
  }
  const stake = Math.min(targetStake, ledger.wallet);

  // 真实撮合：按 asks 逐档吃
  let fill;
  try {
    const book = await fillMod.getBook(side === 'up' ? nmkt.upToken : nmkt.downToken);
    fill = fillMod.walkBuy(book.asks, stake);
  } catch (e) {
    judgment.bet = false; judgment.reason = '拉取订单簿失败：' + String(e.message || e).slice(0, 120);
    logError(ledger, `eval-${coin}-book`, e);
    return finish();
  }
  const avgPrice = fill.avgPrice;
  judgment.fill = {
    targetStake: stake, filledCost: fill.filledCost, filledShares: fill.filledShares,
    avgPrice: r4(avgPrice), levelsUsed: fill.levelsUsed, unfilledCost: fill.unfilledCost,
  };
  const skipFill =
    fill.filledCost < cfg.MIN_BET_USD ? `盘口深度不足，仅能成交 $${fill.filledCost.toFixed(2)}` :
    (avgPrice < cfg.PRICE_MIN || avgPrice > cfg.PRICE_MAX) ? `加权成交价 ${avgPrice.toFixed(3)} 超出 0.48–0.52` : null;
  if (skipFill) {
    judgment.bet = false; judgment.reason = `决策通过但未执行：${skipFill}`;
    console.log(`[${coin} ${nextLabel}] 撮合后放弃：${skipFill}`);
    return finish();
  }

  // 买入（持有到期，中途不卖）
  const buyPrice = avgPrice;
  const id = `${nextSlug}-${side}-${Date.now()}`;
  ledger.wallet = round2(ledger.wallet - fill.filledCost);
  ledger.positions.push({
    id, coin, coinName, slug: nextSlug, windowLabel: nextLabel, eventUrl: nmkt.eventUrl,
    side, buyPrice: r4(buyPrice), decidePrice: r4(price),
    shares: fill.filledShares, stake: fill.filledCost,
    buyTime: nowIso(), confTier, dsConf: confR,
    fillLevels: fill.levelsUsed, unfilledCost: fill.unfilledCost,
    dsDirection: dsr.direction, dsConfidence: r4(dsr.confidence), dsReason: dsr.reason,
    museDirection: muser.direction, museConfidence: r4(muser.confidence), museReason: muser.reason,
  });
  ledger.trades.push({
    time: nowIso(), slug: nextSlug, side: 'buy', outcome: side,
    price: r4(buyPrice), decidePrice: r4(price), shares: fill.filledShares, stake: fill.filledCost,
    reason: `双模型看${side === 'up' ? '涨' : '跌'}(DS ${(r4(dsr.confidence) * 100).toFixed(1)}% / Muse ${(r4(muser.confidence) * 100).toFixed(1)}%，取较低${(confR * 100).toFixed(1)}%)，置信度分档 $${confTier}（决策价${price.toFixed(3)}→加权成交${buyPrice.toFixed(3)}，逐档${fill.levelsUsed}档${fill.unfilledCost > 0 ? `，未成交$${fill.unfilledCost.toFixed(2)}` : ''}）`,
  });
  Object.assign(judgment, {
    bet: true, stake: fill.filledCost, confTier,
    reason: `买入 ${side.toUpperCase()} $${fill.filledCost.toFixed(2)} @加权${buyPrice.toFixed(3)}（DS ${(r4(dsr.confidence) * 100).toFixed(1)}% + Muse ${(r4(muser.confidence) * 100).toFixed(1)}%，置信度分档 $${confTier}）`,
  });
  console.log(`[${coin} ${nextLabel}] 开仓 ${side.toUpperCase()} $${fill.filledCost.toFixed(2)} @加权${buyPrice.toFixed(3)}（逐档${fill.levelsUsed}档，${fill.filledShares}股，DS ${(r4(dsr.confidence) * 100).toFixed(1)}% + Muse ${(r4(muser.confidence) * 100).toFixed(1)}%，分档 $${confTier}）`);
  return finish();
}

/** 结算轮询：closed 的盘按 1/0 结算，持有到期（中途不卖）；注额已改为置信度分档（无马丁格） */
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
      buyPrice: pos.buyPrice, stake: pos.stake,
      dsDirection: pos.dsDirection, dsConfidence: pos.dsConfidence, dsReason: pos.dsReason,
      museDirection: pos.museDirection, museConfidence: pos.museConfidence, museReason: pos.museReason,
      confTier: pos.confTier,
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
    await sleep(cfg.EVAL_COOLDOWN_MS); // 上一次评估结束后计时
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
    console.log(`polymarket-crypto-5m-bot 启动（PAPER_MODE=${cfg.PAPER_MODE}，本金 $${cfg.BANKROLL_USD}，5m/双模型/置信度分档）`);
    cfg.COINS.forEach(marketLoop);
    settleLoop();
  }
}

module.exports = { evaluateMarket, settleOnce, loadPrices };
