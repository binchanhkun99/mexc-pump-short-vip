// get-bottom-price.js
import * as dotenv from "dotenv";
import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";

dotenv.config();

// ===== CONFIG PROXY =====
const proxyHost = "14.224.225.105";
const proxyPort = 40220;
const proxyUser = "user1762258669";
const proxyPass = "pass1762258669";

const proxyUrl = `http://${proxyUser}:${proxyPass}@${proxyHost}:${proxyPort}`;
const httpsAgent = new HttpsProxyAgent(proxyUrl);

// ===== AXIOS INSTANCE =====
const axiosInstance = axios.create({
  // httpsAgent,
  proxy: false,
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
  }
});

// ===== RATE LIMIT HELPER =====
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 150;

async function rateLimit() {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
    await new Promise(r => setTimeout(r, MIN_REQUEST_INTERVAL - timeSinceLastRequest));
  }
  lastRequestTime = Date.now();
}

// ===== RETRY HELPER =====
async function fetchRetry(url, params = {}, retry = 3) {
  for (let i = 1; i <= retry; i++) {
    try {
      await rateLimit();
      console.log(`🔗 Attempt ${i}: ${url}`);
      const res = await axiosInstance.get(url, { params });
      
      if (res.data?.success === false) {
        console.log(`⚠️ API returned false:`, res.data);
        await new Promise(r => setTimeout(r, i * 800));
        continue;
      }
      
      return res;
    } catch (err) {
      console.log(`⚠️ Retry ${i}/${retry} for ${url}:`, err.message);
      if (err.response?.status === 403) {
        await new Promise(r => setTimeout(r, 3000));
      } else {
        await new Promise(r => setTimeout(r, i * 800));
      }
    }
  }
  throw new Error(`API failed after retries: ${url}`);
}

// ===== SYMBOL FORMATTING =====
function formatSymbol(symbol) {
  // Nếu đã có _USDT thì giữ nguyên
  if (symbol.includes('_USDT')) {
    return symbol;
  }
  // Nếu có USDT nhưng không có underscore
  if (symbol.endsWith('USDT') && !symbol.includes('_')) {
    return symbol.replace('USDT', '_USDT');
  }
  // Thêm _USDT
  return symbol + '_USDT';
}

