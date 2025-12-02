// test_position_fields.js
// Kiểm tra tên trường thực tế của position từ MEXC API

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

// =========================================================
//                  TEST FUNCTIONS
// =========================================================

async function testGetOpenPositions() {
  console.log("\n" + "=".repeat(60));
  console.log("TEST 1: Get Open Positions via SDK");
  console.log("=".repeat(60));

  try {
    const response = await client.getOpenPositions(null);
    
    console.log("\n📦 Raw SDK Response:");
    console.log(JSON.stringify(response, null, 2));

    let positions = [];
    if (Array.isArray(response)) {
      positions = response;
    } else if (response && response.data && Array.isArray(response.data)) {
      positions = response.data;
    }

    console.log(`\n📊 Found ${positions.length} total positions`);

    const activePositions = positions.filter(
      (p) => parseFloat(p.holdVol || p.volume || 0) !== 0
    );

    console.log(`✅ ${activePositions.length} active positions (holdVol != 0)`);

    if (activePositions.length > 0) {
      console.log("\n" + "-".repeat(60));
      console.log("ACTIVE POSITIONS - ALL FIELDS:");
      console.log("-".repeat(60));

      activePositions.forEach((pos, idx) => {
        console.log(`\nPosition ${idx + 1}:`);
        console.log(JSON.stringify(pos, null, 2));
        
        console.log("\n🔍 Key Fields:");
        console.log(`  symbol: ${pos.symbol}`);
        console.log(`  positionId: ${pos.positionId || "KHÔNG CÓ"}`);
        console.log(`  id: ${pos.id || "KHÔNG CÓ"}`);
        console.log(`  position_id: ${pos.position_id || "KHÔNG CÓ"}`);
        console.log(`  positionID: ${pos.positionID || "KHÔNG CÓ"}`);
        console.log(`  holdVol: ${pos.holdVol}`);
        console.log(`  volume: ${pos.volume}`);
        console.log(`  openAvgPrice: ${pos.openAvgPrice}`);
        console.log(`  positionType: ${pos.positionType} (1=LONG, 2=SHORT)`);
        console.log(`  unrealised: ${pos.unrealised}`);
        console.log(`  unrealizedPnl: ${pos.unrealizedPnl || "KHÔNG CÓ"}`);
        console.log("-".repeat(60));
      });
    } else {
      console.log("\n⚠️ Không có position nào đang mở");
    }

    return activePositions;
  } catch (error) {
    console.error("\n❌ Error in testGetOpenPositions:");
    console.error(error.message);
    if (error.response) {
      console.error("Response data:", error.response.data);
    }
    return [];
  }
}

async function testGetPositionREST() {
  console.log("\n" + "=".repeat(60));
  console.log("TEST 2: Get Open Positions via REST API");
  console.log("=".repeat(60));

  try {
    const url = `${BASE_URL}/private/position/open_positions`;
    
    console.log(`\n📡 Calling: ${url}`);
    
    const response = await axiosInstance.get(url);

    console.log("\n📦 Raw REST Response:");
    console.log(JSON.stringify(response.data, null, 2));

    if (response.data && response.data.data) {
      const positions = response.data.data;
      
      console.log(`\n📊 Found ${positions.length} positions`);

      const activePositions = positions.filter(
        (p) => parseFloat(p.holdVol || p.volume || 0) !== 0
      );

      console.log(`✅ ${activePositions.length} active positions`);

      if (activePositions.length > 0) {
        console.log("\n" + "-".repeat(60));
        console.log("REST API POSITIONS - ALL FIELDS:");
        console.log("-".repeat(60));

        activePositions.forEach((pos, idx) => {
          console.log(`\nPosition ${idx + 1}:`);
          console.log(JSON.stringify(pos, null, 2));
        });
      }

      return activePositions;
    }

    return [];
  } catch (error) {
    console.error("\n❌ Error in testGetPositionREST:");
    console.error(error.message);
    if (error.response) {
      console.error("Response data:", error.response.data);
    }
    return [];
  }
}

async function testSpecificSymbol(symbol = "SVSA_USDT") {
  console.log("\n" + "=".repeat(60));
  console.log(`TEST 3: Get Position for ${symbol}`);
  console.log("=".repeat(60));

  try {
    const response = await client.getOpenPositions(symbol);

    console.log("\n📦 Raw Response for specific symbol:");
    console.log(JSON.stringify(response, null, 2));

    let positions = [];
    if (Array.isArray(response)) {
      positions = response;
    } else if (response && response.data && Array.isArray(response.data)) {
      positions = response.data;
    }

    const position = positions.find(
      (p) =>
        p.symbol === symbol && parseFloat(p.holdVol || p.volume || 0) !== 0
    );

    if (position) {
      console.log("\n✅ Found position for", symbol);
      console.log("\n🔍 FULL POSITION OBJECT:");
      console.log(JSON.stringify(position, null, 2));

      console.log("\n🎯 POSITION ID DETECTION:");
      console.log(`  position.positionId = ${position.positionId || "undefined"}`);
      console.log(`  position.id = ${position.id || "undefined"}`);
      console.log(`  position.position_id = ${position.position_id || "undefined"}`);
      console.log(`  position.positionID = ${position.positionID || "undefined"}`);
      console.log(`  position.contractId = ${position.contractId || "undefined"}`);

      // Tìm tất cả các field có chứa "id" (case-insensitive)
      console.log("\n🔎 All fields containing 'id':");
      Object.keys(position).forEach((key) => {
        if (key.toLowerCase().includes("id")) {
          console.log(`  ${key}: ${position[key]}`);
        }
      });

      return position;
    } else {
      console.log(`\n⚠️ Không tìm thấy active position cho ${symbol}`);
      return null;
    }
  } catch (error) {
    console.error("\n❌ Error in testSpecificSymbol:");
    console.error(error.message);
    if (error.response) {
      console.error("Response data:", error.response.data);
    }
    return null;
  }
}

