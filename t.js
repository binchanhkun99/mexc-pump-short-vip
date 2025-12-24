// t.js — Test đơn giản lấy balance futures MEXC từ VN qua proxy
import * as dotenv from "dotenv";
import axios from "axios";
import crypto from "crypto";
import { HttpsProxyAgent } from "https-proxy-agent";

dotenv.config();

// 🔐 Lấy từ .env
const API_KEY = process.env.MEXC_API_KEY?.trim();
const API_SECRET = process.env.MEXC_SECRET_KEY?.trim();

if (!API_KEY || !API_SECRET) {
  console.error("❌ Thiếu MEXC_API_KEY hoặc MEXC_SECRET_KEY trong .env");
  process.exit(1);
}

// 🌐 PROXY — theo thông tin bạn cung cấp
const proxyHost = "14.224.225.129";
const proxyPort = 37771;
const proxyUser = "user1764683329";
const proxyPass = "pass1764683329";
const proxyUrl = `http://${proxyUser}:${proxyPass}@${proxyHost}:${proxyPort}`;
const httpsAgent = new HttpsProxyAgent(proxyUrl);

const axiosInstance = axios.create({
  // httpsAgent,
  proxy: false,
  timeout: 15000,
});

// 🔑 Ký tham số (chuẩn MEXC)
function signParams(params, secret) {
  const query = new URLSearchParams(params).toString();
  return crypto.createHmac("sha256", secret).update(query).digest("hex");
}

// 💰 Lấy balance futures (USDT)
async function getFuturesBalance() {
  const timestamp = Date.now();
  const params = { currency: "USDT", timestamp };
  const signature = signParams(params, API_SECRET);
  const queryString = new URLSearchParams({ ...params, signature }).toString();
console.log(queryString)
  const url = `https://contract.mexc.com/api/v1/private/account/assets?${queryString}`;

  try {
    const res = await axiosInstance.get(url, {
      headers: { "ApiKey": API_KEY, "Content-Type": "application/json" },
    });

    if (res.data.code !== 0) {
      throw new Error(`API error: ${res.data.message || res.data.msg}`);
    }

    const usdt = res.data.data.find(a => a.currency === "USDT");
    if (!usdt) return { error: "USDT not found" };

    return {
      available: parseFloat(usdt.available || 0),
      frozen: parseFloat(usdt.frozen || 0),
      equity: parseFloat(usdt.equity || 0),
      total: parseFloat(usdt.available || 0) + parseFloat(usdt.frozen || 0),
    };
  } catch (err) {
    console.error("❌ Lỗi khi lấy balance:", err.message);
    return null;
  }
}

// ▶️ Chạy test
(async () => {
  console.log("🚀 Bắt đầu test lấy balance MEXC qua proxy...");
  console.log(`🌐 Proxy: ${proxyHost}:${proxyPort}`);
  console.log(`🔑 API Key: ${API_KEY.substring(0, 6)}...`);

  const balance = await getFuturesBalance();

  if (balance) {
    console.log("\n✅ Thành công! Số dư futures (USDT):");
    console.table([
      { Field: "Available", Value: balance.available.toFixed(4) },
      { Field: "Frozen (Margin)", Value: balance.frozen.toFixed(4) },
      { Field: "Equity", Value: balance.equity.toFixed(4) },
      { Field: "Total", Value: balance.total.toFixed(4) },
    ]);
  } else {
    console.log("\n❌ Không lấy được balance.");
  }
})();