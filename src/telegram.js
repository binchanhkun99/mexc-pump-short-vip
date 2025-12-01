// src/telegram.js - THÊM MARKDOWN ESCAPE
import TelegramBot from 'node-telegram-bot-api';
import { CONFIG } from './config.js';

if (!CONFIG.TELEGRAM_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) {
  console.error('❌ Thiếu TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID trong .env');
  process.exit(1);
}

export const bot = new TelegramBot(CONFIG.TELEGRAM_TOKEN, { polling: false });

// Hàm escape Markdown characters
function escapeMarkdown(text) {
  if (typeof text !== 'string') return text;

  // Danh sách ký tự cần escape trong MarkdownV2
  return text.replace(/([_*\[\]()~`>#+=|{}])/g, '\\$1');
}


// Hàm escape Markdown nhưng giữ URL
function escapeMarkdownKeepUrls(text) {
  if (typeof text !== 'string') return text;
  
  // Tách URL ra trước để không escape
  const urlRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  const parts = [];
  let lastIndex = 0;
  let match;
  
  while ((match = urlRegex.exec(text)) !== null) {
    // Text trước URL
    if (match.index > lastIndex) {
      parts.push({
        type: 'text',
        content: escapeMarkdown(text.substring(lastIndex, match.index))
      });
    }
    
    // URL (giữ nguyên)
    parts.push({
      type: 'url',
      content: match[0] // Giữ nguyên format [text](url)
    });
    
    lastIndex = match.index + match[0].length;
  }
  
  // Phần còn lại
  if (lastIndex < text.length) {
    parts.push({
      type: 'text',
      content: escapeMarkdown(text.substring(lastIndex))
    });
  }
  
  return parts.map(part => part.content).join('');
}

/**
 * Gửi tin nhắn với auto escape Markdown
 */
export async function sendMessageWithAutoDelete(message, options = {}) {
  try {
    // Clone options để không modify original
    const safeOptions = { ...options };
    
    // Nếu dùng Markdown, escape message
    if (safeOptions.parse_mode === 'Markdown' || safeOptions.parse_mode === 'MarkdownV2') {
      const escapedMessage = escapeMarkdownKeepUrls(message);
      
      await bot.sendMessage(CONFIG.TELEGRAM_CHAT_ID, escapedMessage, safeOptions);
    } else {
      // Không dùng Markdown, gửi bình thường
      await bot.sendMessage(CONFIG.TELEGRAM_CHAT_ID, message, safeOptions);
    }
    
  } catch (err) {
    console.error('Lỗi gửi Telegram:', err.message);
    
    // Thử gửi lại không dùng Markdown nếu lỗi
    if (options.parse_mode) {
      try {
        console.log('🔄 Thử gửi lại không dùng Markdown...');
        const fallbackOptions = { ...options };
        delete fallbackOptions.parse_mode;
        
        await bot.sendMessage(CONFIG.TELEGRAM_CHAT_ID, message, fallbackOptions);
      } catch (fallbackErr) {
        console.error('Lỗi gửi Telegram fallback:', fallbackErr.message);
      }
    }
  }
}

/**
 * Cleanup old messages - giữ nguyên
 */
export async function cleanupOldMessages() {
  // Do nothing → không xoá tin nhắn nào
  return;
}