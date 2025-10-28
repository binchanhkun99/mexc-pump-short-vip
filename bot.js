// bot-mexc-pump-alert-v4.js (Phân tích tâm lý + Đa tín hiệu)
import dotenv from 'dotenv';
import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import https from 'https';

dotenv.config();

// === CẤU HÌNH NÂNG CAO ===
const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const pollInterval = parseInt(process.env.POLL_INTERVAL) || 5000; // Giảm để bắt nhanh hơn
const alertCooldown = 30000; // Tăng thời gian chờ giữa các alert cùng coin
const axiosTimeout = 8000;
const klineLimit = 20;
const maxConcurrentRequests = 8;
const maxRequestsPerSecond = 8;
const messageLifetime = 2 * 60 * 60 * 1000;
const MIN_VOLUME_USDT = parseFloat(process.env.MIN_VOLUME_USDT) || 150000; // Giảm để bắt sớm

// Ngưỡng pump linh hoạt
const PUMP_THRESHOLD_PCT = parseFloat(process.env.PUMP_THRESHOLD_PCT) || 8;
const STRONG_PUMP_PCT = 15;
const EXTREME_PUMP_PCT = 25;

if (!token || !chatId) {
  console.error('❌ Thiếu TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID trong .env');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: false });
const lastAlertTimes = new Map();
const sentMessages = [];
const pumpHistory = new Map(); // Theo dõi lịch sử pump
let binanceSymbols = new Set();

const axiosInstance = axios.create({
  timeout: axiosTimeout,
  httpsAgent: new https.Agent({ keepAlive: true }),
});

// === HÀM PHÂN TÍCH NÂNG CAO ===
function calculateMarketPsychology(klines) {
  if (klines.length < 10) return { sentiment: 'NEUTRAL', confidence: 0 };
  
  const recent = klines.slice(-10);
  const volumes = recent.map(k => k.volume);
  const priceChanges = recent.map(k => k.pct);
  
  // Phân tích volume
  const avgVolume = volumes.reduce((a, b) => a + b) / volumes.length;
  const currentVolume = volumes[volumes.length - 1];
  const volumeRatio = currentVolume / avgVolume;
  
  // Phân tích biến động giá
  const volatility = Math.max(...recent.map(k => k.high - k.low)) / recent[0].open;
  const avgChange = priceChanges.reduce((a, b) => a + b) / priceChanges.length;
  
  // Phân tích áp lực mua/bán
  const bullishCandles = recent.filter(k => k.close > k.open).length;
  const bearishCandles = recent.filter(k => k.close < k.open).length;
  const pressureRatio = bullishCandles / (bullishCandles + bearishCandles);
  
  let sentiment = 'NEUTRAL';
  let confidence = 0;
  
  if (volumeRatio > 3 && avgChange > 2) {
    sentiment = 'STRONG_BULLISH';
    confidence = 80;
  } else if (volumeRatio > 5 && volatility > 0.05) {
    sentiment = 'EXTREME_BULLISH';
    confidence = 90;
  } else if (volumeRatio > 2 && pressureRatio > 0.7) {
    sentiment = 'BULLISH';
    confidence = 65;
  } else if (volumeRatio < 0.5 && avgChange < -1) {
    sentiment = 'BEARISH';
    confidence = 60;
  }
  
  return { sentiment, confidence, volumeRatio, volatility, pressureRatio };
}

function detectSidewayPhase(klines) {
  if (klines.length < 10) return false;
  
  const sidewayPeriod = klines.slice(-10, -1); // 9 nến trước nến hiện tại
  const highs = sidewayPeriod.map(k => k.high);
  const lows = sidewayPeriod.map(k => k.low);
  const maxHigh = Math.max(...highs);
  const minLow = Math.min(...lows);
  
  const rangePct = ((maxHigh - minLow) / minLow) * 100;
  return rangePct < 1.5; // Biên độ < 1.5%
}

