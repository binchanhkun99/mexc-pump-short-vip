import axios from 'axios';
import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
dotenv.config(); // 👈 dòng này nạp biến từ .env


const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const sentMessages = [];
const symbol = 'YALA_USDT'
const bot = new TelegramBot(token, { polling: false });

async function sendMessageWithAutoDelete(message, options) {
  try {
    const sent = await bot.sendMessage(chatId, message, options);
    sentMessages.push({ id: sent.message_id, time: Date.now() });
  } catch (err) {
    console.error('Lỗi gửi tin nhắn:', err.message);
  }
}

    const link = `https://mexc.com/futures/${symbol}?type=swap`;
    const message =
      `🚨 [${symbol}](${link})\n` +
      `📈 Pumped 5.8% in 10 phút\n` +
      `📉 False breakout: đỉnh 0.1059 bị phá vỡ rơi về 0.104\n` +
      `🧱 Volume: 442K (x2 trung bình)\n` +
      `👉 Ưu tiên SHORT (coin chỉ có trên MEXC)`;

    await sendMessageWithAutoDelete(message, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });
