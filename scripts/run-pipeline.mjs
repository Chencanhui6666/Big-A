import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataRoot = join(projectRoot, 'public', 'data');
const latestRoot = join(dataRoot, 'latest');

const arg = process.argv.find((item) => item.startsWith('--as-of='));
const asOf = arg ? new Date(arg.slice('--as-of='.length)) : new Date();
if (Number.isNaN(asOf.getTime())) throw new Error('Invalid --as-of date');
const providerArg = process.argv.find((item) => item.startsWith('--provider-input='));
let providerInput = null;
if (providerArg) {
  const providerPath = join(projectRoot, providerArg.slice('--provider-input='.length));
  providerInput = JSON.parse(await readFile(providerPath, 'utf8'));
  if (providerInput.provider !== 'longbridge') throw new Error('Unsupported provider input');
  if (!providerInput.capturedAt || !Array.isArray(providerInput.quotes) || providerInput.quotes.length < 4) {
    throw new Error('Longbridge input is incomplete');
  }
}

let trainedModel = null;
try {
  trainedModel = JSON.parse(await readFile(join(projectRoot, 'model', 'one-year-ridge-v0.1.0.json'), 'utf8'));
} catch {}
let optimizationExperiment = null;
try {
  optimizationExperiment = JSON.parse(await readFile(join(projectRoot, 'model', 'one-year-stable-rule-v0.3.0.json'), 'utf8'));
} catch {}
const optimizationAudit = optimizationExperiment?.metrics?.audit ?? optimizationExperiment?.metrics?.test ?? null;
let candlestickDecisionTree = null;
try {
  candlestickDecisionTree = JSON.parse(await readFile(join(projectRoot, 'model', 'candlestick-decision-tree-v0.4.0.json'), 'utf8'));
} catch {}

const shanghaiParts = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
}).formatToParts(asOf).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});

const tradeDate = `${shanghaiParts.year}-${shanghaiParts.month}-${shanghaiParts.day}`;
const runTime = `${shanghaiParts.hour}-${shanghaiParts.minute}-${shanghaiParts.second}`;
const snapshotId = `${tradeDate}T${runTime.replaceAll('-', '')}+0800`;
const archiveRelative = `snapshots/${tradeDate}/${runTime}`;
const archiveRoot = join(dataRoot, archiveRelative);
const seed = Number(`${shanghaiParts.month}${shanghaiParts.day}${shanghaiParts.hour}`);
const drift = (seed % 7) - 3;

const meta = {
  snapshotId,
  asOf: `${tradeDate}T${shanghaiParts.hour}:${shanghaiParts.minute}:${shanghaiParts.second}+08:00`,
  tradeDate,
  modelVersion: providerInput ? 'dual-list-v0.5.0' : 'hotspot-v0.2.0',
  status: 'complete',
  mode: providerInput ? 'real' : 'demo',
  provider: providerInput ? 'longbridge' : 'demo',
  capturedAt: providerInput?.capturedAt ?? null,
};

let existingHistory = [];
try { existingHistory = JSON.parse(await readFile(join(dataRoot, 'index.json'), 'utf8')).snapshots ?? []; } catch {}

const demoThemes = [
  { rank: 1, name: '商业航天', score: 86 + drift, change: 12, stage: '加速', catalyst: '产业政策与卫星组网招标预期共振', breadth: '31/42', turnover: 74 },
  { rank: 2, name: '固态电池', score: 78 + drift, change: 6, stage: '发酵', catalyst: '行业规范征求意见，头部厂商披露扩产', breadth: '24/38', turnover: 48 },
  { rank: 3, name: '人形机器人', score: 73 - drift, change: -2, stage: '分化', catalyst: '新品发布会临近，核心零部件出现订单催化', breadth: '28/57', turnover: 29 },
  { rank: 4, name: '电网设备', score: 69 + drift, change: 4, stage: '启动', catalyst: '新一轮设备招标金额超市场预期', breadth: '19/46', turnover: 35 },
];

function pctChange(quote) {
  return Number((((Number(quote.last) / Number(quote.prevClose)) - 1) * 100).toFixed(2));
}

function isNoThresholdMainBoard(quote) {
  const code = String(quote.symbol ?? '').split('.')[0];
  const name = String(quote.name ?? '').toUpperCase();
  const isShanghaiMain = /^(600|601|603|605)\d{3}$/.test(code);
  const isShenzhenMain = /^(000|001|002|003)\d{3}$/.test(code);
  const isRiskWarning = name.includes('ST') || name.includes('退');
  return (isShanghaiMain || isShenzhenMain) && !isRiskWarning;
}

