// src/exchange.js
import axios from 'axios';
import https from 'https';
import { CONFIG } from './config.js';

const axiosInstance = axios.create({
  timeout: CONFIG.AXIOS_TIMEOUT,
  httpsAgent: new https.Agent({ keepAlive: true }),
});

let binanceSymbols = new Set();

export async function fetchBinanceSymbols() {
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

export function isMexcExclusive(mexcSymbol) {
  const binanceSymbol = mexcSymbol.replace('_USDT', 'USDT');
  return !binanceSymbols.has(binanceSymbol);
}

export async function fetchAllTickers() {
  try {
    const response = await axiosInstance.get('https://contract.mexc.com/api/v1/contract/ticker');
    if (response.data?.success && Array.isArray(response.data.data)) {
      const filtered = response.data.data
        .filter(t => t.symbol?.endsWith('_USDT') && t.amount24 > CONFIG.MIN_VOLUME_USDT);
      return filtered.sort((a, b) => (b.amount24 || 0) - (a.amount24 || 0));
    }
  } catch (err) {
    console.error('Lỗi fetch tickers:', err.message);
  }
  return [];
}

export async function fetchKlinesWithRetry(symbol, retries = 3) {
  const now = Math.floor(Date.now() / 1000);
  const start = now - CONFIG.KLINE_LIMIT * 60;

  for (let i = 0; i < retries; i++) {
    try {
      const res = await axiosInstance.get(
        `https://contract.mexc.com/api/v1/contract/kline/${symbol}`,
        { params: { interval: 'Min1', start, end: now } }
      );
      if (res.data?.success && res.data.data) {
        const { time, open, high, low, close, vol } = res.data.data;
        const klines = time.map((t, idx) => {
          const o = parseFloat(open[idx]);
          const h = parseFloat(high[idx]);
          const l = parseFloat(low[idx]);
          const c = parseFloat(close[idx]);
          const v = parseFloat(vol[idx]);
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
            totalRange: h - l,
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

export async function mapWithRateLimit(items, fn) {
  const results = [];
  let queue = 0;
  let lastTime = 0;
  const interval = 1000 / CONFIG.MAX_REQUESTS_PER_SECOND;

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

  const initial = Math.min(CONFIG.MAX_CONCURRENT_REQUESTS, items.length);
  const runners = Array.from({ length: initial }, runNext);
  await Promise.all(runners);
  return results;
}
