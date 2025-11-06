// bot-mexc-prediction-pro.js
import dotenv from 'dotenv';
import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import https from 'https';
import fs from 'fs';

dotenv.config();

// === CẤU HÌNH ===
const token = process.env.TELEGRAM_BOT_TOKEN_BO;
const chatId = process.env.TELEGRAM_CHAT_ID_BO;
const pollInterval = 15000; // 15 giây quét 1 lần
const axiosTimeout = 8000;

// Cấu hình trading
const INITIAL_BALANCE = 100; // Vốn ban đầu
const MIN_ORDER_SIZE = 5; // Lệnh tối thiểu $5
const MAX_DAILY_ORDERS = 100;
const ALLOWED_COINS = ['BTC_USDT', 'SOL_USDT', 'ETH_USDT', 'DOGE_USDT'];

// Tỷ lệ thắng theo timeframe
const WIN_RATES = {
  '3m': 0.75,   // 75%
  '5m': 0.75,   // 75%
  '10m': 0.82,  // 82%
  '30m': 0.87,  // 87%
  '1h': 0.87,   // 87%
  '1d': 0.87    // 87%
};

// Tham số phân tích kỹ thuật
const RSI_OVERSOLD = 30;
const RSI_OVERBOUGHT = 70;
const VOLUME_SPIKE_RATIO = 1.8;
const SUPPORT_RESISTANCE_TOUCHES = 3; // Số lần chạm để xác nhận vùng
const TREND_STRENGTH_MIN = 0.65; // Độ mạnh trend tối thiểu

