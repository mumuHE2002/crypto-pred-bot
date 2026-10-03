// Polymarket 15m Up/Down 市场层
// slug 可直接算出：{btc|eth}-updown-15m-{整15分钟unix时间戳}，无需搜索
const cfg = require('./config');
const { getJson } = require('./http');

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';

const COIN_NAME = { btc: 'Bitcoin', eth: 'Ethereum', sol: 'Solana', xrp: 'XRP', doge: 'Dogecoin' };

function bucketStart(tsSec = Math.floor(Date.now() / 1000), windowSec = cfg.WINDOW_SEC) {
  return Math.floor(tsSec / windowSec) * windowSec;
}
function slugFor(coin, startSec, windowSec = cfg.WINDOW_SEC) {
  const tag = windowSec === 900 ? '15m' : `${windowSec / 60}m`;
  return `${coin}-updown-${tag}-${startSec}`;
}
function eventUrl(slug) {
  return `https://polymarket.com/event/${slug}`;
}

function parseTokens(market) {
  let outcomes = market.outcomes;
  let prices = market.outcomePrices;
  let tids = market.clobTokenIds;
  try { if (typeof outcomes === 'string') outcomes = JSON.parse(outcomes); } catch {}
  try { if (typeof prices === 'string') prices = JSON.parse(prices); } catch {}
  try { if (typeof tids === 'string') tids = JSON.parse(tids); } catch {}
  const upIdx = outcomes.findIndex(o => String(o).toLowerCase() === 'up');
  const downIdx = outcomes.findIndex(o => String(o).toLowerCase() === 'down');
  return {
    upIdx, downIdx,
    upToken: upIdx >= 0 ? tids[upIdx] : null,
    downToken: downIdx >= 0 ? tids[downIdx] : null,
    upPrice: upIdx >= 0 ? Number(prices[upIdx]) : NaN,   // last trade
    downPrice: downIdx >= 0 ? Number(prices[downIdx]) : NaN,
  };
}

/** 取指定窗口起始时间的市场（含 token 与盘口价）；盘口不存在返回 null */
async function fetchMarketAt(coin, startSec, windowSec = cfg.WINDOW_SEC) {
  const slug = slugFor(coin, startSec, windowSec);
  const end = startSec + windowSec;
  let ev;
  try {
    const data = await getJson(`${GAMMA}/events?slug=${slug}`, 15000);
    if (!Array.isArray(data) || data.length === 0) return null;
    ev = data[0];
  } catch (e) {
    return { error: String(e.message || e), slug, start: startSec, end };
  }
  const market = (ev.markets || [])[0];
  if (!market) return { error: 'no markets in event', slug, start: startSec, end };
  const t = parseTokens(market);
  return {
    coin, slug, title: ev.title || market.question, start: startSec, end,
    secondsLeft: end - Math.floor(Date.now() / 1000),
    eventUrl: eventUrl(slug),
    closed: !!market.closed,
    umaStatus: market.umaResolutionStatus || null,
    upToken: t.upToken, downToken: t.downToken,
    upLast: t.upPrice, downLast: t.downPrice,
    volume: Number(market.volume) || 0,
    liquidity: Number(market.liquidity) || 0,
    raw: market,
  };
}

/** 取当前窗口的市场（含 token 与盘口价）；盘口不存在返回 null */
async function fetchCurrentMarket(coin) {
  const nowSec = Math.floor(Date.now() / 1000);
  const start = bucketStart(nowSec);
  return fetchMarketAt(coin, start);
}

/** CLOB 可成交价：side=buy 为你买入时付的价，side=sell 为你卖出时得的价 */
async function clobPrice(tokenId, side) {
  const d = await getJson(`${CLOB}/price?token_id=${tokenId}&side=${side}`, 12000);
  const p = Number(d && d.price);
  if (!Number.isFinite(p)) throw new Error(`CLOB 无报价 ${side} ${String(tokenId).slice(0, 10)}`);
  return p;
}
async function clobMid(tokenId) {
  const d = await getJson(`${CLOB}/midpoint?token_id=${tokenId}`, 12000);
  const p = Number(d && d.mid);
  return Number.isFinite(p) ? p : NaN;
}

/** 取某 slug 的结算状态：closed + outcomePrices 1/0 */
async function fetchSettlement(slug) {
  const data = await getJson(`${GAMMA}/events?slug=${slug}`, 15000);
  if (!Array.isArray(data) || data.length === 0) return { found: false };
  const market = (data[0].markets || [])[0];
  if (!market) return { found: false };
  const t = parseTokens(market);
  return {
    found: true,
    closed: !!market.closed,
    umaStatus: market.umaResolutionStatus || null,
    upWon: t.upPrice === 1,
    downWon: t.downPrice === 1,
    upPrice: t.upPrice, downPrice: t.downPrice,
  };
}

module.exports = {
  GAMMA, CLOB, COIN_NAME,
  bucketStart, slugFor, eventUrl,
  fetchCurrentMarket, fetchMarketAt, fetchSettlement,
  clobPrice, clobMid,
};
