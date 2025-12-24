// t.js — ✅ ĐÃ SỬA: GET + query params + header signature
import * as dotenv from "dotenv";
import axios from "axios";
import crypto from "crypto";
import { HttpsProxyAgent } from "https-proxy-agent";

dotenv.config();

const API_KEY = process.env.MEXC_API_KEY?.trim();
const API_SECRET = process.env.MEXC_SECRET_KEY?.trim();

if (!API_KEY || !API_SECRET) {
  console.error("❌ Thiếu MEXC_API_KEY hoặc MEXC_SECRET_KEY");
  process.exit(1);
}

// 🌐 Proxy
const httpsAgent = new HttpsProxyAgent(
  "http://user1764683329:pass1764683329@14.224.225.129:37771"
);

const axiosInstance = axios.create({
  // httpsAgent,
  proxy: false,
  timeout: 15000,
});

// ✅ Ký futures — giống trước, nhưng dùng cho query string
function signFuturesQuery(params, secret) {
  const sortedKeys = Object.keys(params).sort();
  const queryString = sortedKeys
    .map(k => `${k}=${params[k]}`)
    .join("&");
  return crypto.createHmac("sha256", secret).update(queryString).digest("hex");
}

// ✅ GET balance — đúng chuẩn MEXC Futures
async function getFuturesBalance() {
  const timestamp = Date.now();
  const params = {
    currency: "USDT",
    timestamp: timestamp,
  };

  // Tạo query string đã sắp xếp
  const sortedKeys = Object.keys(params).sort();
  const queryString = sortedKeys
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join("&");

  const signature = signFuturesQuery(params, API_SECRET);

  const url = `https://contract.mexc.com/api/v1/private/account/assets?${queryString}`;

  try {
    const res = await axiosInstance.get(url, {
      headers: {
        "ApiKey": API_KEY,
        "Request-Time": timestamp,
        "Signature": signature,
      },
    });

    if (res.data.code !== 0) {
      throw new Error(`MEXC error ${res.data.code}: ${res.data.message || res.data.msg}`);
    }

    const usdt = res.data.data.find(a => a.currency === "USDT");
    if (!usdt) throw new Error("USDT not found");

    return {
      available: parseFloat(usdt.available || 0),
      frozen: parseFloat(usdt.frozen || 0),
      equity: parseFloat(usdt.profit_unreal || 0) + parseFloat(usdt.available || 0) + parseFloat(usdt.frozen || 0),
    };
  } catch (err) {
    console.error("❌ Lỗi balance:", err.message);
    if (err.response) {
      console.log("📡 Status:", err.response.status);
      console.log("📡 Raw:", JSON.stringify(err.response.data, null, 2));
    }
    return null;
  }
}

// ▶️ Chạy
(async () => {
  console.log("🚀 Test MEXC Futures Balance — GET /private/account/assets");
  const bal = await getFuturesBalance();
  if (bal) {
    console.log("✅ Balance:", bal);
  } else {
    console.log("❌ Thất bại.");
  }
})();