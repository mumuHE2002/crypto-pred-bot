// 5m 盘双模型分析师：DeepSeek V4.1 Flash + Muse Spark 1.3 Contributor
// 经 commandcode 网关（OpenAI 格式）。注意网关不支持 response_format，从文本里解析 JSON；
// 两个都是推理模型，max_tokens 给足（reasoning 会先烧 budget）。
const cfg = require('./config');
const { fetchWithTimeout } = require('./http');

function extractJson(text, tag) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`${tag} 未返回 JSON`);
  return JSON.parse(m[0]);
}

function buildPrompt({ coin, coinName, windowLabel, secondsLeft, feat, candleText, windowHistoryText, upBuy, downBuy, upMid, downMid }) {
  return (
    `You are a crypto momentum analyst for a PAPER-TRADING bot (no real money).\n` +
    `Keep your internal reasoning concise (a few sentences max) and always finish with the JSON answer.\n` +
    `Market: Polymarket "${coinName} Up or Down" 5-minute window ${windowLabel} — this is the NEXT window, starting in about ${secondsLeft} seconds.\n` +
    `Resolution rule: the market resolves to "Up" if the Chainlink TWAP of ${coinName} over the 5-minute window ` +
    `is GREATER THAN OR EQUAL TO the price at the START of the window; otherwise "Down".\n` +
    `The window has NOT started yet. Its start price will be close to the current spot price.\n` +
    `Seconds until the window starts: ${secondsLeft}.\n` +
    `Current Polymarket executable prices: Up buy=${upBuy.toFixed(3)} / mid=${upMid.toFixed(3)}, ` +
    `Down buy=${downBuy.toFixed(3)} / mid=${downMid.toFixed(3)} (price = market-implied probability).\n` +
    `Spot momentum (Coinbase 1m candles, last ${feat.n} min): drift=${feat.driftBps}bps, ` +
    `per-min volatility=${feat.volBps}bps, range=${feat.rangeBps}bps, RSI14=${feat.rsi14}, last=${feat.last}.\n` +
    `Recent candles (UTC, close, 1m change):\n${candleText}\n` +
    (windowHistoryText
      ? `Recent 5-minute windows, Coinbase spot (TWAP vs window-start price; labels +08:00; Chainlink TWAP may differ slightly, use as context only):\n${windowHistoryText}\n`
      : ``) +
    `Task: judge whether the coming 5-minute window is more likely to resolve Up (TWAP at/above its start price) ` +
    `or Down (TWAP below its start price). The start price is ~the current spot, so your call is essentially: ` +
    `will ${coinName} drift UP or DOWN over the next 5 minutes? Use the recent momentum, trend persistence ` +
    `(do recent windows keep resolving the same way?), mean-reversion signals, and RSI — but do NOT overfit ` +
    `to the last 1-2 candles; answer "neutral" if there is no clear lean.\n` +
    `Respond with ONLY a JSON object: {"direction":"up"|"down"|"neutral","confidence":0.0-1.0,"reason":"one sentence"}.`
  );
}

/**
 * 单次模型调用
 * @returns { direction: 'up'|'down'|'neutral', confidence: 0..1, reason, via, io: {prompt, raw} }
 */
async function callOnce({ model, maxTokens, timeoutMs, tag, via, prompt }) {
  if (!cfg.JEV_API_KEY) throw new Error('未配置 JEV_API_KEY（commandcode key）');
  const io = { prompt };
  try {
    const res = await fetchWithTimeout(`${cfg.JEV_API_BASE}/provider/v1/chat/completions`, {
      method: 'POST',
      timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.JEV_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature: 0.2,
        // 推理模型会把 budget 先花在 reasoning 上：max_tokens 太小会被吃光导致空 content。
        // 实测 reasoning_effort='low' 未被网关/模型遵守（reasoning 照样烧几千 token），
        // 所以上限给足，保证 reasoning 烧完也有正文预算。按实际用量计费，成本几乎不涨。
        reasoning_effort: 'low',
      }),
    });
    const rawText = await res.text();
    if (!res.ok) throw new Error(`${tag} HTTP ${res.status}：${rawText.slice(0, 200)}`);
    let data;
    try { data = JSON.parse(rawText); } catch { throw new Error(`${tag} 返回不是 JSON：${rawText.slice(0, 120)}`); }
    const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    const dbg = `finish=${data.choices && data.choices[0] && data.choices[0].finish_reason}，content_len=${text.length}，reasoning=${JSON.stringify(data.usage && data.usage.completion_tokens_details)}`;
    let j;
    try {
      j = extractJson(text, tag);
    } catch (e) {
      throw new Error(`${tag} JSON 解析失败（${dbg}）：${text.slice(0, 300)}`);
    }
    const direction = ['up', 'down', 'neutral'].includes(j.direction) ? j.direction : 'neutral';
    const confidence = Math.max(0, Math.min(1, Number(j.confidence) || 0));
    io.raw = String(text).slice(0, 6000);
    return { direction, confidence, reason: String(j.reason || '').slice(0, 300), via, io };
  } catch (e) {
    e._io = io; // 失败也把 prompt 留给调用方存档
    throw e;
  }
}

/**
 * 带一次重试的分析：推理模型间歇性把 token 预算烧光返回空内容
 * （finish=length），这种 JSON 失败重试一次往往就能成功；其他硬错误不重试
 */
async function analyzeWithRetry({ model, maxTokens, timeoutMs, tag, via, args }) {
  const prompt = buildPrompt(args);
  const call = () => callOnce({ model, maxTokens, timeoutMs, tag, via, prompt });
  try {
    return await call();
  } catch (e) {
    const msg = String((e && e.message) || e);
    // 本地超时掐断（abort）也重试一次：推理模型间歇性慢，会被自家超时杀掉
    if (/JSON|未返回|解析失败|length|abort|aborted|超时|timeout/i.test(msg)) {
      console.error(`[${tag}] 首次调用失败，重试一次：${msg.slice(0, 120)}`);
      return await call();
    }
    throw e;
  }
}

/** DeepSeek V4.1 Flash 分析 */
function analyze(args) {
  return analyzeWithRetry({
    model: cfg.DEEPSEEK_MODEL, maxTokens: cfg.DEEPSEEK_MAX_TOKENS,
    timeoutMs: cfg.DEEPSEEK_TIMEOUT_MS, tag: 'deepseek', via: 'deepseek', args,
  });
}

/** Muse Spark 1.3 Contributor 分析（第二确认模型） */
function analyzeMuse(args) {
  return analyzeWithRetry({
    model: cfg.MUSE_MODEL, maxTokens: cfg.MUSE_MAX_TOKENS,
    timeoutMs: cfg.MUSE_TIMEOUT_MS, tag: 'muse', via: 'muse', args,
  });
}

module.exports = { analyze, analyzeMuse, buildPrompt };
