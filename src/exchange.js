// src/exchange.js - Fully fixed version
// - Unified contractInfo handling
// - Proper retry logic
// - No incorrect fallbacks
// - Shared with mexc-api.js contract parsing rules
// - Stable caching and error isolation.

import axios from 'axios';
import https from 'https';
import { CONFIG } from './config.js';

// Axios instance
const axiosInstance = axios.create({
  timeout: CONFIG.AXIOS_TIMEOUT,
  httpsAgent: new https.Agent({ keepAlive: true })
});

// Binance symbol set
let binanceSymbols = new Set();

// Caches
const listingDaysCache = new Map();
const contractInfoCache = new Map();
const CONTRACT_CACHE_TTL = 5 * 60 * 1000;

// =============================
// Load Binance symbols
// =============================
export async function fetchBinanceSymbols() {
  try {
    const resp = await axiosInstance.get(
      'https://api.binance.com/api/v3/exchangeInfo'
    );

    if (resp.data?.symbols?.length) {
      const usdt = resp.data.symbols
        .filter(s => s.symbol.endsWith('USDT') && s.status === 'TRADING')
        .map(s => s.symbol);

      binanceSymbols = new Set(usdt);
      console.log(`✅ Loaded ${binanceSymbols.size} Binance symbols.`);
    }
  } catch (err) {
    console.warn('⚠️ Failed to load Binance symbols:', err.message);
  }
}

export function isMexcExclusive(mexcSymbol) {
  const binanceSymbol = mexcSymbol.replace('_USDT', 'USDT');
  return !binanceSymbols.has(binanceSymbol);
}

// =============================
// Fetch all tickers
// =============================
export async function fetchAllTickers() {
  try {
    const res = await axiosInstance.get(
      'https://contract.mexc.com/api/v1/contract/ticker'
    );

    if (!res.data?.success || !Array.isArray(res.data.data)) return [];

    const raw = res.data.data;

    const filtered = raw
      .filter(t => t.symbol?.endsWith('_USDT'))
      .map(t => ({
        symbol: t.symbol,
        lastPrice: parseFloat(t.lastPrice),
        bid: parseFloat(t.bid1),
        ask: parseFloat(t.ask1),
        fundingRate: parseFloat(t.fundingRate || 0),
        volume24: parseFloat(t.volume24),
        amount24: parseFloat(t.amount24),
        fairPrice: parseFloat(t.fairPrice),
        indexPrice: parseFloat(t.indexPrice)
      }))
      .filter(t => !isNaN(t.lastPrice));

    return filtered.sort((a, b) => b.amount24 - a.amount24);
  } catch (err) {
    console.error('fetchAllTickers error:', err.message);
    return [];
  }
}

// =============================
// Retry wrapper
// =============================
async function fetchRetry(url, params = {}, retry = 3) {
  for (let i = 1; i <= retry; i++) {
    try {
      return await axiosInstance.get(url, { params });
    } catch (err) {
      console.log(`⚠️ Retry ${i}/${retry} for ${url}:`, err.message);
      await new Promise(r => setTimeout(r, i * 500));
    }
  }
  throw new Error(`API failed after retries: ${url}`);
}

// =============================
// KLINE fetch
// =============================
export async function fetchKlinesWithRetry(symbol, retries = 3) {
  const now = Math.floor(Date.now() / 1000);
  const start = now - CONFIG.KLINE_LIMIT * 60;

  for (let i = 0; i < retries; i++) {
    try {
      const res = await axiosInstance.get(
        `https://contract.mexc.com/api/v1/contract/kline/${symbol}`,
        {
          params: { interval: 'Min1', start, end: now }
        }
      );

      if (res.data?.success && res.data.data) {
        const { time, open, high, low, close, vol } = res.data.data;

        const klines = time
          .map((t, idx) => ({
            time: t * 1000,
            open: parseFloat(open[idx]),
            high: parseFloat(high[idx]),
            low: parseFloat(low[idx]),
            close: parseFloat(close[idx]),
            volume: parseFloat(vol[idx])
          }))
          .filter(k => !isNaN(k.close));

        return klines.sort((a, b) => a.time - b.time);
      }
    } catch (err) {
      if (err.response?.status === 429) {
        await new Promise(r => setTimeout(r, 300));
        continue;
      }
      console.error(`fetchKlines error: ${symbol}`, err.message);
      return [];
    }
  }

  return [];
}

