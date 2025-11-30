// src/mexc-api.js
// Updated to match the working test file

import * as dotenv from "dotenv";
import { MexcFuturesClient } from "mexc-futures-sdk";
import axios from "axios";
import crypto from "crypto";
import { HttpsProxyAgent } from 'https-proxy-agent';

dotenv.config();

const WEB_TOKEN = process.env.MEXC_AUTH_TOKEN ?? "";
const API_KEY = process.env.MEXC_API_KEY || "";
const API_SECRET = process.env.MEXC_SECRET_KEY || "";
const BASE_URL = 'https://futures.mexc.co/api/v1';
const LEVERAGE = 20;

// Proxy config
const proxyHost = "14.224.225.105";
const proxyPort = 40220;
const proxyUser = "user1762258669";
const proxyPass = "pass1762258669";
const proxyUrl = `http://${proxyUser}:${proxyPass}@${proxyHost}:${proxyPort}`;
const httpsAgent = new HttpsProxyAgent(proxyUrl);

// Axios instance với proxy
const axiosInstance = axios.create({
  // httpsAgent,
  // proxy: false,
  timeout: 15000,
});

// Init SDK client
const client = new MexcFuturesClient({
  authToken: WEB_TOKEN,
  baseURL: BASE_URL,
});

// Set auth headers
if (WEB_TOKEN) {
  axiosInstance.defaults.headers.common['Authorization'] = `Bearer ${WEB_TOKEN}`;
}

// Sign params
function signParams(params) {
  const timestamp = Date.now();
  const query = { ...params, timestamp };
  const queryString = new URLSearchParams(query).toString();
  const signature = crypto.createHmac('sha256', API_SECRET).update(queryString).digest('hex');
  return `${queryString}&signature=${signature}`;
}

if (API_KEY) {
  axiosInstance.defaults.headers.common['ApiKey'] = API_KEY;
  axiosInstance.interceptors.request.use(config => {
    if (config.url.includes('/private/')) {
      const signed = signParams(config.params || {});
      config.params = new URLSearchParams(signed);
    }
    return config;
  });
}

// =========================================================
//                  CORE API FUNCTIONS
// =========================================================

// Get current price - FIXED: Proper symbol handling
async function getCurrentPrice(symbol) {
  try {
    // Format symbol
    const formattedSymbol = symbol.includes('_USDT') ? symbol : symbol.replace('USDT', '_USDT');
    
    // Try SDK first
    const tickerData = await client.getTicker(formattedSymbol);
    if (tickerData && tickerData.lastPrice) {
      return parseFloat(tickerData.lastPrice);
    }
    
    // Fallback to public API
    const res = await axiosInstance.get('https://contract.mexc.com/api/v1/contract/ticker');
    const tickers = res.data.data || [];
    
    const ticker = tickers.find(t => 
      t.symbol === formattedSymbol || 
      t.symbol === symbol
    );
    
    if (ticker) {
      return parseFloat(ticker.lastPrice || 0);
    }
    
    return 0;
  } catch (error) {
    console.error(`❌ [PRICE_ERROR] ${symbol}:`, error.message);
    return 0;
  }
}

// Get 24h volume
async function getVolume24h(symbol) {
  try {
    const formattedSymbol = symbol.includes('_USDT') ? symbol : symbol.replace('USDT', '_USDT');
    const res = await axiosInstance.get('https://contract.mexc.com/api/v1/contract/ticker');
    const tickers = res.data.data || [];
    
    const ticker = tickers.find(t => 
      t.symbol === formattedSymbol || 
      t.symbol === symbol
    );
    
    if (ticker) {
      return parseFloat(ticker.amount24 || 0);
    }
    return 0;
  } catch (err) {
    console.error(`❌ [VOLUME_ERROR] ${symbol}:`, err.message);
    return 0;
  }
}

// Get futures balance (USDT)
async function getFuturesBalance() {
  try {
 const usdtAsset = await client.getAccountAsset('USDT');
    console.log('🔍 USDT Asset response:', JSON.stringify(usdtAsset, null, 2));
    
    if (usdtAsset && usdtAsset.data) {
      const balance = parseFloat(usdtAsset.data.availableBalance || usdtAsset.data.walletBalance || 0);
      console.log(`💰 Balance từ SDK: $${balance}`);
      return balance;
    }
    
    return 0;
  } catch (err) {
    console.error('❌ [FUTURES_BALANCE_ERROR]', err.message);
      return 0;

  }
}

