// src/telegram.js
import TelegramBot from 'node-telegram-bot-api';
import { CONFIG } from './config.js';

if (!CONFIG.TELEGRAM_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) {
  console.error('❌ Thiếu TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID trong .env');
  process.exit(1);
}

export const bot = new TelegramBot(CONFIG.TELEGRAM_TOKEN, { polling: false });

const sentMessages = [];

export async function sendMessageWithAutoDelete(message, options) {
  try {
    const sent = await bot.sendMessage(CONFIG.TELEGRAM_CHAT_ID, message, options);
    sentMessages.push({ id: sent.message_id, time: Date.now() });
  } catch (err) {
    console.error('Lỗi gửi Telegram:', err.message);
  }
}

export async function cleanupOldMessages() {
  const now = Date.now();
  const toDelete = sentMessages.filter(m => now - m.time > CONFIG.MESSAGE_LIFETIME);
  for (const msg of toDelete) {
    try {
      await bot.deleteMessage(CONFIG.TELEGRAM_CHAT_ID, msg.id);
    } catch { /* ignore */ }
  }
  const remain = sentMessages.filter(m => now - m.time <= CONFIG.MESSAGE_LIFETIME);
  sentMessages.splice(0, sentMessages.length, ...remain);
}
