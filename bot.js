// bot-mexc-pump-alert-v5.js (Tracking Pump + Phát hiện đảo chiều SHORT)
import dotenv from 'dotenv';
import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import https from 'https';

dotenv.config();

// === CẤU HÌNH ===
const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const pollInterval = parseInt(process.env.POLL_INTERVAL) || 5000;
const alertCooldown = 30000;
const axiosTimeout = 8000;
const klineLimit = 20;
const maxConcurrentRequests = 8;
const maxRequestsPerSecond = 8;
const messageLifetime = 2 * 60 * 60 * 1000;
const MIN_VOLUME_USDT = parseFloat(process.env.MIN_VOLUME_USDT) || 150000;

// Ngưỡng pump để tracking
const TRACKING_PUMP_THRESHOLD = 15; // 15% trong 10 nến
const REVERSAL_CONFIRMATION_PCT = -5; // Giảm 5% từ đỉnh để confirm đảo chiều
const STRONG_REVERSAL_PCT = -8; // Giảm 8% = tín hiệu SHORT mạnh
const VOLUME_SPIKE_RATIO = 2.5; // Volume tăng 2.5x = có áp lực bán

if (!token || !chatId) {
  console.error('❌ Thiếu TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID trong .env');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: false });
const lastAlertTimes = new Map();
const sentMessages = [];
const trackingCoins = new Map(); // Danh sách coin đang tracking
let binanceSymbols = new Set();

const axiosInstance = axios.create({
  timeout: axiosTimeout,
  httpsAgent: new https.Agent({ keepAlive: true }),
});

// === TRACKING DATA STRUCTURE ===
// trackingCoins.set(symbol, {
//   addedAt: timestamp,
//   peakPrice: number,
//   peakTime: timestamp,
//   initialPumpPct: number,
//   notifiedReversal: boolean
// })

// === HÀM HỖ TRỢ ===
function calculateMA(klines, period) {
  if (klines.length < period) return null;
  const closes = klines.slice(-period).map(k => k.close);
  return closes.reduce((a, b) => a + b) / period;
}

function detectBearishPatterns(candle, previousCandle) {
  // Shooting Star: Nến có bóng trên dài, thân nhỏ, close gần low
  const upperShadow = candle.high - Math.max(candle.open, candle.close);
  const lowerShadow = Math.min(candle.open, candle.close) - candle.low;
  const body = Math.abs(candle.close - candle.open);
  const totalRange = candle.high - candle.low;
  
  const isShootingStar = upperShadow > body * 2 && 
                         lowerShadow < body * 0.5 && 
                         candle.close < candle.open;
  
  // Bearish Engulfing: Nến đỏ bao trùm nến xanh trước
  const isBearishEngulfing = previousCandle && 
                             previousCandle.close > previousCandle.open &&
                             candle.close < candle.open &&
                             candle.open >= previousCandle.close &&
                             candle.close <= previousCandle.open;
  
  // Evening Star approximation: Nến đỏ mạnh sau gap up
  const isEveningStar = candle.close < candle.open && 
                        body / totalRange > 0.7 &&
                        previousCandle && previousCandle.close > previousCandle.open;
  
  return { isShootingStar, isBearishEngulfing, isEveningStar };
}

async function fetchBinanceSymbols() {
  try {
    const resp = await axiosInstance.get('https://api.binance.com/api/v3/exchangeInfo');
    if (resp.data?.symbols?.length) {
      const usdt = resp.data.symbols
        .filter(s => s.symbol.endsWith('USDT') && s.status === 'TRADING')
        .map(s => s.symbol);
      binanceSymbols = new Set(usdt);
      console.log(`✅ Đã load ${binanceSymbols.size} Binance symbols.`);
    }
  } catch (err) {
    console.warn('⚠️ Không thể load Binance symbols:', err.message);
  }
}

async function fetchAllTickers() {
  try {
    const response = await axiosInstance.get('https://contract.mexc.com/api/v1/contract/ticker');
    if (response.data?.success && Array.isArray(response.data.data)) {
      const filtered = response.data.data
        .filter(t => t.symbol?.endsWith('_USDT') && t.amount24 > MIN_VOLUME_USDT);      
      return filtered.sort((a, b) => (b.amount24 || 0) - (a.amount24 || 0));
    }
  } catch (err) {
    console.error('Lỗi fetch tickers:', err.message);
  }
  return [];
}