async function testCloseOrderParams() {
  console.log("\n" + "=".repeat(60));
  console.log("TEST 4: Test Close Order Structure (DRY RUN)");
  console.log("=".repeat(60));

  const positions = await testGetOpenPositions();

  if (positions.length > 0) {
    const testPos = positions[0];
    
    console.log("\n📝 Example Close Order Params:");
    
    // Thử các field ID khác nhau
    const possibleIdFields = [
      "positionId",
      "id", 
      "position_id",
      "positionID",
      "contractId"
    ];

    possibleIdFields.forEach(fieldName => {
      if (testPos[fieldName] !== undefined) {
        console.log(`\n✅ Found: ${fieldName} = ${testPos[fieldName]}`);
        console.log(`Close order params would be:`);
        console.log(JSON.stringify({
          symbol: testPos.symbol,
          price: 0.00352,
          vol: 100,
          side: 4, // Close SHORT
          type: 5,
          openType: 2,
          leverage: LEVERAGE,
          [fieldName]: testPos[fieldName]
        }, null, 2));
      }
    });
  }
}

// =========================================================
//                  RUN ALL TESTS
// =========================================================

async function runAllTests() {
  console.log("\n🚀 Starting MEXC Position Field Tests...\n");

  try {
    // Test 1: SDK
    const sdkPositions = await testGetOpenPositions();

    // Test 2: REST API
    await testGetPositionREST();

    // Test 3: Specific symbol (nếu có position)
    if (sdkPositions.length > 0) {
      const firstSymbol = sdkPositions[0].symbol;
      await testSpecificSymbol(firstSymbol);
    }

    // Test 4: Close order params
    await testCloseOrderParams();

    console.log("\n" + "=".repeat(60));
    console.log("✅ ALL TESTS COMPLETED");
    console.log("=".repeat(60));
    console.log("\n📌 NEXT STEPS:");
    console.log("1. Tìm field name chính xác của position ID từ log trên");
    console.log("2. Update mexc-api.js sử dụng đúng field name");
    console.log("3. Test close position thật");

  } catch (error) {
    console.error("\n❌ Test suite failed:");
    console.error(error);
  }
}

// Run tests
runAllTests().catch(console.error);

// ============================================================
// TEST 1: Get Open Positions via SDK
// ============================================================

// 📦 Raw SDK Response:
// {
//   "success": true,
//   "code": 0,
//   "data": [
//     {
//       "positionId": 1172704016,
//       "symbol": "PUP_USDT",
//       "positionType": 2,
//       "openType": 2,
//       "state": 1,
//       "holdVol": 58,
//       "frozenVol": 0,
//       "closeVol": 0,
//       "holdAvgPrice": 0.002533,
//       "holdAvgPriceFullyScale": "0.002533",
//       "openAvgPrice": 0.002533,
//       "openAvgPriceFullyScale": "0.002533",
//       "closeAvgPrice": 0,
//       "liquidatePrice": 0.028784,
//       "oim": 0.7375964284,
//       "im": 0.7375964284,
//       "holdFee": 0,
//       "realised": -0.0029,
//       "leverage": 20,
//       "marginRatio": 0.0038,
//       "createTime": 1764668693490,
//       "updateTime": 1764668693490,
//       "autoAddIm": false,
//       "version": 1,
//       "profitRatio": -0.0039,
//       "newOpenAvgPrice": 0.002533,
//       "newCloseAvgPrice": 0,
//       "closeProfitLoss": 0,
//       "fee": -0.0029,
//       "deductFeeList": [],
//       "totalFee": 0.0029,
//       "zeroSaveTotalFeeBinance": 0,
//       "zeroTradeTotalFeeBinance": 0.0029
//     },
//     {
//       "positionId": 1172623142,
//       "symbol": "MEMERUSH_USDT",
//       "positionType": 2,
//       "openType": 2,
//       "state": 1,
//       "holdVol": 61,
//       "frozenVol": 0,
//       "closeVol": 0,
//       "holdAvgPrice": 0.0024,
//       "holdAvgPriceFullyScale": "0.0024",
//       "openAvgPrice": 0.0024,
//       "openAvgPriceFullyScale": "0.0024",
//       "closeAvgPrice": 0,
//       "liquidatePrice": 0.027278,
//       "oim": 0.73803168,
//       "im": 0.73803168,
//       "holdFee": 0,
//       "realised": -0.0058,
//       "leverage": 20,
//       "marginRatio": 0.0038,
//       "createTime": 1764664647731,
//       "updateTime": 1764664647731,
//       "autoAddIm": false,
//       "version": 1,
//       "profitRatio": -0.0079,
//       "newOpenAvgPrice": 0.0024,
//       "newCloseAvgPrice": 0,
//       "closeProfitLoss": 0,
//       "fee": -0.0058,
//       "deductFeeList": [],
//       "totalFee": 0.0058,
//       "zeroSaveTotalFeeBinance": 0,
//       "zeroTradeTotalFeeBinance": 0.0058
//     }
//   ]
// }