// src/mexc-api.js
// ĐÃ SỬA: contractInfo chuẩn, xử lý lỗi MEXC rõ ràng, không báo success khi order bị reject

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
    const usdtAsset = await client.getAccountAsset("USDT");
    console.log(
      "🔍 USDT Asset response:",
      JSON.stringify(usdtAsset, null, 2)
    );

    if (usdtAsset && usdtAsset.data) {
      const balance = parseFloat(
        usdtAsset.data.availableBalance || usdtAsset.data.walletBalance || 0
      );
      console.log(`💰 Balance từ SDK: $${balance}`);
      return balance;
    }

    return 0;
  } catch (err) {
    console.error("❌ [FUTURES_BALANCE_ERROR]", err.message);
    return 0;
  }
}

// Get contract info (CHUẨN NHẤT, CÓ CACHE + RETRY, KHÔNG FALLBACK ẢO)
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
        {
          params: { symbol: formattedSymbol },
        }
      );

      if (!res.data || res.data.success === false || res.data.code !== 0) {
        const msg =
          res.data?.message || res.data?.msg || "Unknown contract detail error";
        throw new Error(`MEXC contract.detail error: code=${res.data?.code}, msg=${msg}`);
      }

      const contract = res.data.data;
      const info = {
        volumePrecision: contract.volScale ?? 0,
        pricePrecision: contract.priceScale ?? 5,
        minQuantity: parseFloat(contract.minVol ?? "1"),
        quantityUnit: parseFloat(contract.volUnit ?? "1"),
        contractMultiplier: parseFloat(contract.contractSize ?? "1"),
        contractSize: parseFloat(contract.contractSize ?? "1"),
      };

      contractInfoCache.set(cacheKey, { data: info, timestamp: now });
      console.log("📄 [CONTRACT_INFO]", formattedSymbol, info);
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

  // Sau 3 lần retry vẫn fail → throw để phía trên xử lý, KHÔNG fallback ảo
  throw new Error(
    `Không lấy được contract info cho ${formattedSymbol}: ${lastError?.message}`
  );
}

export function roundVolume(
  contracts,       // input = số CONTRACTS
  precision,       // volPrecision từ API
  quantityUnit = 1 // volUnit từ API
) {
  console.log(
    `🔧 Rounding contracts: ${contracts}, precision: ${precision}, unit: ${quantityUnit}`
  );

  if (!isFinite(contracts) || contracts <= 0) {
    console.log("   ❌ Invalid contracts → return 0");
    return 0;
  }

  let rounded;

  if (precision === 0) {
    rounded = Math.round(contracts);   // 14.28 → 14
  } else {
    const factor = Math.pow(10, precision);
    rounded = Math.round(contracts * factor) / factor;
  }

  // áp dụng unit
  if (quantityUnit !== 1) {
    rounded = Math.floor(rounded / quantityUnit) * quantityUnit;
  }

  // min contracts
  if (rounded < quantityUnit) {
    rounded = quantityUnit;
  }

  console.log(`   Rounded = ${rounded} CONTRACTS`);
  return rounded; // ✔ trả về CONTRACTS
}


// Tính position size (đang dùng theo logic cũ: quantity theo coin)
// 🎯 Tính CONTRACTS trực tiếp, KHÔNG qua coins
export function calculatePositionSize(
  balance,
  price,
  positionPercent,
  confidence,
  contractInfo
) {
  if (price <= 0 || balance <= 0) return 0;

  const margin = balance * positionPercent * confidence;
  const notional = margin * LEVERAGE;

  const size = contractInfo.contractSize || 1;

  // rawContracts ~ 14.28 chẳng hạn
  const rawContracts = notional / (price * size);

  const contracts = roundVolume(
    rawContracts,
    contractInfo.volumePrecision,
    contractInfo.quantityUnit
  );

  return contracts; // TRẢ VỀ CONTRACTS
}


// =========================================================
//                  OPEN / CLOSE POSITION
// =========================================================

