// Jev 概率校准层：经 commandcode 网关 systemone + noul
// 铁律：Jev 失败 → 不下新单（REQUIRE_JEV），绝不回退启发式下单
const cfg = require('./config');
const { fetchWithTimeout } = require('./http');

async function callJev(state, questions) {
  const res = await fetchWithTimeout(`${cfg.JEV_API_BASE}/provider/v1/systemone`, {
    method: 'POST',
    timeoutMs: cfg.JEV_TIMEOUT_MS,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.JEV_API_KEY}`,
    },
    body: JSON.stringify({ model: cfg.JEV_MODEL, state, questions }),
  });
  const rawText = await res.text();
  if (!res.ok) throw new Error(`Jev HTTP ${res.status}：${rawText.slice(0, 200)}`);
  let data;
  try { data = JSON.parse(rawText); } catch { throw new Error(`Jev 返回不是 JSON：${rawText.slice(0, 120)}`); }
  return data;
}
function noulProb(data, name) {
  const a = data.answers && data.answers[name];
  const p = a && Number(a.noul);
  if (!Number.isFinite(p)) throw new Error(`Jev 未返回有效概率 (${name})`);
  return Math.max(0, Math.min(1, p));
}

/**
 * 校准 P(Up)：DeepSeek 分析 + 现货动量 + 盘口价 → Up 获胜概率
 * @returns { pUp: 0..1, via: 'jev' }
 */
async function calibrateUp({ coinName, windowLabel, secondsLeft, feat, ds, upBuy, downBuy, upMid, downMid }) {
  if (!cfg.JEV_API_KEY) throw new Error('未配置 JEV_API_KEY');
  const state =
    `You are calibrating a probability for a PAPER-TRADING bot (no real money).\n` +
    `Market: Polymarket "${coinName} Up or Down" 15-minute window ${windowLabel}.\n` +
    `Resolution: "Up" wins if the Chainlink TWAP of ${coinName} over the window >= the price at window START; else "Down" wins.\n` +
    `Seconds left in window: ${secondsLeft}.\n` +
    `Analyst view (DeepSeek): direction=${ds.direction}, confidence=${(ds.confidence * 100).toFixed(0)}%, reason: ${ds.reason}\n` +
    `Spot momentum (Coinbase 1m): drift=${feat.driftBps}bps over last ${feat.n}min, per-min vol=${feat.volBps}bps, ` +
    `range=${feat.rangeBps}bps, RSI14=${feat.rsi14}.\n` +
    `Market prices (implied probabilities): Up buy=${upBuy.toFixed(3)} mid=${upMid.toFixed(3)} | ` +
    `Down buy=${downBuy.toFixed(3)} mid=${downMid.toFixed(3)}.\n` +
    `Calibrate against momentum and time left; do NOT just echo the market price. ` +
    `With little time left, the current spot level vs the window-start price dominates the outcome.`;
  const data = await callJev(state, {
    up: { type: 'noul', instructions: `What is the probability (0-100%) that this 15-minute "${coinName} Up or Down" market resolves to "Up"?` },
  });
  return { pUp: noulProb(data, 'up'), via: 'jev' };
}

/**
 * 退出复核：持有到期 vs 现在按卖出价卖出，哪个总盈亏更高？
 * @returns { probHoldBetter: 0..1, via: 'jev' }（失败直接抛错，不回退）
 */
async function askExit({ pos, curSellPrice, secondsLeft }) {
  const usd = n => (n >= 0 ? '+' : '') + '$' + n.toFixed(2);
  const unreal = pos.shares * curSellPrice - pos.stake;
  const unrealPct = unreal / pos.stake;
  const state =
    `You are reviewing a PAPER-TRADING position (no real money).\n` +
    `Market: Polymarket "${pos.coinName} Up or Down" 15-minute window ${pos.windowLabel} (${pos.eventUrl}).\n` +
    `Position: ${pos.side.toUpperCase()}, bought at $${pos.buyPrice.toFixed(4)}/share, ` +
    `${pos.shares.toFixed(2)} shares, $${pos.stake.toFixed(2)} stake.\n` +
    `Current SELL price: $${curSellPrice.toFixed(4)} → unrealized P&L ${usd(unreal)} (${(unrealPct * 100).toFixed(1)}%).\n` +
    `If you SELL NOW you lock in ≈ ${usd(unreal)}. If you HOLD to expiry (≈${Math.max(0, Math.round(secondsLeft))}s left), ` +
    `you receive $1/share if ${pos.side.toUpperCase()} wins, $0 otherwise.\n` +
    `Resolution: Chainlink TWAP over the window vs window-start price.`;
  const data = await callJev(state, {
    exit: { type: 'noul', instructions: `What is the probability (0-100%) that HOLDING this ${pos.side.toUpperCase()} position to expiry yields a HIGHER total P&L than SELLING it NOW at $${curSellPrice.toFixed(4)}/share?` },
  });
  return { probHoldBetter: noulProb(data, 'exit'), via: 'jev' };
}

module.exports = { calibrateUp, askExit };
