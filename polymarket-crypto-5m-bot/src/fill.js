// 订单簿深度撮合：模拟按实际盘口逐档吃单
// 注意：CLOB /book 返回的 bids 是升序、asks 是降序，数组头不是最优价，必须显式排序
const { getJson } = require('./http');
const CLOB = 'https://clob.polymarket.com';

function r2(n) { return Math.round(n * 100) / 100; }

/** 拉取并规范化订单簿：bids 降序（最优在前），asks 升序（最优在前） */
async function getBook(tokenId) {
  const b = await getJson(`${CLOB}/book?token_id=${tokenId}`, 12000);
  const norm = arr => (arr || [])
    .map(x => ({ price: Number(x.price), size: Number(x.size) }))
    .filter(x => Number.isFinite(x.price) && x.price > 0 && Number.isFinite(x.size) && x.size > 0);
  const bids = norm(b.bids).sort((a, c) => c.price - a.price);
  const asks = norm(b.asks).sort((a, c) => a.price - c.price);
  if (!bids.length && !asks.length) throw new Error('订单簿为空');
  return { bids, asks, t: Date.now() };
}

/**
 * 买入：用目标金额逐档吃 asks
 * 返回 { filledCost, filledShares, avgPrice, levelsUsed, unfilledCost, fillRatio }
 */
function walkBuy(asks, targetStake) {
  let remaining = targetStake, cost = 0, shares = 0, levels = 0;
  for (const lv of asks) {
    if (remaining <= 1e-9) break;
    const levelCost = lv.price * lv.size;
    const takeCost = Math.min(remaining, levelCost);
    cost += takeCost;
    shares += takeCost / lv.price;
    remaining -= takeCost;
    levels++;
    if (takeCost < levelCost - 1e-9) break; // 本档没吃完，吃单结束
  }
  const avg = shares > 0 ? cost / shares : NaN;
  return {
    filledCost: r2(cost),
    filledShares: r2(shares),
    avgPrice: avg,
    levelsUsed: levels,
    unfilledCost: r2(Math.max(0, remaining)),
    fillRatio: targetStake > 0 ? cost / targetStake : 0,
  };
}

/**
 * 卖出：用目标股数逐档吃 bids
 * 返回 { soldShares, proceeds, avgPrice, levelsUsed, unfilledShares, fillRatio }
 */
function walkSell(bids, targetShares) {
  let remaining = targetShares, proceeds = 0, sold = 0, levels = 0;
  for (const lv of bids) {
    if (remaining <= 1e-9) break;
    const takeShares = Math.min(remaining, lv.size);
    sold += takeShares;
    proceeds += takeShares * lv.price;
    remaining -= takeShares;
    levels++;
    if (takeShares < lv.size - 1e-9) break; // 本档没吃完，吃单结束
  }
  const avg = sold > 0 ? proceeds / sold : NaN;
  return {
    soldShares: r2(sold),
    proceeds: r2(proceeds),
    avgPrice: avg,
    levelsUsed: levels,
    unfilledShares: r2(Math.max(0, remaining)),
    fillRatio: targetShares > 0 ? sold / targetShares : 0,
  };
}

module.exports = { getBook, walkBuy, walkSell };
