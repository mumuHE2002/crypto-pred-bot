# polymarket-crypto-bot

Polymarket 加密货币 15 分钟涨跌（Up/Down）预测模拟交易机器人。

- 标的：BTC / ETH × 15m（slug 可直接算出：`{btc|eth}-updown-15m-{整15分钟时间戳}`）
- 模型：DeepSeek V4.1 Flash（分析师）+ Jev（概率校准），走 commandcode 网关
- 每盘独立循环：上一次评估结束后 30 秒再评估（不是固定 30 秒整点循环）
- 模拟交易（PAPER_MODE=true），本金 $200，单笔 $1–10，edge ≥ 8% 才下注
- 盘中可按 CLOB 卖出价提前止盈/止损（真实模拟执行）；到期按链上结算 1/0 自动结算
- 面板：http://localhost:3200；静态报告：`~/workspace/your_files/crypto-polymarket-report.html`

## 运行

```bash
npm start    # 主循环（每币种独立 30s 评估 + 结算轮询）
npm run server  # 面板 :3200
```

`.env` 不进仓库（key 沿用天气机器人那份 commandcode key）。
