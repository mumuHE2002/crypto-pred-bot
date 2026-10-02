#!/usr/bin/env node
// 15m + 5m 每日复盘：只读账本 → 确定性统计 → 模型写中文复盘 → markdown 报告（只给人看，不回灌）
// 用法: node src/daily-review.js [YYYY-MM-DD]   (默认昨天，+08:00；不传参则复盘昨天全天)
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { fetchWithTimeout } = require('./http');

const HOME = process.env.HOME || '/home/hatch';
const L15 = path.join(HOME, 'workspace/polymarket-crypto-bot/data/ledger.json');
const L5 = path.join(HOME, 'workspace/polymarket-crypto-5m-bot/data/ledger.json');
const OUT_DIR = path.join(HOME, 'workspace/your_files');

const dayArg = process.argv[2];
function yesterdayShanghai() {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const y = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 24 * 3600 * 1000);
  return y.toISOString().slice(0, 10);
}
const DAY = dayArg || yesterdayShanghai();
const [Y, M, D] = DAY.split('-').map(Number);
const T0 = Date.UTC(Y, M - 1, D) - 8 * 3600 * 1000; // 当天 00:00 +08:00
const T1 = T0 + 24 * 3600 * 1000;
const inDay = t => { const ms = new Date(t).getTime(); return ms >= T0 && ms < T1; };

const load = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const pct = x => (x * 100).toFixed(1) + '%';
const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const q = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const f2 = x => x == null || !Number.isFinite(x) ? 'n/a' : x.toFixed(2);
const fp = x => x == null || !Number.isFinite(x) ? 'n/a' : pct(x);