export async function openPosition(
  symbol,
  quantity,
  side = "SHORT",
  signalType = ""
) {
  try {
    const contractInfo = await getContractInfo(symbol);
    const currentPrice = await getCurrentPrice(symbol);

    if (currentPrice <= 0) {
      return { success: false, error: "Invalid price" };
    }

    const formattedSymbol = formatSymbol(symbol);

    // Round quantity (quantity hiện tại đang là "coins", chưa refactor về contracts)
    const openQty = roundVolume(
      quantity,
      contractInfo.volumePrecision,
      contractInfo.quantityUnit,
      contractInfo.contractMultiplier
    );

    if (openQty <= 0) {
      return { success: false, error: "Invalid quantity" };
    }

    console.log(
      `🎯 Opening ${side}: ${formattedSymbol}, Qty: ${openQty}, Price: ${currentPrice}`
    );

    const orderParams = {
      symbol: formattedSymbol,
      price: currentPrice,
      vol: openQty,
      side: side === "LONG" ? 1 : 3, // 1 = Open long, 3 = Open short
      type: 5, // 5 = Market order
      openType: 2, // Cross margin
      leverage: LEVERAGE,
      positionId: 0,
    };

    console.log("🔐 Order params:", orderParams);

    const orderResponse = await client.submitOrder(orderParams);

    console.log("📦 Order response:", orderResponse);

    // --------- XỬ LÝ LỖI TỪ MEXC ----------
    if (orderResponse && typeof orderResponse === "object") {
      const { success, code, message, msg } = orderResponse;
      if (success === false || (typeof code !== "undefined" && code !== 0)) {
        const errMsg = message || msg || "MEXC rejected order";
        console.error("❌ [OPEN_ORDER_REJECTED]", {
          symbol: formattedSymbol,
          code,
          message: errMsg,
        });
        return { success: false, error: errMsg, code };
      }
    }

    let orderId = `order_${Date.now()}`;
    let realPositionId = undefined;

    // Lấy orderId từ data nếu có
    if (orderResponse && orderResponse.data) {
      if (typeof orderResponse.data === "string") {
        orderId = orderResponse.data;
      } else if (typeof orderResponse.data === "object") {
        orderId =
          orderResponse.data.orderId?.toString() || `order_${Date.now()}`;
        realPositionId = orderResponse.data.positionId?.toString();
      }
    }

    // Thử lấy realPositionId từ getOpenPositions (không bắt buộc)
    if (!realPositionId) {
      try {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const positions = await getOpenPositions(formattedSymbol);
        const position = positions.find(
          (p) => p.symbol === formattedSymbol && p.positionType === 2 // 2 = SHORT
        );
        if (position) {
          realPositionId =
            position.id?.toString() || position.positionId?.toString();
        }
      } catch (error) {
        console.error("Error fetching realPositionId:", error);
      }
    }

    console.log(
      `✅ [ORDER_OPENED] ${formattedSymbol} | ${side} | Qty: ${openQty} | Order: ${orderId} | Position: ${realPositionId}`
    );

    return {
      success: true,
      orderId,
      positionId: realPositionId,
      realPositionId,
      quantity: openQty,
      price: currentPrice,
    };
  } catch (err) {
    console.error(`❌ [OPEN_ORDER_ERROR] ${symbol}:`, err.message);
    if (err.response) {
      console.error("❌ Response error:", err.response.data);
    }
    return { success: false, error: err.message };
  }
}

// Cache cho positions
let positionsCache = null;
let positionsCacheTime = 0;
const CACHE_DURATION = 10_000; // 10s

export async function getOpenPositions(symbol = null) {
  try {
    const now = Date.now();
    if (positionsCache && now - positionsCacheTime < CACHE_DURATION) {
      if (!symbol) return positionsCache;
      const formattedSymbol = symbol.replace("USDT", "_USDT");
      return positionsCache.filter((p) => p.symbol === formattedSymbol);
    }

    console.log("🔍 Fetching all positions via SDK...");

    const response = await client.getOpenPositions();

    let positionsData = [];

    if (response && Array.isArray(response)) {
      positionsData = response;
    } else if (response && response.data && Array.isArray(response.data)) {
      positionsData = response.data;
    }

    const activePositions = positionsData.filter(
      (p) => parseFloat(p.holdVol || p.volume || 0) !== 0
    );

    console.log(`📊 Found ${activePositions.length} active positions`);

    positionsCache = activePositions;
    positionsCacheTime = now;

    if (symbol) {
      const formattedSymbol = symbol.replace("USDT", "_USDT");
      return activePositions.filter((p) => p.symbol === formattedSymbol);
    }

    return activePositions;
  } catch (error) {
    console.error(`❌ [POSITIONS_SDK_ERROR]:`, error.message);
    return [];
  }
}

