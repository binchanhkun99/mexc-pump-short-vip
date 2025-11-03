// bot-mexc-downtrend-short-improved.js
import dotenv from 'dotenv';
import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import https from 'https';

dotenv.config();

// === CẤU HÌNH CẢI TIẾN ===
const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID_DOWN_TREND;
const pollInterval = parseInt(process.env.DOWNTREND_POLL_INTERVAL) || 10000; // 10s
const alertCooldown = 30000;
const axiosTimeout = 8000;
const klineLimit = 100; // Tăng từ 60 → 100 để tính MA200 chính xác hơn
const maxConcurrentRequests = 8;
const maxRequestsPerSecond = 8;
const messageLifetime = 2 * 60 * 60 * 1000;

const MIN_VOLUME_USDT = parseFloat(process.env.DOWNTREND_MIN_VOLUME_USDT) || 100000;
const DOWNTREND_SLOPE_THRESHOLD = -0.12; // Nới lỏng từ -0.15 → -0.12
const DOWNTREND_MIN_DURATION = 30 * 60 * 1000; // Tăng từ 20 → 30 phút
const DOWNTREND_TRACKING_MAX = 90 * 60 * 1000; // Tăng từ 1h → 1.5h
const RSI_OVERSOLD_THRESHOLD = 32; // Tăng từ 25 → 32
const MAX_DISTANCE_TO_MA30_PCT = 4.0; // Tăng từ 2.0 → 4.0
const LOWER_HIGHS_WINDOW = 60; // Tăng từ 30 → 60 nến

if (!token || !chatId) {
  console.log("TL TOKEN", token);
  console.log("TL ID", chatId);
  console.error('❌ Thiếu TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID trong .env');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: false });
const sentMessages = [];
const trackedDowntrendCoins = new Map(); // { symbol → { addedAt, notified } }
let binanceSymbols = new Set();

const axiosInstance = axios.create({
  timeout: axiosTimeout,
  httpsAgent: new https.Agent({ keepAlive: true }),
});

// === HÀM HỖ TRỢ ===
function calculateMA(klines, period) {
  if (klines.length < period) return null;
  const closes = klines.slice(-period).map(k => k.close);
  return closes.reduce((a, b) => a + b, 0) / period;
}

function calculateMASlope(klines, period) {
  if (klines.length < period + 10) return null;
  const recentMA = calculateMA(klines.slice(-5), period);
  const olderMA = calculateMA(klines.slice(-10, -5), period);
  if (recentMA === null || olderMA === null || olderMA === 0) return 0;
  return ((recentMA - olderMA) / olderMA) * 100;
}

function calculateRSI(klines, period = 14) {
  if (klines.length < period + 1) return 50;
  const closes = klines.slice(-period - 1).map(k => k.close);
  const gains = [], losses = [];
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains.push(diff);
    else losses.push(-diff);
  }
  const avgGain = gains.reduce((a, b) => a + b, 0) / period;
  const avgLoss = losses.reduce((a, b) => a + b, 0) / period;
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// === CẢI TIẾN: PHÁT HIỆN LOWER HIGHS LINH HOẠT HƠN ===
function detectLowerHighs(klines, window = LOWER_HIGHS_WINDOW) {
  if (klines.length < window) return false;
  
  const recentCandles = klines.slice(-window);
  const highs = recentCandles.map(k => k.high);
  let peaks = [];
  
  // Tìm peaks với range lớn hơn và tolerance
  for (let i = 10; i < highs.length - 10; i++) {
    const leftMax = Math.max(...highs.slice(Math.max(0, i - 10), i));
    const rightMax = Math.max(...highs.slice(i + 1, Math.min(highs.length, i + 11)));
    
    // Nới lỏng: chỉ cần cao hơn 98% xung quanh
    if (highs[i] >= leftMax * 0.98 && highs[i] >= rightMax * 0.98) {
      peaks.push({ value: highs[i], index: i });
    }
  }
  
  if (peaks.length < 2) return false;
  
  // Lọc peaks gần nhau (cách nhau < 5 nến)
  const filteredPeaks = [];
  for (let i = 0; i < peaks.length; i++) {
    if (filteredPeaks.length === 0 || 
        peaks[i].index - filteredPeaks[filteredPeaks.length - 1].index >= 5) {
      filteredPeaks.push(peaks[i]);
    }
  }
  
  if (filteredPeaks.length < 2) return false;
  
  // Check Lower Highs với tolerance 1%
  let lowerHighsCount = 0;
  for (let i = 1; i < filteredPeaks.length; i++) {
    if (filteredPeaks[i].value < filteredPeaks[i - 1].value * 0.99) {
      lowerHighsCount++;
    }
  }
  
  // Chỉ cần ít nhất 1 cặp Lower Highs
  return lowerHighsCount >= 1;
}