// ---------- 15m ----------
function stats15(L) {
  const J = L.judgments.filter(j => inDay(j.time));
  const Jm = J.filter(j => j.io && (j.io.ds || j.io.jev)); // 真调过模型的（非粗筛跳过）
  const bets = J.filter(j => j.bet);
  const preSkip = J.filter(j => (j.reason || '').includes('跳过 DeepSeek')).length;
  const eu = Jm.map(j => j.edgeUp).filter(Number.isFinite);
  const ed = Jm.map(j => j.edgeDown).filter(Number.isFinite);
  const pup = Jm.map(j => j.pUp).filter(Number.isFinite);
  const conf = Jm.map(j => j.dsConfidence).filter(Number.isFinite);
  const dirSplit = {};
  Jm.forEach(j => { dirSplit[j.dsDirection || '?'] = (dirSplit[j.dsDirection || '?'] || 0) + 1; });
  const confirmed = J.filter(j => (j.edgeConfirm || '').startsWith('confirmed')).length;

  const buys = L.trades.filter(t => t.side === 'buy' && inDay(t.time));
  const sells = L.trades.filter(t => t.side === 'sell' && inDay(t.time));
  const realizedSell = sells.reduce((s, t) => s + (t.realizedPnl || 0), 0);
  const st = L.settlements.filter(s => inDay(s.time));
  const wins = st.filter(s => s.win).length;
  const pnl = st.reduce((s, x) => s + (x.pnl || 0), 0);
  const byCoin = {}, bySide = {};
  st.forEach(s => {
    (byCoin[s.coin] = byCoin[s.coin] || { n: 0, pnl: 0 }); byCoin[s.coin].n++; byCoin[s.coin].pnl += s.pnl || 0;
    (bySide[s.side] = bySide[s.side] || { n: 0, pnl: 0 }); bySide[s.side].n++; bySide[s.side].pnl += s.pnl || 0;
  });

  // 预测 edge vs 实现盈亏（按 slug join 开仓判断；尽力而为）
  const pairs = [];
  st.forEach(s => {
    const buy = L.trades.filter(t => t.side === 'buy' && t.slug === s.slug && t.outcome === s.side)
      .sort((a, b) => new Date(b.time) - new Date(a.time))[0];
    if (!buy || !buy.stake) return;
    const j = J.filter(x => x.slug === s.slug && x.side === s.side && new Date(x.time) <= new Date(buy.time))
      .sort((a, b) => new Date(b.time) - new Date(a.time))[0];
    let pred = null;
    if (j) pred = (j.fill && Number.isFinite(j.fill.edgeAvg)) ? j.fill.edgeAvg : (s.side === 'up' ? j.edgeUp : j.edgeDown);
    if (Number.isFinite(pred)) pairs.push({ pred, realized: s.pnl / buy.stake, coin: s.coin, side: s.side, win: s.win });
  });

  const er = L.exitReviews.filter(e => inDay(e.time));
  const erSplit = {};
  er.forEach(e => { erSplit[e.decision || '?'] = (erSplit[e.decision || '?'] || 0) + 1; });
  const erSells = er.filter(e => String(e.decision || '').startsWith('sell'));
  const errs = L.errors.filter(e => inDay(e.time));
  const errBy = {};
  errs.forEach(e => { errBy[e.where || '?'] = (errBy[e.where || '?'] || 0) + 1; });

  // 样本：最近 8 笔开仓判断 + 5 个高 edge 未下单
  const jBets = [...bets].sort((a, b) => new Date(b.time) - new Date(a.time)).slice(0, 8)
    .map(j => ({ t: j.time.slice(11, 16), coin: j.coin, side: j.side, pUp: j.pUp, edge: j.fill ? j.fill.edgeAvg : (j.side === 'up' ? j.edgeUp : j.edgeDown), conf: j.dsConfidence, reason: (j.reason || '').slice(0, 90) }));
  const jSkip = Jm.filter(j => !j.bet && Math.max(j.edgeUp || -1, j.edgeDown || -1) >= 0.06)
    .sort((a, b) => Math.max(b.edgeUp || -1, b.edgeDown || -1) - Math.max(a.edgeUp || -1, a.edgeDown || -1)).slice(0, 5)
    .map(j => ({ t: j.time.slice(11, 16), coin: j.coin, edgeUp: j.edgeUp, edgeDown: j.edgeDown, reason: (j.reason || '').slice(0, 90) }));

  return {
    judgments: J.length, modelEvals: Jm.length, bets: bets.length, betRate: bets.length / Math.max(1, J.length),
    preScreenSkips: preSkip, confirmedSecond: confirmed,
    edgeUp: { p50: q(eu, .5), p90: q(eu, .9) }, edgeDown: { p50: q(ed, .5), p90: q(ed, .9) },
    pUp: { mean: avg(pup), p10: q(pup, .1), p50: q(pup, .5), p90: q(pup, .9) },
    dsConfMean: avg(conf), dsDirSplit: dirSplit,
    buys: { n: buys.length, stake: buys.reduce((s, t) => s + (t.stake || 0), 0) },
    sells: { n: sells.length },
    settlements: { n: st.length, wins, winRate: wins / Math.max(1, st.length), pnl, byCoin, bySide },
    edgeCalib: { n: pairs.length, avgPred: avg(pairs.map(p => p.pred)), avgRealized: avg(pairs.map(p => p.realized)), pairs: pairs.slice(0, 12) },
    exitReviews: { n: er.length, split: erSplit, sellAvgHoldProb: avg(erSells.map(e => e.probHoldBetter).filter(Number.isFinite)), sellAvgUnrealPct: avg(erSells.map(e => e.unrealPct).filter(Number.isFinite)) },
    errors: { n: errs.length, by: errBy },
    samples: { bets: jBets, highEdgeSkips: jSkip },
  };
}

// ---------- 5m ----------
function stats5(L) {
  const J = L.judgments.filter(j => inDay(j.time) && j.modelsCalled);
  const bets = J.filter(j => j.bet);
  const agree = J.filter(j => j.dsDirection && j.dsDirection === j.museDirection).length;
  const dc = J.map(j => j.dsConfidence).filter(Number.isFinite);
  const mc = J.map(j => j.museConfidence).filter(Number.isFinite);
  const tier = {};
  J.forEach(j => { const k = 't' + (j.confTier ?? '?'); tier[k] = (tier[k] || 0) + 1; });
  const st = L.settlements.filter(s => inDay(s.time));
  const wins = st.filter(s => s.win).length;
  const pnl = st.reduce((s, x) => s + (x.pnl || 0), 0);
  const byTier = {}, byCoin = {};
  st.forEach(s => {
    const k = 't' + (s.confTier ?? '?');
    (byTier[k] = byTier[k] || { n: 0, wins: 0, pnl: 0 }); byTier[k].n++; if (s.win) byTier[k].wins++; byTier[k].pnl += s.pnl || 0;
    (byCoin[s.coin] = byCoin[s.coin] || { n: 0, wins: 0, pnl: 0 }); byCoin[s.coin].n++; if (s.win) byCoin[s.coin].wins++; byCoin[s.coin].pnl += s.pnl || 0;
  });
  Object.values(byTier).forEach(t => t.winRate = t.wins / Math.max(1, t.n));
  Object.values(byCoin).forEach(t => t.winRate = t.wins / Math.max(1, t.n));
  const errs = L.errors.filter(e => inDay(e.time));
  const samples = [...bets].sort((a, b) => new Date(b.time) - new Date(a.time)).slice(0, 8)
    .map(j => ({ t: j.time.slice(11, 16), coin: j.coin, side: j.side, ds: j.dsConfidence, muse: j.museConfidence, reason: (j.reason || '').slice(0, 90) }));
  return {
    judgments: J.length, bets: bets.length, betRate: bets.length / Math.max(1, J.length),
    agreement: agree / Math.max(1, J.length), dsConfMean: avg(dc), museConfMean: avg(mc), tierDist: tier,
    settlements: { n: st.length, wins, winRate: wins / Math.max(1, st.length), pnl, byTier, byCoin },
    errors: errs.length, samples,
  };
}

