// 静态 HTML 报告：市场名直链 Polymarket 官方盘口；判断明细折进对应行点击展开
const fs = require('fs');
const cfg = require('./config');
const { load } = require('./store');

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const usd = n => (n >= 0 ? '+' : '') + '$' + Number(n).toFixed(2);
const pnlCls = n => n > 0 ? 'pos' : n < 0 ? 'neg' : '';
const tstr = iso => { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`; };
const evUrl = slug => `https://polymarket.com/event/${esc(slug)}`;

// 全页面统一盘口名：BTC 5m-1790869800（11:50–11:55）
// 一律从 slug 时间戳按东八区算窗口，不依赖各进程 TZ 环境
function mktName(slug) {
  const m = /^([a-z]+)-updown-(\d+)m-(\d+)$/.exec(slug || '');
  if (!m) return esc(slug || '—');
  const f = s => {
    const d = new Date((Number(s) + 8 * 3600) * 1000);
    return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
  };
  const start = m[3];
  const winSec = Number(m[2]) * 60;
  return `${m[1].toUpperCase()} ${m[2]}m-${start}（${f(start)}–${f(Number(start) + winSec)}）`;
}

const dsName = d => d === 'up' ? '涨' : d === 'down' ? '跌' : '—';

function judgmentSubTable(judgs) {
  if (!judgs.length) return '';
  const blocks = [];
  const rows = judgs.slice().reverse().map(j => {
    let mioBtn = '—';
    if (j.io) {
      const mid = mioId();
      mioBtn = `<button class="exp2" data-t="${mid}">▸ 输入/输出</button>`;
      blocks.push(mioBlock(mid, j.io));
    }
    const mg = j.mgIdx != null ? `第${j.mgIdx + 1}档 $${j.mgStake}` : '—';
    return `<tr><td><a href="${esc(j.eventUrl || ('https://polymarket.com/event/' + (j.slug || '')))}" target="_blank">${mktName(j.slug)}</a></td><td>${tstr(j.time)}</td><td>${j.secToNextStart != null ? j.secToNextStart + 's' : '—'}</td><td>${j.upBuy != null ? j.upBuy : '—'}</td><td>${j.downBuy != null ? j.downBuy : '—'}</td><td class="${j.dsDirection === 'up' ? 'pos' : j.dsDirection === 'down' ? 'neg' : ''}">${dsName(j.dsDirection)}${j.dsConfidence != null ? ' ' + (j.dsConfidence * 100).toFixed(0) + '%' : ''}</td><td>${j.driftBps != null ? j.driftBps + 'bps·RSI' + j.rsi14 : '—'}</td><td>${mg}</td><td>${j.bet ? '买入' + (j.side === 'up' ? '涨' : '跌') + ' $' + Number(j.stake).toFixed(2) : '跳过'}</td><td class="rs">${esc(j.reason || '')}${j.dsReason ? '<br>DS：' + esc(j.dsReason) : ''}</td><td>${mioBtn}</td></tr>`;
  }).join('');
  return `<div class="dh">📝 判断记录</div><div class="twrap"><table class="sub"><tr><th>预测窗口</th><th>判断时间</th><th>距开盘</th><th>Up买入</th><th>Down买入</th><th>DS方向</th><th>动量</th><th>马丁格</th><th>操作</th><th>原因</th><th>模型</th></tr>${rows}</table></div>${blocks.join('')}`;
}

// 模型 io 二级展开：发给模型的完整输入 + 原始输出，烘焙进 HTML
let mioSeq = 0;
function mioId() { return `mio${++mioSeq}`; }
function mioBlock(mid, io) {
  const secs = [];
  if (io.ds) {
    secs.push(`<div class="mioh">DeepSeek 输入（完整 prompt）</div><pre>${esc(io.ds.prompt || '')}</pre>`);
    if (io.ds.raw) secs.push(`<div class="mioh">DeepSeek 原始返回</div><pre>${esc(io.ds.raw)}</pre>`);
  }
  if (io.failed) {
    secs.push(`<div class="mioh">失败时的输入（未拿到输出）</div><pre>${esc(io.failed.prompt || io.failed.state || '')}</pre>`);
    if (io.failed.raw) secs.push(`<div class="mioh">失败时的原始返回</div><pre>${esc(io.failed.raw)}</pre>`);
  }
  return `<div class="mio" id="${mid}" style="display:none">${secs.join('')}</div>`;
}

function posUnreal(pos, prices) {
  const q = prices[pos.slug];
  if (!q) return null;
  // 持有到期：现价仅供参考（downMid 本就是 Down token 自己的价格，不要再取 1-）
  const px = pos.side === 'up' ? q.upMid : q.downMid;
  if (!Number.isFinite(px)) return null;
  const unreal = pos.shares * px - pos.stake;
  return { px, unreal, unrealPct: unreal / pos.stake, t: q.t };
}

function renderHtml(ledger, prices, opts = {}) {
  const live = opts.live ? ' <span class="tag">LIVE</span>' : '';
  const updated = new Date().toLocaleString('zh-CN', { hour12: false });
  const totalPnl = round2(ledger.wallet - cfg.BANKROLL_USD);
  const settled = ledger.settlements;
  const winN = settled.filter(s => s.win).length;
  const mg = ledger.mg || { btc: 0, eth: 0 };
  const stakes = cfg.MG_STAKES;
  const mgLine = c => `第${(mg[c] || 0) + 1}档 $${stakes[mg[c] || 0]}`;

  const posRows = ledger.positions.map((p, i) => {
    const u = posUnreal(p, prices);
    const judgs = ledger.judgments.filter(j => j.slug === p.slug);
    const detailId = `pd${i}`;
    return `<tr class="mainrow" data-detail="${detailId}">
      <td><a href="${esc(p.eventUrl)}" target="_blank">${mktName(p.slug)}</a></td>
      <td class="${p.side === 'up' ? 'pos' : 'neg'}">${p.side === 'up' ? '涨' : '跌'}</td>
      <td>${p.buyPrice.toFixed(3)}<div class="dim">决策${p.decidePrice != null ? p.decidePrice.toFixed(3) : '—'}</div></td><td>${p.shares.toFixed(1)}</td><td>$${p.stake.toFixed(2)}</td>
      <td>${u ? u.px.toFixed(3) : '—'}</td>
      <td class="${u ? pnlCls(u.unreal) : ''}">${u ? usd(u.unreal) : '—'}</td>
      <td>${tstr(p.buyTime)}</td>
      <td>${p.dsDirection ? dsName(p.dsDirection) + (p.dsConfidence != null ? ' ' + (p.dsConfidence * 100).toFixed(0) + '%' : '') : '—'}</td>
      <td>第${(p.mgIdx || 0) + 1}档 $${p.mgStake}</td>
      <td>${judgs.length ? `<button class="exp" data-t="${detailId}">▸ 判断${judgs.length}</button>` : '—'}</td>
    </tr>
    <tr class="detail" id="${detailId}" style="display:none"><td colspan="11">
      ${judgmentSubTable(judgs)}
    </td></tr>`;
  }).join('');

  const tradeRows = ledger.trades.slice().reverse().slice(0, 80).map(t =>
    `<tr><td>${tstr(t.time)}</td><td>${mktName(t.slug)}</td>
     <td class="${t.side === 'buy' ? 'pos' : ''}">${t.side === 'buy' ? '买入' : '结算'}</td>
     <td>${t.outcome ? (t.outcome === 'up' ? '涨' : '跌') : '—'}</td><td>${t.price}${t.decidePrice != null && t.decidePrice !== t.price ? `<div class="dim">决策${Number(t.decidePrice).toFixed(3)}</div>` : ''}</td><td>${t.shares}</td>
     <td>$${Number(t.stake).toFixed(2)}</td><td class="rs">${esc(t.reason || '')}</td></tr>`).join('');

  const settleRows = settled.slice().reverse().map((s, i) => {
    const judgs = ledger.judgments.filter(j => j.slug === s.slug);
    const detailId = `st${i}`;
    return `<tr class="mainrow" data-detail="${detailId}">
     <td>${tstr(s.time)}</td><td><a href="${esc(s.eventUrl)}" target="_blank">${mktName(s.slug)}</a></td>
     <td>${s.side === 'up' ? '涨' : '跌'}</td><td class="${s.win ? 'pos' : 'neg'}">${s.win ? '命中' : '归零'}</td>
     <td>${s.buyPrice != null ? s.buyPrice.toFixed(3) : '—'}</td>
     <td>$${(s.stake).toFixed(2)}</td><td>$${(s.payout).toFixed(2)}</td>
     <td class="${pnlCls(s.pnl)}">${usd(s.pnl)}</td>
     <td>${s.dsDirection ? dsName(s.dsDirection) + (s.dsConfidence != null ? ' ' + (s.dsConfidence * 100).toFixed(0) + '%' : '') : '—'}</td>
     <td>第${(s.mgBefore || 0) + 1}档→第${(s.mgAfter || 0) + 1}档</td>
     <td>${judgs.length ? `<button class="exp" data-t="${detailId}">▸ 判断${judgs.length}</button>` : '—'}</td></tr>
    <tr class="detail" id="${detailId}" style="display:none"><td colspan="11">
      ${judgmentSubTable(judgs)}
    </td></tr>`;
  }).join('');

  const errRows = ledger.errors.slice().reverse().slice(0, 10).map(e =>
    `<tr><td>${tstr(e.time)}</td><td>${esc(e.where)}</td><td class="rs">${esc(e.message)}</td></tr>`).join('');

  const recentJudgs = ledger.judgments.slice(-100);

  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Polymarket Crypto 5m 模拟盘${live}</title>
<style>
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#0f1420;color:#e6e9f0;margin:0;padding:16px}
h1{font-size:20px;margin:0 0 4px}.tag{background:#2f81f7;border-radius:4px;font-size:11px;padding:2px 6px;vertical-align:middle}
.meta{color:#8b93a7;font-size:12px;margin-bottom:12px}
.cards{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px}
.card{background:#1a2233;border-radius:8px;padding:10px 14px;min-width:120px}
.card .k{font-size:11px;color:#8b93a7}.card .v{font-size:20px;font-weight:700}
.pos{color:#3fb950}.neg{color:#f85149}
h2{font-size:15px;margin:18px 0 8px;color:#c9d1d9}
table{width:100%;border-collapse:collapse;font-size:12px;background:#1a2233;border-radius:8px;overflow:hidden}
th,td{padding:7px 8px;text-align:left;border-bottom:1px solid #2a3348}
th{color:#8b93a7;font-weight:600;background:#161d2e}
tr.mainrow{cursor:pointer}tr.mainrow:hover td{background:#222c44}
a{color:#58a6ff;text-decoration:none}.exp{background:#2a3348;border:0;color:#c9d1d9;border-radius:4px;padding:3px 8px;cursor:pointer;font-size:12px}
.sub{margin:8px 0;background:#141b2c}.dh{font-size:12px;color:#8b93a7;margin:10px 0 4px}
.rs{max-width:340px;word-break:break-word;color:#9aa4b8}
.empty{color:#5c6579;padding:14px;font-size:12px}
.exp2{background:#2a3348;border:0;color:#c9d1d9;border-radius:4px;padding:3px 8px;cursor:pointer;font-size:12px}
.twrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
@media (max-width:640px){
body{padding:10px}
h1{font-size:17px}
.cards{gap:8px;margin-bottom:10px}
.card{padding:8px 10px;min-width:100px;flex:1 1 30%}
.card .v{font-size:17px}
h2{font-size:14px;margin:14px 0 6px}
th,td{padding:8px 6px;font-size:11px;white-space:nowrap}
td.rs{white-space:normal;min-width:120px}
.exp,.exp2{padding:8px 12px;font-size:12px}
.mio pre{font-size:10px}
.dh{font-size:11px}
}
.mio{margin:6px 0 12px;background:#10182a;border-radius:6px;padding:4px 10px 10px}
.mioh{font-size:11px;color:#8b93a7;margin:10px 0 4px}
.mio pre{background:#0b1120;padding:8px;border-radius:4px;font-size:11px;white-space:pre-wrap;word-break:break-word;max-height:320px;overflow:auto;margin:0;color:#c9d1d9}
.dim{font-size:10px;color:#5c6579}
</style></head><body>
<h1>⚡ Polymarket Crypto 5m 模拟盘${live}</h1>
<div class="meta">更新：${updated} · BTC/ETH × 5m · 本金 $${cfg.BANKROLL_USD} · DeepSeek 单模型 · 只买 0.48–0.52 · 持有到期 · PAPER_MODE</div>
<div class="cards">
<div class="card"><div class="k">钱包</div><div class="v">$${ledger.wallet.toFixed(2)}</div></div><div class="card"><div class="k">总盈亏</div><div class="v ${pnlCls(totalPnl)}">${usd(totalPnl)}</div></div>
<div class="card"><div class="k">持仓</div><div class="v">${ledger.positions.length}</div></div>
<div class="card"><div class="k">已结算</div><div class="v">${settled.length}（命中${winN}）</div></div>
<div class="card"><div class="k">BTC 马丁格</div><div class="v">${mgLine('btc')}</div></div>
<div class="card"><div class="k">ETH 马丁格</div><div class="v">${mgLine('eth')}</div></div>
</div>
<h2>📦 持仓（持有到期，点击行展开判断明细）</h2>
${ledger.positions.length ? `<div class="twrap"><table><tr><th>市场</th><th>方向</th><th>买入价</th><th>股数</th><th>投入</th><th>参考现价</th><th>参考浮盈亏</th><th>买入时间</th><th>DS</th><th>马丁格</th><th>明细</th></tr>${posRows}</table></div>` : '<div class="empty">暂无持仓</div>'}
<h2>🏁 结算记录（点击行展开判断明细）</h2>
${settled.length ? `<div class="twrap"><table><tr><th>时间</th><th>市场</th><th>方向</th><th>结果</th><th>买入价</th><th>投入</th><th>收回</th><th>盈亏</th><th>DS</th><th>马丁格</th><th>明细</th></tr>${settleRows}</table></div>` : '<div class="empty">暂无结算</div>'}
<h2>📒 成交记录（近80）</h2>
${ledger.trades.length ? `<div class="twrap"><table><tr><th>时间</th><th>市场</th><th>动作</th><th>方向</th><th>价格</th><th>股数</th><th>金额</th><th>原因</th></tr>${tradeRows}</table></div>` : '<div class="empty">暂无成交</div>'}
${ledger.errors.length ? `<h2>⚠️ 错误（近10）</h2><div class="twrap"><table><tr><th>时间</th><th>位置</th><th>信息</th></tr>${errRows}</table></div>` : ''}
<h2>🕐 最近评估（近100轮，只记预测区）</h2>
${recentJudgs.length ? judgmentSubTable(recentJudgs) : '<div class="empty">暂无评估记录</div>'}
<script>
document.addEventListener('click',e=>{
  const b=e.target.closest('.exp');
  if(b){
    const d=document.getElementById(b.dataset.t);
    const open=d.style.display!=='none';
    d.style.display=open?'none':'table-row';
    b.textContent=(open?'▸ ':'▾ ')+b.textContent.replace(/^[▸▾] /,'');
    return;
  }
  const b2=e.target.closest('.exp2'); if(!b2) return;
  const d2=document.getElementById(b2.dataset.t);
  const open2=d2.style.display!=='none';
  d2.style.display=open2?'none':'block';
  b2.textContent=(open2?'▸ ':'▾ ')+b2.textContent.replace(/^[▸▾] /,'');
});
</script>
</body></html>`;
}

function round2(n) { return Math.round(n * 100) / 100; }

function loadPrices() {
  try { return JSON.parse(fs.readFileSync(require('path').join(cfg.DATA_DIR, 'prices.json'), 'utf8')); }
  catch { return {}; }
}

function buildReport() {
  const ledger = load();
  const html = renderHtml(ledger, loadPrices());
  fs.writeFileSync(cfg.REPORT_PATH, html);
  return cfg.REPORT_PATH;
}

if (require.main === module) {
  console.log(buildReport());
}

module.exports = { renderHtml, buildReport, loadPrices };
