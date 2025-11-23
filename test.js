// test.js
import axios from 'axios';
import crypto from 'crypto';

const BASE = "https://contract.mexc.com";
const API_KEY ='mx0vgl8ERg4VtcBHRC';
const API_SECRET = 'e2a1c832b10848a99e679c4131af5524';
console.log("=== 🔍 DEBUG MODE ===");
console.log("API Key:", API_KEY);
console.log("API Secret length:", API_SECRET ? API_SECRET.length : "MISSING");

/**
 * Tạo signature CHUẨN cho MEXC Futures
 * - Thứ tự key theo alphabet
 * - Thêm req_time
 * - Không encode
 */
function sign(params) {
  const sortedKeys = Object.keys(params).sort();
  const queryString = sortedKeys.map(k => `${k}=${params[k]}`).join("&");
  const signature = crypto
    .createHmac("sha256", API_SECRET)
    .update(queryString)
    .digest("hex");
  return signature;
}

/**
 * Lấy tài sản Futures (Get All Account Assets)
 */
async function getFuturesAssets() {
  const params = {
    api_key: API_KEY,
    req_time: Date.now(), // BẮT BUỘC
  };

  // ký
  const signature = sign(params);

  // thêm chữ ký vào params
  const fullParams = { ...params, sign: signature };

  // tạo query string
  const queryString = Object.entries(fullParams)
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const url = `${BASE}/api/v1/private/account/assets?${queryString}`;

  console.log("➡️ Full URL:", url);

  try {
    const res = await axios.get(url, { timeout: 10000 });
    console.log("✅ Response:", res.data);
  } catch (err) {
    console.error(
      "❌ Error:",
      err.response ? err.response.data : err.message
    );
  }
}

getFuturesAssets();