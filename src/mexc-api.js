// src/mexc-api.js
// ĐÃ SỬA: contractInfo chuẩn, xử lý lỗi MEXC rõ ràng, không báo success khi order bị reject
// THÊM: Công thức contracts chính xác từ test_2.js, handle contractSize=0, roundContracts thống nhất

import * as dotenv from "dotenv";
import { MexcFuturesClient } from "mexc-futures-sdk";
import axios from "axios";
import crypto from "crypto";
import { HttpsProxyAgent } from "https-proxy-agent";

dotenv.config();

const WEB_TOKEN = process.env.MEXC_AUTH_TOKEN ?? "";
const API_KEY = process.env.MEXC_API_KEY || "";
const API_SECRET = process.env.MEXC_SECRET_KEY || "";
const BASE_URL = "https://futures.mexc.co/api/v1";
const LEVERAGE = 20;

// ======================= PROXY (nếu cần) =======================
const proxyHost = "14.224.225.105";
const proxyPort = 40220;
const proxyUser = "user1762258669";
const proxyPass = "pass1762258669";
const proxyUrl = `http://${proxyUser}:${proxyPass}@${proxyHost}:${proxyPort}`;
const httpsAgent = new HttpsProxyAgent(proxyUrl);

// Axios instance (hiện đang TẮT proxy để ổn định hơn)
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

// Set auth headers cho axios
if (WEB_TOKEN) {
  axiosInstance.defaults.headers.common["Authorization"] = `Bearer ${WEB_TOKEN}`;
}

if (API_KEY) {
  axiosInstance.defaults.headers.common["ApiKey"] = API_KEY;
}

// ======================= SIGNATURE SPOT API =======================
function signParams(params) {
  // params: object đã bao gồm timestamp
  const query = new URLSearchParams(params).toString();
  const signature = crypto
    .createHmac("sha256", API_SECRET)
    .update(query)
    .digest("hex");
  return `${query}&signature=${signature}`;
}

// ======================= HELPERS =======================
function formatSymbol(symbol) {
  return symbol.includes("_USDT") ? symbol : symbol.replace("USDT", "_USDT");
}

// Cache contract info để tránh call quá nhiều
const contractInfoCache = new Map();
const CONTRACT_CACHE_TTL = 5 * 60 * 1000; // 5 phút

// =========================================================
//                  CORE API FUNCTIONS
// =========================================================

