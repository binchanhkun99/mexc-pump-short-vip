// src/strategy.js
import { CONFIG } from './config.js';
import { calculateMA, detectBearishPatterns } from './indicators.js';
import {
  fetchAllTickers,
  fetchKlinesWithRetry,
  isMexcExclusive,
  mapWithRateLimit,
  fetchFundingRate,
} from './exchange.js';
import { updatePositionWithPrice, openShortPosition } from './account.js';
import { sendMessageWithAutoDelete, cleanupOldMessages } from './telegram.js';

const trackingCoins = new Map(); // symbol -> { addedAt, peakPrice, peakTime, initialPumpPct, notifiedReversal }

function formatUsd(v) {
  if (Math.abs(v) >= 1) return v.toFixed(2);
  if (Math.abs(v) >= 0.01) return v.toFixed(4);
  return v.toFixed(6);
}

// ============================================================
//              CHIẾN LƯỢC PHÁT HIỆN ĐẢO CHIỀU
// ============================================================
async function analyzeForPumpAndReversal(symbol, klines) {
  if (!klines || klines.length < 15) return;

  const mexcOnly = isMexcExclusive(symbol);

  const current = klines[klines.length - 1];
  const prev = klines[klines.length - 2];
  const currentPrice = current.close;
  const ma10 = calculateMA(klines, 10);

  // Update lệnh đang chạy
  await updatePositionWithPrice(symbol, currentPrice, ma10);

  const last10 = klines.slice(-10);
  const firstPrice = last10[0].open;
  const highestPrice = Math.max(...last10.map(k => k.high));
  const pumpPct = ((highestPrice - firstPrice) / firstPrice) * 100;

  const isTracked = trackingCoins.has(symbol);

  // ==============================
  //   STEP 1 — PHÁT HIỆN PUMP
  // ==============================
  if (!isTracked) {
    let pumpThreshold = CONFIG.TRACKING_PUMP_THRESHOLD_BASE;
    if (mexcOnly) pumpThreshold += CONFIG.TRACKING_PUMP_MEXC_ONLY_DELTA;
    if (pumpThreshold < 10) pumpThreshold = 10;

    if (pumpPct >= pumpThreshold) {
      trackingCoins.set(symbol, {
        addedAt: Date.now(),
        peakPrice: highestPrice,
        peakTime: current.time,
        initialPumpPct: pumpPct,
        notifiedReversal: false,
      });

      const msg =
        `🎯 *TRACKING PUMP*: [${symbol}](https://mexc.co/futures/${symbol}?type=swap)\n` +
        `Pump: +${pumpPct.toFixed(2)}%\n` +
        `Đỉnh tạm: $${formatUsd(highestPrice)}\n` +
        `${mexcOnly ? 'CHỈ MEXC 🟢' : 'CÓ BINANCE 🟡'}\n` +
        `Đang chờ đảo chiều...`;

      await sendMessageWithAutoDelete(msg, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      });

      return;
    }
    return;
  }

  // ============================================================
  //   STEP 2 — ĐANG TRACK → TÌM ĐỈNH THẬT & ĐẢO CHIỀU
  // ============================================================

  const track = trackingCoins.get(symbol);

  // Cập nhật đỉnh mới
  if (current.high > track.peakPrice) {
    track.peakPrice = current.high;
    track.peakTime = current.time;
  }

  const dropFromPeak = ((track.peakPrice - currentPrice) / track.peakPrice) * 100;

  // Volume
  const avgVol9 =
    last10.slice(0, -1).reduce((s, k) => s + k.volume, 0) /
    Math.max(1, last10.length - 1);
  const volumeRatio = current.volume / (avgVol9 || 1);

  // fix candle spike
  const hasCrazy1mCandle =
    last10.some(k => Math.abs((k.close - k.open) / k.open) * 100 >= CONFIG.CRAZY_CANDLE_PCT);

  const patterns = detectBearishPatterns(current, prev);

  const ma5 = calculateMA(klines, 5);
  const priceUnderMA = currentPrice < ma5 && currentPrice < ma10;

  const last3 = last10.slice(-3);
  const consecutiveBearish = last3.every(k => k.close < k.open);

  // Double top
  let hasDoubleTop = false;
  if (klines.length >= 4) {
    const c1 = klines[klines.length - 3];
    const c2 = klines[klines.length - 2];
    const near1 = Math.abs(c1.high - track.peakPrice) / track.peakPrice <= 0.004;
    const near2 = Math.abs(c2.high - track.peakPrice) / track.peakPrice <= 0.004;
    if (near1 && near2 && c2.close < c2.open) hasDoubleTop = true;
  }

  const aggressivePump =
    track.initialPumpPct >= CONFIG.STRONG_PUMP_THRESHOLD ||
    hasCrazy1mCandle ||
    (mexcOnly && track.initialPumpPct >= 25);

  const hasReversalSignal = dropFromPeak >= Math.abs(CONFIG.REVERSAL_CONFIRMATION_PCT);
  const hasStrongReversal = dropFromPeak >= Math.abs(CONFIG.STRONG_REVERSAL_PCT);
  const hasVolumeSpike = volumeRatio >= CONFIG.VOLUME_SPIKE_RATIO;

  const hasBearishPattern =
    patterns.isShootingStar || patterns.isBearishEngulfing || patterns.isEveningStar;

  // EARLY TOP logic
  const upperWick = current.high - Math.max(current.open, current.close);
  const body = Math.abs(current.close - current.open);
  const wickRatio = body > 0 ? upperWick / body : 0;

  const nearPeak =
    Math.abs(current.high - track.peakPrice) / track.peakPrice <= 0.006;

  const closeWeak = current.close < current.open || current.close < ma5;

  const earlyTopSignal =
    nearPeak &&
    wickRatio >= 2 &&
    closeWeak &&
    volumeRatio >= 1.8;

  const reversalTriggered =
    hasReversalSignal || (earlyTopSignal && dropFromPeak >= 1.5);

  // ============================================================
  //   STEP 3 — PHÁT TÍN HIỆU SHORT
  // ============================================================

  if (!track.notifiedReversal && reversalTriggered) {
    let confidence = 0;

    if (hasStrongReversal) confidence += 35;
    else if (dropFromPeak >= Math.abs(CONFIG.REVERSAL_CONFIRMATION_PCT)) confidence += 25;
    else if (dropFromPeak >= 2) confidence += 15;

    if (earlyTopSignal) confidence += 25;
    if (hasBearishPattern) confidence += 20;
    if (hasDoubleTop) confidence += 20;

    if (hasVolumeSpike) confidence += 20;
    if (priceUnderMA) confidence += 15;
    if (consecutiveBearish) confidence += 15;

    if (mexcOnly) confidence += 10;

    const minConfidence = aggressivePump
      ? mexcOnly ? 45 : 50
      : 65;

    if (confidence < minConfidence) return;

    const t1 = dropFromPeak * 1.3;
    const t2 = dropFromPeak * 1.8;
    const t1Price = currentPrice * (1 - t1 / 100);
    const t2Price = currentPrice * (1 - t2 / 100);

    const msg =
      `🔻 *TÍN HIỆU SHORT*: [${symbol}](https://mexc.co/futures/${symbol}?type=swap)\n\n` +
      `• Pump: +${track.initialPumpPct.toFixed(2)}%\n` +
      `• Giảm từ đỉnh: ${dropFromPeak.toFixed(2)}%\n` +
      `• Giá hiện tại: $${formatUsd(currentPrice)}\n` +
      `• Volume: x${volumeRatio.toFixed(2)}\n` +
      `• MA: ${priceUnderMA ? 'Đã chui xuống MA5/10' : 'Chưa gãy MA'}\n` +
      `• Momentum: ${consecutiveBearish ? '3 nến đỏ liên tiếp' : 'Hỗn hợp'}\n\n` +
      `🎯 Entry: $${formatUsd(currentPrice)}\n` +
      `• TP1: -${t1.toFixed(2)}% ($${formatUsd(t1Price)})\n` +
      `• TP2: -${t2.toFixed(2)}% ($${formatUsd(t2Price)})\n` +
      `• Stop: $${formatUsd(track.peakPrice)}\n`;

    await sendMessageWithAutoDelete(msg, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    });

    track.notifiedReversal = true;

    // ============================================================
    //  FUNDING RATE CHECK — KHÔNG VÀO LỆNH SHORT KHI FUNDING CAO
    // ============================================================

    let fundingRate = 0;
    try {
      fundingRate = await fetchFundingRate(symbol);
    } catch (err) {}

    if (fundingRate > CONFIG.FUNDING_RATE_LIMIT) {
      await sendMessageWithAutoDelete(
        `⚠️ Funding Rate: ${(fundingRate * 100).toFixed(2)}%\n` +
        `Không mở SHORT *${symbol}* do phí funding quá cao.`,
        { parse_mode: "Markdown" }
      );
      return; // dừng, không mở lệnh
    }

    // Mở lệnh nếu funding OK
    const reason =
      `drop ${dropFromPeak.toFixed(1)}% | conf ${confidence}% | ` +
      `${aggressivePump ? 'Aggressive' : 'Conservative'} | ` +
      `${mexcOnly ? 'MEXC-only' : 'With Binance'}`;

    await openShortPosition(symbol, currentPrice, reason);
  }

  // -------------------------
  // KẾT THÚC TRACKING
  // -------------------------
  const dur = Date.now() - track.addedAt;
  if (dur > 30 * 60000 || dropFromPeak > 30) {
    trackingCoins.delete(symbol);
  }
}

// ============================================================
//                 VÒNG LẶP CHÍNH
// ============================================================
export async function checkAndAlert() {
  const tickers = await fetchAllTickers();
  if (!tickers?.length) return;

  const symbols = tickers.map(t => t.symbol);

  await mapWithRateLimit(symbols, async symbol => {
    const klines = await fetchKlinesWithRetry(symbol);
    if (klines?.length >= 15) await analyzeForPumpAndReversal(symbol, klines);
  });

  await cleanupOldMessages();
}