function intradayStructure(quote) {
  const open = Number(quote.open);
  const close = Number(quote.last);
  const previousClose = Number(quote.prevClose);
  const high = Number(quote.high);
  const low = Number(quote.low);
  const gapReturn = Number(((open / previousClose - 1) * 100).toFixed(2));
  const intradayReturn = Number(((close / open - 1) * 100).toFixed(2));
  const closeLocation = high > low ? Number(((close - low) / (high - low)).toFixed(3)) : 0.5;
  const gapLabel = gapReturn >= 0.3 ? '高开' : gapReturn <= -0.3 ? '低开' : '平开';
  const pathLabel = intradayReturn >= 0.3 ? '高走' : intradayReturn <= -0.3 ? '低走' : '震荡';
  const pattern = `${gapLabel}${pathLabel}`;
  const interpretation = gapLabel === '高开' && pathLabel === '低走'
    ? '隔夜预期未获得盘中确认，需防消息兑现。'
    : gapLabel === '低开' && pathLabel === '高走'
      ? '盘中出现修复与承接，仍需VWAP和分时量确认。'
      : pathLabel === '高走' && closeLocation >= 0.75
        ? '价格路径偏强，收盘位于日内区间上部。'
        : pathLabel === '低走' && closeLocation <= 0.25
          ? '价格路径偏弱，收盘接近日内低位。'
          : '日内方向不充分，需结合分时量价确认。';

  return {
    granularity: 'daily-ohlc',
    status: 'coarse',
    gapReturn,
    intradayReturn,
    closeLocation,
    pattern,
    interpretation,
    vwap: null,
    closeVsVwap: null,
    morningVolumeRatio: null,
    closingVolumeRatio: null,
    tradeImbalance: null,
    missing: ['1-minute-bars', 'tick-trades', 'order-book'],
  };
}

const realStocks = providerInput ? providerInput.quotes
  .map((quote) => ({ ...quote, move: pctChange(quote) }))
  .filter((quote) => Number.isFinite(quote.move) && quote.tradeStatus === 'Normal' && isNoThresholdMainBoard(quote))
  .sort((a, b) => (b.signalStrength ?? 0) - (a.signalStrength ?? 0) || b.move - a.move)
  .slice(0, providerInput?.universeScan ? 60 : 10) : [];

const themeGroups = providerInput ? Object.values(realStocks.reduce((groups, stock) => {
  const name = stock.theme || '其他异动';
  const group = groups[name] ?? { name, stocks: [], turnover: 0 };
  group.stocks.push(stock); group.turnover += Number(stock.turnover || 0); groups[name] = group;
  return groups;
}, {})).sort((a, b) => b.turnover - a.turnover) : [];

const realThemes = themeGroups.slice(0, 6).map((group, index) => {
  const avgMove = group.stocks.reduce((sum, stock) => sum + stock.move, 0) / group.stocks.length;
  return { rank: index + 1, name: group.name, score: Math.round(Math.min(95, 60 + avgMove * 3 + group.stocks.length * 4)), change: Number(avgMove.toFixed(1)), stage: avgMove > 3 ? '加速' : avgMove > 0 ? '发酵' : '分化', catalyst: `${group.stocks.length}只样本出现量价或异动信号`, breadth: `${group.stocks.length}/${realStocks.length}`, turnover: Number((group.turnover / 100_000_000).toFixed(1)) };
});
const themes = providerInput ? realThemes : demoThemes;

const radar = {
  meta,
  marketState: { label: providerInput ? providerInput.market.description : '主题扩散', riskAppetite: providerInput ? providerInput.market.temperature : 72 + drift },
  summary: providerInput ? { highConfidenceThemes: themes.filter((item) => item.score >= 70).length, events30m: providerInput.anomalies.length, confirmationRate: Number((realStocks.filter((item) => item.signalStrength >= 2).length / realStocks.length).toFixed(2)), credibleEvents: providerInput.news.length } : { highConfidenceThemes: 4, events30m: 127 + seed % 11, confirmationRate: 0.68, credibleEvents: 18 },
  themes,
  leadingTheme: { name: themes[0]?.name ?? '暂无', score: themes[0]?.score ?? 0, novelty: providerInput ? 70 : 92, velocity: providerInput ? Math.min(100, 50 + Math.abs(themes[0]?.change ?? 0) * 8) : 88, confirmation: providerInput ? Math.round((providerInput.anomalies.length / Math.max(realStocks.length, 1)) * 100) : 78 },
  sourceHealth: { healthy: providerInput ? 3 : 4, total: providerInput ? 3 : 4, delayedSources: [], quoteTimestamp: providerInput?.quoteTimestamp ?? null },
};

