// bot.js - ĐÃ TÍCH HỢP API THẬT & FILTERS
import { CONFIG } from './src/config.js';
import { fetchBinanceSymbols } from './src/exchange.js';
import { checkAndAlert, getTrackingStatus } from './src/strategy.js';
import { 
  initializeAccount, 
  syncAllPositionsFromAPI, 
  logPositionsStatus,
  accountState,
    positions 

} from './src/account.js';
import { getCacheStats, clearCache } from './src/exchange.js';
import { cleanupOldLogs } from './src/logger.js';

// Biến theo dõi trạng thái bot
let isRunning = false;
let checkInterval = null;

// Hiển thị thông tin khởi động
function displayStartupInfo() {
  console.log('\n' + '='.repeat(60));
  console.log('🚀 KHỞI ĐỘNG BOT MEXC PUMP HUNTER - API THẬT');
  console.log('='.repeat(60));
  console.log(`📊 Cấu hình:`);
  console.log(`   • Balance khởi đầu: $${accountState.walletBalance}`);
  console.log(`   • Số lệnh tối đa: ${CONFIG.MAX_OPEN_POSITIONS}`);
  console.log(`   • Leverage: ${CONFIG.LEVERAGE}x`);
  console.log(`   • DCA: ${CONFIG.DCA_PLAN.length} levels`);
  console.log(`   • Poll interval: ${CONFIG.POLL_INTERVAL / 1000}s`);
  console.log('');
  console.log(`🛡️ Filters:`);
  console.log(`   • Volume tối đa: ${CONFIG.MAX_VOLUME_USDT / 1000000}M USD`);
  console.log(`   • Listing days tối thiểu: ${CONFIG.MIN_LISTING_DAYS} ngày`);
  console.log(`   • Spread tối đa: ${CONFIG.MAX_SPREAD_PCT}%`);
  console.log(`   • Funding rate: ${CONFIG.FUNDING_RATE_LIMIT_NEGATIVE * 100}% đến +${CONFIG.FUNDING_RATE_LIMIT_POSITIVE * 100}%`);
  console.log('');
}

// Hiển thị trạng thái bot định kỳ
function displayBotStatus() {
  const now = new Date().toLocaleTimeString();
  console.log(`\n🕒 [${now}] BOT STATUS:`);
  console.log(`   💰 Balance: $${accountState.walletBalance.toFixed(2)} | Equity: $${accountState.equity.toFixed(2)}`);
  console.log(`   📊 Positions: ${positions.size} lệnh mở`); // ← SỬA DÒNG NÀY
  console.log(`   🔍 Tracking: ${getTrackingStatus().length} coins`);
  
  const cacheStats = getCacheStats();
  console.log(`   🗂️  Cache: ${cacheStats.listingDaysCache} symbols | ${cacheStats.contractInfoCache} contracts`);
}


// Xử lý lỗi toàn cục
function setupGlobalErrorHandling() {
  process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ UNHANDLED REJECTION at:', promise, 'reason:', reason);
  });

  process.on('uncaughtException', (error) => {
    console.error('❌ UNCAUGHT EXCEPTION:', error);
    // Không exit để bot tiếp tục chạy
  });
}

// Xử lý tín hiệu dừng bot
function setupGracefulShutdown() {
  process.on('SIGINT', async () => {
    console.log('\n\n🛑 Nhận tín hiệu dừng bot...');
    await gracefulShutdown();
  });

  process.on('SIGTERM', async () => {
    console.log('\n\n🛑 Nhận tín hiệu terminate...');
    await gracefulShutdown();
  });
}

// Dừng bot một cách graceful
async function gracefulShutdown() {
  if (!isRunning) {
    console.log('Bot đã dừng.');
    process.exit(0);
  }

  console.log('Đang dừng bot...');
  isRunning = false;

  if (checkInterval) {
    clearInterval(checkInterval);
    console.log('✅ Đã dừng polling interval');
  }

  // Hiển thị trạng thái cuối cùng
  console.log('\n📋 TRẠNG THÁI CUỐI CÙNG:');
  logPositionsStatus();
  
  const trackingStatus = getTrackingStatus();
  console.log(`🔍 Đang tracking ${trackingStatus.length} coins:`);
  trackingStatus.forEach(track => {
    console.log(`   • ${track.symbol}: pump ${track.pumpPct.toFixed(1)}%, added ${track.addAt}`);
  });

  console.log('\n👋 Bot đã dừng hoàn toàn.');
  process.exit(0);
}

// Khởi tạo và chạy bot
async function initializeBot() {
  try {
    cleanupOldLogs(7); // Xóa logs > 7 ngày

    console.log('🔄 Đang khởi tạo bot...');
    
    // 1. Khởi tạo account và sync positions
    await initializeAccount();
    await syncAllPositionsFromAPI();
    
    // 2. Load Binance symbols để filter MEXC-only
    console.log('📥 Đang load Binance symbols...');
    await fetchBinanceSymbols();
    
    // 3. Hiển thị thông tin khởi động
    displayStartupInfo();
    
    // 4. Chạy cycle đầu tiên ngay lập tức
    console.log('🔍 Chạy scan đầu tiên...');
    await checkAndAlert();
    
    // 5. Thiết lập interval cho các lần sau
    isRunning = true;
    checkInterval = setInterval(async () => {
      if (isRunning) {
        try {
          await checkAndAlert();
          // Hiển thị status mỗi 5 phút
          if (Date.now() % (5 * 60 * 1000) < CONFIG.POLL_INTERVAL) {
            displayBotStatus();
          }
        } catch (error) {
          console.error('❌ Lỗi trong main loop:', error);
        }
      }
    }, CONFIG.POLL_INTERVAL);

    console.log(`\n✅ Bot đã khởi động thành công!`);
    console.log(`🔁 Đang polling mỗi ${CONFIG.POLL_INTERVAL / 1000} giây`);
    
    // Hiển thị trạng thái ban đầu
    displayBotStatus();
    
  } catch (error) {
    console.error('❌ Lỗi khởi động bot:', error);
    process.exit(1);
  }
}

// Hàm restart bot (cho future use)
async function restartBot() {
  console.log('\n🔄 Khởi động lại bot...');
  
  if (checkInterval) {
    clearInterval(checkInterval);
  }
  
  await clearCache();
  await initializeBot();
}

// Main execution
(async () => {
  try {
    // Thiết lập error handling
    setupGlobalErrorHandling();
    setupGracefulShutdown();
    
    // Khởi động bot
    await initializeBot();
    
    // Export functions cho testing/debug (optional)
    global.restartBot = restartBot;
    global.getBotStatus = () => ({
      isRunning,
      accountState,
      tracking: getTrackingStatus(),
      cache: getCacheStats()
    });
    
  } catch (error) {
    console.error('❌ Lỗi khởi động ứng dụng:', error);
    process.exit(1);
  }
})();

// Export cho testing
export { initializeBot, restartBot, gracefulShutdown };