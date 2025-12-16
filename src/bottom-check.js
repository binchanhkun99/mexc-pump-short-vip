// src/bottom-check.js - Filter không short gần đáy 7 ngày
import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { CONFIG } from "./config.js";

// ===== PROXY CONFIG (Giống bot chính) =====
const proxyUrl = `http://user1762258669:pass1762258669@14.224.225.105:40220`;
const httpsAgent = new HttpsProxyAgent(proxyUrl);

const axiosInstance = axios.create({
//   httpsAgent, Tạm thời tắt proxy
  proxy: false,
  timeout: 10000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  }
});

// ===== CACHE =====
const bottomCache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 phút

// ===== RATE LIMITING =====
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 200;

async function rateLimit() {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
    await new Promise(r => setTimeout(r, MIN_REQUEST_INTERVAL - timeSinceLastRequest));
  }
  lastRequestTime = Date.now();
}

// ===== HELPER =====
function formatSymbol(symbol) {
  return symbol.includes('_USDT') ? symbol : symbol.replace('USDT', '_USDT');
}

async function fetchWithRetry(url, params, retries = 3) {
  for (let i = 1; i <= retries; i++) {
    try {
      await rateLimit();
      const res = await axiosInstance.get(url, { params });
      
      if (res.data?.success === false) {
        if (res.data.code === 429) {
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        throw new Error(`API error: ${res.data.message} (code: ${res.data.code})`);
      }
      return res;
    } catch (err) {
      if (i === retries) throw err;
      await new Promise(r => setTimeout(r, 1000 * i));
    }
  }
}

// ===== CORE: Lấy giá đáy 7 ngày =====
export async function get7DayBottomPrice(symbol, useCache = true) {
  const formattedSymbol = formatSymbol(symbol);
  const cacheKey = formattedSymbol;
  const now = Date.now();
  
  // Check cache
  if (useCache && bottomCache.has(cacheKey)) {
    const cached = bottomCache.get(cacheKey);
    if (now - cached.timestamp < CACHE_TTL) {
      return cached.data;
    }
  }
  
  try {
    const endTime = Math.floor(now / 1000);
    const startTime = endTime - (7 * 24 * 60 * 60);
    
    const res = await fetchWithRetry(
      `https://contract.mexc.com/api/v1/contract/kline/${formattedSymbol}`,
      {
        interval: 'Min60',
        start: startTime,
        end: endTime,
        limit: 168
      }
    );
    
    if (res.data.success && res.data.data?.low?.length) {
      const lows = res.data.data.low.map(l => parseFloat(l));
      const validLows = lows.filter(p => p > 0);
      
      if (validLows.length === 0) return null;
      
      const bottomPrice = Math.min(...validLows);
      const highPrice = Math.max(...validLows);
      
      const result = {
        bottomPrice,
        highPrice,
        candleCount: validLows.length,
        timestamp: now
      };
      
      // Cache
      bottomCache.set(cacheKey, { data: result, timestamp: now });
      
      // Cleanup
      if (bottomCache.size > 50) {
        const oldestKey = [...bottomCache.keys()][0];
        bottomCache.delete(oldestKey);
      }
      
      return result;
    }
    return null;
    
  } catch (err) {
    console.error(`❌ [BOTTOM_PRICE_ERROR] ${symbol}:`, err.message);
    return null;
  }
}

// ===== MAIN FILTER: Kiểm tra có được short không =====
export async function checkBottomFilter(symbol, currentPrice) {
  if (!currentPrice || currentPrice <= 0) {
    return { safe: true, reason: 'Invalid price, skip check' };
  }
  
  const bottomData = await get7DayBottomPrice(symbol, true);
  
  if (!bottomData?.bottomPrice) {
    return { safe: true, reason: 'No bottom data, skip check' };
  }
  
  const aboveBottomPct = ((currentPrice - bottomData.bottomPrice) / bottomData.bottomPrice) * 100;
  const isSafe = aboveBottomPct >= CONFIG.MIN_ABOVE_BOTTOM_PCT;
  
  const result = {
    safe: isSafe,
    aboveBottomPct: parseFloat(aboveBottomPct.toFixed(2)),
    currentPrice,
    bottomPrice: bottomData.bottomPrice,
    highPrice: bottomData.highPrice,
    positionInRange: bottomData.highPrice > bottomData.bottomPrice 
      ? parseFloat(((currentPrice - bottomData.bottomPrice) / (bottomData.highPrice - bottomData.bottomPrice) * 100).toFixed(1))
      : 0,
    reason: isSafe 
      ? `✅ +${aboveBottomPct.toFixed(1)}% above 7-day bottom` 
      : `🚫 Only +${aboveBottomPct.toFixed(1)}% above bottom (need >${CONFIG.MIN_ABOVE_BOTTOM_PCT}%)`
  };
  
  return result;
}

// ===== UTILITIES =====
export function clearBottomCache() {
  const count = bottomCache.size;
  bottomCache.clear();
  console.log(`🧹 Cleared ${count} bottom cache entries`);
  return count;
}