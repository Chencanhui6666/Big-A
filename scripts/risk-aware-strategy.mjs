export const riskAwareRules = Object.freeze({
  strategyId: 'risk-aware-trend-v0.8.0',
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
  pullbackRet1Min: -5,
  breakoutRet1Max: 6,
  breakoutMaxVolumeRatio: 1.5,
  breakoutMaxAtr20Pct: 3.5,
  breakoutMinCloseLocation: 0.75,
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
  weakRegimeScorePenalty: 10,
  minTrendHistoryBars: 61,
  drawdownMode: 'advisory',
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

export function dailyMoveBand(candidate, rules = riskAwareRules) {
  const ret1 = number(candidate.ret1);
  if (!finite(ret1)) return { kind: 'rejected', reason: '缺少单日涨跌幅' };
  if (ret1 >= rules.minRet1 && ret1 <= rules.maxRet1) return { kind: 'standard', reason: '常规涨跌区间 -3%—4%' };
  if (ret1 >= rules.pullbackRet1Min && ret1 < rules.minRet1) {
    return { kind: 'pullback-shadow', reason: '强趋势回调 -5%—-3%，仅影子观察、不自动买入' };
  }
  if (ret1 > rules.maxRet1 && ret1 <= rules.breakoutRet1Max) {
    const high = number(candidate.high), low = number(candidate.low), last = number(candidate.last);
    const closeLocation = high > low ? (last - low) / (high - low) : 0;
    if (number(candidate.volRatio) <= rules.breakoutMaxVolumeRatio
      && number(candidate.atr20Pct) <= rules.breakoutMaxAtr20Pct
      && closeLocation >= rules.breakoutMinCloseLocation) {
      return { kind: 'breakout', reason: '健康突破 4%—6%，量能、波动与收盘位置确认' };
    }
    return { kind: 'rejected', reason: '4%—6%突破缺少低量比、低波动或强收盘确认' };
  }
  return { kind: 'rejected', reason: '单日涨跌超出分档交易区间' };
}

export function candidateGate(candidate, rules = riskAwareRules) {
  const required = ['ret20', 'ret1', 'volRatio', 'trendEfficiency', 'atr20Pct', 'averageTurnover20', 'last', 'ma20', 'ma60', 'ma20Slope5'];
  const missing = required.filter((key) => !finite(candidate[key]));
  if (missing.length) return { allowed: false, reason: `缺少字段: ${missing.join(', ')}` };
  // IPOs can remain in the short-term hotspot view, but cannot enter a
  // MA60-based trend strategy before enough adjusted daily history exists.
  if (candidate.historyBars != null && (!finite(candidate.historyBars) || number(candidate.historyBars) < rules.minTrendHistoryBars)) {
    return { allowed: false, reason: `上市时间不足：仅 ${candidate.historyBars} 根复权日线，趋势策略至少需要 ${rules.minTrendHistoryBars} 根` };
  }
  if (candidate.tradeStatus !== 'Normal') return { allowed: false, reason: '证券不是正常交易状态' };
  if (['sell', 'negative', 'bearish'].includes(String(candidate.signalDirection ?? '').toLowerCase())) return { allowed: false, reason: '负向异动不得触发买入' };
  if (number(candidate.ret20) < rules.minRet20 || number(candidate.ret20) > rules.maxRet20) return { allowed: false, reason: '20日收益超出5%—25%区间' };
  const moveBand = dailyMoveBand(candidate, rules);
  if (moveBand.kind === 'pullback-shadow') return { allowed: false, reason: moveBand.reason };
  if (moveBand.kind === 'rejected') return { allowed: false, reason: moveBand.reason };
  if (number(candidate.volRatio) < rules.minVolumeRatio || number(candidate.volRatio) > rules.maxVolumeRatio) return { allowed: false, reason: '量比超出0.8—2.0区间' };
  if (number(candidate.atr20Pct) > rules.maxAtr20Pct) return { allowed: false, reason: 'ATR20波动率超过5%' };
  if (number(candidate.averageTurnover20) < rules.minAverageTurnover20) return { allowed: false, reason: '20日平均成交额低于2亿元' };
  if (!(number(candidate.last) > number(candidate.ma20) && number(candidate.ma20) > number(candidate.ma60) && number(candidate.ma20Slope5) > 0)) return { allowed: false, reason: '未满足 close > MA20 > MA60 且MA20向上' };
  return { allowed: true, reason: `风险感知趋势门槛通过；${moveBand.reason}`, dailyMoveBand: moveBand.kind };
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
  const evaluated = candidates.map((candidate) => ({ candidate, gate: candidateGate(candidate, rules) }));
  return {
    regime,
    eligible: evaluated.filter((item) => item.gate.allowed).map((item) => ({
      ...item.candidate,
      riskAwareScore: Number(Math.max(0, candidateScore(item.candidate) - (regime.allowed ? 0 : rules.weakRegimeScorePenalty)).toFixed(2)),
      gateReason: regime.allowed ? item.gate.reason : `${item.gate.reason}；宽基趋势偏弱，候选降分但不禁止买入`,
      regimeAdjusted: !regime.allowed,
    })).sort((a, b) => b.riskAwareScore - a.riskAwareScore),
    rejected: evaluated.filter((item) => !item.gate.allowed).map((item) => ({ symbol: item.candidate.symbol, ...item.gate })),
  };
}

export function portfolioRiskState({ drawdownPct, dailyReturnPct }, rules = riskAwareRules) {
  if (number(drawdownPct) <= rules.drawdownHaltPct) return { state: 'WATCH', allowBuys: true, maxTotalPosition: rules.maxTotalPosition, reason: '回撤达到5%，仅作风险提示；继续依据大盘、热点和个股信号交易' };
  if (number(drawdownPct) <= rules.drawdownRiskOffPct || number(dailyReturnPct) <= rules.dailyLossPausePct) return { state: 'WATCH', allowBuys: true, maxTotalPosition: rules.maxTotalPosition, reason: '回撤达到3%或单日亏损达到1.5%，仅作风险提示' };
  return { state: 'NORMAL', allowBuys: true, maxTotalPosition: rules.maxTotalPosition, reason: '组合风险门槛通过' };
}

export function obsoletePortfolioRiskExit(plan) {
  return plan?.side === 'SELL' && /组合回撤达到5%|组合进入RISK_OFF/.test(String(plan.reason ?? ''));
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
