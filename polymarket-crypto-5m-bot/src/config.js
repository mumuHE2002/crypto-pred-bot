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
  DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL || 'deepseek/deepseek-v4.1-flash',
  DEEPSEEK_MAX_TOKENS: Number(process.env.DEEPSEEK_MAX_TOKENS) || 32000,
  DEEPSEEK_TIMEOUT_MS: Number(process.env.DEEPSEEK_TIMEOUT_MS) || 180000,
  // 第二确认模型：Muse Spark 1.3 Contributor（双模型方向一致才下单，用户拍板 2026-10-02）
  MUSE_MODEL: process.env.MUSE_MODEL || 'meta/muse-spark-1.3-contributor',
  MUSE_MAX_TOKENS: Number(process.env.MUSE_MAX_TOKENS) || 16000,
  MUSE_TIMEOUT_MS: Number(process.env.MUSE_TIMEOUT_MS) || 180000,
  HISTORY_WINDOWS: num('HISTORY_WINDOWS', 6), // 喂给模型的历史窗口数（不含当前盘）

  PORT: num('PORT', 3201),
  PAPER_MODE: process.env.PAPER_MODE !== 'false',

  // 交易参数（用户拍板，2026-10-01）
  COINS: ['btc', 'eth', 'sol', 'xrp', 'doge'], // 用户拍板 2026-10-03：加 SOL/XRP/DOGE 扩大机会数
  WINDOW_SEC: 300, // 5m
  BANKROLL_USD: num('BANKROLL_USD', 200),
  MIN_BET_USD: num('MIN_BET_USD', 1),
  PREDICT_AHEAD_SEC: num('PREDICT_AHEAD_SEC', 50), // 当前盘剩余≤50s 时预测下一个盘（用户拍板 2026-10-02）
  PRICE_MIN: num('PRICE_MIN', 0), // 下限放开（用户拍板 2026-10-03：<0.45 偏便宜对我们有利）；只保留上限
  PRICE_MAX: num('PRICE_MAX', 0.55), // 只买 ≤0.55 的价格（用户拍板 2026-10-02，2026-10-03 确认保留）
  DS_MIN_CONF: num('DS_MIN_CONF', 0.57), // DeepSeek 置信度低于此不下单
  // 置信度分档注额（用户拍板 2026-10-02，马丁格已移除）：
  // 0.57–0.60 → $1，0.61–0.70 → $2，≥0.71 → $3
  // 胜率倍投（用户拍板 2026-10-03）：按币种+方向分桶算已结算胜率，<40%→x2，<35%→x3，<30%→x4，
  // 乘在分档注额上；每桶已结算样本不足此数时该桶不激活
  WR_MULT_MIN_SETTLED: num('WR_MULT_MIN_SETTLED', 30),
  EVAL_COOLDOWN_MS: num('EVAL_COOLDOWN_MS', 30000), // 上次评估结束后等待 30s

  DATA_DIR: require('path').join(__dirname, '..', 'data'),
  REPORT_PATH: '/home/hatch/workspace/your_files/crypto-polymarket-5m-report.html',
};
