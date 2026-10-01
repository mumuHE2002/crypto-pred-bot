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
  // 模型网关（沿用 commandcode key，只用 DeepSeek，不用 Jev）
  JEV_API_BASE: (process.env.JEV_API_BASE || 'https://api.commandcode.ai').replace(/\/+$/, ''),
  JEV_API_KEY: process.env.JEV_API_KEY || '',
  DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL || 'deepseek/deepseek-v4.1-flash-fast',
  DEEPSEEK_MAX_TOKENS: Number(process.env.DEEPSEEK_MAX_TOKENS) || 32000,
  DEEPSEEK_TIMEOUT_MS: Number(process.env.DEEPSEEK_TIMEOUT_MS) || 180000,

  PORT: num('PORT', 3201),
  PAPER_MODE: process.env.PAPER_MODE !== 'false',

  // 交易参数（用户拍板，2026-10-01）
  COINS: ['btc', 'eth'],
  WINDOW_SEC: 300, // 5m
  BANKROLL_USD: num('BANKROLL_USD', 200),
  MIN_BET_USD: num('MIN_BET_USD', 1),
  PREDICT_AHEAD_SEC: num('PREDICT_AHEAD_SEC', 120), // 当前盘剩余≤120s 时预测下一个盘
  PRICE_MIN: num('PRICE_MIN', 0.48), // 只买 0.48–0.52 的价格
  PRICE_MAX: num('PRICE_MAX', 0.52),
  DS_MIN_CONF: num('DS_MIN_CONF', 0.57), // DeepSeek 置信度低于此不下单
  // 置信度分档注额（用户拍板 2026-10-02，马丁格已移除）：
  // 0.57–0.60 → $1，0.61–0.70 → $2，≥0.71 → $3
  EVAL_COOLDOWN_MS: num('EVAL_COOLDOWN_MS', 30000), // 上次评估结束后等待 30s

  DATA_DIR: require('path').join(__dirname, '..', 'data'),
  REPORT_PATH: '/home/hatch/workspace/your_files/crypto-polymarket-5m-report.html',
};
