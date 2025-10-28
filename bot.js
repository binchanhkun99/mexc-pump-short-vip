// bot-mexc-pump-alert-v3.js (Có lọc Binance + Bắt buộc nến đỏ)
import dotenv from 'dotenv';
import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import https from 'https';

dotenv.config();

// === CẤU HÌNH ===
const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const pollInterval = parseInt(process.env.POLL_INTERVAL) || 8000;
const alertCooldown = 6000;
const axiosTimeout = 10000;
const klineLimit = 15;
const maxConcurrentRequests = 6;
const maxRequestsPerSecond = 5;
const messageLifetime = 2 * 60 * 60 * 1000;
const MIN_VOLUME_USDT = parseFloat(process.env.MIN_VOLUME_USDT) || 250000; 
const PUMP_THRESHOLD_PCT = parseFloat(process.env.PUMP_THRESHOLD_PCT) || 12;

if (!token || !chatId) {
  console.error('❌ Thiếu TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID trong .env');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: false });
const lastAlertTimes = new Map();
const sentMessages = [];
let binanceSymbols = new Set();

const axiosInstance = axios.create({
  timeout: axiosTimeout,
  httpsAgent: new https.Agent({ keepAlive: true }),
});

function avgVolume(klines) {
  if (klines.length === 0) return 0;
  return klines.reduce((sum, k) => sum + k.volume, 0) / klines.length;
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
          return { time: t * 1000, open: o, high: h, low: l, close: c, volume: v, pct };
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

async function mapWithRateLimit(items, fn, concurrency = 8, rps = 6) {
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

async function detectPumpAndShort(symbol, klines) {
  if (!klines || klines.length < 10) return;
  
  const recent = klines.slice(-15);
  const firstPrice = recent[0].open;
  const lastPrice = recent[recent.length - 1].close;
  const totalChange = ((lastPrice - firstPrice) / firstPrice) * 100;
  
  if (totalChange < PUMP_THRESHOLD_PCT) return;

  // === KIỂM TRA BINANCE ===
  const binanceSymbol = symbol.replace('_USDT', 'USDT');
  const isMexcExclusive = !binanceSymbols.has(binanceSymbol);
  
  // Tìm đỉnh cao nhất
  const peakCandle = recent.reduce((max, k) => k.high > max.high ? k : max, recent[0]);
  const peakPrice = peakCandle.high;
  
  const currentCandle = recent[recent.length - 1];
  const currentPrice = currentCandle.close;
  const dropFromPeak = ((peakPrice - currentPrice) / peakPrice) * 100;
  
  // === BẮT BUỘC PHẢI CÓ NẾN ĐỎ ===
  const isRedCandle = currentCandle.close < currentCandle.open;
  if (!isRedCandle) return; // ❌ Không có nến đỏ = bỏ qua
  
  // Volume
  const sortedByVol = [...recent].sort((a, b) => b.volume - a.volume);
  const avgVol = avgVolume(sortedByVol.slice(3));
  const peakVolRatio = peakCandle.volume / avgVol;
  const currentVolRatio = currentCandle.volume / avgVol;

  // Kiểm tra đã qua đỉnh
  const isPeakPassed = dropFromPeak >= 2;
  const hasVolumeSpike = peakVolRatio > 2.5;
  
  // === HỆ THỐNG PHÂN LOẠI 3 MỨC ===
  let safetyLabel = '';
  let safetyScore = 0;
  let shouldAlert = false;
  let marketStatus = ''; // Thêm trạng thái thị trường
  
  if (isMexcExclusive) {
    // === MEXC-ONLY: Ưu tiên cao nhất ===
    marketStatus = '🔒 CHỈ CÓ TRÊN MEXC';
    
    if (isPeakPassed && hasVolumeSpike && dropFromPeak >= 3) {
      safetyLabel = '🟢 CAO';
      safetyScore = 90;
      shouldAlert = true;
    } else if (isPeakPassed && hasVolumeSpike) {
      safetyLabel = '🟡 VỪA';
      safetyScore = 75;
      shouldAlert = true;
    } else if (totalChange > 15 && peakVolRatio > 5) {
      safetyLabel = '🟠 THẤP';
      safetyScore = 55;
      shouldAlert = true;
    }
    
  } else {
    // === CÓ TRÊN BINANCE: Cẩn trọng hơn ===
    marketStatus = '⚠️ CÓ TRÊN BINANCE';
    
    if (isPeakPassed && hasVolumeSpike && dropFromPeak >= 5) {
      // Yêu cầu giảm ít nhất 5% từ đỉnh
      safetyLabel = '🟡 VỪA';
      safetyScore = 60;
      shouldAlert = true;
    } else if (totalChange > 20 && dropFromPeak >= 7 && peakVolRatio > 5) {
      // Chỉ alert nếu pump cực mạnh (>20%) và đã giảm >7%
      safetyLabel = '🟠 THẤP';
      safetyScore = 45;
      shouldAlert = true;
    }
    // Không alert các trường hợp còn lại với coin có trên Binance
  }
  
  if (!shouldAlert) return;

  // Cooldown
  const lastAlert = lastAlertTimes.get(symbol);
  if (lastAlert && Date.now() - lastAlert < alertCooldown) return;

  const link = `https://mexc.com/futures/${symbol}?type=swap`;
  const redCandleSize = ((currentCandle.open - currentCandle.close) / currentCandle.open) * 100;
  
  const message =
    `🚨 SHORT SIGNAL: [${symbol}](${link})\n` +
    `${marketStatus}\n\n` +
    `📈 Pump: ${totalChange.toFixed(1)}% trong ${recent.length}p\n` +
    `📍 Đỉnh: ${peakPrice.toFixed(8)}\n` +
    `📉 Hiện tại: ${currentPrice.toFixed(8)} (giảm ${dropFromPeak.toFixed(1)}% từ đỉnh)\n` +
    `🕯️ Nến đỏ: -${redCandleSize.toFixed(1)}% (CONFIRM đảo chiều)\n` +
    `🧱 Vol đỉnh: x${peakVolRatio.toFixed(1)} | Vol hiện tại: x${currentVolRatio.toFixed(1)}\n\n` +
    `💡 Độ an toàn: ${safetyLabel} (${safetyScore}/100)\n` +
    `${isMexcExclusive ? '✅ Coin này KHÔNG có trên Binance - Rủi ro thấp hơn' : '⚠️ Coin có trên Binance - Cẩn thận pump tiếp'}`;

  await sendMessageWithAutoDelete(message, { parse_mode: 'Markdown', disable_web_page_preview: true });
  lastAlertTimes.set(symbol, Date.now());
  
  const statusLog = isMexcExclusive ? 'MEXC-only' : 'On-Binance';
  console.log(`🔔 SHORT: ${symbol} [${statusLog}] (pump ${totalChange.toFixed(1)}%, giảm ${dropFromPeak.toFixed(1)}%, ${safetyLabel})`);
}

async function checkAndAlert() {
  const tickers = await fetchAllTickers();
  if (!tickers?.length) {
    console.log('⚠️ Không có tickers.');
    return;
  }
  console.log(`🔍 Quét ${tickers.length} coin futures trên MEXC...`);
  const symbols = tickers.map(t => t.symbol);
  await mapWithRateLimit(symbols, async (symbol) => {
    const klines = await fetchKlinesWithRetry(symbol);
    if (klines?.length >= 10) await detectPumpAndShort(symbol, klines);
  }, maxConcurrentRequests, maxRequestsPerSecond);
  await cleanupOldMessages();
}

(async () => {
  console.log('🚀 Khởi động bot SHORT v3 (Lọc Binance + Bắt buộc nến đỏ)...');
  await fetchBinanceSymbols();
  await checkAndAlert();
  setInterval(checkAndAlert, pollInterval);
  console.log(`🔁 Polling mỗi ${pollInterval / 1000} giây`);
})();