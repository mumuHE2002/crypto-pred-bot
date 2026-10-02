// 历史窗口数据（喂给模型做趋势/均值回归参考）：
// - 前 N 个已结束窗口：开盘价 vs 窗口内 TWAP → UP/DOWN
// - 当前盘：开盘价 vs 现价 → 当前偏向
// 全部用 Coinbase 1m K 线估算（与官方 Chainlink TWAP 可能有小偏差，仅作模型参考）
const wlabel = (s, windowSec) => {
  const f = x => {
    const d = new Date((x + 8 * 3600) * 1000); // 东八区，与 runner.windowLabel 一致
    return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
  };
  return `${f(s)}–${f(s + windowSec)}`;
};
const fmtPx = p => (p >= 1000 ? p.toFixed(1) : p.toFixed(2));
const bps = (a, b) => (((a / b - 1) * 10000).toFixed(0));

/**
 * @param {Array} candles 1m K 线 [{t(ms),o,h,l,c,v}] 时间升序
 * @param {number} curStartSec 当前窗口起始（秒）
 * @param {number} windowSec 窗口秒数
 * @param {number} n 历史窗口数（不含当前盘）
 * @returns 紧凑文本
 */
function windowHistoryText(candles, curStartSec, windowSec = 300, n = 6) {
  const lines = [];
  for (let i = n; i >= 1; i--) {
    const ws = curStartSec - i * windowSec;
    const w = candles.filter(c => c.t >= ws * 1000 && c.t < (ws + windowSec) * 1000);
    if (w.length === 0) { lines.push(`- ${wlabel(ws, windowSec)}: 数据缺失`); continue; }
    const startPx = w[0].o;
    const twap = w.reduce((a, c) => a + c.c, 0) / w.length;
    const up = twap >= startPx;
    lines.push(`- ${wlabel(ws, windowSec)}: ${up ? 'UP' : 'DOWN'}（开盘 ${fmtPx(startPx)}，TWAP ${fmtPx(twap)}，${bps(twap, startPx)}bps）`);
  }
  const cw = candles.filter(c => c.t >= curStartSec * 1000 && c.t < (curStartSec + windowSec) * 1000);
  if (cw.length > 0) {
    const startPx = cw[0].o;
    const nowPx = cw[cw.length - 1].c;
    const secsLeft = Math.max(0, curStartSec + windowSec - Math.floor(Date.now() / 1000));
    lines.push(`- ${wlabel(curStartSec, windowSec)}（当前盘，还剩约${secsLeft}s）: 开盘 ${fmtPx(startPx)}，现价 ${fmtPx(nowPx)}（${bps(nowPx, startPx)}bps，当前${nowPx >= startPx ? '偏向UP' : '偏向DOWN'}）`);
  }
  return lines.join('\n');
}

module.exports = { windowHistoryText };
