// 主循环：每币种独立评估循环（上次结束后 30s 再评估）+ 结算轮询（60s）
const cfg = require('./config');
const { load, save, pushCapped, recordEquity } = require('./store');
const pm = require('./polymarket');
const spot = require('./spot');
const ds = require('./deepseek');
const jev = require('./jev');
const brain = require('./brain');
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

/** edge 双重确认（去抖）：同窗口同方向连续 N 次评估 edge 达标才开仓。
 *  15m 盘报价闪动快，单次评估的 8% gap 常是过期报价/薄订单簿打印的幻影；
 *  真实分歧应能挺过约 1 分钟（一次评估间隔）。内存态，重启丢失=保守跳过。 */
const edgeConfirm = new Map(); // `${coin}:${slug}` → { side, hits, pUp }
const confirmKey = (coin, mkt) => `${coin}:${mkt.slug}`;
function edgeConfirmed(coin, mkt, d2, judgment, label) {
  const ck = confirmKey(coin, mkt);
  const need = Math.max(1, cfg.EDGE_CONFIRM_HITS || 2);
  const maxDrift = cfg.EDGE_CONFIRM_MAX_PUP_DRIFT ?? 0.15;
  const prev = edgeConfirm.get(ck);
  const pUp = judgment.pUp;
  // 同方向还不够：Jev 概率本身也要稳定，否则是两次基于完全不同判断的"达标"
  // 漂移抹到 4 位小数再比较，避开 0.65-0.50=0.15000000000000002 这类浮点边界误杀
  const stable = prev && prev.side === d2.side
    && typeof prev.pUp === 'number' && typeof pUp === 'number'
    && r4(Math.abs(pUp - prev.pUp)) <= maxDrift;
  const driftReset = prev && prev.side === d2.side && !stable;
  const hits = stable ? prev.hits + 1 : 1;
  if (hits >= need) {
    edgeConfirm.delete(ck);
    judgment.edgeConfirm = `confirmed(${hits}/${need})`;
    return true;
  }
  edgeConfirm.set(ck, { side: d2.side, hits, pUp });
  const edge = d2.side === 'up' ? d2.edgeUp : d2.edgeDown;
  judgment.bet = false;
  judgment.side = d2.side; judgment.stake = d2.stake;
  judgment.edgeConfirm = `pending(${hits}/${need})`;
  judgment.reason = driftReset
    ? `P(Up) ${(prev.pUp * 100).toFixed(0)}%→${(pUp * 100).toFixed(0)}% 变化过大，确认链重置（${hits}/${need}，${d2.side}）`
    : `edge ${(edge * 100).toFixed(1)}% 达标，等待二次确认（${hits}/${need}，${d2.side}）`;
  console.log(`[${coin} ${label}] edge 达标，等待二次确认（${hits}/${need}）${driftReset ? '（概率漂移重置）' : ''}`);
  return false;
}