// === CẢI TIẾN: CHECK VOLUME PULLBACK ===
function isPullbackVolume(klines) {
  if (klines.length < 15) return true; // Không đủ data thì skip check
  
  const last3Vol = klines.slice(-3).map(k => k.volume);
  const avg10Vol = klines.slice(-13, -3).reduce((sum, k) => sum + k.volume, 0) / 10;
  
  const currentAvgVol = last3Vol.reduce((a, b) => a + b, 0) / 3;
  
  // Volume pullback giảm ít nhất 20% so với trung bình
  return currentAvgVol < avg10Vol * 0.85;
}

// === CẢI TIẾN: KIỂM TRA GIÁ REJECT TẠI MA ===
function isPriceRejectionAtMA(klines, ma30, ma60) {
  if (klines.length < 5) return false;
  
  const last5Candles = klines.slice(-5);
  let rejectionCount = 0;
  
  for (const candle of last5Candles) {
    // Nến có bóng trên dài và close gần low (rejection)
    const upperShadow = candle.high - Math.max(candle.open, candle.close);
    const bodySize = Math.abs(candle.close - candle.open);
    const totalRange = candle.high - candle.low;
    
    if (totalRange > 0 && upperShadow > bodySize * 1.5) {
      // Check xem có chạm MA30 hoặc MA60 không
      if (candle.high >= ma30 * 0.99 && candle.high <= ma30 * 1.01) {
        rejectionCount++;
      }
    }
  }
  
  return rejectionCount >= 1;
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
          return { 
            time: t * 1000, 
            open: o, 
            high: h, 
            low: l, 
            close: c, 
            volume: v 
          };
        }).filter(k => !isNaN(k.close));
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

