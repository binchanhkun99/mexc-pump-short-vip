// bot-mexc-pump-alert.js (v2 - có điểm an toàn)
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
const klineLimit = 10;
const maxConcurrentRequests = 6;
const maxRequestsPerSecond = 5;
const messageLifetime = 2 * 60 * 60 * 1000;
const MIN_VOLUME_USDT = parseFloat(process.env.MIN_VOLUME_USDT) || 50000;
const PUMP_THRESHOLD_PCT = parseFloat(process.env.PUMP_THRESHOLD_PCT) || 5;

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
      return response.data.data
        .filter(t => t.symbol?.endsWith('_USDT') && t.amount24 > MIN_VOLUME_USDT)
        .sort((a, b) => (b.amount24 || 0) - (a.amount24 || 0));
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
  if (!klines || klines.length < 5) return;
  const recent = klines.slice(-10);
  const firstPrice = recent[0].open;
  const lastPrice = recent[recent.length - 1].close;
  const totalChange = ((lastPrice - firstPrice) / firstPrice) * 100;
  if (totalChange < PUMP_THRESHOLD_PCT) return;
  const binanceSymbol = symbol.replace('_USDT', 'USDT');
  const isMexcExclusive = !binanceSymbols.has(binanceSymbol);
  if (!isMexcExclusive) return;

  const prevHigh = Math.max(...recent.slice(0, -1).map(k => k.high));
  const current = recent[recent.length - 1];
  const avgVol = avgVolume(recent.slice(0, -1));
  const volRatio = current.volume / avgVol;
  const isFalseBreakout = current.high > prevHigh && current.close < current.open && current.close < prevHigh && volRatio > 2;

  const aggressiveSignal = totalChange > 8 && volRatio > 4 && current.close < current.open && current.high > prevHigh * 0.98;
  const safeSignal = isFalseBreakout;

  let safetyLabel = 'Không xác định';
  let safetyScore = 0;

  if (safeSignal) {
    safetyLabel = 'Cao (Safe logic)';
    safetyScore = 90;
  } else if (aggressiveSignal) {
    safetyLabel = 'Thấp (Aggressive logic)';
    safetyScore = 45;
  }

  if (!(safeSignal || aggressiveSignal)) return;

  const lastAlert = lastAlertTimes.get(symbol);
  if (lastAlert && Date.now() - lastAlert < alertCooldown) return;

  const link = `https://mexc.com/futures/${symbol}?type=swap`;
  const message =
    `🚨 [${symbol}](${link})\n` +
    `📈 Pumped ${totalChange.toFixed(2)}% trong 10 phút\n` +
    `📉 False breakout: đỉnh ${prevHigh.toFixed(8)} bị phá rồi rơi về ${current.close.toFixed(8)}\n` +
    `🧱 Volume: ${current.volume.toLocaleString()} (x${volRatio.toFixed(1)} trung bình)\n` +
    `👉 Ưu tiên SHORT (coin chỉ có trên MEXC)\n` +
    `💡 Độ an toàn: ${safetyLabel} (${safetyScore}/100)`;

  await sendMessageWithAutoDelete(message, { parse_mode: 'Markdown', disable_web_page_preview: true });
  lastAlertTimes.set(symbol, Date.now());
  console.log(`🔔 SHORT alert: ${symbol} (${totalChange.toFixed(2)}% pump, ${safetyLabel})`);
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
    if (klines?.length >= 5) await detectPumpAndShort(symbol, klines);
  }, maxConcurrentRequests, maxRequestsPerSecond);
  await cleanupOldMessages();
}

(async () => {
  console.log('🚀 Khởi động bot cảnh báo pump & short (MEXC-only)...');
  await fetchBinanceSymbols();
  await checkAndAlert();
  setInterval(checkAndAlert, pollInterval);
  console.log(`🔁 Polling mỗi ${pollInterval / 1000} giây`);
})();
