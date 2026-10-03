// 胜率倍投：按（币种+方向）分桶的已结算胜率 → 注额倍数（用户拍板 2026-10-03）
// 胜率 <30% → x4，<35% → x3，<40% → x2；
// 每桶已结算样本不足 WR_MULT_MIN_SETTLED（默认10）时该桶不激活（x1），避免小样本噪音。
function settledWinRate(settlements) {
  const arr = settlements || [];
  const n = arr.length;
  const wins = arr.filter(s => s.win).length;
  return { n, wins, winRate: n ? wins / n : 1 };
}

function stakeMultiplier(winRate, n, minN) {
  if (!(n >= minN)) return 1;
  if (winRate < 0.30) return 4;
  if (winRate < 0.35) return 3;
  if (winRate < 0.40) return 2;
  return 1;
}

function bucketKey(coin, side) {
  return `${coin}:${side}`;
}

// 按币种+方向分桶统计已结算胜率
function bucketStats(settlements) {
  const m = {};
  for (const s of settlements || []) {
    const k = bucketKey(s.coin, s.side);
    const b = m[k] || (m[k] = { coin: s.coin, side: s.side, n: 0, wins: 0 });
    b.n++;
    if (s.win) b.wins++;
  }
  for (const k of Object.keys(m)) m[k].winRate = m[k].n ? m[k].wins / m[k].n : 1;
  return m;
}

// 某桶的注额倍数（样本不足则 x1）
function bucketMultiplier(stats, coin, side, minN) {
  const b = stats[bucketKey(coin, side)];
  if (!b) return 1;
  return stakeMultiplier(b.winRate, b.n, minN);
}

module.exports = { settledWinRate, stakeMultiplier, bucketKey, bucketStats, bucketMultiplier };
