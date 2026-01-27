import fetch from "node-fetch";

const SYMBOL = "BTCUSDT";
const BASE_URL = "https://fapi.binance.com";

// leverage model
const LEVERAGE_MODEL = [
  { lev: 10, weight: 0.4 },
  { lev: 20, weight: 0.35 },
  { lev: 50, weight: 0.25 }
];

async function getPrice() {
  const res = await fetch(`${BASE_URL}/fapi/v1/ticker/price?symbol=${SYMBOL}`);
  const data = await res.json();
  return Number(data.price);
}

async function getOpenInterest() {
  const res = await fetch(`${BASE_URL}/fapi/v1/openInterest?symbol=${SYMBOL}`);
  const data = await res.json();
  return Number(data.openInterest);
}

async function getLongShortRatio() {
  const res = await fetch(
    `${BASE_URL}/futures/data/globalLongShortAccountRatio?symbol=${SYMBOL}&period=5m&limit=1`
  );
  const data = await res.json();
  return {
    long: Number(data[0].longAccount),
    short: Number(data[0].shortAccount)
  };
}

function buildHeatmap(price, oiUsd, ratio) {
  const heatmap = [];

  for (const m of LEVERAGE_MODEL) {
    const longUsd = oiUsd * ratio.long * m.weight;
    const shortUsd = oiUsd * ratio.short * m.weight;

    heatmap.push({
      price: Math.round(price * (1 - 1 / m.lev)),
      long_usd: Math.round(longUsd),
      short_usd: 0
    });

    heatmap.push({
      price: Math.round(price * (1 + 1 / m.lev)),
      long_usd: 0,
      short_usd: Math.round(shortUsd)
    });
  }

  return heatmap.sort((a, b) => a.price - b.price);
}

(async () => {
  const price = await getPrice();
  const oi = await getOpenInterest();
  const ratio = await getLongShortRatio();

  // convert OI to USD
  const oiUsd = oi * price;

  const liquidation_heatmap = buildHeatmap(price, oiUsd, ratio);

  console.log("=== ENTRY SIGNAL INPUT ===");
  console.log(JSON.stringify({ liquidation_heatmap }, null, 2));
})();