// Close position (partial or full)
export async function closePosition(symbol, quantity, side = "SHORT") {
  try {
    const contractInfo = await getContractInfo(symbol);
    const currentPrice = await getCurrentPrice(symbol);
    const formattedSymbol = formatSymbol(symbol);

    const closeQty = roundVolume(
      quantity,
      contractInfo.volumePrecision,
      contractInfo.quantityUnit,
      contractInfo.contractMultiplier
    );

    console.log(
      `🎯 Closing ${side}: ${formattedSymbol}, Qty: ${closeQty}, Price: ${currentPrice}`
    );

    const orderParams = {
      symbol: formattedSymbol,
      price: currentPrice,
      vol: closeQty,
      side: side === "LONG" ? 2 : 4, // 2 = Close long, 4 = Close short
      type: 5, // Market order
      openType: 2,
      leverage: LEVERAGE,
      positionId: 0,
    };

    console.log("🔐 Close order params:", orderParams);

    const orderResponse = await client.submitOrder(orderParams);

    console.log("📦 Close order response:", orderResponse);

    if (orderResponse && typeof orderResponse === "object") {
      const { success, code, message, msg } = orderResponse;
      if (success === false || (typeof code !== "undefined" && code !== 0)) {
        const errMsg = message || msg || "MEXC rejected close order";
        console.error("❌ [CLOSE_ORDER_REJECTED]", {
          symbol: formattedSymbol,
          code,
          message: errMsg,
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
        orderId =
          orderResponse.data.orderId?.toString() || `close_${Date.now()}`;
      }
    }

    console.log(
      `✅ [ORDER_CLOSED] ${formattedSymbol} | ${side} | Qty: ${closeQty} | Order: ${orderId}`
    );

    // Ước lượng PnL (tốt nhất nên lấy từ API PnL)
    const positions = await getOpenPositions(formattedSymbol);
    const position = positions.find((p) => p.symbol === formattedSymbol);
    if (position) {
      pnl = parseFloat(position.unrealised || position.unrealizedPnl || 0);
    }

    return {
      success: true,
      orderId,
      pnl,
    };
  } catch (err) {
    console.error(`❌ [CLOSE_ORDER_ERROR] ${symbol}:`, err.message);
    if (err.response) {
      console.error("❌ Response error:", err.response.data);
    }
    return { success: false, pnl: 0, error: err.message };
  }
}

// Get position details
export async function getPosition(symbol) {
  try {
    const allPositions = await getOpenPositions();
    const formattedSymbol = formatSymbol(symbol);

    const position = allPositions.find((p) => {
      const hasPosition = parseFloat(p.holdVol || p.volume || 0) !== 0;
      const symbolMatch = p.symbol === formattedSymbol;
      return hasPosition && symbolMatch;
    });

    if (!position) {
      return null;
    }

    const price = await getCurrentPrice(symbol);
    const entryPrice = parseFloat(
      position.openAvgPrice || position.avgPrice || 0
    );
    const qty = Math.abs(
      parseFloat(position.holdVol || position.volume || 0)
    );
    const pnl = parseFloat(
      position.unrealised || position.unrealizedPnl || 0
    );

    let roi = 0;
    if (entryPrice > 0) {
      roi = ((entryPrice - price) / entryPrice) * LEVERAGE * 100;
      if (position.positionType !== 2) {
        // LONG
        roi = -roi;
      }
    }

    return {
      symbol,
      side: position.positionType === 2 ? "SHORT" : "LONG",
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
    const futuresBalance = await getFuturesBalance();
    if (futuresBalance > minBalance) return true;

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
