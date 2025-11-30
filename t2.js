// test-open-position-contract-fixed.js
// Standalone JS test: Implements openPosition with proper contract multiplier handling.
// Tests opening SHORT on PIPPIN_USDT with qty ~0.5 USDT margin (leverage=20).
// Polls position/PnL every 10s for 2 min.
// Uses provided proxy config for axiosInstance.
// Run: node test-open-position-contract-fixed.js
// Stop: Ctrl+C

import * as dotenv from "dotenv";
dotenv.config();

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

// Mocks/Helpers based on function
const validSymbolsCache = new Set(['PIPPIN_USDT']);  // Assume valid

// Get contract info from API - FIXED: Correct contract multiplier parsing
async function getContractInfo(symbol) {
  try {
    // Get contract detail from public API
    const formattedSymbol = symbol.includes('_USDT') ? symbol : symbol.replace('USDT', '_USDT');
    const res = await api.get('https://contract.mexc.com/api/v1/contract/detail', {
      params: { symbol: formattedSymbol }
    });
    
    if (res.data && res.data.data) {
      const contract = res.data.data;
      console.log('📄 Raw contract info:', JSON.stringify({
        symbol: contract.symbol,
        contractSize: contract.contractSize,
        minVol: contract.minVol,
        volUnit: contract.volUnit,
        priceScale: contract.priceScale,
        volScale: contract.volScale
      }, null, 2));
      
      // FIXED: Correct contract multiplier calculation
      // contractSize = 10 means 1 contract = 10 coins
      const contractMultiplier = contract.contractSize || 1;
      
      return {
        volumePrecision: contract.volScale || 0,
        pricePrecision: contract.priceScale || 5,
        minQuantity: contract.minVol || 1,
        quantityUnit: contract.volUnit || 1,
        contractMultiplier: contractMultiplier, // This is the key fix
        contractSize: contract.contractSize || 1
      };
    }
  } catch (error) {
    console.error('❌ Contract info error:', error.message);
  }
  
  // Fallback values
  return { 
    volumePrecision: 0,
    pricePrecision: 5,
    minQuantity: 1,
    quantityUnit: 1,
    contractMultiplier: 10, // Based on the actual contractSize=10
    contractSize: 10
  };
}
// Get current price - FIXED: Proper symbol handling
async function getCurrentPrice(symbol) {
  if (!validSymbolsCache.has(symbol)) {
    return 0;
  }
  try {
    // Use original symbol first
    const tickerData = await client.getTicker(symbol);
    if (tickerData && tickerData.lastPrice) {
      return parseFloat(tickerData.lastPrice);
    }
  } catch (error) {
    console.error(`❌ Price SDK error:`, error.message);
  }

  try {
    // Fallback: try with formatted symbol
    const formattedSymbol = symbol.includes('_USDT') ? symbol : symbol.replace('USDT', '_USDT');
    const tickerData = await client.getTicker(formattedSymbol);
    if (tickerData && tickerData.lastPrice) {
      return parseFloat(tickerData.lastPrice);
    }
  } catch (error2) {
    console.error(`❌ Price SDK formatted error:`, error2.message);
  }

  try {
    // Final fallback: public API
    const res = await api.get('https://contract.mexc.com/api/v1/contract/ticker');
    const tickers = res.data.data || [];
    
    // Try multiple symbol formats
    const formattedSymbol = symbol.includes('_USDT') ? symbol : symbol.replace('USDT', '_USDT');
    const originalSymbol = symbol.includes('_USDT') ? symbol.replace('_USDT', 'USDT') : symbol;
    
    let ticker = tickers.find(t => t.symbol === formattedSymbol);
    if (!ticker) {
      ticker = tickers.find(t => t.symbol === originalSymbol);
    }
    if (!ticker) {
      ticker = tickers.find(t => t.symbol === symbol);
    }
    
    if (ticker) {
      return parseFloat(ticker.lastPrice || ticker.price || 0);
    } else {
      console.error(`❌ Ticker not found for ${symbol} (tried: ${formattedSymbol}, ${originalSymbol})`);
      return 0;
    }
  } catch (fallbackErr) {
    console.error(`❌ Price fallback error:`, fallbackErr.message);
    return 0;
  }
}