const candidates = {
  meta,
  accessPolicy: providerInput ? { id: 'cn-mainboard-no-extra-permission', label: '普通A股账户可交易', includedPrefixes: ['600', '601', '603', '605', '000', '001', '002', '003'], excluded: ['创业板', '科创板', '北交所', 'B股', 'ST/*ST', '退市整理', '停牌', '无效价格'] } : null,
  coverage: providerInput ? { totalReported: providerInput.universeScan?.totalReported ?? providerInput.quotes.length, recordsFetched: providerInput.universeScan?.recordsFetched ?? providerInput.quotes.length, eligibleCount: providerInput.universeScan?.eligibleCount ?? providerInput.quotes.length, deepQuoteCount: providerInput.universeScan?.deepQuoteCount ?? providerInput.quotes.length, accessEligibleDeepCount: realStocks.length, pagesFetched: providerInput.universeScan?.pagesFetched ?? 1, method: providerInput.universeScan?.method ?? '异动样本池', screenedAt: providerInput.universeScan?.screenedAt ?? providerInput.capturedAt } : null,
  stocks: providerInput ? realStocks.slice(0, providerInput.universeScan ? 20 : 6).map((stock, index) => ({ code: stock.symbol.split('.')[0], symbol: stock.symbol, name: stock.name, theme: stock.theme, score: Math.round(Math.min(95, 64 + Math.max(0, stock.move) * 3 + (stock.signalStrength ?? 0) * 4 - index)), catalyst: Math.round(Math.min(95, 60 + (stock.signalStrength ?? 0) * 8)), confirmation: Math.round(Math.min(95, 55 + Math.log10(Math.max(1, Number(stock.turnover))) * 4)), universeRank: stock.universeRank ?? null, universeScore: stock.universeScore ?? null, screening: stock.screening ?? null, access: '普通A股账户可交易', price: Number(stock.last), prevClose: Number(stock.prevClose), open: Number(stock.open), high: Number(stock.high), low: Number(stock.low), volume: Number(stock.volume), turnover: Number(stock.turnover), move: stock.move, intradayStructure: intradayStructure(stock), quoteTime: stock.timestamp, capturedAt: providerInput.capturedAt, tradeStatus: stock.tradeStatus, quoteKind: stock.timestamp.slice(0, 10) === tradeDate ? 'intraday' : 'latest-close', reason: `${stock.anomalyReason || '量价异动'}；当日涨跌幅 ${stock.move.toFixed(2)}%，成交额 ${(Number(stock.turnover) / 100_000_000).toFixed(2)}亿元。${providerInput.universeScan ? ` 来自${providerInput.universeScan.eligibleCount}只有效A股的全市场初筛，全市场排名 #${stock.universeRank ?? '--'}；已通过普通A股账户权限过滤。` : ''}`, risk: stock.move >= 7 ? '短线涨幅较大，次日可能分化' : '信号仅反映当前量价与异动，不代表持续上涨', horizon: '1-3日', source: 'Longbridge OpenAPI', sourceUrl: 'https://open.longbridge.com/zh-CN/docs/quote/overview' })) : [
    { code: '600118', name: '中国卫星', theme: '商业航天', score: 84 + drift, catalyst: 91, confirmation: 78, price: 32.46, move: 5.62, reason: '卫星制造核心标的，题材收入关联明确；量价同步放大。', risk: '前期累计涨幅偏高', horizon: '1-3日' },
    { code: '002025', name: '航天电器', theme: '商业航天', score: 80 + drift, catalyst: 86, confirmation: 73, price: 48.21, move: 3.18, reason: '高可靠连接器直接受益，机构关注度与成交额同步回升。', risk: '板块分化时弹性有限', horizon: '1-3日' },
    { code: '300750', name: '宁德时代', theme: '固态电池', score: 76 - drift, catalyst: 88, confirmation: 61, price: 286.4, move: 1.74, reason: '技术路线与产业化进度具备验证信息，基本面承载能力强。', risk: '大市值导致短线弹性较弱', horizon: '5-10日' },
    { code: '688017', name: '绿的谐波', theme: '人形机器人', score: 72 + drift, catalyst: 79, confirmation: 64, price: 146.88, move: 2.91, reason: '核心零部件业务纯度较高，历史上多次充当板块中军。', risk: '估值处于历史高分位', horizon: '1-3日' },
  ],
};

if (providerInput) {
  const trendStocks = (providerInput.trendCandidates ?? [])
    .filter((stock) => stock.tradeStatus === 'Normal' && isNoThresholdMainBoard(stock))
    .slice(0, 20)
    .map((stock) => {
      const candlestick = providerInput.candlestickSignals?.[stock.symbol] ?? { patterns: [], primary: 'none', scoreBonus: 0, status: 'none', reason: '无K线形态数据' };
      return ({
      code: stock.symbol.split('.')[0], symbol: stock.symbol, name: stock.name, theme: stock.theme,
      score: Math.round(stock.trendScore + Number(candlestick.scoreBonus || 0)), catalyst: Math.round(Math.min(95, 52 + stock.volRatio * 12)),
      confirmation: Math.round(Math.min(95, 48 + stock.trendEfficiency * 38 + Math.max(0, stock.ret20) * 0.5)),
      trendRank: stock.trendRank, candidateType: 'trend', access: '普通A股账户可交易',
      price: Number(stock.last), prevClose: Number(stock.prevClose), open: Number(stock.open), high: Number(stock.high), low: Number(stock.low),
      volume: Number(stock.volume), turnover: Number(stock.turnover), move: Number(stock.ret1), ret20: Number(stock.ret20),
      volRatio: Number(stock.volRatio), trendEfficiency: Number(stock.trendEfficiency), candlestick, intradayStructure: intradayStructure(stock),
      quoteTime: stock.timestamp, capturedAt: providerInput.capturedAt, tradeStatus: stock.tradeStatus,
      quoteKind: stock.timestamp.slice(0, 10) === tradeDate ? 'intraday' : 'latest-close',
      reason: `近20日上涨 ${Number(stock.ret20).toFixed(2)}%，当日涨跌 ${Number(stock.ret1).toFixed(2)}%，量比 ${Number(stock.volRatio).toFixed(2)}；通过2%—30%趋势区间、单日不超过7%及行业分散过滤。K线：${candlestick.reason}。`,
      risk: Number(stock.ret20) > 24 ? '20日累计涨幅接近趋势池上限，需等待回踩确认' : '趋势信号可能在市场风格切换时失效',
      horizon: '1-3日', source: stock.source || 'Longbridge OpenAPI', sourceUrl: 'https://open.longbridge.com/zh-CN/docs/quote/overview',
    }); });
  candidates.stocks = candidates.stocks.map((stock) => ({ ...stock, candidateType: 'hotspot' }));
  candidates.lists = {
    hotspot: { id: 'hotspot', label: '热点爆发', description: '关注当日异动、涨幅和资金热度，波动与追高风险较高。', stocks: candidates.stocks },
    trend: { id: 'trend', label: '趋势潜伏', description: '关注20日趋势、量能确认和行业分散，并过滤极端追高。', stocks: trendStocks },
  };
  candidates.trendScan = providerInput.trendScan ?? null;
  candidates.candlestickDecisionTree = candlestickDecisionTree ? { modelId: candlestickDecisionTree.modelId, status: candlestickDecisionTree.status, acceptedLeaves: candlestickDecisionTree.tree.acceptedLeaves, promotionGate: candlestickDecisionTree.promotionGate } : null;
}

const tradingRules = {
  initialCapital: 1_000_000,
  maxTotalPosition: 0.7,
  maxSinglePosition: 0.1,
  maxThemePosition: 0.25,
  lotSize: 100,
  commissionRate: 0.0003,
  minimumCommission: 5,
  stampDutyRateOnSell: 0.0005,
  slippageRate: 0.0015,
  settlement: 'T+1',
};

function nextTradingDate(dateText) {
  const date = new Date(`${dateText}T12:00:00+08:00`);
  do { date.setUTCDate(date.getUTCDate() + 1); } while ([0, 6].includes(date.getUTCDay()));
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(date);
}

function dayDistance(from, to) {
  return Math.max(0, Math.floor((new Date(`${to}T00:00:00+08:00`) - new Date(`${from}T00:00:00+08:00`)) / 86_400_000));
}

async function loadPreviousPortfolio() {
  const previous = existingHistory
    .filter((item) => item.asOf < meta.asOf && item.files?.portfolio && item.mode === meta.mode)
    .sort((a, b) => b.asOf.localeCompare(a.asOf))[0];
  if (!previous) return null;
  try { return JSON.parse(await readFile(join(dataRoot, previous.path, previous.files.portfolio), 'utf8')); } catch { return null; }
}

function bootstrapAccount() {
  if (meta.mode === 'real') return {
    accountId: 'model', name: '纯模型账户', type: 'MODEL', enabled: true,
    initialCapital: tradingRules.initialCapital, cash: tradingRules.initialCapital,
    positions: [], tradeHistory: [], nav: [{ date: tradeDate, totalAsset: tradingRules.initialCapital, benchmark: 1 }], nextPlan: null,
  };
  const positions = [
    { code: '600118', name: '中国卫星', theme: '商业航天', shares: 2500, availableShares: 2500, costPrice: 30.82, lastPrice: 32.46, openedAt: '2026-08-25', reason: '政策催化与卫星组网预期共振', stopLoss: 28.66, targetPrice: 35.8 },
    { code: '002025', name: '航天电器', theme: '商业航天', shares: 1400, availableShares: 1400, costPrice: 46.35, lastPrice: 48.21, openedAt: '2026-08-26', reason: '核心连接器业务纯度较高', stopLoss: 43.11, targetPrice: 52.4 },
  ];
  return {
    accountId: 'model', name: '纯模型账户', type: 'MODEL', enabled: true, initialCapital: tradingRules.initialCapital,
    cash: 857_140, positions, tradeHistory: [
      { id: 'T-0825-600118', tradeDate: '2026-08-25', code: '600118', name: '中国卫星', side: 'BUY', shares: 2500, price: 30.82, fees: 23.12, reason: '热点分与盘面确认同时超过阈值' },
      { id: 'T-0826-002025', tradeDate: '2026-08-26', code: '002025', name: '航天电器', side: 'BUY', shares: 1400, price: 46.35, fees: 19.47, reason: '商业航天题材扩散至核心零部件' },
    ], nav: [{ date: '2026-08-26', totalAsset: 999_957.41, benchmark: 1 }, { date: '2026-08-27', totalAsset: 1_006_480, benchmark: 1.003 }, { date: '2026-08-28', totalAsset: 1_013_477, benchmark: 1.006 }],
    nextPlan: null,
  };
}

function commission(amount) { return Math.max(tradingRules.minimumCommission, amount * tradingRules.commissionRate); }

function simulateModelAccount(previousPortfolio) {
  const previous = previousPortfolio?.accounts?.find((account) => account.accountId === 'model') ?? bootstrapAccount();
  let cash = previous.cash;
  let positions = previous.positions.map((position) => ({ ...position }));
  const todayTrades = [];
  const todayOrders = [];
  const marketClosed = [0, 6].includes(new Date(`${tradeDate}T12:00:00+08:00`).getUTCDay());

  if (!marketClosed && previous.nextPlan?.executeOn === tradeDate) {
    for (const plan of previous.nextPlan.orders) {
      const quote = candidates.stocks.find((stock) => stock.code === plan.code);
      if (!quote) continue;
      const order = { id: `O-${tradeDate}-${plan.code}`, createdAt: meta.asOf, code: plan.code, name: plan.name, side: plan.side, status: 'PENDING', targetWeight: plan.targetWeight, reason: plan.reason };
      if (plan.side === 'BUY') {
        const referenceAsset = cash + positions.reduce((sum, item) => sum + item.shares * item.lastPrice, 0);
        const price = Number((quote.price * (1 + tradingRules.slippageRate)).toFixed(2));
        const existing = positions.find((item) => item.code === plan.code);
        const existingValue = existing ? existing.shares * price : 0;
        const gapValue = Math.max(0, referenceAsset * plan.targetWeight - existingValue);
        const shares = Math.floor(gapValue / price / tradingRules.lotSize) * tradingRules.lotSize;
        const amount = shares * price; const fee = commission(amount);
        if (shares > 0 && amount + fee <= cash) {
          cash -= amount + fee;
          if (existing) { const totalShares = existing.shares + shares; existing.costPrice = Number(((existing.costPrice * existing.shares + amount + fee) / totalShares).toFixed(2)); existing.shares = totalShares; }
          else positions.push({ code: plan.code, name: plan.name, theme: plan.theme, shares, availableShares: 0, costPrice: Number(((amount + fee) / shares).toFixed(2)), lastPrice: quote.price, openedAt: tradeDate, reason: plan.reason, stopLoss: Number((price * 0.93).toFixed(2)), targetPrice: Number((price * 1.12).toFixed(2)) });
          order.status = 'FILLED'; order.fillPrice = price; order.shares = shares; order.fees = Number(fee.toFixed(2));
          todayTrades.push({ id: `T-${tradeDate}-${plan.code}`, tradeDate, code: plan.code, name: plan.name, side: 'BUY', shares, price, fees: Number(fee.toFixed(2)), reason: plan.reason });
        } else { order.status = gapValue < price * tradingRules.lotSize ? 'SKIPPED' : 'REJECTED'; order.rejectReason = gapValue < price * tradingRules.lotSize ? '已达到目标仓位' : '可用资金或整手数量不足'; }
      } else if (plan.side === 'SELL') {
        const existing = positions.find((item) => item.code === plan.code);
        if (existing && existing.availableShares > 0) {
          const price = Number((quote.price * (1 - tradingRules.slippageRate)).toFixed(2));
          const shares = existing.availableShares; const amount = shares * price;
          const fee = commission(amount) + amount * tradingRules.stampDutyRateOnSell;
          cash += amount - fee; existing.shares -= shares; existing.availableShares = 0;
          order.status = 'FILLED'; order.fillPrice = price; order.shares = shares; order.fees = Number(fee.toFixed(2));
          todayTrades.push({ id: `T-${tradeDate}-${plan.code}-S`, tradeDate, code: plan.code, name: plan.name, side: 'SELL', shares, price, fees: Number(fee.toFixed(2)), realizedPnl: Number(((price - existing.costPrice) * shares - fee).toFixed(2)), reason: plan.reason });
          if (existing.shares === 0) positions = positions.filter((item) => item.code !== plan.code);
        } else { order.status = 'REJECTED'; order.rejectReason = 'T+1可卖数量不足'; }
      }
      todayOrders.push(order);
    }
  }

  positions = positions.map((position) => {
    const quote = candidates.stocks.find((stock) => stock.code === position.code);
    const lastPrice = quote?.price ?? position.lastPrice;
    return { ...position, lastPrice, availableShares: position.openedAt < tradeDate ? position.shares : position.availableShares, holdingDays: dayDistance(position.openedAt, tradeDate), marketValue: Number((position.shares * lastPrice).toFixed(2)), unrealizedPnl: Number((position.shares * (lastPrice - position.costPrice)).toFixed(2)), returnPct: Number(((lastPrice / position.costPrice - 1) * 100).toFixed(2)) };
  });
  const marketValue = positions.reduce((sum, position) => sum + position.marketValue, 0);
  const totalAsset = Number((cash + marketValue).toFixed(2));
  const previousAsset = previous.nav.at(-1)?.totalAsset ?? previous.initialCapital;
  const nav = [...previous.nav.filter((item) => item.date !== tradeDate), { date: tradeDate, totalAsset, benchmark: Number((1 + (seed % 9 - 3) / 1000).toFixed(4)) }].slice(-120);
  const peak = Math.max(...nav.map((item) => item.totalAsset));
  const winningTrades = previous.tradeHistory.filter((trade) => trade.realizedPnl > 0).length;
  const closedTrades = previous.tradeHistory.filter((trade) => trade.realizedPnl != null).length;
  const exitOrders = positions.filter((position) => {
    const quote = candidates.stocks.find((stock) => stock.code === position.code);
    return position.holdingDays >= 10 || position.lastPrice <= position.stopLoss || !quote || quote.score < 68;
  }).map((position, index) => ({ code: position.code, name: position.name, theme: position.theme, side: 'SELL', targetWeight: 0, priority: index + 1, reason: position.lastPrice <= position.stopLoss ? '触发模拟止损' : position.holdingDays >= 10 ? '达到最大持有周期' : '热点评分跌破持仓阈值', cancelIf: '无；仅受T+1、停牌和跌停限制' }));
  const buyOrders = candidates.stocks.slice(0, 3).map((stock, index) => ({ code: stock.code, name: stock.name, theme: stock.theme, side: 'BUY', targetWeight: [0.1, 0.08, 0.06][index], priority: exitOrders.length + index + 1, maxOpenMove: 4, reason: stock.reason, cancelIf: `题材热度低于${Math.max(65, stock.score - 10)}或出现重大负面公告` }));
  const nextPlan = {
    generatedAt: meta.asOf, executeOn: nextTradingDate(tradeDate), status: 'READY',
    orders: [...exitOrders, ...buyOrders],
  };
  return { ...previous, cash: Number(cash.toFixed(2)), positions, todayOrders, todayTrades, tradeHistory: [...previous.tradeHistory, ...todayTrades].slice(-200), nav, nextPlan, summary: { totalAsset, cash: Number(cash.toFixed(2)), marketValue: Number(marketValue.toFixed(2)), dailyPnl: Number((totalAsset - previousAsset).toFixed(2)), cumulativePnl: Number((totalAsset - previous.initialCapital).toFixed(2)), cumulativeReturn: Number(((totalAsset / previous.initialCapital - 1) * 100).toFixed(2)), positionRate: Number((marketValue / totalAsset * 100).toFixed(1)), maxDrawdown: Number(((totalAsset / peak - 1) * 100).toFixed(2)), winRate: closedTrades ? Number((winningTrades / closedTrades * 100).toFixed(1)) : 0 }, marketClosed };
}

const previousPortfolio = await loadPreviousPortfolio();
const modelAccount = simulateModelAccount(previousPortfolio);
const assistedAccount = previousPortfolio?.accounts?.find((account) => account.accountId === 'assisted') ?? { accountId: 'assisted', name: '人工增强账户', type: 'ASSISTED', enabled: false, status: 'READY_FOR_MANUAL_INPUT', initialCapital: tradingRules.initialCapital, summary: { totalAsset: tradingRules.initialCapital, cash: tradingRules.initialCapital, marketValue: 0, cumulativePnl: 0, cumulativeReturn: 0, positionRate: 0, maxDrawdown: 0, winRate: 0 }, positions: [], todayOrders: [], todayTrades: [], tradeHistory: [], nav: [{ date: tradeDate, totalAsset: tradingRules.initialCapital, benchmark: 1 }], nextPlan: null };
const portfolio = { meta, rules: tradingRules, accounts: [modelAccount, assistedAccount], comparison: { modelReturn: modelAccount.summary.cumulativeReturn, assistedReturn: assistedAccount.summary.cumulativeReturn, benchmarkReturn: Number(((modelAccount.nav.at(-1)?.benchmark ?? 1) - 1) * 100) } };

const evidence = providerInput ? {
  meta,
  summary: { total: providerInput.news.length + providerInput.anomalies.length, official: 0, confirmed: providerInput.news.filter((item) => item.relatedSymbols?.length).length, duplicateRate: 0 },
  events: [
    ...providerInput.news.slice(0, 20).map((item, index) => ({ id: `lb-news-${item.id ?? index}`, time: new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(item.publishedAt)), level: 'B', source: item.source || 'Longbridge资讯', title: item.title, summary: item.summary, tags: ['新闻'], relatedThemes: item.themes ?? [], relatedStocks: (item.relatedSymbols ?? []).map((symbol) => symbol.split('.')[0]), url: item.url })),
    ...providerInput.anomalies.slice(0, 20).map((item, index) => ({ id: `lb-anomaly-${index}`, time: item.time.slice(11, 16), level: 'B', source: 'Longbridge行情异动', title: `${item.name}：${item.reason}`, tags: ['盘面', '异动'], relatedThemes: item.theme ? [item.theme] : [], relatedStocks: [item.symbol.split('.')[0]], url: '' })),
  ],
} : {
  meta,
  summary: { total: 127 + seed % 11, official: 12, confirmed: 18, duplicateRate: 0.41 },
  events: [
    { id: 'evt-policy-space', time: '09:42', level: 'S', source: '部委官网', title: '商业航天产业配套政策进入公开征求意见阶段', tags: ['政策', '首次'], relatedThemes: ['商业航天'], relatedStocks: ['600118', '002025'], url: '#' },
    { id: 'evt-order-space', time: '09:36', level: 'A', source: '公司公告', title: '产业链公司披露新增卫星载荷相关订单', tags: ['订单', '确认'], relatedThemes: ['商业航天'], relatedStocks: ['600118'], url: '#' },
    { id: 'evt-market-space', time: '09:18', level: 'B', source: '财经媒体', title: '卫星互联网产业链开盘活跃，板块成交快速放大', tags: ['盘面', '扩散'], relatedThemes: ['商业航天'], relatedStocks: ['600118', '002025'], url: '#' },
    { id: 'evt-battery', time: '08:57', level: 'A', source: '行业协会', title: '固态电池行业规范公开征求意见', tags: ['产业', '政策'], relatedThemes: ['固态电池'], relatedStocks: ['300750'], url: '#' },
  ],
};

const review = providerInput ? {
  meta,
  metrics: trainedModel ? { precisionAt10: trainedModel.metrics.threeDay.top10HitRate, ndcgAt10: null, avgExcess1d: trainedModel.metrics.oneDay.top10MeanExcess * 100, avgExcess3d: trainedModel.metrics.threeDay.top10MeanExcess * 100, maxDrawdown: null, samples: trainedModel.metrics.testSamples } : { precisionAt10: null, ndcgAt10: null, avgExcess1d: null, avgExcess3d: null, maxDrawdown: null, samples: 0 },
  periods: trainedModel ? [{ label: '一年样本外', signals: trainedModel.metrics.testSamples, hitRate: trainedModel.metrics.threeDay.top10HitRate * 100, excess: trainedModel.metrics.threeDay.top10MeanExcess * 100 }] : [], recentPredictions: [],
  trainingModel: trainedModel ? { modelId: trainedModel.modelId, status: trainedModel.status, provider: trainedModel.provider, universe: trainedModel.universe, window: trainedModel.window, limitations: trainedModel.limitations } : null,
  optimizationExperiment: optimizationExperiment ? { modelId: optimizationExperiment.modelId, status: optimizationExperiment.status, objective: optimizationExperiment.objective, window: optimizationExperiment.window, preprocessing: optimizationExperiment.preprocessing, metrics: optimizationExperiment.metrics, promotionGate: optimizationExperiment.promotionGate, limitations: optimizationExperiment.limitations } : null,
  notes: trainedModel ? [`${trainedModel.modelId}使用${trainedModel.metrics.trainSamples}条训练样本和${trainedModel.metrics.testSamples}条样本外测试`, `3日Top10平均超额${(trainedModel.metrics.threeDay.top10MeanExcess * 100).toFixed(2)}%，命中率${(trainedModel.metrics.threeDay.top10HitRate * 100).toFixed(1)}%`, trainedModel.status === 'SHADOW_READY' ? '已达到影子观察门槛，仍不直接驱动模拟买卖' : '未通过预设上线门槛，保持研究模型，不替换模拟盘决策', ...(optimizationExperiment && optimizationAudit ? [`优化实验${optimizationExperiment.modelId}审计命中率${((optimizationAudit.top10HitRate ?? optimizationAudit.hit) * 100).toFixed(1)}%，未覆盖现有模型`] : []), ...trainedModel.limitations] : ['尚无已训练的真实历史模型', '行情与新闻来自Longbridge，重要公告仍需官方来源交叉确认'],
} : {
  meta,
  metrics: { precisionAt10: 0.62, ndcgAt10: 0.71, avgExcess1d: 0.86, avgExcess3d: 1.74, maxDrawdown: -6.8, samples: 184 },
  periods: [
    { label: '近5日', signals: 48, hitRate: 64.6, excess: 2.18 },
    { label: '近20日', signals: 184, hitRate: 62.0, excess: 1.74 },
    { label: '近60日', signals: 527, hitRate: 57.9, excess: 1.21 },
  ],
  recentPredictions: [
    { date: tradeDate, theme: '商业航天', score: themes[0].score, outcome: '观察中', excess: null },
    { date: '2026-08-29', theme: '固态电池', score: 79, outcome: '命中', excess: 2.34 },
    { date: '2026-08-28', theme: '机器人', score: 76, outcome: '命中', excess: 1.68 },
    { date: '2026-08-27', theme: '创新药', score: 71, outcome: '未命中', excess: -1.12 },
  ],
  notes: ['政策类事件在1—3日窗口表现较好', '高拥挤题材次日分化概率上升', '当前为演示统计，接入真实数据后重新计算'],
};

const files = { radar: 'radar.json', candidates: 'candidates.json', evidence: 'evidence.json', review: 'review.json', portfolio: 'portfolio.json' };
const payloads = { radar, candidates, evidence, review, portfolio };

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temp, path);
}

