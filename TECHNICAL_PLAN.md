# Big A Radar 个人A股热点量化平台技术方案

## 1. 建设目标

平台面向个人研究，接入历史行情、实时行情、公告、政策与财经新闻，持续输出：

- 盘中、1—3日、5—10日三个周期的热点题材排名；
- 题材下候选股票、催化强度、交易确认度及风险；
- 从原始新闻到题材、公司和盘面确认的证据链；
- 可回放、可复盘、无未来数据污染的模型结果。

第一阶段仅做研究、告警与模拟，不直接连接真实账户。

## 2. 设计原则

1. **供应商可替换**：Wind、Choice、Tushare等通过统一适配器接入，业务层不依赖厂商字段。
2. **研究与交易隔离**：模型产生候选信号，执行端必须经过独立风控；前期不实现自动下单。
3. **原始证据不可变**：保存原文、来源、首次发布时间、采集时间及内容哈希。
4. **时点正确**：回测只能读取当时已经公开的数据，财报、概念成分和公司关系均保存有效期。
5. **解释来自证据**：大模型负责抽取和表述，不凭自身知识生成不存在的公司关系。

## 3. 总体架构

```text
数据供应商层
├── 历史/实时行情：Tushare → Wind/Choice（可升级）
├── 公告：交易所/巨潮资讯/授权供应商
├── 新闻：授权实时快讯、政府网站、公司公告
└── 基本面：财务、主营构成、行业、概念、产业链
        │
        ▼
采集与标准化层
├── provider adapters（字段、代码、时区、复权统一）
├── 去重、内容哈希、源可信度和延迟监控
└── 原始数据落盘（只追加，不覆盖）
        │
        ▼
事件智能层
├── 实体识别：公司、产品、技术、政策主体
├── 事件分类：政策/订单/涨价/扩产/业绩/风险等
├── 新颖度与传播速度
└── 题材—产业链—股票知识图谱
        │
        ▼
信号与研究层
├── 历史相似事件与事件研究
├── 题材热点评分
├── 候选股排序
├── 盘面确认与风险过滤
└── walk-forward回测、归因、模型版本管理
        │
        ▼
服务层
├── FastAPI查询API
├── Redis实时快照/发布订阅
├── WebSocket或SSE推送
└── 定时任务与数据质量告警
        │
        ▼
React个人看板（当前项目）
```

## 4. 推荐组件

| 环节 | MVP | 后续升级 | 说明 |
|---|---|---|---|
| 日线/财务 | Tushare | Wind或Choice | 用统一适配器屏蔽差异 |
| 分钟行情 | Tushare实时分钟 | 授权L1/L2 | MVP按1分钟刷新 |
| 新闻/公告 | 授权快讯+官方公告 | Wind/Choice资讯 | 禁止用不稳定网页爬虫作为生产主源 |
| 批量计算 | Polars/Pandas | DolphinDB | 数据量未到瓶颈前不引入重平台 |
| 历史存储 | Parquet + DuckDB | ClickHouse/DolphinDB | Parquet保存行情分区 |
| 业务存储 | PostgreSQL | PostgreSQL | 保存事件、关系、信号与版本 |
| 实时状态 | Redis | Redis Streams | 看板读取最新快照 |
| 模型 | 规则分 + LightGBM | 排序集成模型 | 大模型仅做事件抽取和解释 |
| 回测 | 自建事件研究 | Ricequant交叉验证 | 两套回测结果互相校验 |
| 执行 | 无 | QMT/PTrade | 与研究服务物理隔离 |

## 5. 服务拆分

个人部署初期采用模块化单体，避免过早微服务化：

```text
backend/
├── adapters/       # tushare、wind、choice、announcement、news
├── ingestion/      # 定时采集、实时订阅、重试和质量检查
├── normalization/  # 股票代码、交易日、复权、字段标准化
├── intelligence/   # 事件抽取、聚类、实体链接、知识图谱
├── features/       # 行情、资金、新闻、基本面特征
├── scoring/        # 题材及股票评分
├── backtest/       # 时点回测、事件研究、归因
├── api/            # FastAPI REST + SSE
└── jobs/           # 盘前、盘中、盘后任务
```

数据量和运维复杂度上升后，再独立拆出采集服务和实时特征服务。

## 6. 核心数据模型

### news_document

- `id`, `provider`, `source_name`, `source_url`
- `published_at`, `first_seen_at`, `ingested_at`
- `title`, `content`, `content_hash`, `language`
- `credibility_level`, `is_official`, `raw_payload_uri`

### market_event

- `id`, `event_type`, `direction`, `status`, `event_time`
- `novelty_score`, `impact_score`, `confidence`
- `summary`, `structured_facts`, `model_version`
- `source_document_ids`

### entity_relation

- `subject_id`, `predicate`, `object_id`
- `evidence_document_id`, `effective_from`, `effective_to`
- `business_exposure`, `confidence`, `verified_by`

