// ===============================
// test_kline_listing.js
// Test futures kline + tính ngày listing
// ===============================

import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";

// ===== CONFIG PROXY =====
const proxyHost = "14.224.225.105";
const proxyPort = 40220;
const proxyUser = "user1762258669";
const proxyPass = "pass1762258669";

const proxyUrl = `http://${proxyUser}:${proxyPass}@${proxyHost}:${proxyPort}`;
const httpsAgent = new HttpsProxyAgent(proxyUrl);

// ===== AXIOS INSTANCE y như BOT =====
export const axiosInstance = axios.create({
  httpsAgent,
  proxy: false,
  timeout: 15000,
});

// ===== CONFIG =====
const FUTURES_SYMBOL = "BTC_USDT";      // đổi coin tại đây
const SPOT_SYMBOL    = FUTURES_SYMBOL.replace("_USDT", "USDT");

// ===============================
// Retry wrapper
// ===============================
async function fetchRetry(url, params = {}, retry = 5) {
  for (let i = 1; i <= retry; i++) {
    try {
      return await axiosInstance.get(url, {
        params,
        timeout: 15000,
      });
    } catch (err) {
      console.log(`⚠️ Retry ${i}/${retry} -> ${err.message}`);
      await new Promise(r => setTimeout(r, i * 800));
    }
  }
  throw new Error("❌ API failed after retries");
}

// ===============================
// LẤY LISTING AGE TỪ FUTURES → FALLBACK SPOT
// ===============================
async function getListingAgeDays(symbol) {
  const now = Date.now();

  // 1) FUTURES KLINE (Day1)
  try {
    console.log("⏳ Fetching FUTURES Day1 kline...");

    const res = await fetchRetry(
      `https://contract.mexc.com/api/v1/contract/kline/${symbol}`,
      {
        interval: "Day1",
        start: Math.floor((now - 86400000 * 200) / 1000), // 200 ngày
        end: Math.floor(now / 1000),
      }
    );

    if (res.data?.success && res.data.data?.time?.length > 0) {
      const firstTime = res.data.data.time[0] * 1000;
      const ageDays = (now - firstTime) / (1000 * 60 * 60 * 24);
      return { age: ageDays, source: "futures" };
    } else {
      console.log("⚠️ Futures kline không có dữ liệu");
    }
  } catch (err) {
    console.log("⚠️ Futures Day1 error:", err.message);
  }

  // 2) SPOT KLINE fallback
  try {
    console.log("⏳ Fetching SPOT klines fallback:", SPOT_SYMBOL);

    const resSpot = await fetchRetry(
      "https://api.mexc.com/api/v3/klines",
      {
        symbol: SPOT_SYMBOL,
        interval: "1d",
        limit: 500,
      }
    );

    if (resSpot.data?.length > 0) {
      const firstTime = resSpot.data[0][0];
      const ageDays =
        (now - firstTime) / (1000 * 60 * 60 * 24);
      return { age: ageDays, source: "spot" };
    }
  } catch (err) {
    console.log("⚠️ Spot kline fallback error:", err.message);
  }

  // 3) → Nếu tất cả fail → xem như coin mới list
  return { age: 0.2, source: "none" };
}

// ===============================
// TEST FUTURES Min1 KLINE
// ===============================
async function testFuturesKline(symbol) {
  const now = Math.floor(Date.now() / 1000);
  const start = now - 50 * 60; // 50 nến (50 phút)

  console.log(`\n=== 🧪 TESTING futures kline (${symbol}) ===\n`);

  const res = await fetchRetry(
    `https://contract.mexc.com/api/v1/contract/kline/${symbol}`,
    {
      interval: "Min1",
      start,
      end: now,
    }
  );

  if (!res.data?.success) {
    console.log("⛔ API trả về không success");
    return [];
  }

  const { time, open, high, low, close, vol } = res.data.data;

  const klines = time.map((t, idx) => ({
    time: t * 1000,
    open: Number(open[idx]),
    high: Number(high[idx]),
    low: Number(low[idx]),
    close: Number(close[idx]),
    volume: Number(vol[idx]),
  }));

  console.log(`📌 Số nến lấy được: ${klines.length}`);
  console.log("📌 Nến đầu tiên:", klines[0]);
  console.log("📌 Nến cuối cùng:", klines[klines.length - 1]);

  return klines;
}

// ===============================
// RUN TEST
// ===============================
(async () => {
  try {
    // 1) test futures klines (Min1)
    await testFuturesKline(FUTURES_SYMBOL);

    // 2) test listing age
    const { age, source } = await getListingAgeDays(FUTURES_SYMBOL);
    console.log("\n=== 📌 LISTING AGE RESULT ===");
    console.log("Nguồn:", source);
    console.log("Tuổi listing:", age.toFixed(1), "ngày");

    console.log("\n🎯 TEST HOÀN TẤT\n");
  } catch (err) {
    console.error("❌ Test bị lỗi:", err.message);
  }
})();