// Get contract info
async function getContractInfo(symbol) {
  try {
    const formattedSymbol = symbol.includes('_USDT') ? symbol : symbol.replace('USDT', '_USDT');
    const res = await axiosInstance.get('https://contract.mexc.com/api/v1/contract/detail', {
      params: { symbol: formattedSymbol }
    });
    
    if (res.data && res.data.data) {
      const contract = res.data.data;
      return {
        volumePrecision: contract.volScale || 0,
        pricePrecision: contract.priceScale || 5,
        minQuantity: contract.minVol || 1,
        quantityUnit: contract.volUnit || 1,
        contractMultiplier: contract.contractSize || 1,
        contractSize: contract.contractSize || 1
      };
    }
  } catch (error) {
    console.error('❌ [CONTRACT_INFO_ERROR]:', error.message);
  }
  
  // Fallback values
  return { 
    volumePrecision: 0,
    pricePrecision: 5,
    minQuantity: 1,
    quantityUnit: 1,
    contractMultiplier: 1,
    contractSize: 1
  };
}

// Round volume
function roundVolume(quantity, precision, quantityUnit = 1) {
  if (precision === 0) {
    const rounded = Math.round(quantity);
    return Math.floor(rounded / quantityUnit) * quantityUnit;
  } else {
    const factor = Math.pow(10, precision);
    const rounded = Math.round(quantity * factor) / factor;
    return Math.floor(rounded / quantityUnit) * quantityUnit;
  }
}

// Calculate position size với contract multiplier
async function calculatePositionSize(symbol, positionPercent, confidence = 1) {
  const balance = await getFuturesBalance();
  const price = await getCurrentPrice(symbol);
  const contractInfo = await getContractInfo(symbol);
  
  if (price <= 0 || balance <= 0) return 0;

  const margin = balance * positionPercent * confidence;
  const notional = margin * LEVERAGE;
  const contracts = notional / price;
  const coins = contracts / contractInfo.contractMultiplier;
  
  const quantity = roundVolume(coins, contractInfo.volumePrecision, contractInfo.quantityUnit);
  return quantity;
}

// Open position (SHORT) - FIXED: Using correct API format
async function openPosition(symbol, quantity, side = 'SHORT', signalType = '') {
  try {
    const contractInfo = await getContractInfo(symbol);
    const currentPrice = await getCurrentPrice(symbol);
    
    if (currentPrice <= 0) {
      return { success: false, error: 'Invalid price' };
    }

    // Format symbol
    const formattedSymbol = symbol.includes('_USDT') ? symbol : symbol.replace('USDT', '_USDT');
    
    // Round quantity
    const openQty = roundVolume(quantity, contractInfo.volumePrecision, contractInfo.quantityUnit);
    
    if (openQty <= 0) {
      return { success: false, error: 'Invalid quantity' };
    }

    console.log(`🎯 Opening ${side}: ${formattedSymbol}, Qty: ${openQty}, Price: ${currentPrice}`);

    // MEXC Futures order parameters
    const orderParams = {
      symbol: formattedSymbol,
      price: currentPrice,
      vol: openQty,
      side: 3, // 3 = Open short, 1 = Open long
      type: 5, // 5 = Market order
      openType: 2, // 2 = Cross margin
      leverage: LEVERAGE,
      positionId: 0,
    };

    console.log('🔐 Order params:', orderParams);

    const orderResponse = await client.submitOrder(orderParams);

    console.log('📦 Order response:', orderResponse);

    let orderId = `order_${Date.now()}`;
    let realPositionId = undefined;

    if (orderResponse && orderResponse.data) {
      if (typeof orderResponse.data === 'string') {
        orderId = orderResponse.data;
      } else if (typeof orderResponse.data === 'object') {
        orderId = orderResponse.data.orderId?.toString() || `order_${Date.now()}`;
        realPositionId = orderResponse.data.positionId?.toString();
      }
    }

    // Try to get real position ID
    if (!realPositionId) {
      try {
        await new Promise(resolve => setTimeout(resolve, 3000));
        const positions = await getOpenPositions(formattedSymbol);
        const position = positions.find(p => 
          p.symbol === formattedSymbol && p.positionType === 2 // 2 = SHORT
        );
        if (position) {
          realPositionId = position.id?.toString() || position.positionId?.toString();
        }
      } catch (error) {
        console.error('Error fetching realPositionId:', error);
      }
    }

    console.log(`✅ [ORDER_OPENED] ${formattedSymbol} | ${side} | Qty: ${openQty} | Order: ${orderId} | Position: ${realPositionId}`);

    return {
      success: true,
      orderId,
      positionId: realPositionId,
      realPositionId,
      quantity: openQty,
      price: currentPrice
    };

  } catch (err) {
    console.error(`❌ [OPEN_ORDER_ERROR] ${symbol}:`, err.message);
    if (err.response) {
      console.error('❌ Response error:', err.response.data);
    }
    return { success: false, error: err.message };
  }
}

