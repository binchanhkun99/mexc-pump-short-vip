// src/strategy.js - ĐÃ SỬA THEO LOGIC CHECK FILTERS SAU TÍN HIỆU
import { CONFIG } from './config.js';
import { calculateMA, detectBearishPatterns } from './indicators.js';
import {
  fetchAllTickers,
  fetchKlinesWithRetry,
  isMexcExclusive,
  mapWithRateLimit,
  checkTradingFilters,
  getListingDays
} from './exchange.js';
import { logTrade, logDebug } from './logger.js';

import { updatePositionWithPrice, openShortPosition } from './account.js';
import { sendMessageWithAutoDelete, cleanupOldMessages } from './telegram.js';

const trackingCoins = new Map();
const pumpCooldown = new Map(); // Track các coin vừa pump

function formatUsd(v) {
  if (Math.abs(v) >= 1) return v.toFixed(2);
  if (Math.abs(v) >= 0.01) return v.toFixed(4);
  return v.toFixed(6);
}

// ======================================================================
// ANALYZE FOR PUMP & SHORT REVERSAL - FILTERS CHECK SAU TÍN HIỆU
// ======================================================================
async function analyzeForPumpAndReversal(symbol, klines, tickers) {
  if (!klines || klines.length < 15) return;

   // CHECK PUMP COOLDOWN: Nếu coin vừa pump trong 10p qua -> bỏ qua
  if (pumpCooldown.has(symbol)) {
    const pumpTime = pumpCooldown.get(symbol);
    const cooldownMs = 10 * 60 * 1000; // 10p
    if (Date.now() - pumpTime < cooldownMs) {
      return; // Bỏ qua coin này trong pump cooldown
    } else {
      pumpCooldown.delete(symbol); // Hết cooldown
    }
  }

  const currentCandle = klines.at(-1);
  const currentPrice = currentCandle.close;
  const previousCandle = klines.at(-2);

  const ma10 = calculateMA(klines, 10);
  const ma5 = calculateMA(klines, 5);

  // Cập nhật PnL / DCA / TP/SL nếu có lệnh mở
  const { positions } = await import('./account.js');
  if (positions.has(symbol)) {
    await updatePositionWithPrice(symbol, currentPrice, ma10);
  }
  // ---------------- FETCH FUNDING & SPREAD FROM TICKER ----------------
  const ticker = tickers.find(t => t.symbol === symbol);
  if (!ticker) return;

  const bid = parseFloat(ticker.bid1 || ticker.bid || 0);
  const ask = parseFloat(ticker.ask1 || ticker.ask || 0);
  const fundingRate = parseFloat(ticker.fundingRate || 0);
  const volume24h = parseFloat(ticker.amount24 || 0);

  let spreadPct = 0;
  if (bid > 0 && ask > 0) spreadPct = ((ask - bid) / bid) * 100;

  const fundingPctStr = (fundingRate * 100).toFixed(4);

  const frLimitPos = CONFIG.FUNDING_RATE_LIMIT_POSITIVE ?? 0.015;
  const frLimitNeg = CONFIG.FUNDING_RATE_LIMIT_NEGATIVE ?? -0.015;

  // ======================================================================
  // STEP 1 — DETECT PUMP → TRACKING (KHÔNG CHECK FILTERS Ở ĐÂY)
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
       // THÊM VÀO PUMP COOLDOWN (quan trọng)
      pumpCooldown.set(symbol, Date.now());
      // CHỈ LƯU VOLUME24H, KHÔNG CHECK FILTERS KHI TRACKING
      trackingCoins.set(symbol, {
        addedAt: Date.now(),
        peakPrice: highestPrice,
        peakTime: currentCandle.time,
        initialPumpPct: pumpPct,
        notifiedReversal: false,
        volume24h: volume24h // Lưu volume để sau này check
      });

      const msg =
        `🎯 *TRACKING PUMP*: [${symbol}](https://mexc.co/futures/${symbol}?type=swap)\n` +
        `Pump: +${pumpPct.toFixed(2)}%\n` +
        `Đỉnh tạm thời: $${formatUsd(highestPrice)}\n` +
        `Volume 24h: $${(volume24h / 1000000).toFixed(1)}M\n` +
        `${mexcOnly ? 'KHÔNG CÓ TRÊN BINANCE 🟢' : 'CÓ BINANCE 🟡'}\n` +
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
    const confidenceReasons = []; // ĐẢM BẢO LUÔN ĐƯỢC ĐỊNH NGHĨA

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
// THÊM VÀO FILE LOG
logDebug(`Confidence analysis for ${symbol}`, {
  confidence: confidence,
  required: minConf,
  reasons: confidenceReasons,
  pumpPct: track.initialPumpPct,
  dropFromPeak: dropFromPeak
});
if (confidence < minConf) {
  logDebug(`Confidence too low for ${symbol}`, {
    confidence: confidence,
    required: minConf,
    difference: minConf - confidence
  });
  return;
}
    const bottomCheck = await checkBottomFilter(symbol, currentPrice);

    if (!bottomCheck.safe) {
      // Gửi cảnh báo chi tiết
      const alertMsg = 
        `🚫 **BOTTOM FILTER BLOCKED**\n` +
        `[${symbol}](https://mexc.co/futures/${symbol}?type=swap)\n\n` +
        `• ${bottomCheck.reason}\n` +
        `• Current: $${formatUsd(currentPrice)}\n` +
        `• 7-Day Bottom: $${formatUsd(bottomCheck.bottomPrice)}\n` +
        `• Required: >${CONFIG.MIN_ABOVE_BOTTOM_PCT}% ($${formatUsd(bottomCheck.bottomPrice * (1 + CONFIG.MIN_ABOVE_BOTTOM_PCT/100))})\n` +
        `• Position in 7-day range: ${bottomCheck.positionInRange}%\n\n` +
        `⚠️ **KHÔNG SHORT** - Giá quá gần đáy 7 ngày, rủi ro cao!`;
      
      await sendMessageWithAutoDelete(alertMsg, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      });
      
      // Xóa khỏi tracking và DỪNG xử lý
      trackingCoins.delete(symbol);
      console.log(`[BOTTOM_BLOCK] ${symbol}: Only +${bottomCheck.aboveBottomPct}% above bottom`);
      return; 
    }

    console.log(`✅ [BOTTOM_PASS] ${symbol}: +${bottomCheck.aboveBottomPct}% above 7-day bottom`);

    // ======================================================================
    // STEP 4 — GỬI TÍN HIỆU SHORT (VẪN CHƯA CHECK FILTERS)
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
      `• Confidence: ${confidence}%\n` +
      `• Volume 24h: $${(track.volume24h / 1000000).toFixed(1)}M\n` +
      `• Spread: ${spreadPct.toFixed(2)}%\n` +
      `• Funding: ${fundingPctStr}%\n`;

    await sendMessageWithAutoDelete(msg, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    });

    track.notifiedReversal = true;

    // ======================================================================
    // STEP 5 — SAU TÍN HIỆU SHORT: CHECK FILTERS & CONDITIONS (CHECK Ở ĐÂY)
    // ======================================================================

    // CHECK VOLUME & LISTING DAYS FILTERS (GIỐNG NHƯ FUNDING/SPREAD)
    const filters = await checkTradingFilters(symbol, track.volume24h);
    if (!filters.volumeOk || !filters.listingOk) {
      await sendMessageWithAutoDelete(
        `🚫 FILTER BLOCK: [${symbol}](https://mexc.co/futures/${symbol}?type=swap)\n` +
        `Lý do: ${filters.reasons.join(', ')}`,
        {
          parse_mode: 'Markdown',
          disable_web_page_preview: true
        }
      );
      trackingCoins.delete(symbol);
      return;
    }

    if (spreadPct >= CONFIG.MAX_SPREAD_PCT) {
      await sendMessageWithAutoDelete(
        `⚠️ Spread ${spreadPct.toFixed(2)}% quá lớn → KHÔNG mở SHORT ${symbol}`
      );
      return;
    }

    if (fundingRate > frLimitPos) {
      await sendMessageWithAutoDelete(
        `⚠️ Funding ${fundingPctStr}% > +${(frLimitPos * 100).toFixed(2)}% → KHÔNG mở SHORT ${symbol}`
      );
      return;
    }

    if (fundingRate < frLimitNeg) {
      await sendMessageWithAutoDelete(
        `⚠️ Funding ${fundingPctStr}% < ${(frLimitNeg * 100).toFixed(2)}% → KHÔNG mở SHORT ${symbol}`
      );
      return;
    }

    // ======================================================================
    // STEP 6 — MỞ LỆNH SHORT (TẤT CẢ FILTERS ĐÃ PASS)
    // ======================================================================
    const listingDays = await getListingDays(symbol);
    const reason =
      `pump ${track.initialPumpPct.toFixed(1)}% | drop ${dropFromPeak.toFixed(1)}% | conf ${confidence}% | ` +
      `FR ${fundingPctStr}% | SP ${spreadPct.toFixed(2)}% | Vol ${(track.volume24h / 1000000).toFixed(1)}M | List ${listingDays.toFixed(1)}d`;

    await openShortPosition(symbol, currentPrice, reason);
    
    // Xóa khỏi tracking sau khi vào lệnh thành công
    trackingCoins.delete(symbol);
  }

  // ======================================================================
  // STOP TRACKING AFTER 30 MINUTES OR IF DUMP TOO DEEP
  // ======================================================================
  const trackingDuration = Date.now() - track.addedAt;
  if (
    trackingDuration > 30 * 60 * 1000 ||
    dropFromPeak > 30
  ) {
    console.log(`⏹️ Stop tracking ${symbol}: duration=${(trackingDuration/60000).toFixed(1)}min, drop=${dropFromPeak.toFixed(1)}%`);
    trackingCoins.delete(symbol);
  }
}