// Get current price
export async function getCurrentPrice(symbol) {
  try {
    const formattedSymbol = formatSymbol(symbol);

    // 1) Thử qua SDK trước
    const tickerData = await client.getTicker(formattedSymbol);
    if (tickerData && tickerData.lastPrice) {
      return parseFloat(tickerData.lastPrice);
    }

    // 2) Fallback REST
    const res = await axiosInstance.get(
      "https://contract.mexc.com/api/v1/contract/ticker"
    );
    const tickers = res.data?.data || [];

    const ticker = tickers.find(
      (t) => t.symbol === formattedSymbol || t.symbol === symbol
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

// Get 24h volume (amount24 = USD notional 24h)
export async function getVolume24h(symbol) {
  try {
    const formattedSymbol = formatSymbol(symbol);

    const res = await axiosInstance.get(
      "https://contract.mexc.com/api/v1/contract/ticker"
    );
    const tickers = res.data?.data || [];

    const ticker = tickers.find(
      (t) => t.symbol === formattedSymbol || t.symbol === symbol
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
export async function getFuturesBalance() {
  try {
    const res = await client.getAccountAsset("USDT");

    const available = parseFloat(res.data.availableBalance || 0);
    const margin = parseFloat(res.data.positionMargin || 0);
    const equity = parseFloat(res.data.equity || 0);

    return {
      available,
      margin,
      totalBalance: available + margin,
      equity
    };

  } catch (err) {
    return {
      available: 0,
      margin: 0,
      totalBalance: 0,
      equity: 0
    };
  }
}


// Get contract info
export async function getContractInfo(symbol) {
  const formattedSymbol = formatSymbol(symbol);
  const cacheKey = formattedSymbol;
  const now = Date.now();

  const cached = contractInfoCache.get(cacheKey);
  if (cached && now - cached.timestamp < CONTRACT_CACHE_TTL) {
    return cached.data;
  }

  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await axiosInstance.get(
        "https://contract.mexc.com/api/v1/contract/detail",
        { params: { symbol: formattedSymbol } }
      );

      if (!res.data || res.data.success === false || res.data.code !== 0) {
        const msg = res.data?.message || res.data?.msg || "Unknown contract detail error";
        throw new Error(
          `MEXC contract.detail error: code=${res.data?.code}, msg=${msg}`
        );
      }

      const c = res.data.data;

      const info = {
        volumePrecision: c.volScale ?? 0,
        pricePrecision: c.priceScale ?? 5,
        minQuantity: parseFloat(c.minVol ?? "1"),
        quantityUnit: parseFloat(c.volUnit ?? "1"),
        contractSize: parseFloat(c.contractSize ?? "1"), // Fallback 1 nếu API=0
      };

      // THÊM: Log raw contract info như test_2.js
      console.log(
        "📄 Raw contract info:",
        JSON.stringify(
          {
            symbol: c.symbol,
            contractSize: info.contractSize,
            minVol: info.minQuantity,
            volUnit: info.quantityUnit,
            priceScale: info.pricePrecision,
            volScale: info.volumePrecision,
          },
          null,
          2
        )
      );

      contractInfoCache.set(cacheKey, { data: info, timestamp: now });
      return info;
    } catch (error) {
      lastError = error;
      console.error(
        `❌ [CONTRACT_INFO_ERROR] ${formattedSymbol} (attempt ${attempt}):`,
        error.message
      );
      await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }

  throw new Error(
    `Không lấy được contract info cho ${formattedSymbol}: ${lastError?.message}`
  );
}

// ✅ TÍNH CONTRACTS CHUẨN như test_2.js
export function calculateContracts(targetMargin, leverage, price, contractSize) {
  const targetPositionSize = targetMargin * leverage; // USD
  // CONTRACTS = notional / (price * contractSize)
  const contracts = targetPositionSize / (price * contractSize);
  console.log(`🔧 Calc contracts: targetMargin=${targetMargin}, leverage=${leverage}, price=${price}, contractSize=${contractSize} → rawContracts=${contracts.toFixed(6)}`);
  return contracts;
}

// ✅ Round CONTRACTS chuẩn như test_2.js (thay thế roundVolume)
export function roundContracts(
  contracts,       // số CONTRACTS thô
  precision,       // volPrecision
  quantityUnit = 1 // volUnit
) {
  console.log(
    `🔧 Rounding contracts: ${contracts}, precision: ${precision}, unit: ${quantityUnit}`
  );

  if (!isFinite(contracts) || contracts <= 0) {
    console.log("   ❌ Invalid contracts → return 0");
    return 0;
  }

  let rounded = contracts;

  if (precision === 0) {
    // Làm tròn integer
    rounded = Math.round(contracts);
  } else {
    const factor = Math.pow(10, precision);
    rounded = Math.round(contracts * factor) / factor;
  }

  // Snap theo unit (step size)
  if (quantityUnit !== 1) {
    rounded = Math.floor(rounded / quantityUnit) * quantityUnit;
  }

  // Đảm bảo >= 1 step
  if (rounded < quantityUnit) {
    rounded = quantityUnit;
  }

  console.log(`   Rounded = ${rounded} CONTRACTS`);
  return rounded;
}

// ✅ Round price
function roundPrice(price, precision) {
  const factor = Math.pow(10, precision);
  return Math.round(price * factor) / factor;
}

// Get open positions
export async function getOpenPositions(symbol = null) {
  try {
    let formattedSymbol = symbol;
    if (symbol && !symbol.includes("_USDT")) {
      formattedSymbol = symbol.replace("USDT", "_USDT");
    }

    const response = await client.getOpenPositions(formattedSymbol);

    let activePositions = [];
    if (response && Array.isArray(response)) {
      activePositions = response.filter((p) => parseFloat(p.holdVol || p.volume || 0) !== 0);
    }
    if (response && response.data && Array.isArray(response.data)) {
      activePositions = response.data.filter((p) => parseFloat(p.holdVol || p.volume || 0) !== 0);
    }

    if (symbol) {
      return activePositions.filter((p) => p.symbol === formattedSymbol);
    }

    return activePositions;
  } catch (error) {
    console.error(`❌ [POSITIONS_SDK_ERROR]:`, error.message);
    return [];
  }
}

// Open position với contracts chính xác (từ test_2.js)
export async function openPosition(symbol, contracts, side, signalType, contractInfo) {
  try {
    const formattedSymbol = formatSymbol(symbol);
    const currentPrice = await getCurrentPrice(symbol);
    const roundedPrice = roundPrice(currentPrice, contractInfo.pricePrecision);
    const roundedContracts = roundContracts(contracts, contractInfo.volumePrecision, contractInfo.quantityUnit);

    // THÊM: Check contractSize > 0 & qty >= min
    if (contractInfo.contractSize <= 0) {
      return { success: false, error: `contractSize=0 for ${symbol}, cannot open` };
    }
    if (roundedContracts < contractInfo.minQuantity) {
      return { success: false, error: `Rounded contracts ${roundedContracts} < minQuantity ${contractInfo.minQuantity}` };
    }

    const positionId = generatePositionId(); // Mock từ test_2
    const realPositionId = `real_${Date.now()}`; // Mock
    const orderId = `order_${Date.now()}`;

    // Gọi API thật (như test_2.js)
    const orderParams = {
      symbol: formattedSymbol,
      price: roundedPrice,
      vol: roundedContracts,
      side: side === "SHORT" ? 3 : 4, // 3=Open short, 4=Open long (adjust theo MEXC)
      type: 5, // Market
      openType: 2,
      leverage: LEVERAGE,
      positionId: 0,
    };

    const orderResponse = await client.submitOrder(orderParams);

    // Check response như test_2.js
    if (orderResponse && typeof orderResponse === "object") {
      const { success, code, message, msg } = orderResponse;
      if (success === false || (typeof code !== "undefined" && code !== 0)) {
        const errMsg = message || msg || "MEXC rejected open order";
        console.error("❌ [OPEN_ORDER_REJECTED]", { symbol: formattedSymbol, code, message: errMsg });
        return { success: false, error: errMsg, code };
      }
    }

    console.log(`✅ [ORDER_OPENED] ${formattedSymbol} | ${side} | Contracts: ${roundedContracts} | Order: ${orderId}`);

    return {
      success: true,
      positionId,
      realPositionId,
      orderId,
      symbol: formattedSymbol,
      quantity: roundedContracts, // contracts
      price: roundedPrice,
      contractInfo,
    };
  } catch (err) {
    console.error("❌ Open position error:", err);
    if (err.response) {
      console.error("❌ Response error:", err.response.data);
    }
    return { success: false, error: err.message };
  }
}

// Mock generatePositionId từ test_2
function generatePositionId() {
  return `pos_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Close position (DCA/TP/SL) với contracts chính xác
export async function closePosition(symbol, quantity, side = "SHORT") {
  try {
    const contractInfo = await getContractInfo(symbol);
    const currentPrice = await getCurrentPrice(symbol);
    const formattedSymbol = formatSymbol(symbol);

    if (contractInfo.contractSize <= 0) {
      return { success: false, pnl: 0, error: `contractSize=0 for ${symbol}, cannot close` };
    }

    // ✅ BƯỚC 1: LẤY POSITION VỚI FIELD NAME ĐÚNG
    const allPositions = await getOpenPositions(formattedSymbol);
    
    
    const position = allPositions.find((p) => {
      const hasPosition = parseFloat(p.holdVol || p.volume || 0) !== 0;
      const symbolMatch = p.symbol === formattedSymbol;
      console.log(`  Checking: ${p.symbol}, holdVol: ${p.holdVol}, match: ${symbolMatch && hasPosition}`);
      return hasPosition && symbolMatch;
    });

    if (!position) {
      console.error(`❌ [NO_POSITION] Không tìm thấy position cho ${formattedSymbol}`);
      console.log(`Available symbols: ${allPositions.map(p => p.symbol).join(', ')}`);
      return { 
        success: false, 
        pnl: 0, 
        error: `Position không tồn tại hoặc đã đóng` 
      };
    }

    // ✅ LẤY POSITION ID ĐÚNG FIELD NAME
    const realPositionId = position.positionId; 
    
    console.log(`✅ Found position:`, {
      symbol: position.symbol,
      positionId: realPositionId,
      holdVol: position.holdVol,
      positionType: position.positionType
    });

    const closeQty = roundContracts(
      quantity,
      contractInfo.volumePrecision,
      contractInfo.quantityUnit
    );

    if (closeQty <= 0) {
      return { success: false, pnl: 0, error: `Close qty=0 for ${symbol}` };
    }

    const roundedPrice = roundPrice(currentPrice, contractInfo.pricePrecision);

    console.log(
      `🎯 Closing ${side}: ${formattedSymbol}, Contracts: ${closeQty}, Price: ${roundedPrice}, PositionId: ${realPositionId}`
    );

    // ✅ ORDER PARAMS VỚI POSITION ID ĐÚNG
    const orderParams = {
      symbol: formattedSymbol,
      price: roundedPrice,
      vol: closeQty,
      side: side === "SHORT" ? 2 : 1, // 2=Close SHORT, 1=Close LONG
      type: 5, // Market order
      openType: 2,
      leverage: LEVERAGE,
      positionId: realPositionId, 
    };

    console.log("📋 Close order params:", JSON.stringify(orderParams, null, 2));

    const orderResponse = await client.submitOrder(orderParams);

    console.log("📦 Close order response:", JSON.stringify(orderResponse, null, 2));

    if (orderResponse && typeof orderResponse === "object") {
      const { success, code, message, msg } = orderResponse;
      if (success === false || (typeof code !== "undefined" && code !== 0)) {
        const errMsg = message || msg || "MEXC rejected close order";
        console.error("❌ [CLOSE_ORDER_REJECTED]", {
          symbol: formattedSymbol,
          code,
          message: errMsg,
          positionId: realPositionId
        });
        return { success: false, pnl: 0, error: errMsg, code };
      }
    }

    let orderId = `close_${Date.now()}`;
    let pnl = 0;

    if (orderResponse && orderResponse.data) {
      if (typeof orderResponse.data === "string") {
        orderId = orderResponse.data;
      } else if (typeof orderResponse.data === "object") {
        orderId = orderResponse.data.orderId?.toString() || `close_${Date.now()}`;
      }
    }

    console.log(
      `✅ [ORDER_CLOSED] ${formattedSymbol} | ${side} | Contracts: ${closeQty} | Order: ${orderId} | PositionId: ${realPositionId}`
    );

    // Lấy PnL thực tế
    await new Promise(r => setTimeout(r, 800));
    const updatedPositions = await getOpenPositions(formattedSymbol);
    const updatedPosition = updatedPositions.find((p) => p.symbol === formattedSymbol && p.positionId === realPositionId);
    
if (updatedPosition) {
  // Partial close - vẫn còn position
  // Lấy realized P/L từ field 'realised'
  const newRealised = parseFloat(updatedPosition.realised || 0);
  const oldRealised = parseFloat(position.realised || 0);
  pnl = newRealised - oldRealised; // P/L từ lần close này
} else {
  // Full close - position đã đóng
  // Lấy toàn bộ realized P/L
  const closedPositions = await getOpenPositions(); // Lấy tất cả positions
  const closedPos = closedPositions.find(p => p.positionId === realPositionId);
  
  if (closedPos) {
    // Position vẫn tồn tại nhưng holdVol = 0
    pnl = parseFloat(closedPos.realised || 0);
  } else {
    // Position đã biến mất, dùng giá trị từ position cũ
    pnl = parseFloat(position.realised || 0);
  }
}

    return {
      success: true,
      orderId,
      pnl,
      positionId: realPositionId
    };
  } catch (err) {
    console.error(`❌ [CLOSE_ORDER_ERROR] ${symbol}:`, err.message);
    if (err.response) {
      console.error("❌ Response data:", JSON.stringify(err.response.data, null, 2));
    }
    return { success: false, pnl: 0, error: err.message };
  }
}
// Get position details với contracts chính xác (cập nhật đầy đủ như test_2)
export async function getPosition(symbol) {
  try {
    const allPositions = await getOpenPositions();
    const formattedSymbol = formatSymbol(symbol);
    const contractInfo = await getContractInfo(symbol);

    const position = allPositions.find((p) => {
      const hasPosition = parseFloat(p.holdVol || p.volume || 0) !== 0;
      const symbolMatch = p.symbol === formattedSymbol;
      return hasPosition && symbolMatch;
    });

    if (!position) {
      return null;
    }

    const price = await getCurrentPrice(symbol);
    const entryPrice = parseFloat(position.openAvgPrice || position.avgPrice || 0);
    const contracts = Math.abs(parseFloat(position.holdVol || position.volume || 0));
    
    // ✅ IGNORE profitRatio FROM API - IT'S WRONG!
    // const profitRatio = parseFloat(position.profitRatio || 0); // ❌ DON'T USE THIS
    
    // Tính P/L đúng từ first principles
    const contractSize = contractInfo.contractSize;
    const coins = contracts * contractSize;
    const entryValue = coins * entryPrice;
    const currentValue = coins * price;
    
    let unrealizedPnl = 0;
    if (position.positionType === 2) { // SHORT
      unrealizedPnl = entryValue - currentValue;
    } else { // LONG
      unrealizedPnl = currentValue - entryValue;
    }
    

    const realizedPnl = parseFloat(position.realised || 0);
    const totalPnl = realizedPnl + unrealizedPnl;
    
    const positionSize = currentValue;
    const marginUsed = parseFloat(position.im || position.oim || positionSize / LEVERAGE);

    let roi = 0;
    if (marginUsed > 0) {
      roi = (totalPnl / marginUsed) * 100;
    }

    // Debug log để confirm
    // console.log(`💰 CORRECTED Position data for ${symbol}:`, {
    //   positionId: position.positionId,
    //   contracts: contracts,
    //   contractSize: contractSize,
    //   coins: coins,
    //   entryPrice: entryPrice,
    //   currentPrice: price,
    //   priceChangePct: (((entryPrice - price) / entryPrice) * 100).toFixed(2) + '%',
    //   entryValue: entryValue.toFixed(4),
    //   currentValue: currentValue.toFixed(4),
    //   unrealizedPnl: unrealizedPnl.toFixed(4),
    //   realizedPnl: realizedPnl.toFixed(4),
    //   totalPnl: totalPnl.toFixed(4),
    //   marginUsed: marginUsed.toFixed(4),
    //   calculatedROI: roi.toFixed(2) + '%',
    //   // Hiển thị API profitRatio để thấy nó sai
    //   apiProfitRatio: (position.profitRatio * 100)?.toFixed(2) + '% (WRONG!)',
    //   warning: 'API profitRatio is incorrect - using calculated values'
    // });

    return {
      symbol,
      side: position.positionType === 2 ? "SHORT" : "LONG",
      entryPrice,
      quantity: contracts,
      coins: coins,
      positionSize: positionSize,
      marginUsed: marginUsed,
      pnl: unrealizedPnl, // unrealized PnL cho tracking
      realizedPnl: realizedPnl,
      totalPnl: totalPnl,
      roi: roi, // ROI tính đúng từ P/L
      lastPrice: price,
      margin: marginUsed,
      notional: positionSize,
      positionId: position.positionId,
      rawPositionData: {
        holdVol: position.holdVol,
        openAvgPrice: position.openAvgPrice,
        realised: position.realised,
        fee: position.fee,
        profitRatio: position.profitRatio // Lưu để debug
      }
    };
  } catch (err) {
    console.error(`❌ [GET_POSITION_ERROR] ${symbol}:`, err.message);
    return null;
  }
}
// ======================= DCA/TP/SL HELPERS =======================

// Tính contracts cho DCA (sửa công thức)
export async function calculateDCAPositionSize(symbol, dcaPercent) {
  const { totalBalance: balance } = await getFuturesBalance();  // dùng balance tổng
  const price = await getCurrentPrice(symbol);
  const contractInfo = await getContractInfo(symbol);

  if (price <= 0 || balance <= 0 || contractInfo.contractSize <= 0) return 0;

  const targetMargin = balance * dcaPercent;  // dcaPercent = % tổng ví muốn nạp thêm

  const rawContracts = calculateContracts(
    targetMargin,
    LEVERAGE,
    price,
    contractInfo.contractSize
  );

  const rounded = roundContracts(
    rawContracts,
    contractInfo.volumePrecision,
    contractInfo.quantityUnit
  );

  if (rounded < contractInfo.minQuantity) return 0;

  return rounded;
}

// Tính contracts cho TP/SL (partial close) - đã đúng
export async function calculatePartialCloseSize(symbol, closePercent) {
  try {
    const position = await getPosition(symbol);
    if (!position) return 0;

    const closeContracts = position.quantity * closePercent;
    const contractInfo = await getContractInfo(symbol);
    
    const rounded = roundContracts(closeContracts, contractInfo.volumePrecision, contractInfo.quantityUnit);
    if (rounded < contractInfo.minQuantity) return contractInfo.minQuantity; // Min close 1 step

    return rounded;
  } catch (err) {
    console.error(`❌ [PARTIAL_CLOSE_CALC_ERROR] ${symbol}:`, err.message);
    return 0;
  }
}

// ======================= TRANSFER & BALANCE =======================

async function universalTransfer({
  fromAccountType,
  toAccountType,
  asset,
  amount,
}) {
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
        "X-MEXC-APIKEY": API_KEY,
        "Content-Type": "application/json",
      },
      timeout: 15000,
      httpsAgent,
    };

    await axios.post(url, null, config);

    console.log(
      `✅ [TRANSFER_SUCCESS] ${fromAccountType} → ${toAccountType}: ${amount} ${asset}`
    );
    return true;
  } catch (err) {
    console.error(
      "❌ [TRANSFER_FAILED]:",
      err.response?.data || err.message
    );
    return false;
  }
}

// Check and transfer balance if low
export async function checkAndTransferBalance(minBalance = 40) {
  try {
    const { available: availableBalance } = await getFuturesBalance();

    // Nếu available đủ lớn, không cần chuyển
    if (availableBalance > minBalance) return true;

    // Lấy spot balance
    const timestamp = Date.now();
    const params = { recvWindow: 5000, timestamp };
    const signedQuery = signParams(params);
    const url = `https://api.mexc.com/api/v3/account?${signedQuery}`;

    const config = {
      headers: {
        "X-MEXC-APIKEY": API_KEY,
        "Content-Type": "application/json",
      },
      timeout: 15000,
      httpsAgent,
    };

    const res = await axios.get(url, config);
    const assetBalance = res.data.balances.find((b) => b.asset === "USDT");
    const spotBalance = parseFloat(assetBalance?.free || "0");

    if (spotBalance <= 0) {
      console.error("❌ [TRANSFER_ERROR] No spot balance to transfer");
      return false;
    }

    const transferAmount = Math.min(spotBalance, 50);

    const success = await universalTransfer({
      fromAccountType: "SPOT",
      toAccountType: "FUTURE",
      asset: "USDT",
      amount: transferAmount.toString(),
    });

    if (success) {
      console.log(`💰 [TRANSFERRED] ${transferAmount} USDT to futures`);
      return true;
    }

    return false;
  } catch (err) {
    console.error("❌ [SPOT_BALANCE_ERROR]:", err.message);
    return false;
  }
}
