// test-open-position-contract-fixed.js
// Standalone JS test: Implements openPosition with proper contract-size (contracts-first) handling.
// Tests opening SHORT on ZEC_USDT (or ALCH_USDT) với target margin cụ thể.
// Polls position/PnL every 10s for 2 min.
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
const BASE_URL = "https://futures.mexc.co/api/v1";
const LEVERAGE = 20; // From config

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
  api.defaults.headers.common["Authorization"] = `Bearer ${WEB_TOKEN}`;
}

// Sign if API key
function signParams(params) {
  const timestamp = Date.now();
  const query = { ...params, timestamp };
  const queryString = new URLSearchParams(query).toString();
  const signature = crypto
    .createHmac("sha256", API_SECRET)
    .update(queryString)
    .digest("hex");
  return `${queryString}&signature=${signature}`;
}

if (API_KEY) {
  api.defaults.headers.common["ApiKey"] = API_KEY;
  api.interceptors.request.use((config) => {
    if (config.url.includes("/private/")) {
      const signed = signParams(config.params || {});
      config.params = new URLSearchParams(signed);
    }
    return config;
  });
}

// Mocks/Helpers based on function
// Bạn có thể thêm symbol khác vào đây để test thêm
const validSymbolsCache = new Set(["ALCH_USDT", "ALCH_USDT"]);

// =====================================
// Get contract info from API (contracts-first)
// =====================================
async function getContractInfo(symbol) {
  try {
    const formattedSymbol = symbol.includes("_USDT")
      ? symbol
      : symbol.replace("USDT", "_USDT");

    const res = await api.get(
      "https://contract.mexc.com/api/v1/contract/detail",
      {
        params: { symbol: formattedSymbol },
      }
    );

    if (res.data && res.data.data) {
      const contract = res.data.data;
      console.log(
        "📄 Raw contract info:",
        JSON.stringify(
          {
            symbol: contract.symbol,
            contractSize: contract.contractSize,
            minVol: contract.minVol,
            volUnit: contract.volUnit,
            priceScale: contract.priceScale,
            volScale: contract.volScale,
          },
          null,
          2
        )
      );

      return {
        volumePrecision: contract.volScale ?? 0, // volScale = volPrecision
        pricePrecision: contract.priceScale ?? 5,
        minQuantity: contract.minVol ?? 1, // minVol = min contracts
        quantityUnit: contract.volUnit ?? 1, // volUnit
        contractSize: contract.contractSize ?? 1, // 1 contract = X coins
      };
    }
  } catch (error) {
    console.error("❌ Contract info error:", error.message);
  }

  // Fallback values (ít khi dùng, nhưng để tránh crash)
  return {
    volumePrecision: 0,
    pricePrecision: 5,
    minQuantity: 1,
    quantityUnit: 1,
    contractSize: 1,
  };
}

// ============================
// Get current price
// ============================
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
    const formattedSymbol = symbol.includes("_USDT")
      ? symbol
      : symbol.replace("USDT", "_USDT");
    const tickerData = await client.getTicker(formattedSymbol);
    if (tickerData && tickerData.lastPrice) {
      return parseFloat(tickerData.lastPrice);
    }
  } catch (error2) {
    console.error(`❌ Price SDK formatted error:`, error2.message);
  }

  try {
    // Final fallback: public API
    const res = await api.get(
      "https://contract.mexc.com/api/v1/contract/ticker"
    );
    const tickers = res.data.data || [];

    const formattedSymbol = symbol.includes("_USDT")
      ? symbol
      : symbol.replace("USDT", "_USDT");
    const originalSymbol = symbol.includes("_USDT")
      ? symbol.replace("_USDT", "USDT")
      : symbol;

    let ticker = tickers.find((t) => t.symbol === formattedSymbol);
    if (!ticker) {
      ticker = tickers.find((t) => t.symbol === originalSymbol);
    }
    if (!ticker) {
      ticker = tickers.find((t) => t.symbol === symbol);
    }

    if (ticker) {
      return parseFloat(ticker.lastPrice || ticker.price || 0);
    } else {
      console.error(
        `❌ Ticker not found for ${symbol} (tried: ${formattedSymbol}, ${originalSymbol})`
      );
      return 0;
    }
  } catch (fallbackErr) {
    console.error(`❌ Price fallback error:`, fallbackErr.message);
    return 0;
  }
}

// ============================
// Round price
// ============================
function roundPrice(price, precision) {
  const factor = Math.pow(10, precision);
  return Math.round(price * factor) / factor;
}

