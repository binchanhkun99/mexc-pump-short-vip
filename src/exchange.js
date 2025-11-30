// src/exchange.js - ĐÃ SỬA THEO LOGIC CHECK FILTERS SAU TÍN HIỆU
import axios from 'axios';
import https from 'https';
import { CONFIG } from './config.js';

// Axios instance KHÔNG proxy
const axiosInstance = axios.create({
  timeout: CONFIG.AXIOS_TIMEOUT,
  httpsAgent: new https.Agent({ 
    keepAlive: true,
  }),
});

let binanceSymbols = new Set();

// Cache cho listing days để tránh request nhiều
const listingDaysCache = new Map();
const contractInfoCache = new Map();

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
    const res = await axiosInstance.get(
      "https://contract.mexc.com/api/v1/contract/ticker"
    );

    if (!res.data?.success || !Array.isArray(res.data.data)) return [];

    const raw = res.data.data;

    const filtered = raw
      .filter(
        t =>
          t.symbol?.endsWith("_USDT") &&
          parseFloat(t.amount24) >= CONFIG.MIN_VOLUME_USDT
      )
      .map(t => ({
        symbol: t.symbol,
        lastPrice: parseFloat(t.lastPrice),

        // ----- bid / ask -----
        bid: parseFloat(t.bid1),
        ask: parseFloat(t.ask1),

        // ----- funding rate -----
        fundingRate: parseFloat(t.fundingRate || 0),

        // ----- volume -----
        volume24: parseFloat(t.volume24),
        amount24: parseFloat(t.amount24),

        fairPrice: parseFloat(t.fairPrice),
        indexPrice: parseFloat(t.indexPrice),
      }));

    // sort descending by amount24 (liquidity priority)
    return filtered.sort((a, b) => b.amount24 - a.amount24);
  } catch (err) {
    console.error("Lỗi fetch tickers:", err.message);
    return [];
  }
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

// ==========================================================
//          ★★★ RETRY WRAPPER ★★★
// ==========================================================
async function fetchRetry(url, params = {}, retry = 3) {
  for (let i = 1; i <= retry; i++) {
    try {
      const response = await axiosInstance.get(url, { params, timeout: 15000 });
      return response;
    } catch (err) {
      console.log(`⚠️ Retry ${i}/${retry} for ${url}: ${err.message}`);
      await new Promise(r => setTimeout(r, i * 800));
    }
  }
  throw new Error(`API failed after ${retry} retries: ${url}`);
}

// ==========================================================
//          ★★★ GET LISTING DAYS (METHOD MỚI) ★★★
// ==========================================================
export async function getListingDays(symbol) {
  // Check cache trước
  if (listingDaysCache.has(symbol)) {
    return listingDaysCache.get(symbol);
  }

  try {
    const now = Date.now();
    let listingDays = 0;
    let source = "unknown";

    // 1) FUTURES KLINE (Day1) - METHOD CHÍNH
    try {
      const res = await fetchRetry(
        `https://contract.mexc.com/api/v1/contract/kline/${symbol}`,
        {
          interval: "Day1",
          start: Math.floor((now - 86400000 * 200) / 1000), // 200 ngày
          end: Math.floor(now / 1000),
        }
      );

      if (res.data?.success && res.data.data?.time?.length > 0) {
        const firstTime = res.data.data.time[0] * 1000;
        listingDays = (now - firstTime) / (1000 * 60 * 60 * 24);
        source = "futures";
        console.log(`📅 ${symbol}: ${listingDays.toFixed(1)} days (from futures)`);
      }
    } catch (err) {
      console.log(`⚠️ Futures Day1 error for ${symbol}:`, err.message);
    }

    // 2) SPOT KLINE fallback - nếu futures fail
    if (listingDays === 0) {
      try {
        const spotSymbol = symbol.replace("_USDT", "USDT");
        const resSpot = await fetchRetry(
          "https://api.mexc.com/api/v3/klines",
          {
            symbol: spotSymbol,
            interval: "1d",
            limit: 500,
          }
        );

        if (resSpot.data?.length > 0) {
          const firstTime = resSpot.data[0][0];
          listingDays = (now - firstTime) / (1000 * 60 * 60 * 24);
          source = "spot";
          console.log(`📅 ${symbol}: ${listingDays.toFixed(1)} days (from spot)`);
        }
      } catch (err) {
        console.log(`⚠️ Spot kline fallback error for ${symbol}:`, err.message);
      }
    }

    // 3) Fallback cuối cùng - nếu tất cả fail
    if (listingDays === 0) {
      listingDays = 365; // Mặc định 1 năm
      source = "fallback";
      console.log(`📅 ${symbol}: ${listingDays} days (fallback)`);
    }

    // Cache kết quả
    listingDaysCache.set(symbol, listingDays);
    return listingDays;

  } catch (err) {
    console.error(`❌ Lỗi getListingDays(${symbol}):`, err.message);
    listingDaysCache.set(symbol, 365); // Fallback
    return 365;
  }
}

