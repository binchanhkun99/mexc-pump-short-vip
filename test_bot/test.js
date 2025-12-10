
import axios from "axios";
const listingDaysCache = new Map();
import { CONFIG } from './config.js';

// Axios instance với rate limiting mạnh
const axiosInstance = axios.create({
  timeout: CONFIG.AXIOS_TIMEOUT,
  httpsAgent: new https.Agent({ keepAlive: true }),
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
  }
});
async function rateLimit() {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
    await new Promise(r => setTimeout(r, MIN_REQUEST_INTERVAL - timeSinceLastRequest));
  }
  lastRequestTime = Date.now();
}

async function fetchRetry(url, params = {}, retry = 3) {
  for (let i = 1; i <= retry; i++) {
    try {
      await rateLimit();
      return await axiosInstance.get(url, { params });
    } catch (err) {
      console.log(`⚠️ Retry ${i}/${retry} for ${url}:`, err.message);
      await new Promise(r => setTimeout(r, i * 800));
    }
  }
  throw new Error(`API failed after retries: ${url}`);
}
async function getListingDays(symbol) {
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
    console.log("res ft", res)
  } catch (err) {
    console.warn(`Failed to fetch futures kline for ${symbol}:`, err.message);
  }

  // Fallback Spot
  try {
    const spotSymbol = symbol.replace('_USDT', 'USDT');
    const res = await fetchRetry('https://api.mexc.com/api/v3/klines', {
      symbol: spotSymbol,
      interval: '1d',
      limit: 500
    });
    console.log("res spot", res);
    

    if (Array.isArray(res.data) && res.data.length > 0) {
      const first = res.data[0][0];
      listingDays = (now - first) / 86400000;
      listingDaysCache.set(symbol, listingDays);
      return listingDays;
    }
  } catch (err) {
    console.warn(`Failed to fetch spot kline for ${symbol}:`, err.message);
  }

  // Fallback cuối
  listingDays = 365;
  listingDaysCache.set(symbol, listingDays);
  return listingDays;
}
getListingDays("WET_USDT")