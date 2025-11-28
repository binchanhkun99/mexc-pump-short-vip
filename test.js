import axios from "axios";
import { HttpsProxyAgent } from 'https-proxy-agent';

// ===== CONFIG PROXY =====
const proxyHost = "14.224.225.105";
const proxyPort = 40220;
const proxyUser = "user1762258669";
const proxyPass = "pass1762258669";

// Tạo HTTPS proxy agent
const proxyUrl = `http://${proxyUser}:${proxyPass}@${proxyHost}:${proxyPort}`;
const httpsAgent = new HttpsProxyAgent(proxyUrl);

// ===== TEST FUNCTION =====
async function testFetchBTC() {
  try {
    console.log("⏳ Fetching BTC_USDT ticker...");

    const url = "https://contract.mexc.com/api/v1/contract/fundingRate?symbol=AKE_USDT";

    const res = await axios.get(url, {
      httpsAgent,     // quan trọng!
      timeout: 15000, // MEXC đôi khi hơi chậm
    });

    const t = res.data.data;

    // Fix: dùng bid1/ask1
    // const bid = Number(t.bid1);
    // const ask = Number(t.ask1);
    // const last = Number(t.lastPrice);
    // console.log("=== BTC_USDT ===");
    // const spread = ((ask - bid) / bid) * 100;

    // console.log("Bid :", bid);
    // console.log("Ask :", ask);
    console.log("Last:", t);
    // console.log("Spread:", spread.toFixed(4), "%");

  } catch (err) {
    console.error("❌ Lỗi fetch:", err.message);
  }
}

testFetchBTC();
