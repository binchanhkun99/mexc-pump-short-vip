// src/telegram.js
import TelegramBot from 'node-telegram-bot-api';
import { CONFIG } from './config.js';

if (!CONFIG.TELEGRAM_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) {
  console.error('❌ Thiếu TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID trong .env');
  process.exit(1);
}

export const bot = new TelegramBot(CONFIG.TELEGRAM_TOKEN, { polling: false });

// Không lưu message_id nữa → không có gì để xoá
const sentMessages = [];

/**
 * Gửi tin nhắn nhưng KHÔNG auto delete
 * (Tên hàm giữ nguyên để không phải sửa strategy/account)
 */
export async function sendMessageWithAutoDelete(message, options) {
  try {
    await bot.sendMessage(CONFIG.TELEGRAM_CHAT_ID, message, options);
    // Không push vào sentMessages => sẽ không bị xóa
  } catch (err) {
    console.error('Lỗi gửi Telegram:', err.message);
  }
}

/**
 * cleanupOldMessages vẫn được gọi trong strategy
 * nhưng KHÔNG xoá gì cả, để tránh lỗi
 */
export async function cleanupOldMessages() {
  // Do nothing → không xoá tin nhắn nào
  return;
}
