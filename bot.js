// bot.js
import { CONFIG } from './src/config.js';
import { fetchBinanceSymbols } from './src/exchange.js';
import { checkAndAlert } from './src/strategy.js';

(async () => {
  console.log('🚀 Khởi động bot MEXC PUMP HUNTER + FAKE TRADING...');

  await fetchBinanceSymbols(); // dùng để phân biệt coin chỉ MEXC
  await checkAndAlert();

  setInterval(checkAndAlert, CONFIG.POLL_INTERVAL);
  console.log(`🔁 Polling mỗi ${CONFIG.POLL_INTERVAL / 1000} giây`);
})();