async function fetchKlinesWithRetry(symbol, retries = 3) {
  const now = Math.floor(Date.now() / 1000);
  const start = now - klineLimit * 60;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await axiosInstance.get(`https://contract.mexc.com/api/v1/contract/kline/${symbol}`, {
        params: { interval: 'Min1', start, end: now },
      });
      if (res.data?.success && res.data.data) {
        const { time, open, high, low, close, vol } = res.data.data;
        const klines = time.map((t, i) => {
          const o = parseFloat(open[i]);
          const h = parseFloat(high[i]);
          const l = parseFloat(low[i]);
          const c = parseFloat(close[i]);
          const v = parseFloat(vol[i]);
          const pct = ((c - o) / o) * 100;
          return { 
            time: t * 1000, 
            open: o, 
            high: h, 
            low: l, 
            close: c, 
            volume: v, 
            pct,
            isBullish: c > o,
            bodySize: Math.abs(c - o),
            totalRange: h - l
          };
        }).filter(k => !isNaN(k.pct));
        return klines.sort((a, b) => a.time - b.time);
      }
      return [];
    } catch (err) {
      const status = err.response?.status;
      if (status === 429) {
        await new Promise(r => setTimeout(r, 300 + Math.random() * 400));
        continue;
      }
      if (status === 400) return [];
      console.error(`Lỗi fetchKlines ${symbol}:`, err.message);
      return [];
    }
  }
  return [];
}

async function mapWithRateLimit(items, fn, concurrency = 8, rps = 8) {
  const results = [];
  let queue = 0;
  let lastTime = 0;
  const interval = 1000 / rps;
  async function runNext() {
    if (queue >= items.length) return;
    const i = queue++;
    const now = Date.now();
    const diff = now - lastTime;
    if (diff < interval) await new Promise(r => setTimeout(r, interval - diff));
    lastTime = Date.now();
    results[i] = await fn(items[i]);
    if (queue < items.length) await runNext();
  }
  const initial = Math.min(concurrency, items.length);
  const runners = Array.from({ length: initial }, runNext);
  await Promise.all(runners);
  return results;
}

async function sendMessageWithAutoDelete(message, options) {
  try {
    const sent = await bot.sendMessage(chatId, message, options);
    sentMessages.push({ id: sent.message_id, time: Date.now() });
  } catch (err) {
    console.error('Lỗi gửi tin nhắn:', err.message);
  }
}

async function cleanupOldMessages() {
  const now = Date.now();
  const toDelete = sentMessages.filter(m => now - m.time > messageLifetime);
  for (const msg of toDelete) {
    try { await bot.deleteMessage(chatId, msg.id); } catch {}
  }
  sentMessages.splice(0, sentMessages.length, ...sentMessages.filter(m => now - m.time <= messageLifetime));
}

