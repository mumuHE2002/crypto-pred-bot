// 极简 .env 加载（无外部依赖）
const fs = require('fs');
const path = require('path');

function loadEnv() {
  const p = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim();
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadEnv();

const num = (k, d) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) ? v : d;
};

module.exports = {
  // 模型网关（沿用天气机器人那份 commandcode key）
  JEV_API_BASE: (process.env.JEV_API_BASE || 'https://api.commandcode.ai').replace(/\/+$/, ''),
  JEV_API_KEY: process.env.JEV_API_KEY || '',
  JEV_MODEL: process.env.JEV_MODEL || 'typesafe/jev',
  JEV_TIMEOUT_MS: 90000,
  DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL || 'deepseek/deepseek-v4.1-flash-fast',
  DEEPSEEK_MAX_TOKENS: Number(process.env.DEEPSEEK_MAX_TOKENS) || 32000,
  // Fast 是重推理模型，单次调用常超过 90s；给到 180s（.env 可调）
  DEEPSEEK_TIMEOUT_MS: Number(process.env.DEEPSEEK_TIMEOUT_MS) || 180000,

  PORT: num('PORT', 3200),
  PAPER_MODE: process.env.PAPER_MODE !== 'false',

  // 交易参数（用户拍板）
  COINS: ['btc', 'eth'],
  WINDOW_SEC: 900, // 15m
  BANKROLL_USD: num('BANKROLL_USD', 200),
  MIN_BET_USD: num('MIN_BET_USD', 1),
  MAX_BET_USD: num('MAX_BET_USD', 10),
  REQUIRED_EDGE: num('REQUIRED_EDGE', 0.08), // Jev概率 − 买入价 ≥ 8%
  LOTTERY_PRICE: num('LOTTERY_PRICE', 0.05), // 低于此价视为彩票区
  LOTTERY_EDGE: num('LOTTERY_EDGE', 0.20), // 彩票区 edge 门槛：尾部概率是模型最测不准的地方，要求 20% 才动手
  DS_REVERSE_BLOCK_CONF: num('DS_REVERSE_BLOCK_CONF', 0.85), // DeepSeek 置信度≥此值时，不许反向买彩票
  EDGE_CONFIRM_HITS: num('EDGE_CONFIRM_HITS', 2), // edge 双重确认：同窗口同方向连续达标 N 次才开仓，过滤闪动报价的幻影 edge
  EVAL_COOLDOWN_MS: num('EVAL_COOLDOWN_MS', 30000), // 上次评估结束后等待 30s
  MIN_SECONDS_LEFT: num('MIN_SECONDS_LEFT', 60), // 剩余不足 60s 不再开新仓
  MAX_BUY_PRICE: num('MAX_BUY_PRICE', 0.92), // 买入价高于此视为结果已定
  EXIT_UNREAL_PCT: num('EXIT_UNREAL_PCT', 0.15), // 浮盈亏 |≥15%| 才触发退出复核
  EXIT_HOLD_PROB: num('EXIT_HOLD_PROB', 0.45), // 持有更优概率 <45% 则卖出

  DATA_DIR: require('path').join(__dirname, '..', 'data'),
  REPORT_PATH: '/home/hatch/workspace/your_files/crypto-polymarket-report.html',
};
