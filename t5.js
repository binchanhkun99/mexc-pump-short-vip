// test-position.js
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

// ===== INIT SDK CLIENT =====
const client = new MexcFuturesClient({
  authToken: WEB_TOKEN,
  baseURL: BASE_URL,
});

if (WEB_TOKEN) {
  axiosInstance.defaults.headers.common["Authorization"] = `Bearer ${WEB_TOKEN}`;
}

if (API_KEY) {
  axiosInstance.defaults.headers.common["ApiKey"] = API_KEY;
}

// ===== HELPER FUNCTIONS =====
function formatSymbol(symbol) {
  return symbol.includes("_USDT") ? symbol : symbol.replace("USDT", "_USDT");
}

// ===== TEST POSITION CALCULATION =====
async function testPositionCalculation() {
  const symbol = "ALCH_USDT";
  const formattedSymbol = formatSymbol(symbol);
  
  console.log(`🔍 TESTING POSITION FOR: ${formattedSymbol}`);
  console.log("=".repeat(80));
  
  try {
    // 1. Lấy position từ API
    console.log("\n1. 📊 GETTING POSITION FROM API...");
    const positions = await client.getOpenPositions(formattedSymbol);
    
    let position = null;
    if (positions && Array.isArray(positions)) {
      position = positions.find(p => p.symbol === formattedSymbol && parseFloat(p.holdVol || 0) !== 0);
    } else if (positions && positions.data && Array.isArray(positions.data)) {
      position = positions.data.find(p => p.symbol === formattedSymbol && parseFloat(p.holdVol || 0) !== 0);
    }
    
    if (!position) {
      console.log("❌ No active position found for", formattedSymbol);
      return;
    }
    
    console.log("✅ Position found:", JSON.stringify(position, null, 2));
    console.log("\n📋 POSITION DATA SUMMARY:");
    console.log("-".repeat(40));
    console.log(`   Symbol: ${position.symbol}`);
    console.log(`   Position Type: ${position.positionType} (${position.positionType === 2 ? 'SHORT' : 'LONG'})`);
    console.log(`   Hold Volume: ${position.holdVol} contracts`);
    console.log(`   Open Avg Price: $${position.openAvgPrice}`);
    console.log(`   IM (Margin Used): $${position.im}`);
    console.log(`   OIM: $${position.oim}`);
    console.log(`   Realised PnL: $${position.realised}`);
    console.log(`   Profit Ratio: ${position.profitRatio} (${(position.profitRatio * 100).toFixed(4)}%)`);
    console.log(`   Fee: $${position.fee}`);
    console.log(`   Close Profit Loss: $${position.closeProfitLoss}`);
    
    // 2. Lấy contract info
    console.log("\n\n2. 📄 GETTING CONTRACT INFO...");
    const contractRes = await axiosInstance.get(
      "https://contract.mexc.com/api/v1/contract/detail",
      { params: { symbol: formattedSymbol } }
    );
    
    const contractInfo = contractRes.data?.data;
    if (!contractInfo) {
      console.log("❌ Cannot get contract info");
      return;
    }
    
    console.log("✅ Contract info:", {
      symbol: contractInfo.symbol,
      contractSize: contractInfo.contractSize,
      minVol: contractInfo.minVol,
      volUnit: contractInfo.volUnit,
      priceScale: contractInfo.priceScale,
      volScale: contractInfo.volScale
    });
    
    // 3. Lấy current price từ nhiều nguồn
    console.log("\n\n3. 💰 GETTING CURRENT PRICE FROM MULTIPLE SOURCES...");
    
    // Source 1: SDK
    let priceSDK = 0;
    try {
      const tickerSDK = await client.getTicker(formattedSymbol);
      priceSDK = parseFloat(tickerSDK?.lastPrice || 0);
      console.log(`   SDK Price: $${priceSDK}`);
    } catch (err) {
      console.log("   SDK Price: ERROR", err.message);
    }
    
    // Source 2: Ticker API
    let priceAPI = 0;
    try {
      const tickerRes = await axiosInstance.get(
        "https://contract.mexc.com/api/v1/contract/ticker"
      );
      const tickers = tickerRes.data?.data || [];
      const ticker = tickers.find(t => t.symbol === formattedSymbol);
      if (ticker) {
        priceAPI = parseFloat(ticker.lastPrice || 0);
        console.log(`   Ticker API Price: $${priceAPI}`);
      }
    } catch (err) {
      console.log("   Ticker API Price: ERROR", err.message);
    }
    
    // Source 3: Order book
    let priceOrderBook = 0;
    try {
      const orderBookRes = await axiosInstance.get(
        `https://contract.mexc.com/api/v1/contract/depth/${formattedSymbol}`,
        { params: { limit: 5 } }
      );
      if (orderBookRes.data?.data) {
        const bids = orderBookRes.data.data.bids || [];
        const asks = orderBookRes.data.data.asks || [];
        if (bids.length > 0 && asks.length > 0) {
          const bestBid = parseFloat(bids[0][0]);
          const bestAsk = parseFloat(asks[0][0]);
          priceOrderBook = (bestBid + bestAsk) / 2;
          console.log(`   Order Book Mid Price: $${priceOrderBook} (Bid: $${bestBid}, Ask: $${bestAsk})`);
        }
      }
    } catch (err) {
      console.log("   Order Book Price: ERROR", err.message);
    }
    
    // Chọn price
    const currentPrice = priceAPI || priceSDK || priceOrderBook;
    console.log(`\n   ✅ Selected Current Price: $${currentPrice}`);
    
    // 4. TÍNH TOÁN CHI TIẾT
    console.log("\n\n4. 🧮 DETAILED CALCULATIONS...");
    console.log("=".repeat(80));
    
    const contracts = Math.abs(parseFloat(position.holdVol || 0));
    const entryPrice = parseFloat(position.openAvgPrice || 0);
    const contractSize = parseFloat(contractInfo.contractSize || 1);
    const marginUsed = parseFloat(position.im || position.oim || 0);
    
    // 4.1 Tính coins và giá trị
    const coins = contracts * contractSize;
    const entryValue = coins * entryPrice;
    const currentValue = coins * currentPrice;
    
    console.log("\n📐 BASIC CALCULATIONS:");
    console.log("-".repeat(40));
    console.log(`   Contracts: ${contracts}`);
    console.log(`   Contract Size: ${contractSize}`);
    console.log(`   Total Coins: ${coins}`);
    console.log(`   Entry Price: $${entryPrice.toFixed(6)}`);
    console.log(`   Current Price: $${currentPrice.toFixed(6)}`);
    console.log(`   Entry Value: $${entryValue.toFixed(4)}`);
    console.log(`   Current Value: $${currentValue.toFixed(4)}`);
    console.log(`   Margin Used: $${marginUsed.toFixed(4)}`);
    
    // 4.2 Tính P/L theo công thức
    console.log("\n💰 P/L CALCULATIONS:");
    console.log("-".repeat(40));
    
    let unrealizedPnl = 0;
    if (position.positionType === 2) { // SHORT
      unrealizedPnl = entryValue - currentValue;
      console.log(`   SHORT PnL = Entry - Current = $${entryValue.toFixed(4)} - $${currentValue.toFixed(4)} = $${unrealizedPnl.toFixed(4)}`);
    } else { // LONG
      unrealizedPnl = currentValue - entryValue;
      console.log(`   LONG PnL = Current - Entry = $${currentValue.toFixed(4)} - $${entryValue.toFixed(4)} = $${unrealizedPnl.toFixed(4)}`);
    }
    
    const realizedPnl = parseFloat(position.realised || 0);
    const totalPnl = realizedPnl + unrealizedPnl;
    
    console.log(`   Realized PnL (from API): $${realizedPnl.toFixed(4)}`);
    console.log(`   Unrealized PnL (calculated): $${unrealizedPnl.toFixed(4)}`);
    console.log(`   Total PnL: $${totalPnl.toFixed(4)}`);
    
    // 4.3 Tính ROI nhiều cách
    console.log("\n📈 ROI CALCULATIONS:");
    console.log("-".repeat(40));
    
    // Cách 1: Từ P/L và margin
    const roiFromPnl = marginUsed > 0 ? (totalPnl / marginUsed) * 100 : 0;
    console.log(`   1. From PnL/Margin: ($${totalPnl.toFixed(4)} / $${marginUsed.toFixed(4)}) * 100 = ${roiFromPnl.toFixed(2)}%`);
    
    // Cách 2: Từ price change và leverage
    const priceChangePct = position.positionType === 2 
      ? ((entryPrice - currentPrice) / entryPrice) * 100
      : ((currentPrice - entryPrice) / entryPrice) * 100;
    
    const roiFromPrice = priceChangePct * LEVERAGE;
    console.log(`   2. From Price Change: ${priceChangePct.toFixed(2)}% * ${LEVERAGE} = ${roiFromPrice.toFixed(2)}%`);
    
    // Cách 3: Từ profitRatio của API
    const roiFromAPI = (position.profitRatio || 0) * 100;
    console.log(`   3. From API profitRatio: ${position.profitRatio} * 100 = ${roiFromAPI.toFixed(2)}%`);
    
    // 4.4 Debug API fields
    console.log("\n🔍 API FIELD ANALYSIS:");
    console.log("-".repeat(40));
    
    const calculatedProfitRatio = marginUsed > 0 ? unrealizedPnl / marginUsed : 0;
    console.log(`   Calculated profitRatio: ${unrealizedPnl.toFixed(4)} / ${marginUsed.toFixed(4)} = ${calculatedProfitRatio.toFixed(6)}`);
    console.log(`   API profitRatio: ${position.profitRatio}`);
    console.log(`   Difference: ${(calculatedProfitRatio - position.profitRatio).toFixed(6)}`);
    
    // 4.5 Tính expected PnL từ ROI
    console.log("\n🎯 EXPECTED VS ACTUAL:");
    console.log("-".repeat(40));
    
    const expectedPnlFromRoi = (roiFromPrice / 100) * marginUsed;
    console.log(`   Expected PnL from ROI ${roiFromPrice.toFixed(2)}%: $${expectedPnlFromRoi.toFixed(4)}`);
    console.log(`   Actual Total PnL: $${totalPnl.toFixed(4)}`);
    console.log(`   Difference: $${(totalPnl - expectedPnlFromRoi).toFixed(4)}`);
    
    // 4.6 Kiểm tra funding/fee ảnh hưởng
    console.log("\n💸 FEE & FUNDING IMPACT:");
    console.log("-".repeat(40));
    
    const fees = parseFloat(position.fee || 0);
    console.log(`   Fee from API: $${fees.toFixed(4)}`);
    console.log(`   Fee impact on PnL: ${fees !== 0 ? 'YES' : 'NO'}`);
    
    if (Math.abs(roiFromPnl - roiFromPrice) > 1) {
      console.log(`\n⚠️  WARNING: ROI mismatch > 1%!`);
      console.log(`   ROI from PnL: ${roiFromPnl.toFixed(2)}%`);
      console.log(`   ROI from Price: ${roiFromPrice.toFixed(2)}%`);
      console.log(`   Difference: ${Math.abs(roiFromPnl - roiFromPrice).toFixed(2)}%`);
    }
    
    // 5. KẾT LUẬN
    console.log("\n\n5. 📌 FINAL SUMMARY:");
    console.log("=".repeat(80));
    console.log(`   Symbol: ${formattedSymbol}`);
    console.log(`   Side: ${position.positionType === 2 ? 'SHORT' : 'LONG'}`);
    console.log(`   Entry: $${entryPrice.toFixed(6)}`);
    console.log(`   Current: $${currentPrice.toFixed(6)}`);
    console.log(`   Price Change: ${priceChangePct.toFixed(2)}%`);
    console.log(`   Expected ROI (${LEVERAGE}x): ${roiFromPrice.toFixed(2)}%`);
    console.log(`   Calculated ROI: ${roiFromPnl.toFixed(2)}%`);
    console.log(`   Total PnL: $${totalPnl.toFixed(4)}`);
    console.log(`   Margin: $${marginUsed.toFixed(4)}`);
    console.log(`   Position: ${coins} coins (${contracts} contracts)`);
    
    // 6. Thông tin thêm
    console.log("\n\n6. 📊 ADDITIONAL INFO:");
    console.log("=".repeat(80));
    
    // Tính liquidation price cho SHORT
    if (position.positionType === 2) {
      const liquidationPrice = parseFloat(position.liquidatePrice || 0);
      console.log(`   Liquidation Price: $${liquidationPrice.toFixed(6)}`);
      console.log(`   Distance to Liquidation: ${((liquidationPrice - currentPrice) / currentPrice * 100).toFixed(2)}%`);
    }
    
    // Check funding rate
    try {
      const fundingRes = await axiosInstance.get(
        'https://contract.mexc.com/api/v1/contract/fundingRate',
        { params: { symbol: formattedSymbol } }
      );
      const fundingRate = fundingRes.data?.data?.fundingRate;
      if (fundingRate) {
        console.log(`   Funding Rate: ${(fundingRate * 100).toFixed(4)}%`);
      }
    } catch (err) {
      // ignore
    }
    
  } catch (error) {
    console.error("\n❌ TEST FAILED:", error.message);
    if (error.response) {
      console.error("Response data:", JSON.stringify(error.response.data, null, 2));
    }
  }
}

// Run test
testPositionCalculation().catch(console.error);