// === PHÂN TÍCH DOWNTREND CẢI TIẾN ===
async function analyzeDowntrend(symbol, klines) {
  if (klines.length < 70) return;

  const currentCandle = klines[klines.length - 1];
  const currentPrice = currentCandle.close;

  // Tính MA
  const ma30 = calculateMA(klines, 30);
  const ma60 = calculateMA(klines, 60);
  const ma200 = calculateMA(klines, 200);
  if (ma30 === null || ma60 === null || ma200 === null) return;

  // Giá phải dưới MA200 và MA60
  if (currentPrice > ma200 || currentPrice > ma60) return;

  // Độ dốc MA200 phải âm (nới lỏng hơn)
  const ma200Slope = calculateMASlope(klines, 200);
  if (ma200Slope === null || ma200Slope > DOWNTREND_SLOPE_THRESHOLD) return;

  // RSI không được quá bán (tăng ngưỡng lên 32)
  const rsi = calculateRSI(klines, 14);
  if (rsi < RSI_OVERSOLD_THRESHOLD) return;

  // === KIỂM TRA LOWER HIGHS CẢI TIẾN ===
  if (!detectLowerHighs(klines, LOWER_HIGHS_WINDOW)) return;

  // === ĐÃ XÁC NHẬN DOWNTREND ===
  if (!trackedDowntrendCoins.has(symbol)) {
    trackedDowntrendCoins.set(symbol, { addedAt: Date.now(), notified: false });
    console.log(`📉 Downtrend detected: ${symbol} (RSI: ${rsi.toFixed(1)})`);
  }

  const trackData = trackedDowntrendCoins.get(symbol);
  const trackingDuration = Date.now() - trackData.addedAt;

  // Dọn dẹp nếu theo dõi quá lâu
  if (trackingDuration > DOWNTREND_TRACKING_MAX) {
    trackedDowntrendCoins.delete(symbol);
    return;
  }

  // Chỉ cảnh báo sau khi theo dõi đủ lâu
  if (trackingDuration < DOWNTREND_MIN_DURATION) return;

  // === PHÁT HIỆN ĐIỂM VÀO ĐẸP: GIÁ HỒI LÊN GẦN MA30 ===
  const distanceToMA30Pct = ((ma30 - currentPrice) / currentPrice) * 100;
  if (distanceToMA30Pct < 0 || distanceToMA30Pct > MAX_DISTANCE_TO_MA30_PCT) return;

  // === CHECK VOLUME PULLBACK ===
  if (!isPullbackVolume(klines)) {
    console.log(`⚠️ ${symbol}: Volume không pullback (có thể đang pump)`);
    return;
  }

  // === CHECK REJECTION AT MA (OPTIONAL - BONUS SIGNAL) ===
  const hasRejection = isPriceRejectionAtMA(klines, ma30, ma60);

  // Volume không được tăng đột biến (tránh pump)
  const avgVol = klines.slice(-10, -1).reduce((sum, k) => sum + k.volume, 0) / 9;
  const volRatio = currentCandle.volume / avgVol;
  if (volRatio > 2.0) return;

  if (!trackData.notified) {
    const binanceSymbol = symbol.replace('_USDT', 'USDT');
    const isMexcExclusive = !binanceSymbols.has(binanceSymbol);

    const rejectionEmoji = hasRejection ? '🔴 Rejection tại MA!' : '';
    const message = 
      `📉 **DOWNTREND SHORT OPPORTUNITY**: [${symbol}](https://mexc.com/futures/${symbol}?type=swap)\n\n` +
      `**Xu hướng giảm ổn định**:\n` +
      `• Giá hiện tại: $${currentPrice.toFixed(6)}\n` +
      `• MA30: $${ma30.toFixed(6)} (${distanceToMA30Pct.toFixed(2)}% phía trên)\n` +
      `• MA60: $${ma60.toFixed(6)}\n` +
      `• MA200 dốc: ${ma200Slope.toFixed(2)}%/5nến\n` +
      `• RSI(14): ${rsi.toFixed(1)}\n` +
      `• Lower Highs: ✅\n` +
      `• Volume pullback: ✅\n` +
      `${rejectionEmoji}\n` +
      `\n🎯 **Chiến lược**:\n` +
      `• Entry: $${currentPrice.toFixed(6)}\n` +
      `• Target 1: -3% → $${(currentPrice * 0.97).toFixed(6)}\n` +
      `• Target 2: -6% → $${(currentPrice * 0.94).toFixed(6)}\n` +
      `• Stop Loss: $${ma30.toFixed(6)} (+${distanceToMA30Pct.toFixed(2)}%)\n` +
      `\n⚡ **Risk: ${hasRejection ? 'LOW' : 'LOW-MEDIUM'}** (downtrend ổn định)\n` +
      `🏪 ${isMexcExclusive ? 'CHỈ MEXC 🟢' : 'CÓ BINANCE 🟡'}`;

    await sendMessageWithAutoDelete(message, { 
      parse_mode: 'Markdown', 
      disable_web_page_preview: true 
    });

    trackData.notified = true;
    console.log(`📉 Downtrend SHORT signal: ${symbol} | RSI: ${rsi.toFixed(1)} | Distance: ${distanceToMA30Pct.toFixed(2)}%`);
  }
}

// === VÒNG LẶP CHÍNH ===
async function checkAndAlert() {
  const tickers = await fetchAllTickers();
  if (!tickers?.length) {
    console.log('⚠️ Không có tickers đủ volume.');
    return;
  }
  console.log(`🔍 Quét ${tickers.length} coin | Downtrend tracking: ${trackedDowntrendCoins.size}`);

  const symbols = tickers.map(t => t.symbol);
  await mapWithRateLimit(symbols, async (symbol) => {
    const klines = await fetchKlinesWithRetry(symbol);
    if (klines?.length >= 70) {
      await analyzeDowntrend(symbol, klines);
    }
  }, maxConcurrentRequests, maxRequestsPerSecond);

  await cleanupOldMessages();
}

// === KHỞI ĐỘNG ===
(async () => {
  console.log('📉 Khởi động bot DOWNTREND SHORT v2 (IMPROVED)...');
  console.log(`📊 Volume tối thiểu: $${MIN_VOLUME_USDT.toLocaleString()}`);
  console.log(`📉 MA200 dốc tối thiểu: ${DOWNTREND_SLOPE_THRESHOLD}%`);
  console.log(`📈 RSI oversold threshold: ${RSI_OVERSOLD_THRESHOLD}`);
  console.log(`📏 Max distance to MA30: ${MAX_DISTANCE_TO_MA30_PCT}%`);
  console.log(`🔍 Lower Highs window: ${LOWER_HIGHS_WINDOW} nến`);
  console.log(`⏱️ Polling mỗi ${pollInterval / 1000} giây`);
  await fetchBinanceSymbols();
  await checkAndAlert();
  setInterval(checkAndAlert, pollInterval);
})();