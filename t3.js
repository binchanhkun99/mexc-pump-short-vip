import { MexcFuturesClient } from "mexc-futures-sdk";
import axios from "axios";
import crypto from "crypto";
import { HttpsProxyAgent } from "https-proxy-agent";

const WEB_TOKEN = process.env.MEXC_AUTH_TOKEN ?? "";
const API_KEY = process.env.MEXC_API_KEY || "";
const API_SECRET = process.env.MEXC_SECRET_KEY || "";
const BASE_URL = 'https://futures.mexc.co/api/v1';
const LEVERAGE = 20;  // From config

// ===== CONFIG PROXY =====
const proxyHost = "14.224.225.105";
const proxyPort = 40220;
const proxyUser = "user1762258669";
const proxyPass = "pass1762258669";

const proxyUrl = `http://${proxyUser}:${proxyPass}@${proxyHost}:${proxyPort}`;
const httpsAgent = new HttpsProxyAgent(proxyUrl);

// ===== AXIOS INSTANCE y như BOT =====
const axiosInstance = axios.create({
  httpsAgent,
  proxy: false,
  timeout: 15000,
});

// Init SDK client
const client = new MexcFuturesClient({
  authToken: WEB_TOKEN,
  baseURL: BASE_URL,
});

// Axios for fallback/private calls (use axiosInstance)
const api = axiosInstance;

// Set auth for api
if (WEB_TOKEN) {
  api.defaults.headers.common['Authorization'] = `Bearer ${WEB_TOKEN}`;
}

// Sign if API key
function signParams(params) {
  const timestamp = Date.now();
  const query = { ...params, timestamp };
  const queryString = new URLSearchParams(query).toString();
  const signature = crypto.createHmac('sha256', API_SECRET).update(queryString).digest('hex');
  return `${queryString}&signature=${signature}`;
}

if (API_KEY) {
  api.defaults.headers.common['ApiKey'] = API_KEY;
  api.interceptors.request.use(config => {
    if (config.url.includes('/private/')) {
      const signed = signParams(config.params || {});
      config.params = new URLSearchParams(signed);
    }
    return config;
  });
}
// Get futures balance (USDT) - FIXED SDK version
async function getFuturesBalance() {
  try {
    // Cách 1: Dùng private API endpoint (recommended)
    const res = await axiosInstance.get('/private/account/assets');
    
    if (res.data && res.data.data) {
      const assets = res.data.data;
      const usdtAsset = assets.find(asset => asset.asset === 'USDT');
      if (usdtAsset) {
        const balance = parseFloat(usdtAsset.walletBalance || 0);
        console.log(`💰 Balance từ API: $${balance}`);
        return balance;
      }
    }
    
    console.log('❌ Không tìm thấy USDT balance trong response');
    return 0;
    
  } catch (err) {
    console.error('❌ [FUTURES_BALANCE_ERROR]:', err.message);
    
    // Fallback: Thử cách khác nếu endpoint trên không work
    try {
      // Cách 2: Dùng endpoint khác
      const res2 = await axiosInstance.get('/private/account/balance');
      console.log('🔍 Balance response structure:', JSON.stringify(res2.data, null, 2));
      
      if (res2.data && res2.data.data) {
        // Tuỳ vào response structure mà extract balance
        const balanceData = res2.data.data;
        if (balanceData.USDT && balanceData.USDT.walletBalance) {
          return parseFloat(balanceData.USDT.walletBalance);
        }
        if (Array.isArray(balanceData)) {
          const usdtAsset = balanceData.find(asset => asset.asset === 'USDT');
          if (usdtAsset) return parseFloat(usdtAsset.walletBalance || 0);
        }
      }
    } catch (fallbackErr) {
      console.error('❌ [FUTURES_BALANCE_FALLBACK_ERROR]:', fallbackErr.message);
    }
    
    return 0;
  }
}

getFuturesBalance()