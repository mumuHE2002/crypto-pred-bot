// 带超时的 fetch 工具
async function fetchWithTimeout(url, { timeoutMs = 15000, ...opts } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...opts,
      signal: ctl.signal,
      headers: { 'User-Agent': 'polymarket-crypto-bot/1.0', ...(opts.headers || {}) },
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url, timeoutMs = 15000) {
  const res = await fetchWithTimeout(url, { timeoutMs });
  if (!res.ok) throw new Error(`HTTP ${res.status} ← ${url}`);
  return res.json();
}

module.exports = { fetchWithTimeout, getJson };
