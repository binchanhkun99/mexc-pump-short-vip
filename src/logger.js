// src/logger.js
import fs from 'fs';
import path from 'path';

const LOG_DIR = './logs';
const TRADING_LOG_FILE = path.join(LOG_DIR, 'trading.log');
const ERROR_LOG_FILE = path.join(LOG_DIR, 'errors.log');

// Đảm bảo thư mục logs tồn tại
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function getTimestamp() {
  return new Date().toISOString();
}

function formatMessage(level, message, data = null) {
  const timestamp = getTimestamp();
  let logEntry = `[${timestamp}] ${level}: ${message}`;
  
  if (data) {
    if (typeof data === 'object') {
      logEntry += ` | ${JSON.stringify(data)}`;
    } else {
      logEntry += ` | ${data}`;
    }
  }
  
  return logEntry + '\n';
}

export function logTrade(message, data = null) {
  const logEntry = formatMessage('TRADE', message, data);
  
  // Ghi vào file
  fs.appendFileSync(TRADING_LOG_FILE, logEntry);
  
  // Vẫn log ra console
  console.log(logEntry.trim());
}

export function logError(message, error = null) {
  const logEntry = formatMessage('ERROR', message, error);
  
  // Ghi vào file error
  fs.appendFileSync(ERROR_LOG_FILE, logEntry);
  
  // Vẫn log ra console
  console.error(logEntry.trim());
}

export function logDebug(message, data = null) {
  const logEntry = formatMessage('DEBUG', message, data);
  
  // Chỉ ghi vào file, không log console để tránh spam
  fs.appendFileSync(TRADING_LOG_FILE, logEntry);
}

// Log rotation (optional)
export function cleanupOldLogs(maxAgeDays = 7) {
  const now = Date.now();
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  
  try {
    const files = fs.readdirSync(LOG_DIR);
    
    files.forEach(file => {
      const filePath = path.join(LOG_DIR, file);
      const stats = fs.statSync(filePath);
      
      if (now - stats.mtimeMs > maxAgeMs) {
        fs.unlinkSync(filePath);
        console.log(`🧹 Deleted old log file: ${file}`);
      }
    });
  } catch (error) {
    console.error('Error cleaning up logs:', error);
  }
}