// === LOGIC CHÍNH: TRACKING VÀ PHÁT HIỆN ĐẢO CHIỀU ===
async function analyzeForPumpAndReversal(symbol, klines) {
  if (!klines || klines.length < 15) return;
  
  const currentCandle = klines[klines.length - 1];
  const last10Candles = klines.slice(-10);
  
  // === BƯỚC 1: PHÁT HIỆN PUMP MẠNH ĐỂ TRACKING ===
  const firstPrice = last10Candles[0].open;
  const highestPrice = Math.max(...last10Candles.map(k => k.high));
  const pumpPct = ((highestPrice - firstPrice) / firstPrice) * 100;
  
  const isTracked = trackingCoins.has(symbol);
  
  if (!isTracked && pumpPct >= TRACKING_PUMP_THRESHOLD) {
    // Thêm vào danh sách tracking
    trackingCoins.set(symbol, {
      addedAt: Date.now(),
      peakPrice: highestPrice,
      peakTime: currentCandle.time,
      initialPumpPct: pumpPct,
      notifiedReversal: false
    });
    
    const binanceSymbol = symbol.replace('_USDT', 'USDT');
    const isMexcExclusive = !binanceSymbols.has(binanceSymbol);
    
    const alertMessage = 
      `🎯 **TRACKING PUMP**: [${symbol}](https://mexc.com/futures/${symbol}?type=swap)\n` +
      `📈 Pump: +${pumpPct.toFixed(2)}% trong 10 phút\n` +
      `💰 Đỉnh: $${highestPrice.toFixed(6)}\n` +
      `🏪 ${isMexcExclusive ? 'CHỈ MEXC 🟢' : 'CÓ BINANCE 🟡'}\n` +
      `⏳ Đang chờ tín hiệu đảo chiều...`;
    
    await sendMessageWithAutoDelete(alertMessage, { 
      parse_mode: 'Markdown', 
      disable_web_page_preview: true 
    });
    
    console.log(`🎯 Tracking: ${symbol} (Pump +${pumpPct.toFixed(2)}%)`);
    return;
  }
  
  // === BƯỚC 2: PHÂN TÍCH ĐẢO CHIỀU CHO COIN ĐANG TRACKING ===
  if (isTracked) {
    const trackData = trackingCoins.get(symbol);
    const currentPrice = currentCandle.close;
    const dropFromPeak = ((trackData.peakPrice - currentPrice) / trackData.peakPrice) * 100;
    
    // Cập nhật peak nếu giá vẫn tăng
    if (currentCandle.high > trackData.peakPrice) {
      trackData.peakPrice = currentCandle.high;
      trackData.peakTime = currentCandle.time;
    }
    
    // Tính toán volume
    const avgVolume10 = last10Candles.slice(0, -1).reduce((sum, k) => sum + k.volume, 0) / 9;
    const volumeRatio = currentCandle.volume / avgVolume10;
    
    // Phân tích nến
    const previousCandle = klines[klines.length - 2];
    const patterns = detectBearishPatterns(currentCandle, previousCandle);
    
    // Tính MA
    const ma5 = calculateMA(klines, 5);
    const ma10 = calculateMA(klines, 10);
    const priceUnderMA = currentPrice < ma5 && currentPrice < ma10;
    
    // Phân tích momentum
    const last3Candles = last10Candles.slice(-3);
    const consecutiveBearish = last3Candles.every(k => k.close < k.open);
    
    // === TIÊU CHÍ ĐẢO CHIỀU ===
    const hasReversalSignal = dropFromPeak >= REVERSAL_CONFIRMATION_PCT;
    const hasStrongReversal = dropFromPeak >= STRONG_REVERSAL_PCT;
    const hasVolumeSpike = volumeRatio >= VOLUME_SPIKE_RATIO;
    const hasBearishPattern = patterns.isShootingStar || patterns.isBearishEngulfing || patterns.isEveningStar;
    
    // === GỬI CẢNH BÁO SHORT ===
    if (!trackData.notifiedReversal && hasReversalSignal) {
      let signalStrength = '';
      let riskLevel = '';
      let confidence = 0;
      
      // Tính độ tin cậy
      if (hasStrongReversal) confidence += 35;
      else if (dropFromPeak >= REVERSAL_CONFIRMATION_PCT) confidence += 25;
      
      if (hasBearishPattern) confidence += 25;
      if (hasVolumeSpike) confidence += 20;
      if (priceUnderMA) confidence += 15;
      if (consecutiveBearish) confidence += 15;
      
      if (confidence >= 80) {
        signalStrength = 'CỰC MẠNH 🔥';
        riskLevel = 'LOW';
      } else if (confidence >= 65) {
        signalStrength = 'Ổn đi vol trung bình, có thể DCA ⚡';
        riskLevel = 'MEDIUM';
      } else if (confidence >= 50) {
        signalStrength = 'Vol nhỏ thôi nha các bố ⚠️';
        riskLevel = 'HIGH';
      } else {
        return; 
      }
      
      const binanceSymbol = symbol.replace('_USDT', 'USDT');
      const isMexcExclusive = !binanceSymbols.has(binanceSymbol);
      
      const patterns_text = [];
      if (patterns.isShootingStar) patterns_text.push('Shooting Star');
      if (patterns.isBearishEngulfing) patterns_text.push('Bearish Engulfing');
      if (patterns.isEveningStar) patterns_text.push('Evening Star');
      
      const alertMessage = 
        `🔻 **TÍN HIỆU SHORT ${signalStrength}**: [${symbol}](https://mexc.com/futures/${symbol}?type=swap)\n\n` +
        `**Phân tích:**\n` +
        `• Giảm từ đỉnh: ${dropFromPeak.toFixed(2)}% (Đỉnh: $${trackData.peakPrice.toFixed(6)})\n` +
        `• Giá hiện tại: $${currentPrice.toFixed(6)}\n` +
        `• Volume: x${volumeRatio.toFixed(1)} (${hasVolumeSpike ? 'ÁP LỰC BÁN ⚠️' : 'Bình thường'})\n` +
        `• MA: ${priceUnderMA ? 'Giá dưới MA5/MA10 ✅' : 'Giá trên MA'}\n` +
        `• Momentum: ${consecutiveBearish ? '3 nến đỏ liên tiếp ✅' : 'Hỗn hợp'}\n` +
        (patterns_text.length > 0 ? `• Pattern: ${patterns_text.join(', ')} ✅\n` : '') +
        `\n🎯 **Chiến lược:**\n` +
        `• Entry: $${currentPrice.toFixed(6)}\n` +
        `• Target 1: -${(dropFromPeak * 1.3).toFixed(2)}% ($${(currentPrice * (1 - dropFromPeak * 1.3 / 100)).toFixed(6)})\n` +
        `• Target 2: -${(dropFromPeak * 1.8).toFixed(2)}% ($${(currentPrice * (1 - dropFromPeak * 1.8 / 100)).toFixed(6)})\n` +
        `• Stop Loss: $${trackData.peakPrice.toFixed(6)} (+${((trackData.peakPrice - currentPrice) / currentPrice * 100).toFixed(2)}%)\n` +
        `\n⚡ **Risk Level: ${riskLevel}**` +
        `🏪 ${isMexcExclusive ? 'KHÔNG CÓ TRÊN BINANCE 🟢' : 'CÓ BINANCE 🟡'}`;
      
      await sendMessageWithAutoDelete(alertMessage, { 
        parse_mode: 'Markdown', 
        disable_web_page_preview: true 
      });
      
      trackData.notifiedReversal = true;
      console.log(`🔔 SHORT SIGNAL: ${symbol} (Giảm ${dropFromPeak.toFixed(2)}%, Confidence: ${confidence}%)`);
    }
    
    // Xóa khỏi tracking sau 30 phút hoặc đã giảm quá sâu
    const trackingDuration = Date.now() - trackData.addedAt;
    if (trackingDuration > 30 * 60 * 1000 || dropFromPeak > 30) {
      trackingCoins.delete(symbol);
      console.log(`✅ Dừng tracking: ${symbol}`);
    }
  }
}

async function checkAndAlert() {
  const tickers = await fetchAllTickers();
  if (!tickers?.length) {
    console.log('⚠️ Không có tickers.');
    return;
  }
  console.log(`🔍 Quét ${tickers.length} coin | Tracking: ${trackingCoins.size} coin`);
  
  const symbols = tickers.map(t => t.symbol);
  await mapWithRateLimit(symbols, async (symbol) => {
    const klines = await fetchKlinesWithRetry(symbol);
    if (klines?.length >= 15) await analyzeForPumpAndReversal(symbol, klines);
  }, maxConcurrentRequests, maxRequestsPerSecond);
  
  await cleanupOldMessages();
}

(async () => {
  console.log('🚀 Khởi động bot PUMP TRACKING + REVERSAL DETECTION v5...');
  console.log(`📊 Tracking pump >= ${TRACKING_PUMP_THRESHOLD}% trong 10 phút`);
  console.log(`🔻 Tín hiệu SHORT khi giảm >= ${REVERSAL_CONFIRMATION_PCT}% từ đỉnh`);
  await fetchBinanceSymbols();
  await checkAndAlert();
  setInterval(checkAndAlert, pollInterval);
  console.log(`🔁 Polling mỗi ${pollInterval / 1000} giây`);
})();