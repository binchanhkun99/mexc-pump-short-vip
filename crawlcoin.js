import axios from "axios";
import fs from "fs";

function formatTimeUTC7(timestampSec) {
  const date = new Date(timestampSec * 1000);
  // Cộng thêm 7 tiếng để chuyển sang UTC+7
  date.setHours(date.getHours());

  const Y = date.getFullYear();
  const M = String(date.getMonth() + 1).padStart(2, "0");
  const D = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");

  return `${Y}.${M}.${D} ${h}.${m}.${s}`;
}

async function fetchKlines(symbol, startSec, endSec) {
  const url = `https://contract.mexc.com/api/v1/contract/kline/${symbol}`;
  const res = await axios.get(url, {
    params: { interval: "Min1", start: startSec, end: endSec },
  });

  if (!res.data?.success || !res.data.data) return [];

  const { time, open, high, low, close, vol } = res.data.data;

  return time.map((t, i) => ({
    time: formatTimeUTC7(t),
    open: +open[i],
    high: +high[i],
    low: +low[i],
    close: +close[i],
    volume: +vol[i],
  }));
}

async function main() {
  // Thời gian theo UTC+7 (chuyển về UTC để gọi API)
  const startUTC = new Date("2025-11-05T06:13:47+07:00").getTime() / 1000;
  const endUTC = new Date("2025-11-06T12:23:00+07:00").getTime() / 1000;

  const data = await fetchKlines("CORL_USDT", startUTC, endUTC);

  fs.writeFileSync("data_corl_m1.txt", JSON.stringify(data, null, 2), "utf8");
  console.log("✅ Đã lưu dữ liệu vào file response.txt (time theo UTC+7)");
}

main().catch(console.error);
