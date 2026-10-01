// DeepSeek V4.1 Flash 分析师：经 commandcode 网关（OpenAI 格式）
// 注意网关不支持 response_format，从文本里解析 JSON；推理模型 max_tokens 给足
const cfg = require('./config');
const { fetchWithTimeout } = require('./http');

function extractJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('DeepSeek 未返回 JSON');
  return JSON.parse(m[0]);
}

/**
 * 分析 15m 窗口的涨跌方向（单次调用）
 * @returns { direction: 'up'|'down'|'neutral', confidence: 0..1, reason, via: 'deepseek' }
 */
async function analyzeOnce({ coin, coinName, windowLabel, secondsLeft, feat, candleText, upBuy, downBuy, upMid, downMid }) {
  if (!cfg.JEV_API_KEY) throw new Error('未配置 JEV_API_KEY（commandcode key）');
  const prompt =
    `You are a crypto momentum analyst for a PAPER-TRADING bot (no real money).\n` +
    `Keep your internal reasoning concise (a few sentences max) and always finish with the JSON answer.\n` +
    `Market: Polymarket "${coinName} Up or Down" 15-minute window ${windowLabel}.\n` +
    `Resolution rule: the market resolves to "Up" if the Chainlink TWAP of ${coinName} over the 15-minute window ` +
    `is GREATER THAN OR EQUAL TO the price at the START of the window; otherwise "Down".\n` +
    `Seconds left in window: ${secondsLeft}.\n` +
    `Current Polymarket executable prices: Up buy=${upBuy.toFixed(3)} / mid=${upMid.toFixed(3)}, ` +
    `Down buy=${downBuy.toFixed(3)} / mid=${downMid.toFixed(3)} (price = market-implied probability).\n` +
    `Spot momentum (Coinbase 1m candles, last ${feat.n} min): drift=${feat.driftBps}bps, ` +
    `per-min volatility=${feat.volBps}bps, range=${feat.rangeBps}bps, RSI14=${feat.rsi14}, last=${feat.last}.\n` +
    `Recent candles (UTC, close, 1m change):\n${candleText}\n` +
    `Task: judge whether the window TWAP is more likely to finish ABOVE/EQUAL (Up) or BELOW (Down) ` +
    `the window-start price. Consider: with little time left, the current spot vs the start price ` +
    `dominates; with more time left, momentum and volatility matter more.\n` +
    `Respond with ONLY a JSON object: {"direction":"up"|"down"|"neutral","confidence":0.0-1.0,"reason":"one sentence"}.`;
  // io 留档：页面可展开看每次发给模型的完整输入和原始输出
  const io = { prompt };
  try {
    const res = await fetchWithTimeout(`${cfg.JEV_API_BASE}/provider/v1/chat/completions`, {
    method: 'POST',
    timeoutMs: cfg.DEEPSEEK_TIMEOUT_MS,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.JEV_API_KEY}`,
    },
    body: JSON.stringify({
      model: cfg.DEEPSEEK_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: cfg.DEEPSEEK_MAX_TOKENS,
      temperature: 0.2,
      // 推理模型会把 budget 先花在 reasoning 上：max_tokens 太小会被吃光导致空 content。
      // 实测 reasoning_effort='low' 未被网关/模型遵守（reasoning 照样烧到 8000），
      // 所以上限给到 32000，保证 reasoning 烧满也有正文预算。按实际用量计费，成本几乎不涨。
      // low 努力保留，万一哪天网关开始遵守还能省一点。
      reasoning_effort: 'low',
    }),
  });
  const rawText = await res.text();
  if (!res.ok) throw new Error(`DeepSeek HTTP ${res.status}：${rawText.slice(0, 200)}`);
  let data;
  try { data = JSON.parse(rawText); } catch { throw new Error(`DeepSeek 返回不是 JSON：${rawText.slice(0, 120)}`); }
  const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  const dbg = `finish=${data.choices && data.choices[0] && data.choices[0].finish_reason}，content_len=${text.length}，reasoning=${JSON.stringify(data.usage && data.usage.completion_tokens_details)}`;
  let j;
  try {
    j = extractJson(text);
  } catch (e) {
    throw new Error(`DeepSeek JSON 解析失败（${dbg}）：${text.slice(0, 300)}`);
  }
  const direction = ['up', 'down', 'neutral'].includes(j.direction) ? j.direction : 'neutral';
  const confidence = Math.max(0, Math.min(1, Number(j.confidence) || 0));
  io.raw = String(text).slice(0, 6000);
  return { direction, confidence, reason: String(j.reason || '').slice(0, 300), via: 'deepseek', io };
  } catch (e) {
    e._io = io; // 失败也把 prompt 留给调用方存档
    throw e;
  }
}

/**
 * 带一次重试的分析：Fast 是推理模型，间歇性把 token 预算烧光返回空内容
 * （finish=length），这种 JSON 失败重试一次往往就能成功；其他硬错误不重试
 */
async function analyze(args) {
  try {
    return await analyzeOnce(args);
  } catch (e) {
    const msg = String((e && e.message) || e);
    // 本地超时掐断（abort）也重试一次：推理模型间歇性慢，>90s 会被自家超时杀掉
    if (/JSON|未返回|解析失败|length|abort|aborted|超时|timeout/i.test(msg)) {
      console.error(`[deepseek] 首次调用失败，重试一次：${msg.slice(0, 120)}`);
      return await analyzeOnce(args);
    }
    throw e;
  }
}

module.exports = { analyze };
