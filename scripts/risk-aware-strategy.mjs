export const riskAwareRules = Object.freeze({
  strategyId: 'risk-aware-trend-v0.7.0',
  maxTotalPosition: 0.4,
  riskOffTotalPosition: 0.2,
  maxSinglePosition: 0.05,
  maxThemePosition: 0.12,
  riskPerTrade: 0.0035,
  maxNewPositionsPerDay: 2,
  minRet20: 5,
  maxRet20: 25,
  minRet1: -3,
  maxRet1: 4,
  minVolumeRatio: 0.8,
  maxVolumeRatio: 2,
  maxAtr20Pct: 5,
  minAverageTurnover20: 200_000_000,
  minOpenGapPct: -2,
  maxOpenGapPct: 2,
  minStopDistancePct: 5,
  maxStopDistancePct: 8,
  atrStopMultiple: 1.8,
  timeStopDays: 5,
  timeStopMinReturnPct: 2,
  maxHoldingDays: 10,
  trailingActivationPct: 8,
  drawdownRiskOffPct: -3,
  drawdownHaltPct: -5,
  dailyLossPausePct: -1.5,
});

const finite = (value) => Number.isFinite(Number(value));
const number = (value) => Number(value);

export function stopDistancePct(atr20Pct, rules = riskAwareRules) {
  if (!finite(atr20Pct) || number(atr20Pct) <= 0) return rules.maxStopDistancePct;
  return Math.min(rules.maxStopDistancePct, Math.max(rules.minStopDistancePct, number(atr20Pct) * rules.atrStopMultiple));
}

export function targetWeight(candidate, rules = riskAwareRules) {
  const stopPct = stopDistancePct(candidate.atr20Pct, rules) / 100;
  return Number(Math.min(rules.maxSinglePosition, rules.riskPerTrade / stopPct).toFixed(4));
}

export function marketRegimeGate(marketRegime) {
  if (!marketRegime || !finite(marketRegime.close) || !finite(marketRegime.ma20) || !finite(marketRegime.ma60)) {
    return { allowed: false, reason: '缺少宽基指数 MA20/MA60 市场状态' };
  }
  if (number(marketRegime.close) <= number(marketRegime.ma20) || number(marketRegime.ma20) <= number(marketRegime.ma60)) {
    return { allowed: false, reason: '宽基指数未满足 close > MA20 > MA60' };
  }
  return { allowed: true, reason: '宽基指数趋势门槛通过' };
}

export function candidateGate(candidate, rules = riskAwareRules) {
  const required = ['ret20', 'ret1', 'volRatio', 'trendEfficiency', 'atr20Pct', 'averageTurnover20', 'last', 'ma20', 'ma60', 'ma20Slope5'];
  const missing = required.filter((key) => !finite(candidate[key]));
  if (missing.length) return { allowed: false, reason: `缺少字段: ${missing.join(', ')}` };
  if (candidate.tradeStatus !== 'Normal') return { allowed: false, reason: '证券不是正常交易状态' };
  if (['sell', 'negative', 'bearish'].includes(String(candidate.signalDirection ?? '').toLowerCase())) return { allowed: false, reason: '负向异动不得触发买入' };
  if (number(candidate.ret20) < rules.minRet20 || number(candidate.ret20) > rules.maxRet20) return { allowed: false, reason: '20日收益超出5%—25%区间' };
  if (number(candidate.ret1) < rules.minRet1 || number(candidate.ret1) > rules.maxRet1) return { allowed: false, reason: '单日涨跌超出-3%—4%区间' };
  if (number(candidate.volRatio) < rules.minVolumeRatio || number(candidate.volRatio) > rules.maxVolumeRatio) return { allowed: false, reason: '量比超出0.8—2.0区间' };
  if (number(candidate.atr20Pct) > rules.maxAtr20Pct) return { allowed: false, reason: 'ATR20波动率超过5%' };
  if (number(candidate.averageTurnover20) < rules.minAverageTurnover20) return { allowed: false, reason: '20日平均成交额低于2亿元' };
  if (!(number(candidate.last) > number(candidate.ma20) && number(candidate.ma20) > number(candidate.ma60) && number(candidate.ma20Slope5) > 0)) return { allowed: false, reason: '未满足 close > MA20 > MA60 且MA20向上' };
  return { allowed: true, reason: '风险感知趋势门槛通过' };
}