// Get open positions
async function getOpenPositions(symbol = null) {
  try {
    let formattedSymbol = symbol;
    if (symbol && !symbol.includes('_USDT')) {
      formattedSymbol = symbol.replace('USDT', '_USDT');
    }

    console.log(`🔍 Fetching positions via SDK: ${formattedSymbol || 'ALL'}`);
    
    // DÙNG SDK METHOD
    const response = await client.getOpenPositions(formattedSymbol);
    
    console.log('📊 Positions SDK response:', JSON.stringify(response, null, 2));
    
    // Xử lý response structure khác nhau
    if (response && Array.isArray(response)) {
      return response;
    }
    if (response && response.data && Array.isArray(response.data)) {
      return response.data;
    }
    if (response && response.positions && Array.isArray(response.positions)) {
      return response.positions;
    }
    
    console.log('⚠️ No positions data found in response');
    return [];
    
  } catch (error) {
    console.error(`❌ [POSITIONS_SDK_ERROR] ${symbol}:`, error.message);
    
    // Fallback: thử private API nếu SDK fail
    try {
      console.log('🔄 Trying private API fallback...');
      const url = 'https://contract.mexc.com/api/v1/private/position/open_positions';
      const params = symbol ? { symbol: symbol.replace('USDT', '_USDT') } : {};
      
      const res = await axiosInstance.get(url, { params });
      if (res.data && res.data.data) {
        return res.data.data;
      }
    } catch (apiError) {
      console.error('❌ Private API fallback also failed:', apiError.message);
    }
    
    return [];
  }
}

// Close position (partial or full)
async function closePosition(symbol, quantity, side = 'SHORT') {
  try {
    const contractInfo = await getContractInfo(symbol);
    const currentPrice = await getCurrentPrice(symbol);
    const formattedSymbol = symbol.includes('_USDT') ? symbol : symbol.replace('USDT', '_USDT');
    
    // Round quantity
    const closeQty = roundVolume(quantity, contractInfo.volumePrecision, contractInfo.quantityUnit);
    
    console.log(`🎯 Closing ${side}: ${formattedSymbol}, Qty: ${closeQty}, Price: ${currentPrice}`);

    // MEXC Futures close order (opposite side)
    const orderParams = {
      symbol: formattedSymbol,
      price: currentPrice,
      vol: closeQty,
      side: 4, // 4 = Close short, 2 = Close long
      type: 5, // Market order
      openType: 2, // Cross margin
      leverage: LEVERAGE,
      positionId: 0,
    };

    console.log('🔐 Close order params:', orderParams);

    const orderResponse = await client.submitOrder(orderParams);

    let orderId = `close_${Date.now()}`;
    let pnl = 0;

    if (orderResponse && orderResponse.data) {
      if (typeof orderResponse.data === 'string') {
        orderId = orderResponse.data;
      } else if (typeof orderResponse.data === 'object') {
        orderId = orderResponse.data.orderId?.toString() || orderId;
      }
    }

    console.log(`✅ [ORDER_CLOSED] ${formattedSymbol} | ${side} | Qty: ${closeQty} | Order: ${orderId}`);

    // Estimate PnL (trong thực tế nên lấy từ API)
    const positions = await getOpenPositions(formattedSymbol);
    const position = positions.find(p => p.symbol === formattedSymbol);
    if (position) {
      pnl = parseFloat(position.unrealised || 0);
    }

    return {
      success: true,
      orderId,
      pnl
    };

  } catch (err) {
    console.error(`❌ [CLOSE_ORDER_ERROR] ${symbol}:`, err.message);
    if (err.response) {
      console.error('❌ Response error:', err.response.data);
    }
    return { success: false, pnl: 0, error: err.message };
  }
}

// Get position details
async function getPosition(symbol) {
  try {
    // ĐẦU TIÊN: Lấy tất cả positions một lần
    const allPositions = await getOpenPositions();
    
    // Tìm position cho symbol cụ thể
    const formattedSymbol = symbol.includes('_USDT') ? symbol : symbol.replace('USDT', '_USDT');
    
    const position = allPositions.find(p => {
      const hasPosition = parseFloat(p.holdVol || p.volume || 0) !== 0;
      const symbolMatch = p.symbol === formattedSymbol;
      return hasPosition && symbolMatch;
    });
    
    if (!position) {
      return null;
    }

    const price = await getCurrentPrice(symbol);
    const entryPrice = parseFloat(position.openAvgPrice || position.avgPrice || 0);
    const qty = Math.abs(parseFloat(position.holdVol || position.volume || 0));
    const pnl = parseFloat(position.unrealised || position.unrealizedPnl || 0);
    
    let roi = 0;
    if (entryPrice > 0) {
      roi = ((entryPrice - price) / entryPrice) * LEVERAGE * 100;
    }

    return {
      symbol,
      side: position.positionType === 2 ? 'SHORT' : 'LONG',
      entryPrice,
      quantity: qty,
      pnl,
      roi,
      lastPrice: price,
      margin: parseFloat(position.im || position.initialMargin || 0),
      notional: qty * price,
    };

  } catch (err) {
    console.error(`❌ [GET_POSITION_ERROR] ${symbol}:`, err.message);
    return null;
  }
}

