// t.js — ✅ LẤY BALANCE SPOT (thay thế futures nếu futures hỏng)
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

// ✅ Ký SPOT — chuẩn MEXC Spot (dùng trong query string)
function signSpot(params, secret) {
  const query = new URLSearchParams(params).toString();
  return crypto.createHmac("sha256", secret).update(query).digest("hex");
}

// ✅ Lấy balance SPOT
async function getSpotBalance() {
  const timestamp = Date.now();
  const params = { timestamp };

  const signature = signSpot(params, API_SECRET);
  const query = new URLSearchParams({ ...params, signature }).toString();

  const url = `https://api.mexc.com/api/v3/account?${query}`;

  try {
    const res = await axiosInstance.get(url, {
      headers: { "X-MEXC-APIKEY": API_KEY },
    });

    // Tìm USDT
    const usdt = res.data.balances.find(b => b.asset === "USDT");
    if (!usdt) return { error: "USDT not found" };

    return {
      free: parseFloat(usdt.free || 0),
      locked: parseFloat(usdt.locked || 0),
      total: parseFloat(usdt.free || 0) + parseFloat(usdt.locked || 0),
    };
  } catch (err) {
    console.error("❌ Spot balance error:", err.message);
    if (err.response?.data) {
      console.log("📡 Raw:", err.response.data);
    }
    return null;
  }
}

// ▶️ Chạy
(async () => {
  console.log("🚀 Lấy balance SPOT (đơn giản & ổn định hơn)...");
  const bal = await getSpotBalance();
  if (bal) {
    console.log("✅ USDT Spot Balance:", bal);
  } else {
    console.log("❌ Thất bại.");
  }
})();