export function candidateScore(candidate) {
  const trend = Math.min(30, Math.max(0, (number(candidate.ret20) - 5) / 20 * 30));
  const crossSection = Math.min(20, Math.max(0, number(candidate.crossSectionMomentumPct ?? 0) * 0.2));
  const efficiency = Math.min(15, Math.max(0, number(candidate.trendEfficiency) * 15));
  const lowVolatility = Math.min(15, Math.max(0, 15 * (1 - number(candidate.atr20Pct) / 10)));
  const liquidity = Math.min(10, Math.max(0, Math.log10(Math.max(1, number(candidate.averageTurnover20) / 100_000_000)) * 10));
  const confirmation = candidate.signalDirection === 'buy' || candidate.eventConfirmed ? 10 : 0;
  return Number((trend + crossSection + efficiency + lowVolatility + liquidity + confirmation).toFixed(2));
}

export function rankRiskAwareCandidates(candidates, marketRegime, rules = riskAwareRules) {
  const regime = marketRegimeGate(marketRegime);
  if (!regime.allowed) return { regime, eligible: [], rejected: candidates.map((candidate) => ({ symbol: candidate.symbol, ...candidateGate(candidate, rules) })) };
  const evaluated = candidates.map((candidate) => ({ candidate, gate: candidateGate(candidate, rules) }));
  return {
    regime,
    eligible: evaluated.filter((item) => item.gate.allowed).map((item) => ({ ...item.candidate, riskAwareScore: candidateScore(item.candidate), gateReason: item.gate.reason })).sort((a, b) => b.riskAwareScore - a.riskAwareScore),
    rejected: evaluated.filter((item) => !item.gate.allowed).map((item) => ({ symbol: item.candidate.symbol, ...item.gate })),
  };
}

export function portfolioRiskState({ drawdownPct, dailyReturnPct }, rules = riskAwareRules) {
  if (number(drawdownPct) <= rules.drawdownHaltPct) return { state: 'HALT', allowBuys: false, maxTotalPosition: 0, reason: '回撤达到5%，只允许减仓' };
  if (number(drawdownPct) <= rules.drawdownRiskOffPct || number(dailyReturnPct) <= rules.dailyLossPausePct) return { state: 'RISK_OFF', allowBuys: false, maxTotalPosition: rules.riskOffTotalPosition, reason: '回撤达到3%或单日亏损达到1.5%' };
  return { state: 'NORMAL', allowBuys: true, maxTotalPosition: rules.maxTotalPosition, reason: '组合风险门槛通过' };
}

export function openExecutionGate(plan, quote, rules = riskAwareRules) {
  const open = number(quote?.open);
  const signalClose = number(plan?.signalClose ?? quote?.prevClose);
  if (!finite(open) || open <= 0 || !finite(signalClose) || signalClose <= 0) return { allowed: false, reason: '缺少有效开盘价或信号收盘价' };
  const gapPct = (open / signalClose - 1) * 100;
  if (gapPct < rules.minOpenGapPct || gapPct > rules.maxOpenGapPct) return { allowed: false, reason: `开盘跳空 ${gapPct.toFixed(2)}%，超出-2%—2%`, gapPct };
  if (plan.stopLoss && open <= number(plan.stopLoss)) return { allowed: false, reason: '开盘价已低于计划止损价', gapPct };
  return { allowed: true, reason: '开盘成交门槛通过', gapPct };
}

export function themeExposure(existingPositions, theme) {
  return existingPositions.filter((position) => position.theme === theme).reduce((sum, position) => sum + number(position.marketValue ?? position.shares * position.lastPrice), 0);
}
