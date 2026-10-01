// 决策：edge = Jev概率 − 可成交买入价 ≥ REQUIRED_EDGE 才下注
// 铁律：Jev 失败 → 不下新单；DeepSeek 失败 → 本轮不开新仓（记录原因）
const cfg = require('./config');

// 价格感知下单金额：极端价格区降档，避免彩票单/深实值单占用过多资金
// price<0.05 彩票区 cap $3；0.05–0.15 深虚值 cap $5；>0.85 深实值 cap $5；中间正常 1–10
function sizeStake(edge, price) {
  const base = Math.round(edge * 50); // edge 8%→$4，20%→$10
  let cap = cfg.MAX_BET_USD;
  if (price < cfg.LOTTERY_PRICE) cap = 3;
  else if (price < 0.15) cap = 5;
  else if (price > 0.85) cap = 5;
  return Math.max(cfg.MIN_BET_USD, Math.min(cap, base));
}

function decide({ pUp, buyUp, buyDown, secondsLeft, wallet, hasPosition, dsDirection, dsConfidence }) {
  // 浮点边界：(1-0.76)-0.16 = 0.07999999999999999 < 0.08，会把真 8.0% 误杀。
  // 先抹到 4 位小数（0.01% 精度足够），再比较，显示与决策一致。
  const r4 = x => Math.round(x * 10000) / 10000;
  const edgeUp = r4(pUp - buyUp);
  const edgeDown = r4((1 - pUp) - buyDown);
  const reasons = [];
  if (hasPosition) reasons.push('本窗口已有持仓');
  if (secondsLeft < cfg.MIN_SECONDS_LEFT) reasons.push(`剩余${secondsLeft}s不足${cfg.MIN_SECONDS_LEFT}s`);
  if (wallet < cfg.MIN_BET_USD) reasons.push(`钱包$${wallet.toFixed(2)}不足最小下注`);

  // 尾部怀疑：彩票区价格的 edge 建立在最不可靠的尾部概率上，门槛提到 LOTTERY_EDGE
  const lotUp = buyUp < cfg.LOTTERY_PRICE, lotDown = buyDown < cfg.LOTTERY_PRICE;
  const needUp = lotUp ? cfg.LOTTERY_EDGE : cfg.REQUIRED_EDGE;
  const needDown = lotDown ? cfg.LOTTERY_EDGE : cfg.REQUIRED_EDGE;
  const lineTag = (need, lot) => `线${(need * 100).toFixed(0)}%${lot ? '·彩票' : ''}`;
  let pick = null;
  if (edgeUp >= needUp && edgeUp >= edgeDown) pick = { side: 'up', edge: edgeUp, price: buyUp };
  else if (edgeDown >= needDown && edgeDown > edgeUp) pick = { side: 'down', edge: edgeDown, price: buyDown };

  if (pick && pick.price > cfg.MAX_BUY_PRICE) {
    reasons.push(`买入价${pick.price.toFixed(3)}>0.92，结果基本已定`);
    pick = null;
  }
  // 报价异常（CLOB 在窗口尾声可能返回 0）：价格必须在 (0,1] 才算有效成交价
  if (pick && !(pick.price > 0 && pick.price <= 1)) {
    reasons.push(`买入价异常（${pick.price}），跳过本轮`);
    pick = null;
  }
  // 反向彩票拦截：DeepSeek 高置信度指明方向时，不许反向买彩票（实测 0.99 置信度反向彩票三连亏）
  if (pick && dsDirection && (dsConfidence || 0) >= cfg.DS_REVERSE_BLOCK_CONF
    && pick.side !== dsDirection && pick.price < cfg.LOTTERY_PRICE) {
    reasons.push(`DeepSeek ${dsDirection} 置信度${((dsConfidence || 0) * 100).toFixed(0)}%≥${(cfg.DS_REVERSE_BLOCK_CONF * 100).toFixed(0)}%，不许反向买彩票`);
    pick = null;
  }
  if (!pick && reasons.length === 0) {
    reasons.push(`edge不足（Up ${(edgeUp * 100).toFixed(2)}%${lineTag(needUp, lotUp)} / Down ${(edgeDown * 100).toFixed(2)}%${lineTag(needDown, lotDown)}）`);
  }
  let stake = 0;
  if (pick && reasons.length === 0) {
    // 价格感知：极端价格降档（彩票区/深实值 cap 更低）
    stake = sizeStake(pick.edge, pick.price);
    stake = Math.min(stake, Math.floor(wallet)); // 不超过钱包
    if (stake < cfg.MIN_BET_USD) { reasons.push('钱包余额不足下注'); pick = null; stake = 0; }
  }
  return {
    bet: !!(pick && reasons.length === 0),
    side: pick ? pick.side : null,
    edge: pick ? pick.edge : Math.max(edgeUp, edgeDown),
    edgeUp, edgeDown,
    price: pick ? pick.price : null,
    stake,
    shares: pick && stake > 0 ? stake / pick.price : 0,
    reason: reasons.join('；') || (pick ? `edge ${(pick.edge * 100).toFixed(1)}% ≥ ${cfg.REQUIRED_EDGE * 100}%` : '—'),
  };
}

module.exports = { decide, sizeStake };