// ============================
// ROUND CONTRACTS (contracts-first)
// ============================
function roundContracts(contracts, precision, quantityUnit = 1) {
  console.log(
    `🔧 Rounding contracts: ${contracts}, precision: ${precision}, unit: ${quantityUnit}`
  );

  if (!isFinite(contracts) || contracts <= 0) {
    console.log("   ❌ Invalid contracts, return 0");
    return 0;
  }

  let rounded;

  if (precision === 0) {
    rounded = Math.round(contracts);
  } else {
    const factor = Math.pow(10, precision);
    rounded = Math.round(contracts * factor) / factor;
  }

  // đảm bảo bội số của quantityUnit
  if (quantityUnit !== 1) {
    rounded = Math.floor(rounded / quantityUnit) * quantityUnit;
  }

  if (rounded < quantityUnit) {
    rounded = quantityUnit;
  }

  console.log(`   Rounded contracts: ${rounded}`);
  return rounded;
}

// ============================
// CALCULATE CONTRACTS (contracts-first)
// ============================
function calculateContracts(targetMargin, leverage, price, contractSize) {
  const targetPositionSize = targetMargin * leverage; // USD
  // CONTRACTS = notional / (price * contractSize)
  const contracts = targetPositionSize / (price * contractSize);
  return contracts;
}