// Round volume - FIXED: Handle contract multiplier
function roundVolume(quantity, precision, quantityUnit = 1, contractMultiplier = 1) {
  // First calculate the actual contracts needed
  const contracts = quantity * contractMultiplier;
  
  if (precision === 0) {
    // For precision 0, round to nearest integer
    const roundedContracts = Math.round(contracts);
    // Ensure it's multiple of quantityUnit
    const finalContracts = Math.floor(roundedContracts / quantityUnit) * quantityUnit;
    // Convert back to coins
    return finalContracts / contractMultiplier;
  } else {
    // For decimal precision
    const factor = Math.pow(10, precision);
    const roundedContracts = Math.round(contracts * factor) / factor;
    const finalContracts = Math.floor(roundedContracts / quantityUnit) * quantityUnit;
    return finalContracts / contractMultiplier;
  }
}

// Round price - Round price to proper precision
function roundPrice(price, precision) {
  const factor = Math.pow(10, precision);
  return Math.round(price * factor) / factor;
}

// FIXED: Correct quantity calculation with contract multiplier
function calculateQuantity(targetMargin, leverage, price, contractMultiplier = 1) {
  const targetPositionSize = targetMargin * leverage; // USDT
  const contracts = targetPositionSize / price; // Số contracts cần
  const coins = contracts / contractMultiplier; // FIXED: Chia cho multiplier (not multiply)
  return coins;
}
// Get current positions - FIXED: Proper symbol handling
async function getCurrentPositions(symbol) {
  let formattedSymbol = symbol;
  
  // Format symbol correctly
  if (symbol && !symbol.includes('_USDT')) {
    formattedSymbol = symbol.replace('USDT', '_USDT');
  }

  try {
    // Try SDK first
    const response = await client.getOpenPositions(formattedSymbol);
    
    if (response && Array.isArray(response)) {
      return response;
    }
    if (response && response.data && Array.isArray(response.data)) {
      return response.data;
    }
    return [];
  } catch (error) {
    console.error(`❌ Positions SDK error:`, error.message);
    try {
      // Fallback to private API
      const res = await api.get('/private/position/open_positions', { 
        params: { symbol: formattedSymbol } 
      });
      return res.data.data || res.data || [];
    } catch (fallbackErr) {
      console.error(`❌ Positions fallback error:`, fallbackErr.message);
      return [];
    }
  }
}