async function callModel(prompt) {
  const body = {
    model: cfg.DEEPSEEK_MODEL,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 16000, temperature: 0.3, reasoning_effort: 'low',
  };
  const res = await fetchWithTimeout(`${cfg.JEV_API_BASE}/provider/v1/chat/completions`, {
    method: 'POST', timeoutMs: 300000,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.JEV_API_KEY}` },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`模型 HTTP ${res.status}: ${raw.slice(0, 200)}`);
  const data = JSON.parse(raw);
  const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '';
  if (!text) throw new Error('模型返回空');
  return text;
}

(async () => {
  const s15 = stats15(load(L15));
  const s5 = stats5(load(L5));
  const prompt =
    `你是 Polymarket 模拟交易机器人的每日复盘分析师。下面是 ${DAY}（+08:00 全天）两套系统的确定性统计（JSON），` +
    `以及部分原始判断样本。15m 系统：DeepSeek 看方向 + Jev 校准 P(Up)，edge≥8% 且连续 2 次确认才开仓，` +
    `浮盈亏 |≥15%| 时 Jev 复核（持有更优<45% 卖出）。5m 系统：DeepSeek + Muse 双模型方向一致才下单，` +
    `按较低置信度分档（t1:57–60%→$1，t2:61–70%→$2，t3:≥71%→$3），持有到结算。\n\n` +
    `15m 统计：\n${JSON.stringify(s15, null, 1)}\n\n5m 统计：\n${JSON.stringify(s5, null, 1)}\n\n` +
    `请用中文写一份复盘报告（markdown），结构：\n` +
    `## 1. 一句话总结（15m / 5m 各一句）\n` +
    `## 2. 概率校准：Jev P(Up) 分布与实现胜率是否匹配？DS/Muse 置信度与胜率是否匹配？5m 按置信度分档的胜率表是否支持当前分档？\n` +
    `## 3. edge 实现：15m 预测 edge 均值 vs 实现盈亏（avgPred vs avgRealized），差距说明什么？\n` +
    `## 4. 系统性偏差：方向/币种/分档上有无持续性偏差（如 Jev 看空偏）？\n` +
    `## 5. 改进建议：3 条以内，具体可执行（只建议，不用写代码）\n` +
    `要求：基于数字说话，不确定的地方明确说样本不足；简洁，少废话。直接输出报告正文，不要开场白。`;
  const report = await callModel(prompt);
  const outPath = path.join(OUT_DIR, `crypto-daily-review-${DAY}.md`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(outPath, `# Crypto 每日复盘 ${DAY}\n\n${report}\n`);
  console.log(JSON.stringify({
    day: DAY, report: outPath,
    m15: { judgments: s15.judgments, bets: s15.bets, settlements: s15.settlements.n, winRate: fp(s15.settlements.winRate), pnl: f2(s15.settlements.pnl), avgPredEdge: fp(s15.edgeCalib.avgPred), avgRealized: fp(s15.edgeCalib.avgRealized) },
    m5: { judgments: s5.judgments, bets: s5.bets, settlements: s5.settlements.n, winRate: fp(s5.settlements.winRate), pnl: f2(s5.settlements.pnl) },
  }));
})().catch(e => { console.error('REVIEW_FAIL: ' + (e.message || e)); process.exit(1); });
