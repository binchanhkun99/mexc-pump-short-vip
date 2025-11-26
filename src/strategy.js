// src/strategy.js
import { CONFIG } from './config.js';
import { calculateMA, detectBearishPatterns } from './indicators.js';
import {
  fetchAllTickers,
  fetchKlinesWithRetry,
  isMexcExclusive,
  mapWithRateLimit,
} from './exchange.js';
import { updatePositionWithPrice, openShortPosition } from './account.js';
import { sendMessageWithAutoDelete, cleanupOldMessages } from './telegram.js';

const trackingCoins = new Map(); // symbol -> { addedAt, peakPrice, peakTime, initialPumpPct, notifiedReversal }

function formatUsd(v) {
  if (Math.abs(v) >= 1) return v.toFixed(2);
  if (Math.abs(v) >= 0.01) return v.toFixed(4);
  return v.toFixed(6);
}

// -------- PHÂN TÍCH CHIẾN LƯỢC CHO MỖI COIN --------
async function analyzeForPumpAndReversal(symbol, klines) {
  if (!klines || klines.length < 15) return;

  const mexcOnly = isMexcExclusive(symbol);

  const currentCandle = klines[klines.length - 1];
  const currentPrice = currentCandle.close;
  const ma10 = calculateMA(klines, 10);

  // Cập nhật PnL / DCA / TP / SL nếu đang có lệnh
  await updatePositionWithPrice(symbol, currentPrice, ma10);

  const last10 = klines.slice(-10);
  const firstPrice = last10[0].open;
  const highestPrice = Math.max(...last10.map(k => k.high));
  const pumpPct = ((highestPrice - firstPrice) / firstPrice) * 100;

  const isTracked = trackingCoins.has(symbol);

  // -------- BƯỚC 1: PHÁT HIỆN PUMP ĐỂ TRACK --------
  if (!isTracked) {
    let pumpThreshold = CONFIG.TRACKING_PUMP_THRESHOLD_BASE;
    if (mexcOnly) pumpThreshold += CONFIG.TRACKING_PUMP_MEXC_ONLY_DELTA; // mexc-only dễ đẩy láo hơn

    // không để quá thấp
    if (pumpThreshold < 10) pumpThreshold = 10;

    if (pumpPct >= pumpThreshold) {
      trackingCoins.set(symbol, {
        addedAt: Date.now(),
        peakPrice: highestPrice,
        peakTime: currentCandle.time,
        initialPumpPct: pumpPct,
        notifiedReversal: false,
      });

      const alertMessage =
        `🎯 *TRACKING PUMP*: [${symbol}](https://mexc.co/futures/${symbol}?type=swap)\n` +
        `Pump: +${pumpPct.toFixed(2)}% trong 10 phút\n` +
        `Đỉnh tạm thời: $${formatUsd(highestPrice)}\n` +
        `${mexcOnly ? 'CHỈ MEXC 🟢 ' : 'CÓ BINANCE 🟡'}\n` +
        `Đang chờ tín hiệu đảo chiều...`;

      await sendMessageWithAutoDelete(alertMessage, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      });

      console.log(`🎯 Tracking: ${symbol} (Pump +${pumpPct.toFixed(2)}%)`);
      return;
    }
    return;
  }

  // -------- BƯỚC 2: ĐANG TRACK -> TÌM ĐIỂM ĐẢO CHIỀU --------
  const trackData = trackingCoins.get(symbol);

  // cập nhật đỉnh nếu có nến cao hơn
  if (currentCandle.high > trackData.peakPrice) {
    trackData.peakPrice = currentCandle.high;
    trackData.peakTime = currentCandle.time;
  }

  const dropFromPeak = ((trackData.peakPrice - currentPrice) / trackData.peakPrice) * 100;

  // ---------- VOLUME ----------
  const avgVol9 =
    last10.slice(0, -1).reduce((sum, k) => sum + k.volume, 0) / Math.max(1, last10.length - 1);
  const volumeRatio = currentCandle.volume / (avgVol9 || 1);

  // ----- FIX BUG: crazy pump candle (không dùng k.pct nữa) -----
  const hasCrazy1mCandle =
    last10.some(k => Math.abs((k.close - k.open) / k.open) * 100 >= CONFIG.CRAZY_CANDLE_PCT);

  const previousCandle = klines[klines.length - 2];
  const patterns = detectBearishPatterns(currentCandle, previousCandle);

  const ma5 = calculateMA(klines, 5);
  const priceUnderMA = currentPrice < ma5 && currentPrice < ma10;

  const last3 = last10.slice(-3);
  const consecutiveBearish = last3.every(k => k.close < k.open);

  // ------------ DOUBLE TOP ------------
  let hasDoubleTop = false;
  if (klines.length >= 4) {
    const c1 = klines[klines.length - 3];
    const c2 = klines[klines.length - 2];
    const nearPeak1 = Math.abs(c1.high - trackData.peakPrice) / trackData.peakPrice <= 0.004;
    const nearPeak2 = Math.abs(c2.high - trackData.peakPrice) / trackData.peakPrice <= 0.004;
    if (nearPeak1 && nearPeak2 && c2.close < c2.open) hasDoubleTop = true;
  }

  const aggressivePump =
    trackData.initialPumpPct >= CONFIG.STRONG_PUMP_THRESHOLD ||
    hasCrazy1mCandle ||
    (mexcOnly && trackData.initialPumpPct >= 25);

  const hasReversalSignal = dropFromPeak >= Math.abs(CONFIG.REVERSAL_CONFIRMATION_PCT);
  const hasStrongReversal = dropFromPeak >= Math.abs(CONFIG.STRONG_REVERSAL_PCT);
  const hasVolumeSpike = volumeRatio >= CONFIG.VOLUME_SPIKE_RATIO;
  const hasBearishPattern =
    patterns.isShootingStar || patterns.isBearishEngulfing || patterns.isEveningStar;

  // ---------- TÍN HIỆU TÂM LÝ "SẮP XẢ" (đỉnh thật sau tracking) ----------
  const upperWick = currentCandle.high - Math.max(currentCandle.open, currentCandle.close);
  const bodySize = Math.abs(currentCandle.close - currentCandle.open);
  const upperWickRatio = bodySize > 0 ? upperWick / bodySize : 0;

  const nearPeakNow =
    Math.abs(currentCandle.high - trackData.peakPrice) / trackData.peakPrice <= 0.006; // ~0.6%

  const closeWeak = currentCandle.close < currentCandle.open || currentCandle.close < ma5;

  const earlyTopSignal =
    nearPeakNow &&
    upperWickRatio >= 2 && // bóng trên dài gấp đôi thân
    closeWeak &&
    volumeRatio >= 1.8; // volume phải dày hơn bình thường

  // Cho phép trigger đảo chiều nếu:
  //  - giá giảm >= REVERSAL_CONFIRMATION_PCT từ đỉnh (logic cũ)
  //  - HOẶC có earlyTopSignal và đã giảm ít nhất ~1.5% (đỉnh thật xuất hiện sau tracking)
  const reversalTriggered =
    hasReversalSignal || (earlyTopSignal && dropFromPeak >= 1.5);

  if (!trackData.notifiedReversal && reversalTriggered) {
    let confidence = 0;

    // Strength core theo mức giảm
    if (hasStrongReversal) confidence += 35;
    else if (dropFromPeak >= Math.abs(CONFIG.REVERSAL_CONFIRMATION_PCT)) confidence += 25;
    else if (dropFromPeak >= 2) confidence += 15;

    // Early top (wick dài + volume dày gần đỉnh)
    if (earlyTopSignal) confidence += 25;

    // Nến
    if (hasBearishPattern) confidence += 20;
    if (hasDoubleTop) confidence += 20;

    // Volume & MA & momentum
    if (hasVolumeSpike) confidence += 20;
    if (priceUnderMA) confidence += 15;
    if (consecutiveBearish) confidence += 15;

    // Ưu tiên coin chỉ MEXC vì dễ dump
    if (mexcOnly) confidence += 10;

    // Ngưỡng tối thiểu: pump đều cần chắc tay hơn pump spike
    const minConfidence = aggressivePump
      ? mexcOnly
        ? 45 // coin "lúa non" trên MEXC -> vào nhanh bắt đỉnh
        : 50
      : 65;

    if (confidence < minConfidence) return;

    let signalStrength = '';
    let riskLevel = '';

    if (confidence >= 80) {
      signalStrength = 'CỰC MẠNH 🔥';
      riskLevel = 'LOW';
    } else if (confidence >= 65) {
      signalStrength = 'KHÁ ỔN ⚡';
      riskLevel = 'MEDIUM';
    } else {
      signalStrength = 'THĂM DÒ ⚠️';
      riskLevel = 'HIGH';
    }

    const target1Pct = dropFromPeak * 1.3;
    const target2Pct = dropFromPeak * 1.8;
    const target1Price = currentPrice * (1 - target1Pct / 100);
    const target2Price = currentPrice * (1 - target2Pct / 100);

    const patternsText = [];
    if (patterns.isShootingStar) patternsText.push('Shooting Star');
    if (patterns.isBearishEngulfing) patternsText.push('Bearish Engulfing');
    if (patterns.isEveningStar) patternsText.push('Evening Star');
    if (hasDoubleTop) patternsText.push('Double Top');
    if (earlyTopSignal && !patterns.isShootingStar) patternsText.push('Long Upper Wick Near Peak');

    const msg =
      `🔻 *TÍN HIỆU SHORT ${signalStrength}*: [${symbol}](https://mexc.co/futures/${symbol}?type=swap)\n\n` +
      `**Phân tích:**\n` +
      `• Pump gốc: +${trackData.initialPumpPct.toFixed(2)}%\n` +
      `• Giảm từ đỉnh: ${dropFromPeak.toFixed(2)}% (Đỉnh: $${formatUsd(trackData.peakPrice)})\n` +
      `• Giá hiện tại: $${formatUsd(currentPrice)}\n` +
      `• Volume: x${volumeRatio.toFixed(1)} (${hasVolumeSpike ? 'XẢ MẠNH ⚠️' : 'Bình thường'})\n` +
      `• MA: ${priceUnderMA ? 'Giá đã chui xuống MA5/10 ✅' : 'Chưa gãy MA rõ ràng'}\n` +
      `• Momentum: ${consecutiveBearish ? '3 nến đỏ liên tiếp ✅' : 'Hỗn hợp'}\n` +
      (patternsText.length ? `• Pattern / tâm lý nến: ${patternsText.join(', ')} ✅\n` : '') +
      (earlyTopSignal
        ? '• Early-top: Wick trên dài gần đỉnh, volume dày → tâm lý đu đỉnh bắt đầu bị xả ❗\n'
        : '') +
      `\n🎯 *Kịch bản tham khảo:*\n` +
      `• Entry tham chiếu: $${formatUsd(currentPrice)}\n` +
      `• Target 1: -${target1Pct.toFixed(2)}% ($${formatUsd(target1Price)})\n` +
      `• Target 2: -${target2Pct.toFixed(2)}% ($${formatUsd(target2Price)})\n` +
      `• Stop kỹ thuật: $${formatUsd(
        trackData.peakPrice
      )} (+${(((trackData.peakPrice - currentPrice) / currentPrice) * 100).toFixed(2)}%)\n` +
      `\n⚡ *Risk Level*: ${riskLevel}\n` +
      `🏪 ${mexcOnly ? 'CHỈ MEXC 🟢 (ưu tiên bào mạnh)' : 'CÓ BINANCE 🟡'}\n`;

    await sendMessageWithAutoDelete(msg, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });

    trackData.notifiedReversal = true;
    console.log(
      `🔔 SHORT SIGNAL: ${symbol} (Giảm ${dropFromPeak.toFixed(
        2
      )}%, Confidence: ${confidence}%, Aggressive: ${aggressivePump}, MexcOnly: ${mexcOnly})`
    );

    // Mở lệnh short mô phỏng (account.js sẽ tự kiểm tra đã đủ 3 lệnh chưa)
    const reason =
      `${signalStrength} | pump ${trackData.initialPumpPct.toFixed(1)}% | ` +
      `dropFromPeak ${dropFromPeak.toFixed(1)}% | conf ${confidence.toFixed(
        0
      )}% | ${aggressivePump ? 'Aggressive' : 'Conservative'} | ` +
      `${mexcOnly ? 'MEXC-only' : 'With Binance'}`;

    await openShortPosition(symbol, currentPrice, reason);
  }

  // Dừng tracking sau 30 phút hoặc giảm quá sâu
  const trackingDuration = Date.now() - trackData.addedAt;
  if (trackingDuration > 30 * 60 * 1000 || dropFromPeak > 30) {
    trackingCoins.delete(symbol);
    console.log(`✅ Dừng tracking: ${symbol}`);
  }
}

// -------- VÒNG LẶP CHÍNH --------
export async function checkAndAlert() {
  const tickers = await fetchAllTickers();
  if (!tickers?.length) {
    console.log('⚠️ Không có tickers hợp lệ.');
    return;
  }

  console.log(`🔍 Quét ${tickers.length} coin | Tracking: ${trackingCoins.size}`);

  const symbols = tickers.map(t => t.symbol);
  await mapWithRateLimit(symbols, async symbol => {
    const klines = await fetchKlinesWithRetry(symbol);
    if (klines?.length >= 15) await analyzeForPumpAndReversal(symbol, klines);
  });

  await cleanupOldMessages();
}
