// src/strategy.js
import { CONFIG } from './config.js';
import { calculateMA, detectBearishPatterns } from './indicators.js';
import {
  fetchAllTickers,
  fetchKlinesWithRetry,
  isMexcExclusive,
  mapWithRateLimit
} from './exchange.js';
import { updatePositionWithPrice, openShortPosition } from './account.js';
import { sendMessageWithAutoDelete, cleanupOldMessages } from './telegram.js';

const trackingCoins = new Map();

function formatUsd(v) {
  if (Math.abs(v) >= 1) return v.toFixed(2);
  if (Math.abs(v) >= 0.01) return v.toFixed(4);
  return v.toFixed(6);
}

// ======================================================================
// ANALYZE FOR PUMP & SHORT REVERSAL
// ======================================================================
async function analyzeForPumpAndReversal(symbol, klines, tickers) {
  if (!klines || klines.length < 15) return;

  const currentCandle = klines.at(-1);
  const currentPrice = currentCandle.close;
  const previousCandle = klines.at(-2);

  const ma10 = calculateMA(klines, 10);
  const ma5 = calculateMA(klines, 5);

  // Cập nhật PnL / DCA / TP/SL nếu có lệnh mở
  await updatePositionWithPrice(symbol, currentPrice, ma10);

  // ---------------- FETCH FUNDING & SPREAD FROM TICKER ----------------
  const ticker = tickers.find(t => t.symbol === symbol);
  if (!ticker) return;

  const bid = parseFloat(ticker.bid1 || ticker.bid || 0);
  const ask = parseFloat(ticker.ask1 || ticker.ask || 0);
  const fundingRate = parseFloat(ticker.fundingRate || 0);

  let spreadPct = 0;
  if (bid > 0 && ask > 0) spreadPct = ((ask - bid) / bid) * 100;

  const fundingPctStr = (fundingRate * 100).toFixed(4);

  const frLimitPos = CONFIG.FUNDING_RATE_LIMIT_POSITIVE ?? 0.015;  // +1.5%
  const frLimitNeg = CONFIG.FUNDING_RATE_LIMIT_NEGATIVE ?? -0.015; // -1.5%

  // Note: KHÔNG CHECK funding/spread ở đầu hàm nữa

  // ======================================================================
  // STEP 1 — DETECT PUMP → TRACKING
  // ======================================================================
  const last10 = klines.slice(-10);
  const firstPrice = last10[0].open;
  const highestPrice = Math.max(...last10.map(k => k.high));
  const pumpPct = ((highestPrice - firstPrice) / firstPrice) * 100;

  const mexcOnly = isMexcExclusive(symbol);
  const isTracked = trackingCoins.has(symbol);

  if (!isTracked) {
    let pumpThreshold = CONFIG.TRACKING_PUMP_THRESHOLD_BASE;
    if (mexcOnly) pumpThreshold += CONFIG.TRACKING_PUMP_MEXC_ONLY_DELTA;
    if (pumpThreshold < 10) pumpThreshold = 10;

    if (pumpPct >= pumpThreshold) {
      trackingCoins.set(symbol, {
        addedAt: Date.now(),
        peakPrice: highestPrice,
        peakTime: currentCandle.time,
        initialPumpPct: pumpPct,
        notifiedReversal: false
      });

      const msg =
        `🎯 *TRACKING PUMP*: [${symbol}](https://mexc.co/futures/${symbol}?type=swap)\n` +
        `Pump: +${pumpPct.toFixed(2)}%\n` +
        `Đỉnh tạm thời: $${formatUsd(highestPrice)}\n` +
        `${mexcOnly ? 'CHỈ MEXC 🟢' : 'CÓ BINANCE 🟡'}\n` +
        `Spread hiện tại: ${spreadPct.toFixed(2)}%\n` +
        `Funding hiện tại: ${fundingPctStr}%\n`;

      await sendMessageWithAutoDelete(msg, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      });
      return;
    }
    return;
  }

  // ======================================================================
  // STEP 2 — ĐANG TRACK: TÌM TÍN HIỆU ĐỈNH ĐỂ SHORT
  // ======================================================================
  const track = trackingCoins.get(symbol);

  if (currentCandle.high > track.peakPrice) {
    track.peakPrice = currentCandle.high;
    track.peakTime = currentCandle.time;
  }

  const dropFromPeak =
    ((track.peakPrice - currentPrice) / track.peakPrice) * 100;

  // Volume ratio
  const avgVol9 =
    last10.slice(0, -1).reduce((s, k) => s + k.volume, 0) /
    Math.max(1, last10.length - 1);
  const volumeRatio = currentCandle.volume / (avgVol9 || 1);

  const patterns = detectBearishPatterns(currentCandle, previousCandle);

  const consecutiveBearish =
    last10.slice(-3).every(k => k.close < k.open);

  // Double top
  let hasDoubleTop = false;
  if (klines.length >= 4) {
    const c1 = klines.at(-3);
    const c2 = klines.at(-2);
    const near1 =
      Math.abs(c1.high - track.peakPrice) / track.peakPrice <= 0.004;
    const near2 =
      Math.abs(c2.high - track.peakPrice) / track.peakPrice <= 0.004;
    if (near1 && near2 && c2.close < c2.open) hasDoubleTop = true;
  }

  const hasCrazy1mCandle = last10.some(
    k => Math.abs((k.close - k.open) / k.open) * 100 >= CONFIG.CRAZY_CANDLE_PCT
  );

  const aggressivePump =
    track.initialPumpPct >= CONFIG.STRONG_PUMP_THRESHOLD ||
    hasCrazy1mCandle ||
    (mexcOnly && track.initialPumpPct >= 25);

  const hasReversalSignal =
    dropFromPeak >= Math.abs(CONFIG.REVERSAL_CONFIRMATION_PCT);

  const hasStrongReversal =
    dropFromPeak >= Math.abs(CONFIG.STRONG_REVERSAL_PCT);

  const hasVolumeSpike = volumeRatio >= CONFIG.VOLUME_SPIKE_RATIO;

  const hasBearishPattern =
    patterns.isShootingStar ||
    patterns.isBearishEngulfing ||
    patterns.isEveningStar;

  // Early top
  const upperWick =
    currentCandle.high - Math.max(currentCandle.open, currentCandle.close);
  const bodySize = Math.abs(
    currentCandle.close - currentCandle.open
  );
  const upperWickRatio = bodySize > 0 ? upperWick / bodySize : 0;
  const nearPeakNow =
    Math.abs(currentCandle.high - track.peakPrice) /
      track.peakPrice <=
    0.006;

  const closeWeak =
    currentCandle.close < currentCandle.open ||
    currentCandle.close < ma5;

  const earlyTopSignal =
    nearPeakNow &&
    upperWickRatio >= 2 &&
    closeWeak &&
    volumeRatio >= 1.8;

  const reversalTriggered =
    hasReversalSignal || (earlyTopSignal && dropFromPeak >= 1.5);

  if (!track.notifiedReversal && reversalTriggered) {
    // ======================================================================
    // STEP 3 — TÍNH CONFIDENCE
    // ======================================================================
    let confidence = 0;

    // Strength
    if (hasStrongReversal) confidence += 35;
    else if (dropFromPeak >= CONFIG.REVERSAL_CONFIRMATION_PCT)
      confidence += 25;
    else if (dropFromPeak >= 2) confidence += 15;

    // Early top
    if (earlyTopSignal) confidence += 25;

    // Candle patterns
    if (hasBearishPattern) confidence += 20;
    if (hasDoubleTop) confidence += 20;

    // Volume, MA, momentum
    if (hasVolumeSpike) confidence += 20;
    if (currentPrice < ma5 && currentPrice < ma10) confidence += 15;
    if (consecutiveBearish) confidence += 15;

    // Ưu tiên MEXC-only
    if (mexcOnly) confidence += 10;

    const minConf = aggressivePump
      ? (mexcOnly ? 45 : 50)
      : 65;

    if (confidence < minConf) return;

    // ======================================================================
    // STEP 4 — GỬI TÍN HIỆU SHORT
    // ======================================================================
    const target1Pct = dropFromPeak * 1.3;
    const target2Pct = dropFromPeak * 1.8;

    const target1Price =
      currentPrice * (1 - target1Pct / 100);
    const target2Price =
      currentPrice * (1 - target2Pct / 100);

    const patternsText = [];
    if (patterns.isShootingStar) patternsText.push('Shooting Star');
    if (patterns.isBearishEngulfing) patternsText.push('Bearish Engulfing');
    if (patterns.isEveningStar) patternsText.push('Evening Star');
    if (hasDoubleTop) patternsText.push('Double Top');
    if (earlyTopSignal && !patterns.isShootingStar)
      patternsText.push('Long Upper Wick Near Peak');

    const msg =
      `🔻 *TÍN HIỆU SHORT*: [${symbol}](https://mexc.co/futures/${symbol}?type=swap)\n\n` +
      `• Pump gốc: +${track.initialPumpPct.toFixed(2)}%\n` +
      `• Giảm từ đỉnh: ${dropFromPeak.toFixed(2)}%\n` +
      `• Giá hiện tại: $${formatUsd(currentPrice)}\n` +
      `• Volume: x${volumeRatio.toFixed(1)}\n` +
      `• MA: ${
        currentPrice < ma5 && currentPrice < ma10
          ? 'Giá đã chui xuống MA5/10'
          : 'Chưa gãy MA'
      }\n` +
      `• Momentum: ${
        consecutiveBearish ? '3 nến đỏ' : 'Hỗn hợp'
      }\n` +
      (patternsText.length
        ? `• Pattern: ${patternsText.join(', ')}\n`
        : '') +
      (earlyTopSignal
        ? '• Early-top: wick dài + volume dày\n'
        : '') +
      `• Spread: ${spreadPct.toFixed(2)}%\n` +
      `• Funding: ${fundingPctStr}%\n`;

    await sendMessageWithAutoDelete(msg, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    });

    track.notifiedReversal = true;

    // ======================================================================
    // STEP 5 — SAU TÍN HIỆU SHORT: CHECK FUNDING + SPREAD
    // ======================================================================
    if (spreadPct >= CONFIG.MAX_SPREAD_PCT) {
      await sendMessageWithAutoDelete(
        `⚠️ Spread ${spreadPct.toFixed(
          2
        )}% quá lớn → KHÔNG mở SHORT ${symbol}`
      );
      return;
    }

    if (fundingRate > frLimitPos) {
      await sendMessageWithAutoDelete(
        `⚠️ Funding ${fundingPctStr}% > +${(
          frLimitPos * 100
        ).toFixed(2)}% → KHÔNG mở SHORT ${symbol}`
      );
      return;
    }

    if (fundingRate < frLimitNeg) {
      await sendMessageWithAutoDelete(
        `⚠️ Funding ${fundingPctStr}% < ${(
          frLimitNeg * 100
        ).toFixed(2)}% → KHÔNG mở SHORT ${symbol}`
      );
      return;
    }

    // ======================================================================
    // STEP 6 — MỞ LỆNH SHORT
    // ======================================================================
    const reason =
      `pump ${track.initialPumpPct.toFixed(1)}% | drop ${dropFromPeak.toFixed(
        1
      )}% | conf ${confidence}% | ` +
      `FR ${fundingPctStr}% | SP ${spreadPct.toFixed(2)}%`;

    await openShortPosition(symbol, currentPrice, reason);
  }

  // ======================================================================
  // STOP TRACKING AFTER 30 MINUTES OR IF DUMP TOO DEEP
  // ======================================================================
  const trackingDuration = Date.now() - track.addedAt;
  if (
    trackingDuration > 30 * 60 * 1000 ||
    dropFromPeak > 30
  ) {
    trackingCoins.delete(symbol);
  }
}

// ======================================================================
// MAIN LOOP
// ======================================================================
export async function checkAndAlert() {
  const tickers = await fetchAllTickers();
  if (!tickers?.length) return;

  console.log(
    `🔍 Quét ${tickers.length} coin | Tracking: ${trackingCoins.size}`
  );

  const symbols = tickers.map(t => t.symbol);

  await mapWithRateLimit(symbols, async symbol => {
    const klines = await fetchKlinesWithRetry(symbol);
    if (klines?.length >= 15)
      await analyzeForPumpAndReversal(symbol, klines, tickers);
  });

  await cleanupOldMessages();
}
