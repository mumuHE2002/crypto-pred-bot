# polymarket-crypto-5m-bot

Polymarket BTC/ETH 5m Up/Down 模拟交易机器人（与 15m 版完全隔离）。

- 当前盘剩余 ≤120s 时预测**下一个** 5m 窗口
- 只用 DeepSeek 给方向（不看 Jev，不算 edge）
- 只买 0.48–0.52 的价格，价格不合适不买
- 中途不卖出，持有到期按 1/0 结算
- 马丁格注额：$1 → 输 $3 → 输 $9 → 输回 $1；BTC/ETH 各自独立
- 买入按订单簿逐档真实撮合

面板：http://localhost:3201
静态报告：~/workspace/your_files/crypto-polymarket-5m-report.html
