// 决策：edge = Jev概率 − 可成交买入价 ≥ REQUIRED_EDGE 才下注
// 铁律：Jev 失败 → 不下新单；DeepSeek 失败 → 本轮不开新仓（记录原因）
const cfg = require('./config');

function decide({ pUp, buyUp, buyDown, secondsLeft, wallet, hasPosition }) {
  const edgeUp = pUp - buyUp;
  const edgeDown = (1 - pUp) - buyDown;
  const reasons = [];
  if (hasPosition) reasons.push('本窗口已有持仓');
  if (secondsLeft < cfg.MIN_SECONDS_LEFT) reasons.push(`剩余${secondsLeft}s不足${cfg.MIN_SECONDS_LEFT}s`);
  if (wallet < cfg.MIN_BET_USD) reasons.push(`钱包$${wallet.toFixed(2)}不足最小下注`);

  let pick = null;
  if (edgeUp >= cfg.REQUIRED_EDGE && edgeUp >= edgeDown) pick = { side: 'up', edge: edgeUp, price: buyUp };
  else if (edgeDown >= cfg.REQUIRED_EDGE && edgeDown > edgeUp) pick = { side: 'down', edge: edgeDown, price: buyDown };

  if (pick && pick.price > cfg.MAX_BUY_PRICE) {
    reasons.push(`买入价${pick.price.toFixed(3)}>0.92，结果基本已定`);
    pick = null;
  }
  // 报价异常（CLOB 在窗口尾声可能返回 0）：价格必须在 (0,1] 才算有效成交价
  if (pick && !(pick.price > 0 && pick.price <= 1)) {
    reasons.push(`买入价异常（${pick.price}），跳过本轮`);
    pick = null;
  }
  if (!pick && reasons.length === 0) {
    reasons.push(`edge不足（Up ${(edgeUp * 100).toFixed(1)}% / Down ${(edgeDown * 100).toFixed(1)}%，线 ${cfg.REQUIRED_EDGE * 100}%）`);
  }
  let stake = 0;
  if (pick && reasons.length === 0) {
    // edge 8%→$4，20%→$10；钳制 1–10u
    stake = Math.round(pick.edge * 50);
    stake = Math.max(cfg.MIN_BET_USD, Math.min(cfg.MAX_BET_USD, stake));
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

module.exports = { decide };
