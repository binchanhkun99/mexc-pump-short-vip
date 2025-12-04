// test-balance.js
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

// ===== TEST FUTURES BALANCE =====
async function testFuturesBalance() {
  console.log("🔍 TESTING FUTURES BALANCE API");
  console.log("=".repeat(80));
  
  try {
    // 1. Test SDK method
    console.log("\n1. 📊 TESTING SDK getAccountAsset('USDT')...");
    console.log("-".repeat(50));
    
    const sdkResponse = await client.getAccountAsset("USDT");
    console.log("✅ SDK Response:", JSON.stringify(sdkResponse, null, 2));
    
    if (sdkResponse && sdkResponse.data) {
      console.log("\n📋 SDK BALANCE DATA:");
      console.log("-".repeat(30));
      
      const data = sdkResponse.data;
      
      // List all fields
      Object.keys(data).forEach(key => {
        const value = data[key];
        console.log(`   ${key}: ${value}`);
      });
      
      console.log("\n💰 KEY METRICS (from SDK):");
      console.log("-".repeat(30));
      console.log(`   Available Balance: $${parseFloat(data.availableBalance || 0).toFixed(2)}`);
      console.log(`   Cash Balance: $${parseFloat(data.cashBalance || 0).toFixed(2)}`);
      console.log(`   Equity: $${parseFloat(data.equity || 0).toFixed(2)}`);
      console.log(`   Position Margin: $${parseFloat(data.positionMargin || 0).toFixed(2)}`);
      console.log(`   Unrealized PnL: $${parseFloat(data.unrealized || 0).toFixed(2)}`);
      console.log(`   Frozen Balance: $${parseFloat(data.frozenBalance || 0).toFixed(2)}`);
    }
    
    // 2. Test REST API method
    console.log("\n\n2. 🌐 TESTING REST API /private/account...");
    console.log("-".repeat(50));
    
    try {
      const timestamp = Date.now();
      const params = {
        recvWindow: 5000,
        timestamp: timestamp,
      };
      
      // Sign params
      const query = new URLSearchParams(params).toString();
      const signature = crypto
        .createHmac("sha256", API_SECRET)
        .update(query)
        .digest("hex");
      const signedQuery = `${query}&signature=${signature}`;
      
      const url = `https://contract.mexc.com/api/v1/private/account?${signedQuery}`;
      
      const config = {
        headers: {
          "ApiKey": API_KEY,
          "Content-Type": "application/json",
        },
        httpsAgent,
        timeout: 10000,
      };
      
      const restResponse = await axios.get(url, config);
      console.log("✅ REST API Response:", JSON.stringify(restResponse.data, null, 2));
      
      if (restResponse.data && restResponse.data.data) {
        console.log("\n📋 REST API BALANCE DATA:");
        console.log("-".repeat(30));
        const restData = restResponse.data.data;
        Object.keys(restData).forEach(key => {
          console.log(`   ${key}: ${restData[key]}`);
        });
      }
      
    } catch (restError) {
      console.log("❌ REST API Error:", restError.message);
      if (restError.response) {
        console.log("   Status:", restError.response.status);
        console.log("   Data:", JSON.stringify(restError.response.data, null, 2));
      }
    }
    
    // 3. Test alternative endpoint
    console.log("\n\n3. 🔄 TESTING ALTERNATIVE ENDPOINT /account/asset...");
    console.log("-".repeat(50));
    
    try {
      const altUrl = `https://contract.mexc.com/api/v1/account/asset?asset=USDT`;
      const altConfig = {
        headers: {
          "ApiKey": API_KEY,
          "Authorization": `Bearer ${WEB_TOKEN}`,
          "Content-Type": "application/json",
        },
        httpsAgent,
        timeout: 10000,
      };
      
      const altResponse = await axios.get(altUrl, altConfig);
      console.log("✅ Alternative Response:", JSON.stringify(altResponse.data, null, 2));
      
    } catch (altError) {
      console.log("❌ Alternative API Error:", altError.message);
    }
    
    // 4. Analyze and compare
    console.log("\n\n4. 📈 ANALYSIS & COMPARISON");
    console.log("=".repeat(80));
    
    if (sdkResponse && sdkResponse.data) {
      const data = sdkResponse.data;
      
      console.log("\n🔍 BALANCE CONSISTENCY CHECK:");
      console.log("-".repeat(40));
      
      // Check 1: Equity = Cash Balance + Unrealized PnL
      const cash = parseFloat(data.cashBalance || 0);
      const unrealized = parseFloat(data.unrealized || 0);
      const equity = parseFloat(data.equity || 0);
      const calculatedEquity = cash + unrealized;
      
      console.log(`   Equity from API: $${equity.toFixed(2)}`);
      console.log(`   Calculated Equity (Cash + Unrealized): $${calculatedEquity.toFixed(2)}`);
      console.log(`   Difference: $${(equity - calculatedEquity).toFixed(2)}`);
      console.log(`   Match: ${Math.abs(equity - calculatedEquity) < 0.01 ? '✅ YES' : '❌ NO'}`);
      
      // Check 2: Available Balance = Cash Balance - Position Margin
      const available = parseFloat(data.availableBalance || 0);
      const positionMargin = parseFloat(data.positionMargin || 0);
      const calculatedAvailable = cash - positionMargin;
      
      console.log(`\n   Available Balance from API: $${available.toFixed(2)}`);
      console.log(`   Calculated Available (Cash - Position Margin): $${calculatedAvailable.toFixed(2)}`);
      console.log(`   Difference: $${(available - calculatedAvailable).toFixed(2)}`);
      console.log(`   Match: ${Math.abs(available - calculatedAvailable) < 0.01 ? '✅ YES' : '❌ NO'}`);
      
      // Check 3: Which balance to use
      console.log("\n🎯 RECOMMENDED BALANCE TO USE:");
      console.log("-".repeat(40));
      console.log(`   • Available Balance: $${available.toFixed(2)} (for trading)`);
      console.log(`   • Cash Balance: $${cash.toFixed(2)} (total cash)`);
      console.log(`   • Equity: $${equity.toFixed(2)} (total value with P/L)`);
      console.log(`   • Unrealized PnL: $${unrealized.toFixed(2)} ${unrealized >= 0 ? '✅ Profit' : '❌ Loss'}`);
      
      // Recommendation
      console.log("\n📌 RECOMMENDATION for account.js:");
      console.log("-".repeat(40));
      console.log(`   walletBalance should be: $${available.toFixed(2)} (availableBalance)`);
      console.log(`   equity should be: $${equity.toFixed(2)} (equity)`);
      
      // Check if negative balance
      if (available < 0 || cash < 0 || equity < 0) {
        console.log("\n⚠️  WARNING: NEGATIVE BALANCE DETECTED!");
        console.log("   This could explain the negative balance in notifications.");
      }
      
    } else {
      console.log("❌ No SDK data to analyze");
    }
    
    // 5. Test account health
    console.log("\n\n5. 🏦 ACCOUNT HEALTH CHECK");
    console.log("=".repeat(80));
    
    if (sdkResponse && sdkResponse.data) {
      const data = sdkResponse.data;
      const available = parseFloat(data.availableBalance || 0);
      const equity = parseFloat(data.equity || 0);
      const positionMargin = parseFloat(data.positionMargin || 0);
      
      console.log("\n📊 HEALTH METRICS:");
      console.log("-".repeat(30));
      console.log(`   Available Balance: $${available.toFixed(2)}`);
      console.log(`   Total Equity: $${equity.toFixed(2)}`);
      console.log(`   Margin Used: $${positionMargin.toFixed(2)}`);
      console.log(`   Margin Usage: ${positionMargin > 0 ? ((positionMargin / equity) * 100).toFixed(1) : 0}% of equity`);
      
      // Risk assessment
      console.log("\n⚠️  RISK ASSESSMENT:");
      console.log("-".repeat(30));
      
      if (available < 10) {
        console.log("   ❌ LOW BALANCE: Available < $10 - Need to transfer from spot");
      } else if (available < 50) {
        console.log("   ⚠️  MEDIUM BALANCE: Available < $50 - Monitor closely");
      } else {
        console.log("   ✅ GOOD BALANCE: Available > $50");
      }
      
      if (positionMargin > equity * 0.5) {
        console.log("   ⚠️  HIGH MARGIN USAGE: > 50% of equity - High risk");
      }
      
      // Recommendations
      console.log("\n💡 RECOMMENDATIONS:");
      console.log("-".repeat(30));
      if (available < 40) {
        console.log("   1. Transfer from spot to futures (at least $50)");
      }
      if (positionMargin > equity * 0.3) {
        console.log("   2. Consider reducing position sizes");
      }
      console.log("   3. Monitor unrealized PnL closely");
    }
    
  } catch (error) {
    console.error("\n❌ TEST FAILED:", error.message);
    if (error.response) {
      console.error("Response data:", JSON.stringify(error.response.data, null, 2));
    }
    console.error("Stack:", error.stack);
  }
  
  console.log("\n" + "=".repeat(80));
  console.log("✅ BALANCE TEST COMPLETED");
}

// Run test
testFuturesBalance().catch(console.error);