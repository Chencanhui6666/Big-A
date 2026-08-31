# Big A Radar

个人A股热点量化看板。当前版本为本地React原型，使用贴近真实接口结构的模拟数据，暂不连接行情供应商或真实交易账户。

详细架构、数据模型、接口契约和实施路线见 [TECHNICAL_PLAN.md](./TECHNICAL_PLAN.md)。

## 本地运行

项目要求 Node.js 22.13 或更高版本。

```bash
npm install
npm run dev
```

默认地址为 `http://localhost:3000`。

## 当前页面

- 盘中、1—3日、5—10日预测周期切换；
- 热点题材排名及催化摘要；
- 题材传播强度；
- 候选股票及可解释评分；
- 新闻证据链和数据源健康度。
- 四个左侧Tab均可切换；
- 可按日期和运行批次读取本地历史JSON快照。

## 数据流水线

```bash
npm run pipeline
```

每次运行会写入：

- `public/data/snapshots/YYYY-MM-DD/HH-mm-ss/`：永久历史快照；
- `public/data/latest/`：最近一次完整数据；
- `public/data/index.json`：供前端历史选择器读取的索引；
- `public/data/manifest.json`：当前批次状态与文件映射。

流水线采用临时文件加重命名的方式更新JSON，失败时不会写入半截文件。目前数据提供器仍为演示实现，后续接入Tushare、Wind或Choice适配器后替换数据采集环节。

模拟盘使用独立的 `portfolio.json` 保存纯模型账户、人工增强账户、持仓、订单、成交、净值和下一交易日计划。15:35产生的研究信号只允许进入下一交易日计划，不使用当日收盘价倒推成交。

### 每日收盘模拟与复盘流程

1. 收盘后先运行 `npm run pipeline:carry-symbols`，导出待执行计划、现有持仓和未完成 1/3 日结算信号所需的报价代码。
2. Longbridge 全市场扫描和热点深度报价完成后，额外获取这份清单的精确报价；保留提供方时间戳，并写入 `provider-data/longbridge-latest.json` 的 `carryQuotes`。
3. 仅当 CN 市场为 `Closed` 且主报价、`carryQuotes` 都完整带时间戳时运行 `npm run pipeline:real`。
4. 管道将前一交易日计划按本交易日开盘价（加滑点和手续费）模拟成交，再按本交易日收盘价估值；缺报价会记录 `SKIPPED`，不会静默丢弃。
5. 收盘信号写入 `review.json` 的 `dailySignalReview`，在后续收盘以“下一交易日开盘入场”的口径结算 1 日和 3 日表现。
6. 所有数据与归档校验通过后，提交本次流程代码、provider input、`public/data/latest`、`manifest.json`、`index.json` 和新快照目录，并推送当前分支；校验失败时不得提交或推送。

页面中的证券、价格、分数和事件均为演示数据，不构成投资建议。