### theme_signal / stock_signal

- `as_of`, `horizon`, `theme_id`或`symbol`
- `score`, `catalyst_score`, `market_confirmation`
- `crowding_penalty`, `risk_flags`, `rank`
- `reason_facts`, `counter_evidence`, `model_version`

所有信号必须带 `as_of` 和 `model_version`，保证历史复现。

## 7. 评分流程

### 题材分

```text
20% 新闻新颖度 + 15% 来源可信度 + 15% 影响强度
+ 15% 传播加速度 + 15% 成交异常 + 10% 上涨广度
+ 10% 龙头强度 - 拥挤/退潮惩罚
```

### 个股分

```text
25% 业务相关度 + 15% 受益弹性 + 15% 历史龙头属性
+ 15% 量价确认 + 10% 相对板块强度 + 10% 流动性
+ 10% 基本面质量 - 风险惩罚
```

分数需要按市场状态校准，不直接解释为上涨概率。机器学习阶段采用按日期滚动训练的LightGBM Ranker，并以Precision@K、NDCG、未来热度排名和可交易超额收益共同评估。

## 8. 实时任务编排

| 时间 | 任务 |
|---|---|
| 07:00—09:00 | 拉取隔夜政策、公告和新闻；生成盘前候选 |
| 09:15—09:25 | 加入集合竞价和板块广度验证 |
| 09:30—15:00 | 新闻事件触发；行情每1分钟更新；热点每1—5分钟重排 |
| 15:05—16:00 | 固化当日信号、归因和异常记录 |
| 18:00后 | 更新财务、公告、关系图谱和训练样本 |

任务使用交易日历驱动，并为每个供应商设置超时、指数退避、熔断和延迟告警。

## 9. 看板接口契约

建议REST用于首屏，SSE用于增量更新：

```text
GET /api/v1/dashboard?as_of=latest&horizon=1d
GET /api/v1/themes/{theme_id}
GET /api/v1/stocks/{symbol}/evidence
GET /api/v1/model-runs/{run_id}/metrics
GET /api/v1/health/sources
GET /api/v1/stream/signals        # SSE
```

首屏响应：

```json
{
  "asOf": "2026-08-30T10:26:18+08:00",
  "marketState": { "label": "主题扩散", "riskAppetite": 72 },
  "summary": { "highConfidenceThemes": 4, "events30m": 127, "confirmationRate": 0.68 },
  "themes": [],
  "stocks": [],
  "evidence": [],
  "dataQuality": { "status": "healthy", "delayedSources": [] }
}
```

前端只消费规范化接口，不持有供应商密钥，也不直接请求行情供应商。

## 10. 数据安全与授权

- 供应商密钥仅保存在后端环境变量或本机密钥链；
- 原始新闻内容的存储、展示和再分发遵循采购合同；
- 前端默认展示摘要与原文链接，不整篇复制受版权保护内容；
- 日志脱敏，不记录密钥、账户号和完整请求头；
- 未来接入QMT/PTrade时，研究服务只有“发布信号”权限，不能直接取得交易凭据；
- API默认绑定本机，远程访问时再增加认证、TLS和访问审计。

## 11. 回测及上线门槛

上线前必须检查：新闻真实发布时间、财务公告时间、历史股票池、退市股、当时概念成分、复权、涨跌停不可成交、停牌、手续费和滑点。

阶段门槛：

1. 离线回测不少于三个市场状态；
2. 滚动样本外结果显著优于随机和简单动量基线；
3. 实时影子运行至少4—8周；
4. 数据延迟、缺失或模型异常时自动降级为“不出信号”；
5. 进入实盘前另行设计账户级限额和人工熔断。

## 12. 交付路线

### M0：当前骨架

- React本地看板；
- 真实业务结构的模拟数据；
- 热点周期切换和候选股详情交互；
- 本技术方案与接口契约。
- 每次运行生成四类JSON并按日期/时刻永久归档；
- 前端历史批次选择和四个完整Tab；
- 每日15:35本地定时流水线。

### M1：数据闭环（2—3周）

- Tushare适配器、交易日历、日线/分钟/财务入库；
- 新闻及公告原始库；
- FastAPI首屏接口；
- 前端替换模拟数据并显示数据延迟。

### M2：事件与回测（3—5周）

- 事件抽取、题材聚类、实体链接；
- 题材—公司关系库；
- 规则评分和无穿越事件回测；
- 证据溯源和模型复盘页。

### M3：实时影子运行（4—8周观察）

- SSE实时推送；
- 盘前/盘中/盘后任务；
- 数据质量、模型漂移和运行告警；
- Ricequant等平台交叉回测。

### M4：可选执行层

- QMT或PTrade信号桥接；
- 模拟账户、订单状态、账户级风控；
- 小资金实盘需要单独评审，不属于当前范围。