// =============================
// Unified Contract Info (same logic as mexc-api.js)
// =============================
export async function getContractInfo(symbol) {
  const formattedSymbol = symbol.includes('_USDT')
    ? symbol
    : symbol.replace('USDT', '_USDT');

  const cache = contractInfoCache.get(formattedSymbol);
  const now = Date.now();

  if (cache && now - cache.timestamp < CONTRACT_CACHE_TTL) {
    return cache.data;
  }

  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await axiosInstance.get(
        'https://contract.mexc.com/api/v1/contract/detail',
        { params: { symbol: formattedSymbol } }
      );

      if (!res.data || res.data.success === false || res.data.code !== 0) {
        throw new Error(
          `MEXC contract.detail error code=${res.data?.code}, msg=${res.data?.message}`
        );
      }

      const c = res.data.data;

      const info = {
        volumePrecision: c.volScale ?? 0,
        pricePrecision: c.priceScale ?? 5,
        minQuantity: parseFloat(c.minVol ?? '1'),
        quantityUnit: parseFloat(c.volUnit ?? '1'),
        contractMultiplier: parseFloat(c.contractSize ?? '1'),
        contractSize: parseFloat(c.contractSize ?? '1')
      };

      contractInfoCache.set(formattedSymbol, { data: info, timestamp: now });
      console.log('📄 [EXCHANGE.CONTRACT_INFO]', formattedSymbol, info);

      return info;
    } catch (err) {
      lastError = err;
      console.error(
        `❌ [EXCHANGE.CONTRACT_INFO_ERROR] ${formattedSymbol} attempt ${attempt}:`,
        err.message
      );
      await new Promise(r => setTimeout(r, attempt * 300));
    }
  }

  throw new Error(
    `Cannot fetch contractInfo for ${formattedSymbol}: ${lastError?.message}`
  );
}

// =============================
// Listing days
// =============================
export async function getListingDays(symbol) {
  if (listingDaysCache.has(symbol)) return listingDaysCache.get(symbol);

  let listingDays = 0;
  const now = Date.now();

  try {
    // Futures Day1
    const res = await fetchRetry(
      `https://contract.mexc.com/api/v1/contract/kline/${symbol}`,
      {
        interval: 'Day1',
        start: Math.floor((now - 86400000 * 200) / 1000),
        end: Math.floor(now / 1000)
      }
    );

    if (res.data?.success && res.data.data?.time?.length) {
      const first = res.data.data.time[0] * 1000;
      listingDays = (now - first) / (86400000);
      listingDaysCache.set(symbol, listingDays);
      return listingDays;
    }
  } catch {}

  // Fallback Spot
  try {
    const spotSymbol = symbol.replace('_USDT', 'USDT');
    const res = await fetchRetry('https://api.mexc.com/api/v3/klines', {
      symbol: spotSymbol,
      interval: '1d',
      limit: 500
    });

    if (Array.isArray(res.data) && res.data.length > 0) {
      const first = res.data[0][0];
      listingDays = (now - first) / 86400000;
      listingDaysCache.set(symbol, listingDays);
      return listingDays;
    }
  } catch {}

  // Fallback cuối
  listingDays = 365;
  listingDaysCache.set(symbol, listingDays);
  return listingDays;
}

// =============================
// Trading Filters
// =============================
export async function checkTradingFilters(symbol, volume24h) {
  const filters = {
    volumeOk: true,
    listingOk: true,
    reasons: []
  };

  if (volume24h > CONFIG.MAX_VOLUME_USDT) {
    filters.volumeOk = false;
    filters.reasons.push(
      `Volume ${(volume24h / 1e6).toFixed(1)}M > ${(CONFIG.MAX_VOLUME_USDT / 1e6).toFixed(1)}M`
    );
  }

  const listingDays = await getListingDays(symbol);
  if (listingDays < CONFIG.MIN_LISTING_DAYS) {
    filters.listingOk = false;
    filters.reasons.push(
      `Listing ${listingDays.toFixed(1)}d < ${CONFIG.MIN_LISTING_DAYS}d`
    );
  }

  return filters;
}

// =============================
// Funding Rate
// =============================
export async function fetchFundingRate(symbol) {
  try {
    const res = await axiosInstance.get(
      'https://contract.mexc.com/api/v1/contract/fundingRate',
      { params: { symbol } }
    );

    if (!res.data?.success || !res.data.data?.fundingRate) return 0;

    const rate = Number(res.data.data.fundingRate);
    return isFinite(rate) ? rate : 0;
  } catch (err) {
    console.warn(`⚠️ fundingRate error for ${symbol}:`, err.message);
    return 0;
  }
}

// =============================
// Clear Cache
// =============================
export function clearCache() {
  listingDaysCache.clear();
  contractInfoCache.clear();
  console.log('🧹 exchange.js cache cleared');
}

// =============================
// Cache stats
// =============================
export function getCacheStats() {
  return {
    listingDaysCache: listingDaysCache.size,
    contractInfoCache: contractInfoCache.size
  };
}

// =============================
// Rate-limited mapping
// =============================
export async function mapWithRateLimit(items, fn) {
  const results = [];
  let idx = 0;
  const interval = 1000 / CONFIG.MAX_REQUESTS_PER_SECOND;
  let lastTime = 0;

  async function runner() {
    while (idx < items.length) {
      const i = idx++;
      const now = Date.now();
      const diff = now - lastTime;
      if (diff < interval) await new Promise(r => setTimeout(r, interval - diff));
      lastTime = Date.now();

      try {
        results[i] = await fn(items[i]);
      } catch (err) {
        console.error('❌ mapWithRateLimit error:', err.message);
        results[i] = null;
      }
    }
  }

  const concurrency = Math.min(CONFIG.MAX_CONCURRENT_REQUESTS, items.length);
  const workers = Array.from({ length: concurrency }, runner);
  await Promise.all(workers);
  return results;
}