// ===== GET 7-DAY BOTTOM (FIXED) =====
export async function get7DayBottomPrice(symbol) {
  const formattedSymbol = formatSymbol(symbol);
  console.log(`\n🔍 Checking 7-day bottom for: ${symbol} -> ${formattedSymbol}`);
  
  try {
    const now = Math.floor(Date.now() / 1000);
    const sevenDaysAgo = now - (7 * 24 * 60 * 60); // 7 ngày
    
    console.log(`📅 Time range: ${new Date(sevenDaysAgo * 1000).toLocaleString()} -> ${new Date(now * 1000).toLocaleString()}`);
    
    // Lấy dữ liệu 1H (Hour1) - limit 168 = 7 ngày * 24 giờ
    console.log(`📊 Fetching 1H candles...`);
    const res = await fetchRetry(
      `https://contract.mexc.com/api/v1/contract/kline/${formattedSymbol}`,
      {
        interval: 'Min60',  // Hoặc 'Min60'
        start: sevenDaysAgo,
        end: now,
        limit: 168
      }
    );
    
    console.log(`✅ API Response: success=${res.data.success}, code=${res.data.code}`);
    
    if (res.data.success && res.data.data?.low?.length) {
      const lows = res.data.data.low.map(l => parseFloat(l));
      const validLows = lows.filter(p => p > 0);
      
      console.log(`📈 Found ${validLows.length} valid low prices`);
      
      if (validLows.length === 0) {
        console.log(`❌ No valid low prices found`);
        return null;
      }
      
      const minPrice = Math.min(...validLows);
      const maxPrice = Math.max(...validLows);
      
      console.log(`\n📊 7-DAY BOTTOM ANALYSIS:`);
      console.log(`├─ Symbol: ${formattedSymbol}`);
      console.log(`├─ Bottom Price: $${minPrice.toFixed(8)}`);
      console.log(`├─ High Price: $${maxPrice.toFixed(8)}`);
      console.log(`├─ Price Range: $${minPrice.toFixed(2)} - $${maxPrice.toFixed(2)}`);
      console.log(`└─ Data Points: ${validLows.length} candles`);
      
      // Lấy giá hiện tại
      console.log(`\n💰 Getting current price...`);
      await rateLimit();
      const tickerRes = await axiosInstance.get(
        'https://contract.mexc.com/api/v1/contract/ticker'
      );
      
      let currentPrice = 0;
      if (tickerRes.data?.success && Array.isArray(tickerRes.data.data)) {
        const ticker = tickerRes.data.data.find(t => t.symbol === formattedSymbol);
        if (ticker) {
          currentPrice = parseFloat(ticker.lastPrice);
        }
      }
      
      if (currentPrice > 0) {
        const aboveBottomPct = ((currentPrice - minPrice) / minPrice) * 100;
        const belowHighPct = ((maxPrice - currentPrice) / maxPrice) * 100;
        
        console.log(`\n📊 CURRENT PRICE ANALYSIS:`);
        console.log(`├─ Current Price: $${currentPrice.toFixed(8)}`);
        console.log(`├─ Above 7-day bottom: +${aboveBottomPct.toFixed(2)}%`);
        console.log(`├─ Below 7-day high: -${belowHighPct.toFixed(2)}%`);
        console.log(`├─ Position in range: ${((currentPrice - minPrice) / (maxPrice - minPrice) * 100).toFixed(1)}%`);
        console.log(`├─ Status: ${aboveBottomPct >= 30 ? '✅ SAFE to short' : '🚫 TOO CLOSE to bottom'}`);
        console.log(`└─ Recommendation: ${aboveBottomPct >= 30 ? 'Can short' : 'Avoid short - too close to bottom'}`);
      }
      
      return {
        success: true,
        symbol: formattedSymbol,
        bottomPrice: minPrice,
        highPrice: maxPrice,
        candleCount: validLows.length,
        source: 'futures_1h'
      };
    } else {
      console.log(`❌ API error or no data:`, {
        success: res.data.success,
        code: res.data.code,
        message: res.data.message,
        hasLowData: !!res.data.data?.low
      });
      
      // Fallback to spot
      console.log(`\n🔄 Falling back to spot API...`);
      return await get7DayBottomPriceSpot(symbol);
    }
    
  } catch (err) {
    console.error(`💥 Error getting 7-day bottom for ${symbol}:`, err.message);
    
    // Try spot as fallback
    try {
      return await get7DayBottomPriceSpot(symbol);
    } catch (spotErr) {
      console.error(`💥 Spot fallback also failed:`, spotErr.message);
      return null;
    }
  }
}

// ===== SPOT API FALLBACK =====
async function get7DayBottomPriceSpot(symbol) {
  const spotSymbol = formatSymbol(symbol).replace('_USDT', 'USDT');
  console.log(`\n🔄 Trying Spot API with symbol: ${spotSymbol}`);
  
  try {
    await rateLimit();
    const res = await axiosInstance.get('https://api.mexc.com/api/v3/klines', {
      params: {
        symbol: spotSymbol,
        interval: '1h',
        limit: 168
      }
    });
    
    if (Array.isArray(res.data) && res.data.length > 0) {
      const lows = res.data.map(k => parseFloat(k[3])); // low price ở index 3
      const validLows = lows.filter(p => p > 0);
      
      if (validLows.length > 0) {
        const minPrice = Math.min(...validLows);
        const maxPrice = Math.max(...validLows);
        
        console.log(`\n📊 SPOT API RESULT:`);
        console.log(`├─ Symbol: ${spotSymbol}`);
        console.log(`├─ Bottom Price: $${minPrice.toFixed(8)}`);
        console.log(`├─ High Price: $${maxPrice.toFixed(8)}`);
        console.log(`└─ Data Points: ${validLows.length} candles`);
        
        return {
          success: true,
          symbol: spotSymbol,
          bottomPrice: minPrice,
          highPrice: maxPrice,
          candleCount: validLows.length,
          source: 'spot_1h'
        };
      }
    }
    
    console.log(`❌ Spot API returned no data`);
    return null;
    
  } catch (err) {
    console.error(`❌ Spot API error:`, err.message);
    return null;
  }
}