// Mock orderManager.generatePositionId
function generatePositionId() {
  return `pos_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Global totalOrders
let totalOrders = 0;

// Mock startRealTimeMonitoring (just log)
function startRealTimeMonitoring(symbol, positionId) {
  console.log(`📡 Started monitoring ${symbol} | Pos ID: ${positionId}`);
}

// Implemented openPosition - FIXED: Proper precision handling
async function openPosition(symbol, quantity, side, signalType) {
  if (!validSymbolsCache.has(symbol)) {
    console.error(`❌ Invalid symbol: ${symbol}`);
    return { success: false };
  }
  
  try {
    const contractInfo = await getContractInfo(symbol);
    const currentPrice = await getCurrentPrice(symbol);

    console.log(`🔍 Contract Info:`, contractInfo);
    console.log(`🔍 Raw - Price: ${currentPrice}, Raw Qty: ${quantity}`);

    if (currentPrice <= 0 || isNaN(currentPrice)) {
      console.error('❌ Invalid price:', currentPrice);
      return { success: false };
    }

    // FIXED: Round both price and quantity to proper precision
    const roundedPrice = roundPrice(currentPrice, contractInfo.pricePrecision);
    let openQty = roundVolume(quantity, contractInfo.volumePrecision, contractInfo.quantityUnit);
    
    // Ensure minimum quantity
    if (openQty < contractInfo.minQuantity) {
      openQty = contractInfo.minQuantity;
    }

    console.log(`🔍 Rounded - Price: ${roundedPrice}, Qty: ${openQty}`);

    if (openQty <= 0 || isNaN(openQty)) {
      console.error('❌ Invalid quantity:', openQty);
      return { success: false };
    }

    // Format symbol correctly
    let formattedSymbol = symbol;
    if (symbol.includes('_USDT')) {
      formattedSymbol = symbol;
    } else {
      formattedSymbol = symbol.replace('USDT', '_USDT');
    }

    console.log(`🎯 Final Order params:`, {
      symbol: formattedSymbol,
      price: roundedPrice,
      vol: openQty,
      side: 3,
      type: 5,
      leverage: LEVERAGE,
      pricePrecision: contractInfo.pricePrecision,
      volumePrecision: contractInfo.volumePrecision,
      contractMultiplier: contractInfo.contractMultiplier
    });

    const orderSide = 3; // Open short
    const orderResponse = await client.submitOrder({
      symbol: formattedSymbol,
      price: roundedPrice, // FIXED: Use rounded price
      vol: openQty,        // FIXED: Use rounded quantity
      side: orderSide,
      type: 5, // Market
      openType: 2, // Cross margin
      leverage: LEVERAGE,
      positionId: 0,
    });

    console.log('📦 Order response:', JSON.stringify(orderResponse, null, 2));

    let orderId = `order_${Date.now()}`;
    let realPositionId = undefined;
    
    if (orderResponse && orderResponse.data) {
      if (typeof orderResponse.data === 'string') {
        orderId = orderResponse.data;
        console.log(`📝 String order ID: ${orderId}`);
        
        try {
          await new Promise(resolve => setTimeout(resolve, 2000));
          const positions = await getCurrentPositions(formattedSymbol);
          console.log(`🔍 Positions after order:`, positions);
          
          const position = positions.find((p) =>
            p.symbol === formattedSymbol && p.positionType === 2
          );
          if (position) {
            realPositionId = position.id?.toString() || position.positionId?.toString();
            console.log(`📝 Found realPositionId from positions: ${realPositionId}`);
          }
        } catch (error) {
          console.error('Error fetching position after string response:', error);
        }
      } else if (typeof orderResponse.data === 'object') {
        orderId = orderResponse.data.orderId?.toString() || `order_${Date.now()}`;
        realPositionId = orderResponse.data.positionId?.toString() ||
                        orderResponse.data.data?.positionId?.toString();
        console.log(`📝 Object order ID: ${orderId}, realPositionId: ${realPositionId}`);
      } else {
        orderId = `order_${Date.now()}`;
        console.log(`📝 Default order ID: ${orderId}`);
      }
    } else {
      orderId = `order_${Date.now()}`;
      console.log(`📝 No response data, using default order ID: ${orderId}`);
    }
    
    // Final attempt to get realPositionId
    if (!realPositionId) {
      try {
        console.log('🔍 Making final attempt to get realPositionId...');
        await new Promise(resolve => setTimeout(resolve, 3000));
        const positions = await getCurrentPositions(formattedSymbol);
        console.log(`🔍 Final positions check:`, positions);
        
        const position = positions.find((p) =>
          p.symbol === formattedSymbol && p.positionType === 2
        );
        if (position) {
          realPositionId = position.id?.toString() || position.positionId?.toString();
          console.log(`✅ Final realPositionId: ${realPositionId}`);
        } else {
          console.log('❌ No position found in final check');
        }
      } catch (error) {
        console.error('Error in final realPositionId fetch:', error);
      }
    }
    
    const positionId = generatePositionId();
    totalOrders++;

    startRealTimeMonitoring(symbol, positionId);

    return { 
      success: true, 
      positionId, 
      realPositionId,
      orderId,
      symbol: formattedSymbol,
      quantity: openQty,
      price: roundedPrice,
      contractInfo
    };
  } catch (err) {
    console.error('❌ Open position error:', err);
    if (err.response) {
      console.error('❌ Response error:', err.response.data);
    }
    return { success: false, error: err.message };
  }
}

// Get position for polling - FIXED: Proper symbol handling
async function getPosition(symbol) {
  try {
    const positions = await getCurrentPositions(symbol);
    let formattedSymbol = symbol;
    if (symbol && !symbol.includes('_USDT')) {
      formattedSymbol = symbol.replace('USDT', '_USDT');
    }

    console.log(`🔍 Polling positions for ${formattedSymbol}:`, positions.length);
    
    const position = positions.find(p => 
      p.symbol === formattedSymbol && 
      parseFloat(p.holdVol || p.volume || 0) !== 0
    );
    
    if (!position) {
      console.log(`🔍 No active position found for ${formattedSymbol}`);
      return null;
    }

    const price = await getCurrentPrice(symbol);
    const entryPrice = parseFloat(position.openAvgPrice || position.avgPrice || 0);
    const qty = Math.abs(parseFloat(position.holdVol || position.volume || 0));
    const pnl = parseFloat(position.unrealised || position.unrealizedPnl || 0);
    const side = position.positionType === 2 ? 'SHORT' : 'LONG';
    const leverage = LEVERAGE;
    
    let roi = 0;
    if (entryPrice > 0) {
      roi = side === 'SHORT' 
        ? ((entryPrice - price) / entryPrice * leverage * 100) 
        : ((price - entryPrice) / entryPrice * leverage * 100);
    }

    return {
      symbol,
      side,
      entryPrice,
      quantity: qty,
      pnl,
      roi,
      lastPrice: price,
      holdVol: position.holdVol,
      positionType: position.positionType,
      oim: position.oim,
      im: position.im
    };
  } catch (err) {
    console.error(`❌ Position poll error:`, err.message);
    return null;
  }
}

// Main test - FIXED: Proper contract multiplier handling
// Main test - FIXED: Correct calculations
async function runTest() {
  const symbol = "PIPPIN_USDT";
  const targetMargin = 0.5;  // 0.5 USDT margin
  const signalType = "TEST_PUMP_SIGNAL";

  console.log(`🚀 Testing openPosition for ${symbol} | Target Margin: ${targetMargin} USDT | Leverage: ${LEVERAGE}x`);

  try {
    // Get contract info first
    console.log('📋 Getting contract info...');
    const contractInfo = await getContractInfo(symbol);
    console.log('📊 Contract Info:', contractInfo);

    // Get current price
    console.log('💰 Getting current price...');
    const price = await getCurrentPrice(symbol);
    console.log(`💰 Current Price: $${price}`);
    
    if (price <= 0 || isNaN(price)) {
      console.error('❌ Invalid price, stopping test');
      return;
    }
    
    // FIXED: Calculate quantity with correct contract multiplier
    const rawQuantity = calculateQuantity(targetMargin, LEVERAGE, price, contractInfo.contractMultiplier);
    const quantity = roundVolume(rawQuantity, contractInfo.volumePrecision, contractInfo.quantityUnit, contractInfo.contractMultiplier);
    
    // Calculate actual values - FIXED: Multiply by contractMultiplier
    const actualPositionSize = quantity * price * contractInfo.contractMultiplier;
    const actualMarginUsed = actualPositionSize / LEVERAGE;
    
    console.log(`💰 Detailed Calculations:
  - Target Margin: $${targetMargin} USDT
  - Leverage: ${LEVERAGE}x
  - Target Position Size: $${(targetMargin * LEVERAGE).toFixed(4)} USDT
  - Contract Multiplier: ${contractInfo.contractMultiplier} (1 contract = ${contractInfo.contractMultiplier} coins)
  - Current Price: $${price}
  - Required Quantity: ${rawQuantity.toFixed(6)} coins
  - Rounded Quantity: ${quantity} coins
  - Equivalent Contracts: ${quantity * contractInfo.contractMultiplier}
  - Actual Position Size: $${actualPositionSize.toFixed(4)} USDT
  - Actual Margin Used: $${actualMarginUsed.toFixed(4)} USDT`);

    // Verify calculations
    console.log(`🔍 Verification:
  - ${quantity} coins × ${contractInfo.contractMultiplier} multiplier = ${quantity * contractInfo.contractMultiplier} contracts
  - ${quantity * contractInfo.contractMultiplier} contracts × $${price} = $${actualPositionSize.toFixed(4)} position size
  - $${actualPositionSize.toFixed(4)} ÷ ${LEVERAGE} leverage = $${actualMarginUsed.toFixed(4)} margin`);

    // Check if we're close to target
    const marginDiff = Math.abs(actualMarginUsed - targetMargin);
    if (marginDiff > targetMargin * 0.1) { // Cho phép sai số 10%
      console.warn(`⚠️  Warning: Actual margin ($${actualMarginUsed.toFixed(4)}) differs from target ($${targetMargin})`);
    }

    // Check if quantity meets minimum requirement
    const minContracts = contractInfo.minQuantity * contractInfo.contractMultiplier;
    if (quantity * contractInfo.contractMultiplier < minContracts) {
      console.error(`❌ Quantity too small: ${quantity} coins = ${quantity * contractInfo.contractMultiplier} contracts < ${minContracts} min contracts`);
      return;
    }

    // Check current positions before opening
    console.log('🔍 Checking current positions before opening...');
    const currentPositions = await getCurrentPositions(symbol);
    console.log('📊 Current positions:', currentPositions.length > 0 ? currentPositions : 'None');

    // Call openPosition
    console.log('📤 Opening position...');
    const result = await openPosition(symbol, quantity, 'SHORT', signalType);
    
    if (!result.success) {
      console.error('❌ Open position failed:', result.error);
      return;
    }
    
    const estimatedPositionSize = result.quantity * result.price * (result.contractInfo.contractMultiplier || 1);
    const estimatedMargin = estimatedPositionSize / LEVERAGE;
    
    console.log(`✅ Position opened successfully!`);
    console.log(`📋 Details: 
  - Position ID: ${result.positionId}
  - Real Position ID: ${result.realPositionId || 'Not found'}
  - Order ID: ${result.orderId}
  - Symbol: ${result.symbol}
  - Quantity: ${result.quantity} coins (${result.quantity * (result.contractInfo.contractMultiplier || 1)} contracts)
  - Price: $${result.price}
  - Contract Multiplier: ${result.contractInfo.contractMultiplier}
  - Estimated Position Size: $${estimatedPositionSize.toFixed(4)} USDT
  - Estimated Margin: $${estimatedMargin.toFixed(4)} USDT
  - Total Orders: ${totalOrders}`);

    // Poll every 10s for 2 min
    console.log('\n📊 Starting position monitoring (2 minutes)...');
    const startTime = Date.now();
    let pollCount = 0;
    
    const interval = setInterval(async () => {
      pollCount++;
      console.log(`\n🔍 Poll #${pollCount}...`);
      
      const pos = await getPosition(symbol);
      if (pos) {
        const timeElapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
        const contractMultiplier = contractInfo.contractMultiplier || 1;
        const currentPositionSize = pos.quantity * pos.lastPrice * contractMultiplier;
        const currentMargin = currentPositionSize / LEVERAGE;
        
        console.log(`⏰ ${timeElapsed} min | Side: ${pos.side} | PnL: $${pos.pnl.toFixed(4)} | ROI: ${pos.roi.toFixed(2)}%`);
        console.log(`   Price: $${pos.lastPrice.toFixed(6)} | Position: $${currentPositionSize.toFixed(4)} | Margin: $${currentMargin.toFixed(4)}`);
        console.log(`   Qty: ${pos.quantity} coins (${pos.quantity * contractMultiplier} contracts) | OIM: $${pos.oim} | IM: $${pos.im}`);
        
        // Verify against expected
        const expectedMargin = targetMargin;
        const marginDiff = Math.abs(currentMargin - expectedMargin);
        if (marginDiff > expectedMargin * 0.1) {
          console.log(`   ⚠️  Margin diff: +$${(currentMargin - expectedMargin).toFixed(4)} (expected: $${expectedMargin})`);
        }
      } else {
        console.log('🔒 No open position found');
        if (pollCount > 3) {
          console.log('🛑 Stopping monitoring - no position active');
          clearInterval(interval);
        }
      }
    }, 10000);

    // Stop after 2 minutes
    setTimeout(() => {
      clearInterval(interval);
      console.log('\n🛑 Test completed - 2 minutes elapsed');
      process.exit(0);
    }, 120000);

  } catch (err) {
    console.error('❌ Test error:', err);
    if (err.response) {
      console.error('❌ Response data:', err.response.data);
    }
  }
}

process.on('SIGINT', () => {
  console.log('\n🛑 Manual stop requested...');
  process.exit(0);
});

// Run the test
runTest();