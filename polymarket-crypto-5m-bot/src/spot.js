// Coinbase 现货 K 线（信号输入；Binance 在此出口被地域封）
const { getJson } = require('./http');

const PRODUCT = { btc: 'BTC-USD', eth: 'ETH-USD', sol: 'SOL-USD', xrp: 'XRP-USD', doge: 'DOGE-USD' };

/** 取最近 n 根 1 分钟 K 线 → [{t, o, h, l, c, v}]（时间升序） */
async function fetchCandles(coin, n = 30) {
  const product = PRODUCT[coin];
  if (!product) throw new Error(`未知币种 ${coin}`);
  const end = new Date();
  const start = new Date(end.getTime() - n * 65 * 1000);
  const url = `https://api.exchange.coinbase.com/products/${product}/candles?start=${start.toISOString()}&end=${end.toISOString()}&granularity=60`;
  const raw = await getJson(url, 15000);
  if (!Array.isArray(raw) || raw.length === 0) throw new Error(`Coinbase 无 K 线 ${product}`);
  return raw
    .map(c => ({ t: c[0] * 1000, l: c[1], h: c[2], o: c[3], c: c[4], v: c[5] }))
    .sort((a, b) => a.t - b.t)
    .slice(-n);
}

/** 从 K 线算动量特征（给模型看的摘要） */
function features(candles) {
  const closes = candles.map(c => c.c);
  const rets = [];
  for (let i = 1; i < closes.length; i++) rets.push((closes[i] / closes[i - 1] - 1) * 10000); // bps
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length || 1));
  const last = closes[closes.length - 1];
  const first = closes[0];
  const driftBps = ((last / first - 1) * 10000);
  const hi = Math.max(...closes), lo = Math.min(...closes);
  // 简易 RSI(14)
  const k = 14;
  let g = 0, l = 0;
  const tail = rets.slice(-k);
  for (const r of tail) { if (r > 0) g += r; else l -= r; }
  const rsi = l === 0 ? 100 : 100 - 100 / (1 + (g / k) / (l / k));
  return {
    last, driftBps: round2(driftBps),
    volBps: round2(sd),           // 每分钟波动（bps）
    rangeBps: round2(((hi / lo - 1) * 10000)),
    rsi14: round2(rsi),
    n: candles.length,
  };
}
function round2(x) { return Math.round(x * 100) / 100; }

/** 给模型的紧凑 K 线文本（最近 n 根：时间 HH:MM + 收盘 + bps 涨跌） */
function candlesText(candles, n = 15) {
  return candles.slice(-n).map(c => {
    const d = new Date(c.t);
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    const prev = candles[candles.indexOf(c) - 1];
    const chg = prev ? (((c.c / prev.c - 1) * 10000).toFixed(1) + 'bps') : '—';
    return `${hh}:${mm} c=${c.c} (${chg})`;
  }).join('\n');
}

module.exports = { PRODUCT, fetchCandles, features, candlesText };