// ==========================================================
//          ★★★ GET CONTRACT INFO ★★★
// ==========================================================
export async function getContractInfo(symbol) {
  // Check cache trước
  if (contractInfoCache.has(symbol)) {
    return contractInfoCache.get(symbol);
  }

  try {
    const formattedSymbol = symbol.includes('_USDT') ? symbol : symbol.replace('USDT', '_USDT');
    const res = await axiosInstance.get('https://contract.mexc.com/api/v1/contract/detail', {
      params: { symbol: formattedSymbol }
    });
    
    if (res.data && res.data.data) {
      const contract = res.data.data;
      const contractInfo = {
        volumePrecision: contract.volScale || 0,
        pricePrecision: contract.priceScale || 5,
        minQuantity: contract.minVol || 1,
        quantityUnit: contract.volUnit || 1,
        contractMultiplier: contract.contractSize || 1,
        contractSize: contract.contractSize || 1
      };
      
      // Cache kết quả
      contractInfoCache.set(symbol, contractInfo);
      return contractInfo;
    }
  } catch (error) {
    console.error('❌ [CONTRACT_INFO_ERROR]:', error.message);
  }
  
  // Fallback values
  const fallbackInfo = { 
    volumePrecision: 0,
    pricePrecision: 5,
    minQuantity: 1,
    quantityUnit: 1,
    contractMultiplier: 1,
    contractSize: 1
  };
  
  contractInfoCache.set(symbol, fallbackInfo);
  return fallbackInfo;
}

// ==========================================================
//          ★★★ CHECK VOLUME & LISTING FILTERS ★★★
// ==========================================================
export async function checkTradingFilters(symbol, volume24h) {
  const filters = {
    volumeOk: true,
    listingOk: true,
    reasons: []
  };

  // Check volume - chặn nếu volume quá lớn
  if (volume24h > CONFIG.MAX_VOLUME_USDT) {
    filters.volumeOk = false;
    filters.reasons.push(`Volume ${(volume24h / 1000000).toFixed(1)}M > ${CONFIG.MAX_VOLUME_USDT / 1000000}M`);
  }

  // Check listing days - chặn nếu coin quá mới
  const listingDays = await getListingDays(symbol);
  if (listingDays < CONFIG.MIN_LISTING_DAYS) {
    filters.listingOk = false;
    filters.reasons.push(`Listing ${listingDays.toFixed(1)} days < ${CONFIG.MIN_LISTING_DAYS} days`);
  }

  return filters;
}

// ==========================================================
//          ★★★ FETCH FUNDING RATE ★★★
// ==========================================================
export async function fetchFundingRate(symbol) {
  try {
    const url = `https://contract.mexc.com/api/v1/contract/fundingRate`;
    const res = await axiosInstance.get(url, { params: { symbol } });

    if (!res.data?.success || !res.data.data?.fundingRate) return 0;

    const rate = Number(res.data.data.fundingRate);
    if (!isFinite(rate)) return 0;

    return rate; // số dạng 0.000123 = 0.0123%
  } catch (err) {
    console.warn(`⚠️ Lỗi fetchFundingRate(${symbol}):`, err.message);
    return 0;
  }
}

// ==========================================================
//          ★★★ CLEAR CACHE ★★★
// ==========================================================
export function clearCache() {
  listingDaysCache.clear();
  contractInfoCache.clear();
  console.log('🧹 Đã clear cache');
}

// ==========================================================
//          ★★★ GET CACHE STATS ★★★
// ==========================================================
export function getCacheStats() {
  return {
    listingDaysCache: listingDaysCache.size,
    contractInfoCache: contractInfoCache.size
  };
}

// ==========================================================
//          ★★★ RATE LIMIT MAPPING ★★★
// ==========================================================
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
    try {
      results[i] = await fn(items[i]);
    } catch (err) {
      console.error(`❌ Lỗi xử lý ${items[i]}:`, err.message);
      results[i] = null;
    }
    if (queue < items.length) await runNext();
  }

  const initial = Math.min(CONFIG.MAX_CONCURRENT_REQUESTS, items.length);
  const runners = Array.from({ length: initial }, runNext);
  await Promise.all(runners);
  return results;
}