// ======================================================================
// CLEANUP OLD TRACKING COINS
// ======================================================================
function cleanupOldTrackingCoins() {
  const now = Date.now();
 const maxTrackingTime = 30 * 60 * 1000; // 30 phút (tracking timeout)
  const maxPumpCooldownTime = 20 * 60 * 1000; // 20 phút (cleanup cooldown cũ)
  
  // Cleanup tracking cũ
  for (const [symbol, track] of trackingCoins.entries()) {
    if (now - track.addedAt > maxTrackingTime) {
      console.log(`🧹 Cleanup tracking ${symbol} (expired)`);
      trackingCoins.delete(symbol);
    }
  }
  
  // Cleanup pump cooldown cũ
  for (const [symbol, pumpTime] of pumpCooldown.entries()) {
    if (now - pumpTime > maxPumpCooldownTime) {
      pumpCooldown.delete(symbol);
      console.log(`🧹 Cleanup pump cooldown ${symbol}`);
    }
  }
}

// ======================================================================
// MAIN LOOP - ĐÃ THÊM CLEANUP
// ======================================================================
export async function checkAndAlert() {
  try {
    const tickers = await fetchAllTickers();
    if (!tickers?.length) {
      console.log('⏳ Không lấy được tickers, bỏ qua cycle này');
      return;
    }

    console.log(
      `🔍 Quét ${tickers.length} coin | Tracking: ${trackingCoins.size}`
    );

    const symbols = tickers.map(t => t.symbol);

    await mapWithRateLimit(symbols, async symbol => {
      try {
        const klines = await fetchKlinesWithRetry(symbol);
        if (klines?.length >= 15) {
          await analyzeForPumpAndReversal(symbol, klines, tickers);
        }
      } catch (err) {
        console.error(`❌ Lỗi analyze ${symbol}:`, err.message);
      }
    });

    // Cleanup old tracking coins
    cleanupOldTrackingCoins();

    await cleanupOldMessages();

  } catch (err) {
    console.error('❌ Lỗi main loop:', err);
  }
}

// Utility function để xem trạng thái tracking
export function getTrackingStatus() {
  const status = [];
  for (const [symbol, track] of trackingCoins.entries()) {
    status.push({
      symbol,
      pumpPct: track.initialPumpPct,
      addedAt: new Date(track.addedAt).toLocaleTimeString(),
      notified: track.notifiedReversal,
      volume: track.volume24h
    });
  }
  return status;
}

// Manual cleanup function (cho testing)
export function cleanupAllTracking() {
  const count = trackingCoins.size;
  trackingCoins.clear();
  console.log(`🧹 Đã xóa ${count} coins khỏi tracking`);
  return count;
}