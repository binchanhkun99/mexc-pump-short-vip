// ======================================================================
//  FINAL TEST — OPEN SHORT POSITION USING 0.5 USDT (20x) FOR PIPPIN_USDT
//  ✔ FULL PROXY SUPPORT
//  ✔ FALLBACK PRICE SYSTEM (like t2.js)
//  ✔ Correct contract multiplier handling
//  ✔ Correct qty rounding
//  ✔ Works for PIPPIN_USDT
// ======================================================================

import * as dotenv from "dotenv";
dotenv.config();

import axios from "axios";
import crypto from "crypto";
import { HttpsProxyAgent } from "https-proxy-agent";
import { MexcFuturesClient } from "mexc-futures-sdk";

// =========================
// CONFIG
// =========================
const API_KEY = process.env.MEXC_API_KEY;
const API_SECRET = process.env.MEXC_SECRET_KEY;
const AUTH_TOKEN = process.env.MEXC_AUTH_TOKEN;

// Futures API
const BASE_URL = "https://futures.mexc.co/api/v1";
const LEVERAGE = 20;

// TEST INPUT
const SYMBOL = "PIPPIN_USDT";
const TARGET_MARGIN = 0.5; // $0.5 before leverage

// =========================
// PROXY CONFIG
// =========================
const proxyURL =
  "http://user1762258669:pass1762258669@14.224.225.105:40220";

const httpsAgent = new HttpsProxyAgent(proxyURL);

// =========================
// AXIOS INSTANCE
// =========================
const api = axios.create({
  httpsAgent,
  proxy: false,
  timeout: 15000,
});

if (AUTH_TOKEN) {
  api.defaults.headers.common["Authorization"] = `Bearer ${AUTH_TOKEN}`;
}

if (API_KEY) {
  api.defaults.headers.common["ApiKey"] = API_KEY;
}

// =========================
// SDK CLIENT (NO OVERRIDE)
// =========================
const client = new MexcFuturesClient({
  authToken: AUTH_TOKEN,
  baseURL: BASE_URL,
});

// =========================
// SIGN PARAMS
// =========================
function sign(params) {
  const ts = Date.now();
  const q = { ...params, timestamp: ts };
  const qs = new URLSearchParams(q).toString();
  const sig = crypto.createHmac("sha256", API_SECRET).update(qs).digest("hex");
  return `${qs}&signature=${sig}`;
}

// =========================
// GET CONTRACT INFO
// =========================
async function getContractInfo(symbol) {
  try {
    const res = await api.get(
      "https://contract.mexc.com/api/v1/contract/detail",
      { params: { symbol } }
    );
    return res.data.data;
  } catch (err) {
    console.log("❌ Contract info error:", err.message);
    return null;
  }
}

// =========================
// FALLBACK PRICE (t2 style)
// =========================
async function getPrice(symbol) {
  // 1) SDK getTicker
  try {
    const t = await client.getTicker(symbol);
    if (t?.lastPrice) return parseFloat(t.lastPrice);
  } catch {}

  // 2) formatted symbol
  try {
    const sym = symbol.replace("USDT", "_USDT");
    const t = await client.getTicker(sym);
    if (t?.lastPrice) return parseFloat(t.lastPrice);
  } catch {}

  // 3) contract ticker list
  try {
    const res = await api.get(
      "https://contract.mexc.com/api/v1/contract/ticker"
    );
    const list = res.data.data;
    const s1 = symbol;
    const s2 = symbol.replace("USDT", "_USDT");
    const s3 = symbol.replace("_USDT", "USDT");

    const tk =
      list.find((x) => x.symbol === s1) ||
      list.find((x) => x.symbol === s2) ||
      list.find((x) => x.symbol === s3);

    if (tk) return parseFloat(tk.lastPrice);
  } catch (e) {
    console.log("❌ Price fallback error:", e.message);
  }

  return 0;
}

// =========================
// ROUND VOL
// =========================
function roundVolume(rawContracts, volScale, volUnit) {
  if (volScale === 0) {
    return Math.floor(rawContracts / volUnit) * volUnit;
  }
  const f = Math.pow(10, volScale);
  const r = Math.floor(rawContracts * f) / f;
  return Math.floor(r / volUnit) * volUnit;
}

// =========================
// MAIN TEST
// =========================
async function main() {
  console.log(`🚀 Testing open SHORT for ${SYMBOL}`);
  console.log(`💵 Margin: ${TARGET_MARGIN} USDT | Leverage: ${LEVERAGE}x`);

  // 1) Contract info
  const info = await getContractInfo(SYMBOL);
  if (!info) return;
  console.log("📘 Contract Info:", {
    contractSize: info.contractSize,
    volScale: info.volScale,
    minVol: info.minVol,
  });

  // 2) Price
  const price = await getPrice(SYMBOL);
  console.log("📈 Price:", price);
  if (price <= 0) {
    console.log("❌ Invalid price. Cannot continue.");
    return;
  }

  // 3) Compute contracts
  const notional = TARGET_MARGIN * LEVERAGE;
  const rawContracts = notional / (price * info.contractSize);

  console.log("🧮 Raw contracts:", rawContracts);

  // 4) Round contracts to valid vol
  let vol = roundVolume(rawContracts, info.volScale, info.volUnit);
  if (vol < info.minVol) vol = info.minVol;

  console.log("🎯 Final vol:", vol);

  // 5) Prepare order
  const orderParams = {
    symbol: SYMBOL,
    price: price, // will be ignored for market orders
    vol: vol,
    side: 3, // SHORT
    type: 5, // MARKET
    openType: 2,
    leverage: LEVERAGE,
    positionId: 0,
  };

  console.log("📦 Order params:", orderParams);

  // 6) Submit order
  try {
    const res = await client.submitOrder(orderParams);
    console.log("✅ ORDER RESULT:\n", res);
  } catch (err) {
    console.log("❌ ORDER ERROR:", err.response?.data || err.message);
  }
}

main();
