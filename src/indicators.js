// src/indicators.js
export function calculateMA(klines, period) {
  if (!klines || klines.length < period) return null;
  const closes = klines.slice(-period).map(k => k.close);
  return closes.reduce((a, b) => a + b, 0) / closes.length;
}

export function detectBearishPatterns(candle, previousCandle) {
  const upperShadow = candle.high - Math.max(candle.open, candle.close);
  const lowerShadow = Math.min(candle.open, candle.close) - candle.low;
  const body = Math.abs(candle.close - candle.open);
  const totalRange = candle.high - candle.low;

  const isShootingStar =
    upperShadow > body * 2 &&
    lowerShadow < body * 0.5 &&
    candle.close < candle.open;

  const isBearishEngulfing =
    previousCandle &&
    previousCandle.close > previousCandle.open &&
    candle.close < candle.open &&
    candle.open >= previousCandle.close &&
    candle.close <= previousCandle.open;

  const isEveningStar =
    candle.close < candle.open &&
    totalRange > 0 &&
    body / totalRange > 0.7 &&
    previousCandle &&
    previousCandle.close > previousCandle.open;

  return { isShootingStar, isBearishEngulfing, isEveningStar };
}
