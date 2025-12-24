// t.js — ✅ SỬA CHỮ KÝ ĐÚNG CHUẨN FUTURES
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

// ✅ Hàm ký CHUẨN FUTURES (theo MEXC docs)
function signFutures(params, secret) {
  // 1. Sắp xếp key theo thứ tự ASCII
  const sortedKeys = Object.keys(params).sort();
  // 2. Nối thành chuỗi: key1=value1&key2=value2...
  const queryString = sortedKeys
    .map(k => `${k}=${params[k]}`)
    .join("&");
  // 3. HMAC-SHA256 với secret
  return crypto.createHmac("sha256", secret).update(queryString).digest("hex");
}

// ✅ Lấy balance — dùng POST + header ký
async function getFuturesBalance() {
  const timestamp = Date.now();

  const payload = {
    currency: "USDT",
    timestamp,
  };

  const signature = signFutures(payload, API_SECRET);

  try {
    const res = await axiosInstance.post(
      "https://contract.mexc.com/api/v1/private/account/assets",
      payload, // body JSON
      {
        headers: {
          "ApiKey": API_KEY,
          "Request-Time": timestamp,
          "Signature": signature,
          "Content-Type": "application/json",
        },
      }
    );

    if (res.data.code !== 0) {
      throw new Error(`MEXC error: ${res.data.message || res.data.msg}`);
    }

    const usdt = res.data.data.find(a => a.currency === "USDT");
    if (!usdt) throw new Error("USDT not found in response");

    return {
      available: parseFloat(usdt.available || 0),
      frozen: parseFloat(usdt.frozen || 0),
      equity: parseFloat(usdt.equity || 0),
    };
  } catch (err) {
    console.error("❌ Lỗi balance:", err.message);
    if (err.response) {
      console.log("📡 Raw response:", JSON.stringify(err.response.data, null, 2));
    }
    return null;
  }
}

// ▶️ Chạy
(async () => {
  console.log("🚀 Test balance — Futures API (POST + header signature)...");
  const bal = await getFuturesBalance();
  if (bal) {
    console.log("✅ Thành công:", bal);
  } else {
    console.log("❌ Thất bại.");
  }
})();