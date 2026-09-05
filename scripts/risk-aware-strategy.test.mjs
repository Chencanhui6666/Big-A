import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateGate, marketRegimeGate, openExecutionGate, portfolioRiskState, rankRiskAwareCandidates, targetWeight } from './risk-aware-strategy.mjs';

const candidate = {
  symbol: '600000.SH', tradeStatus: 'Normal', ret20: 12, ret1: 1.5, volRatio: 1.2,
  trendEfficiency: 0.7, atr20Pct: 3, averageTurnover20: 500_000_000,
  last: 11, ma20: 10.5, ma60: 10, ma20Slope5: 0.2, signalDirection: 'buy',
};

test('accepts a liquid, moderate-momentum uptrend', () => assert.equal(candidateGate(candidate).allowed, true));
test('rejects limit-chasing and negative anomaly directions', () => {
  assert.equal(candidateGate({ ...candidate, ret1: 9.8 }).allowed, false);
  assert.equal(candidateGate({ ...candidate, signalDirection: 'sell' }).allowed, false);
});
test('requires a positive broad-market regime', () => {
  assert.equal(marketRegimeGate({ close: 4100, ma20: 4000, ma60: 3900 }).allowed, true);
  assert.equal(marketRegimeGate({ close: 3900, ma20: 4000, ma60: 3950 }).allowed, false);
});
test('blocks new buys when drawdown reaches risk-off and halt tiers', () => {
  assert.equal(portfolioRiskState({ drawdownPct: -3.1, dailyReturnPct: 0 }).state, 'RISK_OFF');
  assert.equal(portfolioRiskState({ drawdownPct: -5.1, dailyReturnPct: 0 }).state, 'HALT');
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