// ===== TEST FUNCTION =====
async function test() {
  console.log(' ===== TESTING 7-DAY BOTTOM PRICE FUNCTION =====\n');
  
  const testCases = [
    'SKATE', // Coin mới
    'US' // Test coin không tồn tại
  ];
  
  for (const symbol of testCases) {
    console.log(`\n📋 ===== TEST CASE: ${symbol} =====`);
    
    const startTime = Date.now();
    const result = await get7DayBottomPrice(symbol);
    const elapsed = Date.now() - startTime;
    
    if (result?.success) {
      console.log(`\nTEST PASSED in ${elapsed}ms`);
      console.log(`├─ Symbol used: ${result.symbol}`);
      console.log(`├─ Bottom: $${result.bottomPrice.toFixed(8)}`);
      console.log(`├─ High: $${result.highPrice.toFixed(8)}`);
      console.log(`├─ Source: ${result.source}`);
      console.log(`└─ Candles: ${result.candleCount}`);
    } else {
      console.log(`\n❌ TEST FAILED in ${elapsed}ms`);
      console.log(`└─ No data available for ${symbol}`);
    }
    
    // Chờ giữa các request
    if (symbol !== testCases[testCases.length - 1]) {
      console.log(`\n⏳ Waiting 2 seconds...`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  
  console.log('\n🎯 ===== ALL TESTS COMPLETED =====');
}

// ===== INTEGRATION VERSION FOR BOT =====
// Đây là version tối ưu để tích hợp vào bot
export async function get7DayBottomPriceOptimized(symbol, useCache = true) {
  const cacheKey = `bottom_${symbol}`;
  const CACHE_TTL = 30 * 60 * 1000; // 30 phút
  
  // Simple in-memory cache
  if (useCache && global.bottomCache && global.bottomCache[cacheKey]) {
    const cached = global.bottomCache[cacheKey];
    if (Date.now() - cached.timestamp < CACHE_TTL) {
      console.log(` [CACHE] Using cached bottom price for ${symbol}: $${cached.bottomPrice}`);
      return cached;
    }
  }
  
  const formattedSymbol = formatSymbol(symbol);
  
  try {
    const now = Math.floor(Date.now() / 1000);
    const sevenDaysAgo = now - (7 * 24 * 60 * 60);
    
    const res = await fetchRetry(
      `https://contract.mexc.com/api/v1/contract/kline/${formattedSymbol}`,
      {
        interval: 'Hour1',
        start: sevenDaysAgo,
        end: now,
        limit: 168
      }
    );
    
    if (res.data.success && res.data.data?.low?.length) {
      const lows = res.data.data.low.map(l => parseFloat(l));
      const validLows = lows.filter(p => p > 0);
      
      if (validLows.length === 0) return null;
      
      const minPrice = Math.min(...validLows);
      const maxPrice = Math.max(...validLows);
      
      const result = {
        success: true,
        symbol: formattedSymbol,
        bottomPrice: minPrice,
        highPrice: maxPrice,
        candleCount: validLows.length,
        source: 'futures',
        timestamp: Date.now()
      };
      
      // Cache result
      if (useCache) {
        if (!global.bottomCache) global.bottomCache = {};
        global.bottomCache[cacheKey] = result;
      }
      
      return result;
    }
  } catch (err) {
    console.error(`Bottom price error for ${symbol}:`, err.message);
  }
  
  return null;
}

// ===== CHECK IF SAFE TO SHORT =====
export async function isSafeToShort(symbol, currentPrice, minAboveBottomPct = 30) {
  if (!currentPrice || currentPrice <= 0) {
    console.log(`⚠️ Invalid current price for ${symbol}: ${currentPrice}`);
    return false;
  }
  
  const bottomData = await get7DayBottomPriceOptimized(symbol);
  
  if (!bottomData?.bottomPrice || bottomData.bottomPrice <= 0) {
    console.log(`⚠️ Could not get bottom price for ${symbol}`);
    return true; // Không block nếu không lấy được bottom price
  }
  
  const aboveBottomPct = ((currentPrice - bottomData.bottomPrice) / bottomData.bottomPrice) * 100;
  const isSafe = aboveBottomPct >= minAboveBottomPct;
  
  console.log(`📊 Bottom check for ${symbol}:`, {
    currentPrice: currentPrice.toFixed(8),
    bottomPrice: bottomData.bottomPrice.toFixed(8),
    aboveBottomPct: aboveBottomPct.toFixed(2) + '%',
    required: minAboveBottomPct + '%',
    safe: isSafe ? '✅' : '🚫'
  });
  
  return isSafe;
}

// Run test
test().catch(console.error);