function calculateMA(klines, period) {
  if (klines.length < period) return null;
  const closes = klines.slice(-period).map(k => k.close);
  return closes.reduce((a, b) => a + b) / period;
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

async function detectPumpOpportunities(symbol, klines) {
  if (!klines || klines.length < 15) return;
  
  const currentCandle = klines[klines.length - 1];
  const previousCandles = klines.slice(-16, -1); // 15 nến trước
  const psychology = calculateMarketPsychology(klines);
  
  // === PHÁT HIỆN PUMP ĐANG DIỄN RA ===
  const isSidewayBefore = detectSidewayPhase(klines);
  const currentPumpPct = currentCandle.pct;
  const avgVolume10 = previousCandles.slice(-10).reduce((sum, k) => sum + k.volume, 0) / 10;
  const volumeRatio = currentCandle.volume / avgVolume10;
  
  const ma10 = calculateMA(klines.slice(-10), 10);
  const ma20 = calculateMA(klines.slice(-20), 20);
  const maCross = ma10 && ma20 && ma10 > ma20;
  
  const binanceSymbol = symbol.replace('_USDT', 'USDT');
  const isMexcExclusive = !binanceSymbols.has(binanceSymbol);
  
  // === TIÊU CHÍ PHÁT HIỆN PUMP ===
  const isStrongPump = currentPumpPct >= PUMP_THRESHOLD_PCT && 
                       volumeRatio >= 3 && 
                       currentCandle.isBullish;
  
  const isExtremePump = currentPumpPct >= STRONG_PUMP_PCT && 
                        volumeRatio >= 5;
  
  // === PHÂN LOẠI TÍN HIỆU ===
  let signalType = '';
  let alertMessage = '';
  let riskLevel = '';
  
  // TÍN HIỆU 1: PUMP BẮT ĐẦU (LONG opportunity)
  if (isStrongPump && isSidewayBefore && psychology.sentiment === 'STRONG_BULLISH') {
    signalType = 'LONG';
    riskLevel = isMexcExclusive ? 'MEDIUM' : 'HIGH';
    
    alertMessage = 
      `🚀 **PUMP BẮT ĐẦU DỰ KIẾN**: [${symbol}](https://mexc.com/futures/${symbol}?type=swap)\n` +
      `📊 Tâm lý: ${psychology.sentiment} (${psychology.confidence}% confidence)\n` +
      `📈 Pump: +${currentPumpPct.toFixed(2)}% | Volume: x${volumeRatio.toFixed(1)}\n` +
      `🔄 Sideway trước: ${isSidewayBefore ? 'CÓ' : 'KHÔNG'} | MA Cross: ${maCross ? 'CÓ' : 'KHÔNG'}\n` +
      `🏪 Sàn: ${isMexcExclusive ? 'CHỈ MEXC 🟢' : 'CÓ BINANCE 🟡'}\n` +
      `⚡ Risk: ${riskLevel} - Có thể vào LONG với stoploss thấp`;
  }
  
  // TÍN HIỆU 2: PUMP CỰC MẠNH (Cảnh báo đỉnh)
  else if (isExtremePump && currentPumpPct >= EXTREME_PUMP_PCT) {
    signalType = 'EXTREME_PUMP';
    riskLevel = 'VERY_HIGH';
    
    alertMessage = 
      `🔥 **PUMP CỰC MẠNH**: [${symbol}](https://mexc.com/futures/${symbol}?type=swap)\n` +
      `⚠️ CẢNH BÁO ĐỈNH GẦN - CHUẨN BỊ SHORT\n` +
      `📈 Pump: +${currentPumpPct.toFixed(2)}% | Volume: x${volumeRatio.toFixed(1)}\n` +
      `🎯 Kháng cự tâm lý: RẤT CAU | Tâm lý: ${psychology.sentiment}\n` +
      `💡 Chiến lược: Chờ nến đỏ confirm để SHORT`;
  }
  
  // TÍN HIỆU 3: FALSE BREAKOUT (SHORT opportunity)
  else if (psychology.sentiment === 'BEARISH' && currentCandle.pct < -3) {
    const pumpPeak = Math.max(...klines.slice(-5).map(k => k.high));
    const dropFromPeak = ((pumpPeak - currentCandle.close) / pumpPeak) * 100;
    
    if (dropFromPeak >= 8) {
      signalType = 'SHORT';
      riskLevel = isMexcExclusive ? 'LOW' : 'MEDIUM';
      
      alertMessage = 
        `📉 **FALSE BREAKOUT - SHORT**: [${symbol}](https://mexc.com/futures/${symbol}?type=swap)\n` +
        `🔻 Giảm: ${dropFromPeak.toFixed(2)}% từ đỉnh | Nến hiện tại: ${currentCandle.pct.toFixed(2)}%\n` +
        `📊 Tâm lý: ${psychology.sentiment} | Volume: x${volumeRatio.toFixed(1)}\n` +
        `🎯 Entry: Hiện tại | Target: -${(dropFromPeak * 0.6).toFixed(2)}%\n` +
        `⚡ Risk: ${riskLevel} - Tỷ lệ thắng cao`;
    }
  }
  
  // GỬI ALERT NẾU CÓ TÍN HIỆU
  if (signalType && alertMessage) {
    const lastAlert = lastAlertTimes.get(symbol);
    if (lastAlert && Date.now() - lastAlert < alertCooldown) return;
    
    await sendMessageWithAutoDelete(alertMessage, { 
      parse_mode: 'Markdown', 
      disable_web_page_preview: true 
    });
    
    lastAlertTimes.set(symbol, Date.now());
    console.log(`🔔 ${signalType}: ${symbol} (${currentPumpPct.toFixed(2)}%, ${riskLevel})`);
  }
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
    if (klines?.length >= 15) await detectPumpOpportunities(symbol, klines);
  }, maxConcurrentRequests, maxRequestsPerSecond);
  await cleanupOldMessages();
}

(async () => {
  console.log('🚀 Khởi động bot PUMP DETECTION v4 (Phân tích tâm lý + Đa tín hiệu)...');
  await fetchBinanceSymbols();
  await checkAndAlert();
  setInterval(checkAndAlert, pollInterval);
  console.log(`🔁 Polling mỗi ${pollInterval / 1000} giây`);
})();