await mkdir(archiveRoot, { recursive: true });
for (const [key, filename] of Object.entries(files)) {
  await atomicJson(join(archiveRoot, filename), payloads[key]);
}
await atomicJson(join(archiveRoot, 'meta.json'), { ...meta, files });

let history = existingHistory;
const entry = { ...meta, path: archiveRelative, files };
history = [entry, ...history.filter((item) => item.snapshotId !== snapshotId)]
  .sort((a, b) => b.asOf.localeCompare(a.asOf));
await atomicJson(join(dataRoot, 'index.json'), { updatedAt: meta.asOf, snapshots: history });

const stagedLatest = join(dataRoot, `.latest-${process.pid}`);
await rm(stagedLatest, { recursive: true, force: true });
await mkdir(stagedLatest, { recursive: true });
for (const [key, filename] of Object.entries(files)) {
  await atomicJson(join(stagedLatest, filename), payloads[key]);
}
await rm(latestRoot, { recursive: true, force: true });
await rename(stagedLatest, latestRoot);
await atomicJson(join(dataRoot, 'manifest.json'), { ...meta, path: 'latest', files, historyIndex: 'index.json' });

console.log(JSON.stringify({ ok: true, snapshotId, archive: archiveRelative, files: Object.keys(files), mode: meta.mode, provider: meta.provider }));
