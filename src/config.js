// src/config.js
import dotenv from 'dotenv';
dotenv.config();

export const CONFIG = {
  // ---- TELEGRAM / SYSTEM ----
  TELEGRAM_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  POLL_INTERVAL: parseInt(process.env.POLL_INTERVAL) || 5000,
  AXIOS_TIMEOUT: 8000,
  KLINE_LIMIT: 20,
  MAX_CONCURRENT_REQUESTS: 8,
  MAX_REQUESTS_PER_SECOND: 8,
  MESSAGE_LIFETIME: 2 * 60 * 60 * 1000,
  MIN_VOLUME_USDT: parseFloat(process.env.MIN_VOLUME_USDT) || 150000,

  // ---- PUMP / REVERSAL ----
  TRACKING_PUMP_THRESHOLD_BASE: 15,      // Pump 15% trong 10 phút
  TRACKING_PUMP_MEXC_ONLY_DELTA: -3,     // Coin chỉ MEXC cho phép track từ 12%
  STRONG_PUMP_THRESHOLD: 40,             // Pump >= 40% xem là cực mạnh
  CRAZY_CANDLE_PCT: 18,                  // Nến 1m >= 18% là "đẩy láo"
  REVERSAL_CONFIRMATION_PCT: -5,         // Giảm 5% từ đỉnh -> xem là đảo chiều
  STRONG_REVERSAL_PCT: -8,               // Giảm 8% -> đảo chiều mạnh
  VOLUME_SPIKE_RATIO: 2.5,               // Volume hiện tại >= 2.5x trung bình -> xả

  // ---- GIẢ LẬP TÀI KHOẢN & QUẢN LÝ LỆNH ----
  LEVERAGE: 20,
  ACCOUNT_BALANCE_START: 150,
  ACCOUNT_BASE_CAPITAL: 250,             // Dùng để tính ngưỡng 25%

DCA_PLAN: [
    { roiTrigger: -100, addPercent: 0.005 }, // 1×
    { roiTrigger: -200, addPercent: 0.01  }, // 2×
    { roiTrigger: -400, addPercent: 0.02  }, // 4×
    { roiTrigger: -800, addPercent: 0.04  }, // 8×
    { roiTrigger: -1600, addPercent: 0.08 }, // 16×
  ],
  ENTRY_PERCENT: 0.005, 
  MAX_LOSS_RATIO_FOR_HODL: 0.6,          // Lệnh âm >= 60% balance => dừng DCA, gồng lỗ
  EQUITY_CUT_RATIO: 0.25,                // Equity < 25% * 250$ => bắt đầu cắt lỗ
  MAX_PARTIAL_CUTS: 3,                   // Tối đa 3 lần
  PARTIAL_CUT_PERCENT: 0.1,              // Mỗi lần cắt 10% lệnh
  MAX_OPEN_POSITIONS: 3,                 // Tối đa 3 lệnh đang mở

  // ---- TAKE PROFIT THEO TREND ----
  MIN_PROFIT_ROI_FOR_TRAIL: 80,          // ROI >= 80% bắt đầu trailing
  TRAIL_DROP_FROM_MAX_ROI: 40,     
  DCA_MULTIPLIER: 2,
  FUNDING_RATE_LIMIT_POSITIVE: 0.015,   // +1.5%
  FUNDING_RATE_LIMIT_NEGATIVE: -0.015,  // -1.5%
  MIN_LISTING_DAYS: 21, // 21 day
  MAX_VOLUME_USDT: 15000000, // 15 triệu USD
  MAX_SPREAD_PCT: 2.0
};
