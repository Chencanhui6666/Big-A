import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateGate, dailyMoveBand, marketRegimeGate, obsoletePortfolioRiskExit, openExecutionGate, portfolioRiskState, rankRiskAwareCandidates, targetWeight } from './risk-aware-strategy.mjs';

const candidate = {
  symbol: '600000.SH', tradeStatus: 'Normal', ret20: 12, ret1: 1.5, volRatio: 1.2,
  trendEfficiency: 0.7, atr20Pct: 3, averageTurnover20: 500_000_000,
  last: 11, high: 11.1, low: 10.4, ma20: 10.5, ma60: 10, ma20Slope5: 0.2, signalDirection: 'buy',
};

test('accepts a liquid, moderate-momentum uptrend', () => assert.equal(candidateGate(candidate).allowed, true));
test('keeps recent IPOs out of trend execution without excluding them from hotspot data', () => {
  const result = candidateGate({ ...candidate, historyBars: 6 });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /上市时间不足/);
  assert.equal(candidateGate({ ...candidate, historyBars: 61 }).allowed, true);
});
test('rejects limit-chasing and negative anomaly directions', () => {
  assert.equal(candidateGate({ ...candidate, ret1: 9.8 }).allowed, false);
  assert.equal(candidateGate({ ...candidate, signalDirection: 'sell' }).allowed, false);
});
test('keeps deep pullbacks in the shadow lane and admits only confirmed breakouts', () => {
  assert.equal(dailyMoveBand({ ...candidate, ret1: -4 }).kind, 'pullback-shadow');
  assert.equal(candidateGate({ ...candidate, ret1: -4 }).allowed, false);
  assert.equal(dailyMoveBand({ ...candidate, ret1: 5, volRatio: 1.3, atr20Pct: 3, last: 11, high: 11.1, low: 10.4 }).kind, 'breakout');
  assert.equal(candidateGate({ ...candidate, ret1: 5, volRatio: 1.8 }).allowed, false);
  assert.equal(candidateGate({ ...candidate, ret1: 6.1 }).allowed, false);
});
test('requires a positive broad-market regime', () => {
  assert.equal(marketRegimeGate({ close: 4100, ma20: 4000, ma60: 3900 }).allowed, true);
  assert.equal(marketRegimeGate({ close: 3900, ma20: 4000, ma60: 3950 }).allowed, false);
});
test('keeps drawdown advisory without disabling new buys', () => {
  const riskOff = portfolioRiskState({ drawdownPct: -3.1, dailyReturnPct: 0 });
  const deepDrawdown = portfolioRiskState({ drawdownPct: -5.1, dailyReturnPct: 0 });
  assert.equal(riskOff.state, 'WATCH');
  assert.equal(deepDrawdown.state, 'WATCH');
  assert.equal(riskOff.allowBuys, true);
  assert.equal(deepDrawdown.allowBuys, true);
  assert.equal(deepDrawdown.maxTotalPosition, 0.4);
});
test('enforces the next-open gap instead of merely documenting it', () => {
  assert.equal(openExecutionGate({ signalClose: 10 }, { open: 10.15 }).allowed, true);
  assert.equal(openExecutionGate({ signalClose: 10 }, { open: 10.3 }).allowed, false);
});
test('caps risk-sized positions at five percent', () => {
  assert.equal(targetWeight(candidate), 0.05);
  assert.equal(targetWeight({ ...candidate, atr20Pct: 5 }), 0.0437);
});
test('ranks only candidates that pass every gate', () => {
  const result = rankRiskAwareCandidates([candidate, { ...candidate, symbol: '600001.SH', ret1: 8 }], { close: 4100, ma20: 4000, ma60: 3900 });
  assert.deepEqual(result.eligible.map((item) => item.symbol), ['600000.SH']);
});
test('keeps qualified candidates in a weak market with a score penalty', () => {
  const strong = rankRiskAwareCandidates([candidate], { close: 4100, ma20: 4000, ma60: 3900 });
  const weak = rankRiskAwareCandidates([candidate], { close: 3900, ma20: 4000, ma60: 3950 });
  assert.deepEqual(weak.eligible.map((item) => item.symbol), ['600000.SH']);
  assert.equal(weak.eligible[0].regimeAdjusted, true);
  assert.equal(weak.eligible[0].riskAwareScore, strong.eligible[0].riskAwareScore - 10);
});
test('cancels only legacy portfolio-level liquidation orders', () => {
  assert.equal(obsoletePortfolioRiskExit({ side: 'SELL', reason: '组合回撤达到5%，熔断只允许减仓' }), true);
  assert.equal(obsoletePortfolioRiskExit({ side: 'SELL', reason: '组合进入RISK_OFF，仓位降至20%以内' }), true);
  assert.equal(obsoletePortfolioRiskExit({ side: 'SELL', reason: '触发风险感知止损' }), false);
  assert.equal(obsoletePortfolioRiskExit({ side: 'BUY', reason: '组合回撤达到5%' }), false);
});