if (!token || !chatId) {
  console.error('❌ Thiếu TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: false });
const axiosInstance = axios.create({
  timeout: axiosTimeout,
  httpsAgent: new https.Agent({ keepAlive: true }),
});

// === QUẢN LÝ VỐN VÀ LỆNH ===
class TradingManager {
  constructor() {
    this.balance = INITIAL_BALANCE;
    this.initialBalance = INITIAL_BALANCE;
    this.openPositions = new Map(); // symbol -> position data
    this.tradeHistory = [];
    this.dailyOrderCount = 0;
    this.lastResetDate = new Date().toDateString();
    this.loadState();
  }

  loadState() {
    try {
      if (fs.existsSync('trading_state.json')) {
        const data = JSON.parse(fs.readFileSync('trading_state.json', 'utf8'));
        this.balance = data.balance || INITIAL_BALANCE;
        this.tradeHistory = data.tradeHistory || [];
        this.dailyOrderCount = data.dailyOrderCount || 0;
        this.lastResetDate = data.lastResetDate || new Date().toDateString();
        console.log(`📂 Đã load state: Balance=$${this.balance.toFixed(2)}, Orders=${this.tradeHistory.length}`);
      }
    } catch (err) {
      console.log('⚠️ Không load được state, bắt đầu mới');
    }
  }

  saveState() {
    try {
      fs.writeFileSync('trading_state.json', JSON.stringify({
        balance: this.balance,
        tradeHistory: this.tradeHistory,
        dailyOrderCount: this.dailyOrderCount,
        lastResetDate: this.lastResetDate
      }, null, 2));
    } catch (err) {
      console.error('❌ Lỗi save state:', err.message);
    }
  }

  checkDailyReset() {
    const today = new Date().toDateString();
    if (this.lastResetDate !== today) {
      this.dailyOrderCount = 0;
      this.lastResetDate = today;
      console.log('🔄 Reset daily order count');
    }
  }

  canOpenPosition(symbol) {
    this.checkDailyReset();
    
    if (this.dailyOrderCount >= MAX_DAILY_ORDERS) {
      console.log(`⛔ Đã đạt giới hạn ${MAX_DAILY_ORDERS} lệnh/ngày`);
      return false;
    }
    
    if (this.openPositions.has(symbol)) {
      return false;
    }
    
    if (this.balance < MIN_ORDER_SIZE) {
      console.log(`⛔ Không đủ vốn (Balance: $${this.balance.toFixed(2)})`);
      return false;
    }
    
    return true;
  }

  openPosition(symbol, direction, entryPrice, timeframe, confidence, analysis) {
    const orderSize = this.calculateOrderSize(confidence);
    
    const position = {
      symbol,
      direction, // 'UP' hoặc 'DOWN'
      entryPrice,
      orderSize,
      timeframe,
      confidence,
      openTime: Date.now(),
      exitTime: this.calculateExitTime(timeframe),
      analysis,
      status: 'OPEN'
    };
    
    this.openPositions.set(symbol, position);
    this.dailyOrderCount++;
    
    console.log(`📈 MỞ LỆNH: ${symbol} ${direction} @ $${entryPrice} | Size: $${orderSize} | TF: ${timeframe}`);
    return position;
  }

  calculateOrderSize(confidence) {
    // Động order size theo confidence (50-95%)
    // Confidence cao -> cược nhiều hơn
    let sizePercent;
    if (confidence >= 85) {
      sizePercent = 0.15; // 15% vốn
    } else if (confidence >= 75) {
      sizePercent = 0.10; // 10% vốn
    } else if (confidence >= 65) {
      sizePercent = 0.08; // 8% vốn
    } else {
      sizePercent = 0.05; // 5% vốn
    }
    
    const size = Math.max(MIN_ORDER_SIZE, this.balance * sizePercent);
    return Math.min(size, this.balance); // Không vượt quá balance
  }

  calculateExitTime(timeframe) {
    const durations = {
      '3m': 3 * 60 * 1000,
      '5m': 5 * 60 * 1000,
      '10m': 10 * 60 * 1000,
      '30m': 30 * 60 * 1000,
      '1h': 60 * 60 * 1000,
      '1d': 24 * 60 * 60 * 1000
    };
    return Date.now() + durations[timeframe];
  }

  async checkAndClosePositions(currentPrices) {
    const now = Date.now();
    const toClose = [];
    
    for (const [symbol, pos] of this.openPositions) {
      if (now >= pos.exitTime) {
        const currentPrice = currentPrices.get(symbol);
        if (currentPrice) {
          toClose.push({ symbol, pos, currentPrice });
        }
      }
    }
    
    for (const { symbol, pos, currentPrice } of toClose) {
      await this.closePosition(symbol, pos, currentPrice);
    }
  }

  async closePosition(symbol, position, exitPrice) {
    const priceChange = ((exitPrice - position.entryPrice) / position.entryPrice) * 100;
    
    // Xác định win/loss
    let isWin = false;
    if (position.direction === 'UP' && exitPrice > position.entryPrice) {
      isWin = true;
    } else if (position.direction === 'DOWN' && exitPrice < position.entryPrice) {
      isWin = true;
    }
    
    // Tính P&L
    const winRate = WIN_RATES[position.timeframe];
    let pnl;
    if (isWin) {
      pnl = position.orderSize * winRate; // Ăn theo tỷ lệ
    } else {
      pnl = -position.orderSize; // Mất toàn bộ order size
    }
    
    this.balance += pnl;
    
    const trade = {
      ...position,
      exitPrice,
      exitTime: Date.now(),
      priceChange,
      isWin,
      pnl,
      balanceAfter: this.balance,
      status: 'CLOSED'
    };
    
    this.tradeHistory.push(trade);
    this.openPositions.delete(symbol);
    this.saveState();
    
    // Gửi thông báo
    await this.sendTradeResult(trade);
    
    console.log(`${isWin ? '✅ WIN' : '❌ LOSS'}: ${symbol} | P&L: ${pnl > 0 ? '+' : ''}$${pnl.toFixed(2)} | Balance: $${this.balance.toFixed(2)}`);
  }

  async sendTradeResult(trade) {
    const emoji = trade.isWin ? '✅' : '❌';
    const result = trade.isWin ? 'THẮNG' : 'THUA';
    const pnlText = trade.pnl > 0 ? `+$${trade.pnl.toFixed(2)}` : `-$${Math.abs(trade.pnl).toFixed(2)}`;
    
    const duration = ((trade.exitTime - trade.openTime) / 60000).toFixed(1);
    
    const message = 
      `${emoji} **${result}** - ${trade.symbol.replace('_USDT', '')}\n\n` +
      `**Chi tiết lệnh:**\n` +
      `• Hướng: ${trade.direction === 'UP' ? '📈 TĂNG' : '📉 GIẢM'}\n` +
      `• Entry: $${trade.entryPrice.toFixed(6)}\n` +
      `• Exit: $${trade.exitPrice.toFixed(6)}\n` +
      `• Thay đổi: ${trade.priceChange > 0 ? '+' : ''}${trade.priceChange.toFixed(2)}%\n` +
      `• Thời gian: ${duration} phút (${trade.timeframe})\n` +
      `• Vốn lệnh: $${trade.orderSize.toFixed(2)}\n` +
      `• P&L: **${pnlText}** (${(trade.pnl / trade.orderSize * 100).toFixed(1)}%)\n\n` +
      `💰 Balance: $${trade.balanceAfter.toFixed(2)} (${((trade.balanceAfter - INITIAL_BALANCE) / INITIAL_BALANCE * 100).toFixed(1)}%)`;
    
    try {
      await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error('Lỗi gửi kết quả:', err.message);
    }
  }

  getStats() {
    const totalTrades = this.tradeHistory.length;
    const wins = this.tradeHistory.filter(t => t.isWin).length;
    const losses = totalTrades - wins;
    const winRate = totalTrades > 0 ? (wins / totalTrades * 100) : 0;
    
    const totalPnl = this.balance - this.initialBalance;
    const roi = (totalPnl / this.initialBalance) * 100;
    
    return { totalTrades, wins, losses, winRate, totalPnl, roi, balance: this.balance };
  }
}

// === PHÂN TÍCH KỸ THUẬT ===
class TechnicalAnalyzer {
  calculateRSI(prices, period = 14) {
    if (prices.length < period + 1) return null;
    
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
      const change = prices[i] - prices[i - 1];
      if (change > 0) gains += change;
      else losses += Math.abs(change);
    }
    
    const avgGain = gains / period;
    const avgLoss = losses / period;
    
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  calculateEMA(prices, period) {
    if (prices.length < period) return null;
    const k = 2 / (period + 1);
    let ema = prices.slice(0, period).reduce((a, b) => a + b) / period;
    
    for (let i = period; i < prices.length; i++) {
      ema = prices[i] * k + ema * (1 - k);
    }
    return ema;
  }

  findSupportResistance(klines, lookback = 50) {
    const highs = klines.slice(-lookback).map(k => k.high);
    const lows = klines.slice(-lookback).map(k => k.low);
    
    // Tìm vùng giá được chạm nhiều lần
    const priceZones = new Map();
    const tolerance = 0.005; // 0.5% tolerance
    
    [...highs, ...lows].forEach(price => {
      let foundZone = false;
      for (const [zone, count] of priceZones) {
        if (Math.abs((price - zone) / zone) < tolerance) {
          priceZones.set(zone, count + 1);
          foundZone = true;
          break;
        }
      }
      if (!foundZone) {
        priceZones.set(price, 1);
      }
    });
    
    // Lọc vùng có >= 3 lần chạm
    const resistances = [];
    const supports = [];
    
    for (const [price, touches] of priceZones) {
      if (touches >= SUPPORT_RESISTANCE_TOUCHES) {
        const currentPrice = klines[klines.length - 1].close;
        if (price > currentPrice * 1.001) {
          resistances.push({ price, touches });
        } else if (price < currentPrice * 0.999) {
          supports.push({ price, touches });
        }
      }
    }
    
    resistances.sort((a, b) => a.price - b.price);
    supports.sort((a, b) => b.price - a.price);
    
    return { 
      nearestSupport: supports[0]?.price || null,
      nearestResistance: resistances[0]?.price || null,
      allSupports: supports,
      allResistances: resistances
    };
  }

  detectTrend(klines, period = 20) {
    const closes = klines.slice(-period).map(k => k.close);
    const ema = this.calculateEMA(closes, period);
    
    const currentPrice = closes[closes.length - 1];
    const priceAboveEMA = currentPrice > ema;
    
    // Đếm số nến tăng/giảm
    let bullishCandles = 0;
    let bearishCandles = 0;
    
    klines.slice(-period).forEach(k => {
      if (k.close > k.open) bullishCandles++;
      else bearishCandles++;
    });
    
    const trendStrength = Math.abs(bullishCandles - bearishCandles) / period;
    
    let trend = 'SIDEWAYS';
    if (priceAboveEMA && trendStrength > TREND_STRENGTH_MIN) {
      trend = 'UPTREND';
    } else if (!priceAboveEMA && trendStrength > TREND_STRENGTH_MIN) {
      trend = 'DOWNTREND';
    }
    
    return { trend, strength: trendStrength, ema };
  }

  analyzeVolume(klines, period = 20) {
    const volumes = klines.slice(-period).map(k => k.volume);
    const avgVolume = volumes.slice(0, -1).reduce((a, b) => a + b) / (period - 1);
    const currentVolume = volumes[volumes.length - 1];
    const ratio = currentVolume / avgVolume;
    
    return {
      avgVolume,
      currentVolume,
      ratio,
      isSpike: ratio >= VOLUME_SPIKE_RATIO
    };
  }

  generateSignal(klines) {
    if (klines.length < 50) return null;
    
    const currentCandle = klines[klines.length - 1];
    const closes = klines.map(k => k.close);
    
    // RSI
    const rsi = this.calculateRSI(closes);
    
    // Trend
    const trendAnalysis = this.detectTrend(klines);
    
    // Support/Resistance
    const srLevels = this.findSupportResistance(klines);
    
    // Volume
    const volumeAnalysis = this.analyzeVolume(klines);
    
    // EMA
    const ema20 = this.calculateEMA(closes, 20);
    const ema50 = this.calculateEMA(closes, 50);
    
    const currentPrice = currentCandle.close;
    
    // === LOGIC SINH TÍN HIỆU ===
    let signals = [];
    
    // Tín hiệu TĂNG
    if (
      rsi && rsi < RSI_OVERSOLD && // RSI oversold
      srLevels.nearestSupport && // Gần support
      Math.abs((currentPrice - srLevels.nearestSupport) / currentPrice) < 0.015 && // Trong vòng 1.5%
      volumeAnalysis.isSpike && // Volume tăng đột biến
      trendAnalysis.trend !== 'DOWNTREND' // Không trong downtrend mạnh
    ) {
      signals.push({
        direction: 'UP',
        confidence: this.calculateConfidence({
          rsi,
          supportDistance: Math.abs((currentPrice - srLevels.nearestSupport) / currentPrice),
          volumeRatio: volumeAnalysis.ratio,
          trend: trendAnalysis.trend,
          trendStrength: trendAnalysis.strength
        }),
        reason: `RSI oversold (${rsi.toFixed(1)}), Bounce từ support $${srLevels.nearestSupport.toFixed(6)}, Volume spike x${volumeAnalysis.ratio.toFixed(1)}`,
        srLevels,
        rsi,
        volumeAnalysis,
        trendAnalysis
      });
    }
    
    // Tín hiệu GIẢM
    if (
      rsi && rsi > RSI_OVERBOUGHT && // RSI overbought
      srLevels.nearestResistance && // Gần resistance
      Math.abs((srLevels.nearestResistance - currentPrice) / currentPrice) < 0.015 && // Trong vòng 1.5%
      volumeAnalysis.isSpike && // Volume tăng
      trendAnalysis.trend !== 'UPTREND' // Không trong uptrend mạnh
    ) {
      signals.push({
        direction: 'DOWN',
        confidence: this.calculateConfidence({
          rsi,
          resistanceDistance: Math.abs((srLevels.nearestResistance - currentPrice) / currentPrice),
          volumeRatio: volumeAnalysis.ratio,
          trend: trendAnalysis.trend,
          trendStrength: trendAnalysis.strength
        }),
        reason: `RSI overbought (${rsi.toFixed(1)}), Reject tại resistance $${srLevels.nearestResistance.toFixed(6)}, Volume spike x${volumeAnalysis.ratio.toFixed(1)}`,
        srLevels,
        rsi,
        volumeAnalysis,
        trendAnalysis
      });
    }
    
    // Tín hiệu TREND FOLLOWING
    if (
      trendAnalysis.trend === 'UPTREND' &&
      trendAnalysis.strength > 0.7 &&
      currentPrice > ema20 && ema20 > ema50 && // EMA alignment
      !signals.length // Chưa có tín hiệu khác
    ) {
      signals.push({
        direction: 'UP',
        confidence: this.calculateConfidence({
          trend: 'UPTREND',
          trendStrength: trendAnalysis.strength,
          emaAlignment: true,
          volumeRatio: volumeAnalysis.ratio
        }),
        reason: `Strong uptrend (${(trendAnalysis.strength * 100).toFixed(0)}%), EMA bullish alignment`,
        srLevels,
        rsi,
        volumeAnalysis,
        trendAnalysis
      });
    }
    
    if (
      trendAnalysis.trend === 'DOWNTREND' &&
      trendAnalysis.strength > 0.7 &&
      currentPrice < ema20 && ema20 < ema50 &&
      !signals.length
    ) {
      signals.push({
        direction: 'DOWN',
        confidence: this.calculateConfidence({
          trend: 'DOWNTREND',
          trendStrength: trendAnalysis.strength,
          emaAlignment: true,
          volumeRatio: volumeAnalysis.ratio
        }),
        reason: `Strong downtrend (${(trendAnalysis.strength * 100).toFixed(0)}%), EMA bearish alignment`,
        srLevels,
        rsi,
        volumeAnalysis,
        trendAnalysis
      });
    }
    
    // Chọn signal tốt nhất
    if (signals.length > 0) {
      signals.sort((a, b) => b.confidence - a.confidence);
      return signals[0];
    }
    
    return null;
  }

  calculateConfidence(factors) {
    let confidence = 50; // Base confidence
    
    // RSI
    if (factors.rsi) {
      if (factors.rsi < 25 || factors.rsi > 75) confidence += 15;
      else if (factors.rsi < 30 || factors.rsi > 70) confidence += 10;
    }
    
    // Support/Resistance proximity
    if (factors.supportDistance !== undefined && factors.supportDistance < 0.01) confidence += 15;
    if (factors.resistanceDistance !== undefined && factors.resistanceDistance < 0.01) confidence += 15;
    
    // Volume
    if (factors.volumeRatio > 2.5) confidence += 12;
    else if (factors.volumeRatio > 2.0) confidence += 8;
    else if (factors.volumeRatio > 1.5) confidence += 5;
    
    // Trend
    if (factors.trend === 'UPTREND' || factors.trend === 'DOWNTREND') {
      confidence += factors.trendStrength * 15;
    }
    
    // EMA alignment
    if (factors.emaAlignment) confidence += 10;
    
    return Math.min(95, Math.max(50, confidence));
  }
}

// === FETCH DATA ===
async function fetchKlines(symbol, interval = 'Min5', limit = 100) {
  const now = Math.floor(Date.now() / 1000);
  const intervalMinutes = {
    'Min1': 1,
    'Min3': 3,
    'Min5': 5,
    'Min10': 10,
    'Min30': 30,
    'Min60': 60,
    'Day1': 1440
  };
  const start = now - (limit * intervalMinutes[interval] * 60);
  
  try {
    const res = await axiosInstance.get(`https://contract.mexc.com/api/v1/contract/kline/${symbol}`, {
      params: { interval, start, end: now },
    });
    
    if (res.data?.success && res.data.data) {
      const { time, open, high, low, close, vol } = res.data.data;
      return time.map((t, i) => ({
        time: t * 1000,
        open: parseFloat(open[i]),
        high: parseFloat(high[i]),
        low: parseFloat(low[i]),
        close: parseFloat(close[i]),
        volume: parseFloat(vol[i])
      })).sort((a, b) => a.time - b.time);
    }
  } catch (err) {
    console.error(`Lỗi fetch klines ${symbol}:`, err.message);
  }
  return [];
}

async function getCurrentPrice(symbol) {
  try {
    const res = await axiosInstance.get('https://contract.mexc.com/api/v1/contract/ticker');
    if (res.data?.success && Array.isArray(res.data.data)) {
      const ticker = res.data.data.find(t => t.symbol === symbol);
      return ticker ? parseFloat(ticker.lastPrice) : null;
    }
  } catch (err) {
    console.error(`Lỗi fetch price ${symbol}:`, err.message);
  }
  return null;
}

// === MAIN LOGIC ===
const tradingManager = new TradingManager();
const analyzer = new TechnicalAnalyzer();

async function scanAndTrade() {
  console.log('\n🔍 Quét tín hiệu...');
  
  // Check và close positions
  const currentPrices = new Map();
  for (const symbol of ALLOWED_COINS) {
    const price = await getCurrentPrice(symbol);
    if (price) currentPrices.set(symbol, price);
  }
  await tradingManager.checkAndClosePositions(currentPrices);
  
  // Quét tín hiệu mới
  for (const symbol of ALLOWED_COINS) {
    if (!tradingManager.canOpenPosition(symbol)) continue;
    
    const klines = await fetchKlines(symbol, 'Min5', 100);
    if (klines.length < 50) continue;
    
    const signal = analyzer.generateSignal(klines);
    
    if (signal && signal.confidence >= 70) {
      const currentPrice = klines[klines.length - 1].close;
      
      // Chọn timeframe tối ưu dựa trên confidence
      let timeframe;
      if (signal.confidence >= 85) {
        timeframe = '10m'; // Win rate 82%
      } else if (signal.confidence >= 75) {
        timeframe = '5m'; // Win rate 75%
      } else {
        timeframe = '3m'; // Win rate 75%
      }
      
      const position = tradingManager.openPosition(
        symbol,
        signal.direction,
        currentPrice,
        timeframe,
        signal.confidence,
        signal
      );
      
      // Gửi thông báo
      await sendSignalAlert(symbol, currentPrice, signal, position);
    }
    
    await new Promise(r => setTimeout(r, 1000)); // Rate limit
  }
  
  // Log stats
  const stats = tradingManager.getStats();
  console.log(`📊 Stats: ${stats.totalTrades} trades | WR: ${stats.winRate.toFixed(1)}% | Balance: $${stats.balance.toFixed(2)} (${stats.roi > 0 ? '+' : ''}${stats.roi.toFixed(1)}%)`);
}

async function sendSignalAlert(symbol, entryPrice, signal, position) {
  const directionEmoji = signal.direction === 'UP' ? '📈' : '📉';
  const confidenceBar = '█'.repeat(Math.floor(signal.confidence / 10));
  
  const message = 
    `${directionEmoji} **TÍN HIỆU MỚI** - ${symbol.replace('_USDT', '')}\n\n` +
    `**Dự đoán:** ${signal.direction === 'UP' ? 'TĂNG ⬆️' : 'GIẢM ⬇️'}\n` +
    `**Confidence:** ${signal.confidence.toFixed(0)}% ${confidenceBar}\n` +
    `**Entry:** $${entryPrice.toFixed(6)}\n` +
    `**Timeframe:** ${position.timeframe}\n` +
    `**Vốn lệnh:** $${position.orderSize.toFixed(2)}\n\n` +
    `**Phân tích:**\n${signal.reason}\n\n` +
    `📊 **Chi tiết:**\n` +
    `• RSI: ${signal.rsi ? signal.rsi.toFixed(1) : 'N/A'}\n` +
    `• Trend: ${signal.trendAnalysis.trend}\n` +
    `• Volume: x${signal.volumeAnalysis.ratio.toFixed(1)}\n` +
    (signal.srLevels.nearestSupport ? `• Support: $${signal.srLevels.nearestSupport.toFixed(6)}\n` : '') +
    (signal.srLevels.nearestResistance ? `• Resistance: $${signal.srLevels.nearestResistance.toFixed(6)}\n` : '') +
    `\n⏰ Tự động đóng sau ${position.timeframe}`;
  
  try {
    await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Lỗi gửi signal:', err.message);
  }
}

async function sendDailyReport() {
  const stats = tradingManager.getStats();
  
  const message = 
    `📈 **BÁO CÁO GIAO DỊCH**\n\n` +
    `💰 **Vốn hiện tại:** ${stats.balance.toFixed(2)}\n` +
    `📊 **P&L:** ${stats.totalPnl > 0 ? '+' : ''}${stats.totalPnl.toFixed(2)} (${stats.roi > 0 ? '+' : ''}${stats.roi.toFixed(1)}%)\n\n` +
    `🎯 **Thống kê giao dịch:**\n` +
    `• Tổng số lệnh: ${stats.totalTrades}\n` +
    `• Thắng: ${stats.wins} ✅\n` +
    `• Thua: ${stats.losses} ❌\n` +
    `• Win Rate: ${stats.winRate.toFixed(1)}%\n\n` +
    `📅 Hôm nay: ${tradingManager.dailyOrderCount}/${MAX_DAILY_ORDERS} lệnh\n` +
    `🔄 Vốn ban đầu: ${INITIAL_BALANCE}`;
  
  try {
    await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Lỗi gửi báo cáo:', err.message);
  }
}

// === KHỞI ĐỘNG BOT ===
(async () => {
  console.log('🚀 Khởi động MEXC Prediction Bot...');
  console.log(`💰 Vốn ban đầu: ${INITIAL_BALANCE}`);
  console.log(`🎯 Coins: ${ALLOWED_COINS.join(', ')}`);
  console.log(`📊 Win rates: 3m/5m=${WIN_RATES['3m']*100}%, 10m=${WIN_RATES['10m']*100}%, 30m/1h/1d=${WIN_RATES['30m']*100}%`);
  console.log(`⚙️ Min order: ${MIN_ORDER_SIZE}, Max daily: ${MAX_DAILY_ORDERS} lệnh`);
  
  // Load trạng thái
  const stats = tradingManager.getStats();
  console.log(`📂 Balance hiện tại: ${stats.balance.toFixed(2)} | Trades: ${stats.totalTrades} | WR: ${stats.winRate.toFixed(1)}%\n`);
  
  // Gửi báo cáo khởi động
  await bot.sendMessage(chatId, 
    `🤖 **BOT ĐÃ KHỞI ĐỘNG**\n\n` +
    `💰 Balance: ${stats.balance.toFixed(2)}\n` +
    `📊 Total Trades: ${stats.totalTrades}\n` +
    `🎯 Win Rate: ${stats.winRate.toFixed(1)}%\n` +
    `🔍 Đang quét tín hiệu...`,
    { parse_mode: 'Markdown' }
  );
  
  // Chạy lần đầu
  await scanAndTrade();
  
  // Lặp lại mỗi 15 giây
  setInterval(scanAndTrade, pollInterval);
  
  // Gửi báo cáo hàng ngày lúc 00:00
  setInterval(async () => {
    const now = new Date();
    if (now.getHours() === 0 && now.getMinutes() === 0) {
      await sendDailyReport();
    }
  }, 60000); // Check mỗi phút
  
  console.log(`🔁 Polling mỗi ${pollInterval / 1000} giây\n`);
})();