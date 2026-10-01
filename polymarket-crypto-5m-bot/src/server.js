// 面板 :3201（与静态报告同一套模板，每次请求实时渲染）
const http = require('http');
const cfg = require('./config');
const { load } = require('./store');
const { renderHtml, loadPrices } = require('./report');

function json(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/') {
      const html = renderHtml(load(), loadPrices(), { live: true });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    const ledger = load();
    if (url.pathname === '/api/status') return json(res, {
      wallet: ledger.wallet, positions: ledger.positions.length,
      trades: ledger.trades.length, settlements: ledger.settlements.length,
      judgments: ledger.judgments.length, errors: ledger.errors.slice(-5),
      time: new Date().toISOString(),
    });
    if (url.pathname === '/api/positions') return json(res, ledger.positions);
    if (url.pathname === '/api/trades') return json(res, ledger.trades.slice(-100));
    if (url.pathname === '/api/judgments') return json(res, ledger.judgments.slice(-100));
    if (url.pathname === '/api/settlements') return json(res, ledger.settlements.slice(-100));
    if (url.pathname === '/api/equity') return json(res, ledger.equityCurve);
    if (url.pathname === '/api/prices') return json(res, loadPrices());
    res.writeHead(404); res.end('not found');
  } catch (e) {
    res.writeHead(500); res.end(String(e.message || e));
  }
});

if (require.main === module) {
  server.listen(cfg.PORT, () => console.log(`panel :${cfg.PORT}`));
}
module.exports = server;