// ============================
// Get current positions
// ============================
async function getCurrentPositions(symbol) {
  let formattedSymbol = symbol;

  if (symbol && !symbol.includes("_USDT")) {
    formattedSymbol = symbol.replace("USDT", "_USDT");
  }

  try {
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
      const res = await api.get("/private/position/open_positions", {
        params: { symbol: formattedSymbol },
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

// ============================
// openPosition (contracts-first)
// quantity = contracts
// ============================
async function openPosition(symbol, contracts, side, signalType, contractInfo) {
  if (!validSymbolsCache.has(symbol)) {
    console.error(`❌ Invalid symbol: ${symbol}`);
    return { success: false };
  }

  try {
    const currentPrice = await getCurrentPrice(symbol);

    console.log(`🔍 Contract Info (in openPosition):`, contractInfo);
    console.log(
      `🔍 Raw - Price: ${currentPrice}, Raw contracts: ${contracts}`
    );

    if (currentPrice <= 0 || isNaN(currentPrice)) {
      console.error("❌ Invalid price:", currentPrice);
      return { success: false };
    }

    const roundedPrice = roundPrice(currentPrice, contractInfo.pricePrecision);
    let openContracts = roundContracts(
      contracts,
      contractInfo.volumePrecision,
      contractInfo.quantityUnit
    );

    if (openContracts < contractInfo.minQuantity) {
      openContracts = contractInfo.minQuantity;
    }

    console.log(
      `🔍 Rounded - Price: ${roundedPrice}, Contracts: ${openContracts}`
    );

    if (openContracts <= 0 || isNaN(openContracts)) {
      console.error("❌ Invalid contracts:", openContracts);
      return { success: false };
    }

    let formattedSymbol = symbol;
    if (!symbol.includes("_USDT")) {
      formattedSymbol = symbol.replace("USDT", "_USDT");
    }

    const coins = openContracts * contractInfo.contractSize;
    const estimatedPositionSize = coins * roundedPrice;
    const estimatedMargin = estimatedPositionSize / LEVERAGE;

    console.log(`🎯 Final Order params:`, {
      symbol: formattedSymbol,
      price: roundedPrice,
      vol: openContracts, // CONTRACTS
      side: 3,
      type: 5,
      leverage: LEVERAGE,
      contracts: openContracts,
      coins,
      estimatedPositionSize,
      estimatedMargin,
    });

    const orderSide = 3; // Open short
    const orderResponse = await client.submitOrder({
      symbol: formattedSymbol,
      price: roundedPrice,
      vol: openContracts, // CONTRACTS
      side: orderSide,
      type: 5, // Market
      openType: 2, // Cross margin
      leverage: LEVERAGE,
      positionId: 0,
    });

    console.log("📦 Order response:", JSON.stringify(orderResponse, null, 2));

    let orderId = `order_${Date.now()}`;
    let realPositionId = undefined;

    if (orderResponse && orderResponse.data) {
      if (typeof orderResponse.data === "string") {
        orderId = orderResponse.data;
        console.log(`📝 String order ID: ${orderId}`);

        try {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          const positions = await getCurrentPositions(formattedSymbol);
          console.log(`🔍 Positions after order:`, positions);

          const position = positions.find(
            (p) => p.symbol === formattedSymbol && p.positionType === 2
          );
          if (position) {
            realPositionId =
              position.id?.toString() || position.positionId?.toString();
            console.log(
              `📝 Found realPositionId from positions: ${realPositionId}`
            );
          }
        } catch (error) {
          console.error("Error fetching position after string response:", error);
        }
      } else if (typeof orderResponse.data === "object") {
        orderId =
          orderResponse.data.orderId?.toString() || `order_${Date.now()}`;
        realPositionId =
          orderResponse.data.positionId?.toString() ||
          orderResponse.data.data?.positionId?.toString();
        console.log(
          `📝 Object order ID: ${orderId}, realPositionId: ${realPositionId}`
        );
      } else {
        orderId = `order_${Date.now()}`;
        console.log(`📝 Default order ID: ${orderId}`);
      }
    } else {
      orderId = `order_${Date.now()}`;
      console.log(`📝 No response data, using default order ID: ${orderId}`);
    }

    if (!realPositionId) {
      try {
        console.log("🔍 Making final attempt to get realPositionId...");
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const positions = await getCurrentPositions(formattedSymbol);
        console.log(`🔍 Final positions check:`, positions);

        const position = positions.find(
          (p) => p.symbol === formattedSymbol && p.positionType === 2
        );
        if (position) {
          realPositionId =
            position.id?.toString() || position.positionId?.toString();
          console.log(`✅ Final realPositionId: ${realPositionId}`);
        } else {
          console.log("❌ No position found in final check");
        }
      } catch (error) {
        console.error("Error in final realPositionId fetch:", error);
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
      quantity: openContracts, // contracts
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

// ============================
// Get position for polling
// ============================
async function getPosition(symbol) {
  try {
    const positions = await getCurrentPositions(symbol);
    let formattedSymbol = symbol;
    if (symbol && !symbol.includes("_USDT")) {
      formattedSymbol = symbol.replace("USDT", "_USDT");
    }

    console.log(
      `🔍 Polling positions for ${formattedSymbol}:`,
      positions.length
    );

    const position = positions.find(
      (p) =>
        p.symbol === formattedSymbol &&
        parseFloat(p.holdVol || p.volume || 0) !== 0
    );

    if (!position) {
      console.log(`🔍 No active position found for ${formattedSymbol}`);
      return null;
    }

    const price = await getCurrentPrice(symbol);
    const entryPrice = parseFloat(
      position.openAvgPrice || position.avgPrice || 0
    );
    const contracts = Math.abs(
      parseFloat(position.holdVol || position.volume || 0)
    );
    const pnl = parseFloat(position.unrealised || position.unrealizedPnl || 0);
    const side = position.positionType === 2 ? "SHORT" : "LONG";

    let roi = 0;
    if (entryPrice > 0) {
      roi =
        side === "SHORT"
          ? ((entryPrice - price) / entryPrice) * LEVERAGE * 100
          : ((price - entryPrice) / entryPrice) * LEVERAGE * 100;
    }

    return {
      symbol,
      side,
      entryPrice,
      quantity: contracts, // contracts
      pnl,
      roi,
      lastPrice: price,
      holdVol: position.holdVol,
      positionType: position.positionType,
      oim: position.oim,
      im: position.im,
    };
  } catch (err) {
    console.error(`❌ Position poll error:`, err.message);
    return null;
  }
}

// ============================
// Main test - CONTRACT-FIRST
// ============================
async function runTest() {
  const symbol = "ALCH_USDT"; // hoặc "ALCH_USDT"
  const targetMargin = 0.7;
  const signalType = "TEST_PUMP_SIGNAL";

  console.log(
    `🚀 Testing openPosition for ${symbol} | Target Margin: ${targetMargin} USDT | Leverage: ${LEVERAGE}x`
  );

  try {
    console.log("📋 Getting contract info...");
    const contractInfo = await getContractInfo(symbol);
    console.log("📊 Contract Info:", contractInfo);

    console.log("💰 Getting current price...");
    const price = await getCurrentPrice(symbol);
    console.log(`💰 Current Price: $${price}`);

    if (price <= 0 || isNaN(price)) {
      console.error("❌ Invalid price, stopping test");
      return;
    }

    // 1) Tính CONTRACTS (contracts-first)
    const rawContracts = calculateContracts(
      targetMargin,
      LEVERAGE,
      price,
      contractInfo.contractSize
    );

    // 2) Round contracts
    const contracts = roundContracts(
      rawContracts,
      contractInfo.volumePrecision,
      contractInfo.quantityUnit
    );

    // 3) Tính coins, position, margin
    const coins = contracts * contractInfo.contractSize;
    const actualPositionSize = coins * price;
    const actualMarginUsed = actualPositionSize / LEVERAGE;

    console.log(`💰 Detailed Calculations:
  - Target Margin: $${targetMargin} USDT
  - Leverage: ${LEVERAGE}x
  - Target Position Size: $${(targetMargin * LEVERAGE).toFixed(4)} USDT
  - Contract Size: ${contractInfo.contractSize} (1 contract = ${contractInfo.contractSize} coins)
  - Current Price: $${price}
  - Raw Contracts: ${rawContracts}
  - Rounded Contracts: ${contracts}
  - Coins (contracts × contractSize): ${contracts} × ${contractInfo.contractSize} = ${coins}
  - Actual Position Size: $${actualPositionSize.toFixed(4)} USDT
  - Actual Margin Used: $${actualMarginUsed.toFixed(4)} USDT`);

    console.log(`🔍 Verification:
  - Position = coins × price = ${coins} × ${price} = ${actualPositionSize.toFixed(4)}
  - Margin = position / leverage = ${actualPositionSize.toFixed(
      4
    )} ÷ ${LEVERAGE} = ${actualMarginUsed.toFixed(4)} USDT`);

    const marginDiff = Math.abs(actualMarginUsed - targetMargin);
    if (marginDiff > targetMargin * 0.1) {
      console.warn(
        `⚠️  Warning: Actual margin ($${actualMarginUsed.toFixed(
          4
        )}) differs from target ($${targetMargin})`
      );
    }

    // Check min contracts
    const minContracts = contractInfo.minQuantity;
    if (contracts < minContracts) {
      console.error(
        `❌ Contracts too small: ${contracts} < minContracts=${minContracts}`
      );
      return;
    }

    console.log("🔍 Checking current positions before opening...");
    const currentPositions = await getCurrentPositions(symbol);
    console.log(
      "📊 Current positions:",
      currentPositions.length > 0 ? currentPositions : "None"
    );

    console.log("📤 Opening position...");
    const result = await openPosition(
      symbol,
      contracts,
      "SHORT",
      signalType,
      contractInfo
    );

    if (!result.success) {
      console.error("❌ Open position failed:", result.error);
      return;
    }

    const estCoins = result.quantity * result.contractInfo.contractSize;
    const estimatedPositionSize = estCoins * result.price;
    const estimatedMargin = estimatedPositionSize / LEVERAGE;

    console.log(`✅ Position opened successfully!`);
    console.log(`📋 Details: 
  - Position ID: ${result.positionId}
  - Real Position ID: ${result.realPositionId || "Not found"}
  - Order ID: ${result.orderId}
  - Symbol: ${result.symbol}
  - Quantity: ${result.quantity} contracts (${estCoins} coins)
  - Price: $${result.price}
  - Contract Size: ${result.contractInfo.contractSize}
  - Estimated Position Size: $${estimatedPositionSize.toFixed(4)} USDT
  - Estimated Margin: $${estimatedMargin.toFixed(4)} USDT
  - Total Orders: ${totalOrders}`);

    // Poll every 10s for 2 min
    console.log("\n📊 Starting position monitoring (2 minutes)...");
    const startTime = Date.now();
    let pollCount = 0;

    const interval = setInterval(async () => {
      pollCount++;
      console.log(`\n🔍 Poll #${pollCount}...`);

      const pos = await getPosition(symbol);
      if (pos) {
        const timeElapsed = (
          (Date.now() - startTime) /
          1000 /
          60
        ).toFixed(1);
        const contractSize = contractInfo.contractSize || 1;
        const coinsNow = pos.quantity * contractSize;
        const currentPositionSize = coinsNow * pos.lastPrice;
        const currentMargin = currentPositionSize / LEVERAGE;

        console.log(
          `⏰ ${timeElapsed} min | Side: ${pos.side} | PnL: $${pos.pnl.toFixed(
            4
          )} | ROI: ${pos.roi.toFixed(2)}%`
        );
        console.log(
          `   Price: $${pos.lastPrice.toFixed(
            6
          )} | Position: $${currentPositionSize.toFixed(
            4
          )} | Margin: $${currentMargin.toFixed(4)}`
        );
        console.log(
          `   Qty: ${pos.quantity} contracts (${coinsNow} coins) | OIM: $${pos.oim} | IM: $${pos.im}`
        );

        const expectedMargin = targetMargin;
        const marginDiffLive = Math.abs(currentMargin - expectedMargin);
        if (marginDiffLive > expectedMargin * 0.1) {
          console.log(
            `   ⚠️  Margin diff: +$${(
              currentMargin - expectedMargin
            ).toFixed(4)} (expected: $${expectedMargin})`
          );
        }
      } else {
        console.log("🔒 No open position found");
        if (pollCount > 3) {
          console.log("🛑 Stopping monitoring - no position active");
          clearInterval(interval);
        }
      }
    }, 10000);

    setTimeout(() => {
      clearInterval(interval);
      console.log("\n🛑 Test completed - 2 minutes elapsed");
      process.exit(0);
    }, 120000);
  } catch (err) {
    console.error("❌ Test error:", err);
    if (err.response) {
      console.error("❌ Response data:", err.response.data);
    }
  }
}

process.on("SIGINT", () => {
  console.log("\n🛑 Manual stop requested...");
  process.exit(0);
});

// Run the test
runTest();