// Get all open positions - CACHE KẾT QUẢ
let positionsCache = null;
let positionsCacheTime = 0;
const CACHE_DURATION = 10000; // 10 seconds

async function getOpenPositions(symbol = null) {
  try {
    // Check cache
    const now = Date.now();
    if (positionsCache && (now - positionsCacheTime) < CACHE_DURATION) {
      if (!symbol) return positionsCache;
      
      // Filter by symbol nếu có
      return positionsCache.filter(p => 
        !symbol || p.symbol === symbol.replace('USDT', '_USDT')
      );
    }

    console.log('🔍 Fetching all positions via SDK...');
    
    const response = await client.getOpenPositions();
    
    let positionsData = [];
    
    // Xử lý response structure
    if (response && Array.isArray(response)) {
      positionsData = response;
    } else if (response && response.data && Array.isArray(response.data)) {
      positionsData = response.data;
    }
    
    // Filter chỉ positions có volume
    const activePositions = positionsData.filter(p => 
      parseFloat(p.holdVol || p.volume || 0) !== 0
    );
    
    console.log(`📊 Found ${activePositions.length} active positions`);
    
    // Update cache
    positionsCache = activePositions;
    positionsCacheTime = now;
    
    if (symbol) {
      const formattedSymbol = symbol.replace('USDT', '_USDT');
      return activePositions.filter(p => p.symbol === formattedSymbol);
    }
    
    return activePositions;
    
  } catch (error) {
    console.error(`❌ [POSITIONS_SDK_ERROR]:`, error.message);
    return [];
  }
}
// Transfer between spot and futures
async function universalTransfer({ fromAccountType, toAccountType, asset, amount }) {
  try {
    const timestamp = Date.now();
    const params = {
      fromAccountType: fromAccountType.toUpperCase(),
      toAccountType: toAccountType.toUpperCase(),
      asset,
      amount: String(amount),
      recvWindow: 5000,
      timestamp,
    };

    const signedQuery = signParams(params);
    const url = `https://api.mexc.com/api/v3/capital/transfer?${signedQuery}`;

    const config = {
      headers: {
        'X-MEXC-APIKEY': API_KEY,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
      httpsAgent,
    };

    const res = await axios.post(url, null, config);

    console.log(`✅ [TRANSFER_SUCCESS] ${fromAccountType} → ${toAccountType}: ${amount} ${asset}`);
    return true;

  } catch (err) {
    console.error('❌ [TRANSFER_FAILED]:', err.response?.data || err.message);
    return false;
  }
}

// Check and transfer balance if low
async function checkAndTransferBalance(minBalance = 10) {
  const futuresBalance = await getFuturesBalance();
  if (futuresBalance > minBalance) return true;

  // Get spot balance
  try {
    const timestamp = Date.now();
    const params = { recvWindow: 5000, timestamp };
    const signedQuery = signParams(params);
    const url = `https://api.mexc.com/api/v3/account?${signedQuery}`;

    const config = {
      headers: {
        'X-MEXC-APIKEY': API_KEY,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
      httpsAgent,
    };

    const res = await axios.get(url, config);
    const assetBalance = res.data.balances.find((b) => b.asset === 'USDT');
    const spotBalance = parseFloat(assetBalance?.free || '0');

    if (spotBalance <= 0) {
      console.error('❌ [TRANSFER_ERROR] No spot balance to transfer');
      return false;
    }

    const transferAmount = Math.min(spotBalance, 50);
    const success = await universalTransfer({
      fromAccountType: 'SPOT',
      toAccountType: 'FUTURE',
      asset: 'USDT',
      amount: transferAmount.toString(),
    });

    if (success) {
      console.log(`💰 [TRANSFERRED] ${transferAmount} USDT to futures`);
      return true;
    }

    return false;
  } catch (err) {
    console.error('❌ [SPOT_BALANCE_ERROR]:', err.message);
    return false;
  }
}

export {
  getCurrentPrice,
  getVolume24h,
  calculatePositionSize,
  openPosition,
  closePosition,
  getPosition,
  getOpenPositions,
  getFuturesBalance,
  checkAndTransferBalance,
  getContractInfo,
  roundVolume
};