/** 单盘一次评估：退出复核 →（无持仓时）新开仓判断 */
async function evaluateMarket(coin) {
  const coinName = pm.COIN_NAME[coin];
  const mkt = await pm.fetchCurrentMarket(coin);
  if (!mkt) { console.log(`[${coin}] 本轮无盘口（slug 未创建），跳过`); return; }
  if (mkt.error) { logError(ledger, `eval-${coin}`, mkt.error); persist(); return; }
  // 窗口滚动后清理旧确认态（key 含 slug，旧窗口自然过期）
  for (const k of [...edgeConfirm.keys()]) {
    if (k.startsWith(`${coin}:`) && k !== confirmKey(coin, mkt)) edgeConfirm.delete(k);
  }
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
    id: `${mkt.slug}-${Date.now()}`, time: nowIso(), coin, coinName, slug: mkt.slug, windowLabel: label,
    eventUrl: mkt.eventUrl, secondsLeft: mkt.secondsLeft,
    upBuy: r4(upBuy), downBuy: r4(downBuy), upMid: r4(upMid), downMid: r4(downMid),
  };
  const hasPos = ledger.positions.some(p => p.slug === mkt.slug);
  if (!hasPos && mkt.secondsLeft >= cfg.MIN_SECONDS_LEFT && ledger.wallet >= cfg.MIN_BET_USD) {
    try {
      const candles = await spot.fetchCandles(coin, 30);
      const feat = spot.features(candles);
      const candleText = spot.candlesText(candles, 15);
      // C方案（2026-10-02 用户拍板降本）：Jev 先行粗筛。Jev 单次约 $0.00002，
      // DeepSeek 约 $0.0013/次；maxEdge < JEV_PREFILTER_EDGE 直接跳过 DS。
      // 预筛不用 DS 视角（还没调 DS）；通过后走原流程，终判仍用带 DS 视角的校准。
      // 注意：预筛 edge 用 brain.decide 同口径（抹 4 位小数后比可成交价）。
      const finishEarly = () => {
        judgment.ms = Date.now() - t0;
        pushCapped(ledger.judgments, judgment, 300);
        const jWithIo = ledger.judgments.filter(x => x.io);
        for (let k = 0; k < jWithIo.length - 100; k++) delete jWithIo[k].io;
        persist();
        try { buildReport(); } catch (e2) { console.error('[report]', e2.message); }
      };
      let pre = null;
      try {
        pre = await jev.calibrateUp({
          coinName, windowLabel: label, secondsLeft: mkt.secondsLeft,
          feat, ds: { direction: 'n/a', confidence: 0, reason: 'pre-screen without analyst view' },
          upBuy, downBuy, upMid, downMid,
        });
      } catch (e) {
        // Jev 粗筛失败 → 按铁律不下单（等同模型失败，确认链断裂）
        edgeConfirm.delete(confirmKey(coin, mkt));
        if (e._io) judgment.io = { jevPreFailed: e._io };
        judgment.error = String(e.message || e).slice(0, 200);
        judgment.bet = false; judgment.reason = 'Jev 粗筛失败，不下单：' + judgment.error;
        logError(ledger, `eval-${coin}-jevpre`, e);
        console.log(`[${coin} ${label}] Jev 粗筛失败，跳过`);
        finishEarly(); return;
      }
      const preEdgeUp = r4(pre.pUp - upBuy), preEdgeDown = r4((1 - pre.pUp) - downBuy);
      const preEdge = Math.max(preEdgeUp, preEdgeDown);
      judgment.io = { jevPre: pre.io };
      judgment.pUp = r4(pre.pUp); judgment.edgeUp = preEdgeUp; judgment.edgeDown = preEdgeDown;
      if (preEdge < cfg.JEV_PREFILTER_EDGE) {
        // 粗筛未过 → 等同未达标，确认链断裂，不调 DeepSeek
        edgeConfirm.delete(confirmKey(coin, mkt));
        judgment.bet = false;
        judgment.reason = `Jev 粗筛 maxEdge ${(preEdge * 100).toFixed(1)}%<${(cfg.JEV_PREFILTER_EDGE * 100).toFixed(0)}%，跳过 DeepSeek`;
        console.log(`[${coin} ${label}] 粗筛未过（maxEdge ${(preEdge * 100).toFixed(1)}%），跳过 DS`);
        finishEarly(); return;
      }
      const dsr = await ds.analyze({
        coin, coinName, windowLabel: label, secondsLeft: mkt.secondsLeft,
        feat, candleText, upBuy, downBuy, upMid, downMid,
      });
      judgment.io.ds = dsr.io; // 保留前面的 jevPre，不覆盖
      const j = await jev.calibrateUp({
        coinName, windowLabel: label, secondsLeft: mkt.secondsLeft,
        feat, ds: dsr, upBuy, downBuy, upMid, downMid,
      });
      judgment.io.jev = j.io;
      const d = brain.decide({
        pUp: j.pUp, buyUp: upBuy, buyDown: downBuy,
        secondsLeft: mkt.secondsLeft, wallet: ledger.wallet, hasPosition: hasPos,
        dsDirection: dsr.direction, dsConfidence: dsr.confidence,
      });
      Object.assign(judgment, {
        pUp: r4(j.pUp), edgeUp: r4(d.edgeUp), edgeDown: r4(d.edgeDown),
        dsDirection: dsr.direction, dsConfidence: r4(dsr.confidence), dsReason: dsr.reason,
        bet: d.bet, side: d.side, stake: d.stake, reason: d.reason,
        driftBps: feat.driftBps, rsi14: feat.rsi14,
      });
      if (d.bet) {
        // B方案：执行前重抓最新价，用新价重跑 decide；edge 不达标/抓价失败则放弃
        let fUp, fDown, d2 = null, refetchOk = true;
        try {
          [fUp, fDown] = await Promise.all([pm.clobPrice(mkt.upToken, 'buy'), pm.clobPrice(mkt.downToken, 'buy')]);
          d2 = brain.decide({
            pUp: j.pUp, buyUp: fUp, buyDown: fDown,
            secondsLeft: mkt.secondsLeft, wallet: ledger.wallet, hasPosition: hasPos,
            dsDirection: dsr.direction, dsConfidence: dsr.confidence,
          });
        } catch (e) {
          refetchOk = false;
          logError(ledger, `eval-${coin}-refetch`, e);
        }
        judgment.refetch = refetchOk
          ? { upBuy: r4(fUp), downBuy: r4(fDown), edgeUp: r4(d2.edgeUp), edgeDown: r4(d2.edgeDown), bet: d2.bet, reason: d2.reason }
          : { bet: false, reason: '执行前重抓价格失败，跳过' };
        if (!judgment.refetch.bet) {
          judgment.bet = false;
          judgment.reason = `决策通过但未执行：${judgment.refetch.reason}`;
          edgeConfirm.delete(confirmKey(coin, mkt)); // 确认链断裂
          console.log(`[${coin} ${label}] 重抓价后放弃：${judgment.refetch.reason}`);
        } else if (!edgeConfirmed(coin, mkt, d2, judgment, label)) {
          // edge 双重确认未通过：本轮不拉订单簿、不下单（judgment 已填写）
        } else {
          // 深度撮合：按实际订单簿逐档吃 asks，能成交多少买多少；edge 按加权均价重算
          const token = d2.side === 'up' ? mkt.upToken : mkt.downToken;
          let fill = null;
          try {
            const book = await fillMod.getBook(token);
            fill = fillMod.walkBuy(book.asks, d2.stake);
          } catch (e) {
            judgment.bet = false;
            judgment.reason = `决策通过但未执行：拉取订单簿失败（${String(e.message || e).slice(0, 80)}），跳过`;
            logError(ledger, `eval-${coin}-book`, e);
            console.log(`[${coin} ${label}] 订单簿失败放弃`);
            judgment.ms = Date.now() - t0;
            pushCapped(ledger.judgments, judgment, 300);
            persist();
            try { buildReport(); } catch (e2) { console.error('[report]', e2.message); }
            return;
          }
          const decidePrice = d2.price; // 决策时价：执行依据的是重抓价后的 d2，用 d2 的价
          const probSide = d2.side === 'up' ? j.pUp : 1 - j.pUp;
          const edgeAvg = probSide - fill.avgPrice; // 按实际加权成交价重算
          judgment.fill = {
            targetStake: d2.stake, filledCost: fill.filledCost, filledShares: fill.filledShares,
            avgPrice: r4(fill.avgPrice), levelsUsed: fill.levelsUsed,
            unfilledCost: fill.unfilledCost, edgeAvg: r4(edgeAvg),
          };
          const skipFill =
            fill.filledCost < cfg.MIN_BET_USD ? `盘口深度不足，仅能成交 $${fill.filledCost.toFixed(2)}` :
            edgeAvg < cfg.REQUIRED_EDGE ? `按加权成交价${fill.avgPrice.toFixed(3)}重算 edge ${(edgeAvg * 100).toFixed(1)}%<${cfg.REQUIRED_EDGE * 100}%` : null;
          if (skipFill) {
            judgment.bet = false;
            judgment.reason = `决策通过但未执行：${skipFill}`;
            console.log(`[${coin} ${label}] 深度撮合后放弃：${skipFill}`);
          } else {
            const buyPrice = fill.avgPrice; // 实际加权成交价
            const id = `${mkt.slug}-${d2.side}-${Date.now()}`;
            ledger.wallet = round2(ledger.wallet - fill.filledCost);
            ledger.positions.push({
              id, coin, coinName, slug: mkt.slug, windowLabel: label, eventUrl: mkt.eventUrl,
              side: d2.side, buyPrice: r4(buyPrice), decidePrice: r4(decidePrice),
              shares: fill.filledShares,
              stake: fill.filledCost, buyTime: nowIso(), pUp: r4(j.pUp), lastExitReviewAt: 0,
              fillLevels: fill.levelsUsed, unfilledCost: fill.unfilledCost,
            });
            ledger.trades.push({
              time: nowIso(), slug: mkt.slug, side: 'buy', outcome: d2.side,
              price: r4(buyPrice), decidePrice: r4(decidePrice), shares: fill.filledShares, stake: fill.filledCost,
              reason: `edge ${(edgeAvg * 100).toFixed(1)}%（决策价${decidePrice.toFixed(3)}→加权成交${buyPrice.toFixed(3)}，逐档${fill.levelsUsed}档${fill.unfilledCost > 0 ? `，未成交$${fill.unfilledCost.toFixed(2)}` : ''}）`,
            });
            Object.assign(judgment, {
              bet: true, side: d2.side, stake: fill.filledCost,
              reason: `edge ${(edgeAvg * 100).toFixed(1)}%（决策价${decidePrice.toFixed(3)}→加权成交${buyPrice.toFixed(3)}，逐档${fill.levelsUsed}档）`,
            });
            console.log(`[${coin} ${label}] 开仓 ${d2.side.toUpperCase()} $${fill.filledCost} @加权${buyPrice.toFixed(3)}（逐档${fill.levelsUsed}档，${fill.filledShares}股，edge ${(edgeAvg * 100).toFixed(1)}%）`);
          }
        }
      } else {
        edgeConfirm.delete(confirmKey(coin, mkt)); // 初判未达标，确认链断裂
        console.log(`[${coin} ${label}] 跳过：${d.reason}`);
      }
    } catch (e) {
      // Jev/DS 失败 → 不下单（铁律），只记录；能拿到的 io 也存档
      edgeConfirm.delete(confirmKey(coin, mkt)); // 模型失败，确认链断裂
      if (e._io && !judgment.io) judgment.io = {};
      if (e._io) judgment.io.failed = e._io;
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
  // 模型 io 只保留最近 100 条，免账本膨胀
  const jWithIo = ledger.judgments.filter(x => x.io);
  for (let k = 0; k < jWithIo.length - 100; k++) delete jWithIo[k].io;
  persist();
  try { buildReport(); } catch (e) { console.error('[report]', e.message); }
}

/** 退出复核：浮盈亏 |≥15%| → 问 Jev；持有更优 <45% 则重抓最新卖出价真实卖出 */
async function reviewExit(coin, mkt, pos, label) {
  const token = pos.side === 'up' ? mkt.upToken : mkt.downToken;
  let sellPrice;
  try { sellPrice = await pm.clobPrice(token, 'sell'); }
  catch (e) { logError(ledger, `exit-${coin}-price`, e); return; }
  const unreal = pos.shares * sellPrice - pos.stake;
  const unrealPct = unreal / pos.stake;
  const skipReason =
    Math.abs(unrealPct) < cfg.EXIT_UNREAL_PCT ? `浮盈亏 ${(unrealPct * 100).toFixed(1)}% 未达 ±${cfg.EXIT_UNREAL_PCT * 100}%` : null;
  // 2026-10-01 用户拍板：去掉冷静期。每轮评估（约60-120s，2026-10-02 降本 30s→60s）只要 |浮盈亏|≥15% 就问 Jev，
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
  // B方案（2026-10-01 用户拍板）：复核不再盲判，先抓 K 线动量上下文再问 Jev。
  // K 线抓取失败则本轮跳过复核（不盲判），下一轮再试。
  let feat = null, candleText = '';
  try {
    const candles = await spot.fetchCandles(coin, 30);
    feat = spot.features(candles);
    candleText = spot.candlesText(candles, 15);
  } catch (e) {
    logError(ledger, `exit-${coin}-spot`, e);
    const last = [...ledger.exitReviews].reverse().find(r => r.slug === mkt.slug && r.side === pos.side);
    const sr = 'K线抓取失败，本轮跳过复核';
    if (!last || last.decision !== 'skip' || last.reason !== sr) {
      pushCapped(ledger.exitReviews, { ...base, decision: 'skip', reason: sr }, 200);
      persist();
    }
    return;
  }
  Object.assign(base, { driftBps: feat.driftBps, rsi14: feat.rsi14 });
  try {
    const { probHoldBetter, io } = await jev.askExit({
      pos, curSellPrice: sellPrice, secondsLeft: mkt.secondsLeft,
      feat, candleText, triggerPct: (cfg.EXIT_UNREAL_PCT * 100).toFixed(0),
    });
    pos.lastExitReviewAt = Date.now();
    const revIo = io ? { jev: io } : null;
    if (probHoldBetter < cfg.EXIT_HOLD_PROB) {
      // 深度撮合：按实际订单簿逐档吃 bids，能卖多少卖多少；深度不足时部分平仓，剩余继续持有
      let fill;
      try {
        const book = await fillMod.getBook(token);
        fill = fillMod.walkSell(book.bids, pos.shares);
      } catch (e) { logError(ledger, `exit-${coin}-book`, e); persist(); return; }
      if (fill.soldShares <= 0) {
        console.log(`[${coin} ${label}] 卖盘无深度，跳过本轮卖出`);
        persist();
        return;
      }
      const proceeds = fill.proceeds;
      const costBasisSold = round2(pos.stake * (fill.soldShares / pos.shares));
      const fillUnreal = round2(proceeds - costBasisSold);
      ledger.wallet = round2(ledger.wallet + proceeds);
      const remainShares = round2(pos.shares - fill.soldShares);
      const closed = remainShares < 0.01 || fill.unfilledShares <= 0;
      if (closed) {
        ledger.positions = ledger.positions.filter(p => p.id !== pos.id);
      } else {
        pos.shares = remainShares;
        pos.stake = round2(pos.stake - costBasisSold);
      }
      const depthNote = `逐档${fill.levelsUsed}档${fill.unfilledShares > 0 ? `，${fill.unfilledShares}股未成交继续持有` : ''}`;
      ledger.trades.push({
        time: nowIso(), slug: mkt.slug, side: 'sell', outcome: pos.side,
        price: r4(fill.avgPrice), decidePrice: r4(sellPrice), shares: fill.soldShares, stake: proceeds,
        reason: `持有更优 ${(probHoldBetter * 100).toFixed(0)}%<${cfg.EXIT_HOLD_PROB * 100}%（决策价${sellPrice.toFixed(3)}→加权成交${fill.avgPrice.toFixed(3)}，${depthNote}），锁定 ${usd(fillUnreal)}`,
      });
      pushCapped(ledger.exitReviews, { ...base, io: revIo, decision: closed ? 'sell' : 'sell-partial',
        probHoldBetter: r4(probHoldBetter),
        fillPrice: r4(fill.avgPrice), fillUnreal: round2(fillUnreal),
        soldShares: fill.soldShares, remainShares: closed ? 0 : remainShares,
        reason: `${closed ? '卖出' : '部分卖出'}锁定 ${usd(fillUnreal)}（决策价${sellPrice.toFixed(3)}→加权成交${fill.avgPrice.toFixed(3)}，${depthNote}）` }, 200);
      console.log(`[${coin} ${label}] 止盈/止损${closed ? '卖出' : '部分卖出'} ${pos.side.toUpperCase()}：${usd(fillUnreal)}（加权${fill.avgPrice.toFixed(3)}，${depthNote}，持有更优 ${(probHoldBetter * 100).toFixed(0)}%）`);
    } else {
      pushCapped(ledger.exitReviews, { ...base, io: revIo, decision: 'hold', probHoldBetter: r4(probHoldBetter), reason: `持有更优 ${(probHoldBetter * 100).toFixed(0)}%≥${cfg.EXIT_HOLD_PROB * 100}%，继续持有` }, 200);
      console.log(`[${coin} ${label}] 复核：继续持有（持有更优 ${(probHoldBetter * 100).toFixed(0)}%，浮盈亏 ${usd(unreal)}）`);
    }
    // 复核 io 只保留最近 100 条
    const rWithIo = ledger.exitReviews.filter(x => x.io);
    for (let k = 0; k < rWithIo.length - 100; k++) delete rWithIo[k].io;
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

module.exports = { evaluateMarket, settleOnce, loadPrices, edgeConfirmed, _edgeConfirm: edgeConfirm };
