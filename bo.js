// bot-mexc-prediction-v1.js
import dotenv from 'dotenv';
import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import https from 'https';

dotenv.config();

// === CẤU HÌNH ===
const token = process.env.TELEGRAM_BOT_TOKEN_BO;
const chatId = process.env.TELEGRAM_CHAT_ID_BO;
const pollInterval = parseInt(process.env.POLL_INTERVAL) || 30000; // 30 giây
const axiosTimeout = 8000;
const klineLimit = 50;

if (!token || !chatId) {
  console.error('❌ Thiếu TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID trong .env');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: false });

// === DANH SÁCH COIN ĐƯỢC PHÉP ===
const ALLOWED_SYMBOLS = [
  'BTC_USDT',
  'ETH_USDT', 
  'SOL_USDT',
  'DOGE_USDT'
];

// === VỐN VÀ QUẢN LÝ LỆNH ===
let capital = 100.00; // Vốn ban đầu $100
let activeTrades = new Map();
let tradeHistory = [];
let dailyTradeCount = 0;
let lastTradeReset = new Date().toDateString();

// Cấu hình khung thời gian và tỷ lệ thắng
const TIME_FRAMES = {
  '3m': { interval: 'Min3', payout: 0.75, weight: 1 },
  '5m': { interval: 'Min5', payout: 0.75, weight: 1 },
  '10m': { interval: 'Min10', payout: 0.82, weight: 2 },
  '30m': { interval: 'Min30', payout: 0.82, weight: 2 },
  '1h': { interval: 'Hour1', payout: 0.87, weight: 3 },
  '1d': { interval: 'Day1', payout: 0.87, weight: 3 }
};

// === CÁC CHỈ BÁO KỸ THUẬT ===
function calculateRSI(prices, period = 14) {
  if (prices.length < period + 1) return 50;
  
  let gains = 0;
  let losses = 0;
  
  for (let i = 1; i <= period; i++) {
    const difference = prices[prices.length - i] - prices[prices.length - i - 1];
    if (difference >= 0) gains += difference;
    else losses -= difference;
  }
  
  const avgGain = gains / period;
  const avgLoss = losses / period;
  
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calculateMACD(prices) {
  if (prices.length < 26) return { macd: 0, signal: 0, histogram: 0 };
  
  const ema12 = calculateEMA(prices, 12);
  const ema26 = calculateEMA(prices, 26);
  const macd = ema12 - ema26;
  const signal = calculateEMA(prices.slice(-9), 9); // Simplified signal line
  const histogram = macd - signal;
  
  return { macd, signal, histogram };
}

function calculateEMA(prices, period) {
  const multiplier = 2 / (period + 1);
  let ema = prices[0];
  
  for (let i = 1; i < prices.length; i++) {
    ema = (prices[i] - ema) * multiplier + ema;
  }
  
  return ema;
}

function calculateBollingerBands(prices, period = 20) {
  if (prices.length < period) return { upper: 0, middle: 0, lower: 0 };
  
  const slice = prices.slice(-period);
  const middle = slice.reduce((a, b) => a + b) / period;
  const variance = slice.reduce((a, b) => a + Math.pow(b - middle, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  
  return {
    upper: middle + (stdDev * 2),
    middle: middle,
    lower: middle - (stdDev * 2)
  };
}

function calculateSupportResistance(klines) {
  const highs = klines.map(k => k.high).slice(-20);
  const lows = klines.map(k => k.low).slice(-20);
  
  const resistance = Math.max(...highs);
  const support = Math.min(...lows);
  
  const currentPrice = klines[klines.length - 1].close;
  const resistanceDistance = ((resistance - currentPrice) / currentPrice) * 100;
  const supportDistance = ((currentPrice - support) / currentPrice) * 100;
  
  return {
    resistance,
    support,
    resistanceDistance,
    supportDistance,
    nearResistance: resistanceDistance < 1,
    nearSupport: supportDistance < 1
  };
}

// === PHÂN TÍCH XU HƯỚNG ===
function analyzeTrend(klines) {
  const prices = klines.map(k => k.close);
  const currentPrice = prices[prices.length - 1];
  
  // SMA ngắn và dài hạn
  const sma5 = prices.slice(-5).reduce((a, b) => a + b) / 5;
  const sma10 = prices.slice(-10).reduce((a, b) => a + b) / 10;
  const sma20 = prices.slice(-20).reduce((a, b) => a + b) / 20;
  
  // RSI
  const rsi = calculateRSI(prices);
  
  // MACD
  const macd = calculateMACD(prices);
  
  // Bollinger Bands
  const bb = calculateBollingerBands(prices);
  
  // Support/Resistance
  const sr = calculateSupportResistance(klines);
  
  // Phân tích xu hướng
  const trendShort = currentPrice > sma5 ? 'UP' : 'DOWN';
  const trendMedium = currentPrice > sma10 ? 'UP' : 'DOWN';
  const trendLong = currentPrice > sma20 ? 'UP' : 'DOWN';
  
  let trendStrength = 0;
  if (trendShort === 'UP') trendStrength += 1;
  if (trendMedium === 'UP') trendStrength += 1;
  if (trendLong === 'UP') trendStrength += 1;
  
  const overallTrend = trendStrength >= 2 ? 'BULLISH' : 'BEARISH';
  
  // Tín hiệu mua/bán
  let signals = [];
  
  if (rsi < 30 && overallTrend === 'BULLISH') signals.push('RSI OVERSOLD');
  if (rsi > 70 && overallTrend === 'BEARISH') signals.push('RSI OVERBOUGHT');
  if (macd.histogram > 0 && macd.macd > macd.signal) signals.push('MACD BULLISH');
  if (macd.histogram < 0 && macd.macd < macd.signal) signals.push('MACD BEARISH');
  if (currentPrice < bb.lower && overallTrend === 'BULLISH') signals.push('BB OVERSOLD');
  if (currentPrice > bb.upper && overallTrend === 'BEARISH') signals.push('BB OVERBOUGHT');
  if (sr.nearSupport && overallTrend === 'BULLISH') signals.push('NEAR SUPPORT');
  if (sr.nearResistance && overallTrend === 'BEARISH') signals.push('NEAR RESISTANCE');
  
  return {
    trend: overallTrend,
    strength: trendStrength,
    rsi,
    macd,
    bollingerBands: bb,
    supportResistance: sr,
    signals,
    price: currentPrice,
    sma5,
    sma10,
    sma20
  };
}

// === TÍNH ĐIỂM TÍN HIỆU ===
function calculateSignalScore(analysis, timeFrame) {
  let score = 50; // Điểm trung lập
  
  // RSI signals
  if (analysis.rsi < 30) score += 15;
  if (analysis.rsi > 70) score -= 15;
  
  // MACD signals
  if (analysis.macd.histogram > 0) score += 10;
  if (analysis.macd.histogram < 0) score -= 10;
  
  // Bollinger Bands
  if (analysis.price < analysis.bollingerBands.lower) score += 12;
  if (analysis.price > analysis.bollingerBands.upper) score -= 12;
  
  // Support/Resistance
  if (analysis.supportResistance.nearSupport) score += 8;
  if (analysis.supportResistance.nearResistance) score -= 8;
  
  // Xu hướng
  if (analysis.trend === 'BULLISH') score += 5;
  if (analysis.trend === 'BEARISH') score -= 5;
  
  // Điều chỉnh theo khung thời gian
  const timeFrameMultiplier = TIME_FRAMES[timeFrame].weight;
  score = score * (timeFrameMultiplier * 0.3 + 0.7);
  
  return Math.max(0, Math.min(100, score));
}

// === LẤY DỮ LIỆU KLINE ===
async function fetchKlines(symbol, interval) {
  try {
    const now = Math.floor(Date.now() / 1000);
    const start = now - klineLimit * 60;
    
    const res = await axios.get(`https://contract.mexc.com/api/v1/contract/kline/${symbol}`, {
      params: { interval, start, end: now },
      timeout: axiosTimeout
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
      })).filter(k => !isNaN(k.close));
    }
  } catch (err) {
    console.error(`Lỗi fetch klines ${symbol}:`, err.message);
  }
  return [];
}

// === LẤY SYMBOLS (CHỈ 4 COIN ĐƯỢC PHÉP) ===
async function fetchAllowedSymbols() {
  try {
    const response = await axios.get('https://contract.mexc.com/api/v1/contract/ticker');
    if (response.data?.success && Array.isArray(response.data.data)) {
      // Chỉ lấy 4 coin được phép
      return response.data.data
        .filter(t => ALLOWED_SYMBOLS.includes(t.symbol))
        .sort((a, b) => {
          // Sắp xếp theo thứ tự ưu tiên: BTC -> ETH -> SOL -> DOGE
          const priority = { 'BTC_USDT': 1, 'ETH_USDT': 2, 'SOL_USDT': 3, 'DOGE_USDT': 4 };
          return priority[a.symbol] - priority[b.symbol];
        });
    }
  } catch (err) {
    console.error('Lỗi fetch symbols:', err.message);
  }
  return [];
}

// === QUẢN LÝ VỐN VÀ LỆNH ===
function resetDailyTrades() {
  const today = new Date().toDateString();
  if (today !== lastTradeReset) {
    dailyTradeCount = 0;
    lastTradeReset = today;
    console.log('🔄 Đã reset số lệnh trong ngày');
  }
}

function canPlaceTrade() {
  resetDailyTrades();
  return dailyTradeCount < 100 && capital >= 5; // Phải có ít nhất $5 để vào lệnh
}

function calculateTradeAmount(signalScore) {
  const MIN_TRADE_AMOUNT = 5; // $5 - tối thiểu theo quy định sàn
  const MAX_TRADE_PERCENT = 0.1; // Tối đa 10% vốn
  
  const baseAmount = capital * 0.02; // 2% vốn mỗi lệnh
  const confidenceMultiplier = signalScore / 100;
  const calculatedAmount = baseAmount * (0.5 + confidenceMultiplier);
  
  // Đảm bảo số tiền nằm trong khoảng $5 đến 10% vốn
  return Math.max(
    MIN_TRADE_AMOUNT, 
    Math.min(calculatedAmount, capital * MAX_TRADE_PERCENT)
  );
}

function placeTrade(symbol, direction, amount, timeFrame, signalScore) {
  if (!canPlaceTrade()) {
    console.log(`❌ Không thể vào lệnh: Vốn không đủ $5 hoặc đã đạt 100 lệnh/ngày`);
    return null;
  }
  
  // Kiểm tra lại số tiền tối thiểu
  if (amount < 5) {
    console.log(`⚠️ Điều chỉnh số tiền từ $${amount} lên $5 (tối thiểu)`);
    amount = 5;
  }
  
  // Kiểm tra vốn có đủ không
  if (capital < amount) {
    console.log(`❌ Vốn không đủ: $${capital} < $${amount}`);
    return null;
  }
  
  const trade = {
    id: `${symbol}_${Date.now()}`,
    symbol,
    direction, // 'UP' or 'DOWN'
    amount,
    timeFrame,
    entryPrice: 0,
    entryTime: Date.now(),
    exitPrice: null,
    exitTime: null,
    pnl: null,
    status: 'OPEN',
    signalScore
  };
  
  activeTrades.set(trade.id, trade);
  dailyTradeCount++;
  
  console.log(`✅ Đã vào lệnh: ${symbol} ${direction} | $${amount} | Khung: ${timeFrame}`);
  
  return trade;
}

async function closeTrade(tradeId, exitPrice) {
  const trade = activeTrades.get(tradeId);
  if (!trade) return null;
  
  const priceDiff = exitPrice - trade.entryPrice;
  const isWin = trade.direction === 'UP' ? priceDiff > 0 : priceDiff < 0;
  const payoutRate = TIME_FRAMES[trade.timeFrame].payout;
  
  let pnl;
  if (isWin) {
    pnl = trade.amount * payoutRate;
  } else {
    pnl = -trade.amount;
  }
  
  trade.exitPrice = exitPrice;
  trade.exitTime = Date.now();
  trade.pnl = pnl;
  trade.status = 'CLOSED';
  
  capital += pnl;
  
  // Chuyển sang lịch sử
  activeTrades.delete(tradeId);
  tradeHistory.push(trade);
  
  return trade;
}

// === GỬI THÔNG BÁO ===
async function sendTradeAlert(symbol, direction, timeFrame, analysis, signalScore) {
  const trendEmoji = direction === 'UP' ? '🟢' : '🔴';
  const amount = calculateTradeAmount(signalScore);
  
  // Kiểm tra số tiền tối thiểu
  const tradeAmount = Math.max(5, amount); // Đảm bảo tối thiểu $5
  
  const message = 
    `${trendEmoji} **DỰ ĐOÁN ${direction}** ${trendEmoji}\n\n` +
    `**Coin:** ${getCoinName(symbol)} (${symbol})\n` +
    `**Khung:** ${timeFrame} (Ăn ${(TIME_FRAMES[timeFrame].payout * 100)}%)\n` +
    `**Giá hiện tại:** $${analysis.price.toFixed(getPricePrecision(symbol))}\n` +
    `**Điểm tín hiệu:** ${signalScore.toFixed(1)}/100\n` +
    `**Khuyến nghị vào:** $${tradeAmount.toFixed(2)} ⚠️ (Tối thiểu $5)\n\n` +
    `**Phân tích:**\n` +
    `• Xu hướng: ${analysis.trend} (${analysis.strength}/3)\n` +
    `• RSI: ${analysis.rsi.toFixed(1)} ${analysis.rsi < 30 ? '📈' : analysis.rsi > 70 ? '📉' : '➡️'}\n` +
    `• Tín hiệu: ${analysis.signals.join(', ') || 'Không có'}\n` +
    `• Support: $${analysis.supportResistance.support.toFixed(getPricePrecision(symbol))}\n` +
    `• Resistance: $${analysis.supportResistance.resistance.toFixed(getPricePrecision(symbol))}\n\n` +
    `⏰ **Hết hạn sau:** ${timeFrame}\n` +
    `💰 **Vốn hiện tại:** $${capital.toFixed(2)}`;

  await bot.sendMessage(chatId, message, { 
    parse_mode: 'Markdown',
    disable_web_page_preview: true 
  });
  
  // Ghi log trade
  console.log(`📊 Dự đoán: ${getCoinName(symbol)} ${direction} | Khung: ${timeFrame} | Điểm: ${signalScore.toFixed(1)} | Số tiền: $${tradeAmount.toFixed(2)}`);
}

async function sendTradeResult(trade, currentPrice) {
  const isWin = trade.pnl > 0;
  const emoji = isWin ? '💰' : '💸';
  const resultText = isWin ? 'THẮNG' : 'THUA';
  
  const priceDiff = ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100;
  const roi = (trade.pnl / trade.amount) * 100;
  
  const message = 
    `${emoji} **KẾT QUẢ ${resultText}** ${emoji}\n\n` +
    `**Coin:** ${getCoinName(trade.symbol)} (${trade.symbol})\n` +
    `**Dự đoán:** ${trade.direction}\n` +
    `**Khung:** ${trade.timeFrame}\n` +
    `**Vào:** $${trade.amount.toFixed(2)}\n` +
    `**Giá vào:** $${trade.entryPrice.toFixed(getPricePrecision(trade.symbol))}\n` +
    `**Giá ra:** $${trade.exitPrice.toFixed(getPricePrecision(trade.symbol))}\n` +
    `**Biến động:** ${priceDiff.toFixed(2)}%\n` +
    `**ROI:** ${roi.toFixed(2)}% ${isWin ? '🟢' : '🔴'}\n` +
    `**P&L:** $${trade.pnl.toFixed(2)} ${isWin ? '🟢' : '🔴'}\n\n` +
    `**Vốn hiện tại:** $${capital.toFixed(2)}\n` +
    `**Lệnh hôm nay:** ${dailyTradeCount}/100`;

  await bot.sendMessage(chatId, message, { 
    parse_mode: 'Markdown',
    disable_web_page_preview: true 
  });
}

// === HÀM HỖ TRỢ ===
function getCoinName(symbol) {
  const names = {
    'BTC_USDT': 'Bitcoin',
    'ETH_USDT': 'Ethereum', 
    'SOL_USDT': 'Solana',
    'DOGE_USDT': 'Dogecoin'
  };
  return names[symbol] || symbol;
}

function getPricePrecision(symbol) {
  const precision = {
    'BTC_USDT': 2,
    'ETH_USDT': 2,
    'SOL_USDT': 3,
    'DOGE_USDT': 5
  };
  return precision[symbol] || 6;
}

// === KIỂM TRA VÀ ĐÓNG LỆNH ===
async function checkAndCloseTrades() {
  if (activeTrades.size === 0) return;
  
  for (const [tradeId, trade] of activeTrades.entries()) {
    const klines = await fetchKlines(trade.symbol, TIME_FRAMES[trade.timeFrame].interval);
    if (klines.length === 0) continue;
    
    const currentPrice = klines[klines.length - 1].close;
    
    // Nếu là lần đầu, set entry price
    if (trade.entryPrice === 0) {
      trade.entryPrice = currentPrice;
      continue;
    }
    
    // Kiểm tra xem đã hết thời gian chưa
    const tradeDuration = Date.now() - trade.entryTime;
    const timeFrameMs = getTimeFrameMs(trade.timeFrame);
    
    if (tradeDuration >= timeFrameMs) {
      const closedTrade = await closeTrade(tradeId, currentPrice);
      if (closedTrade) {
        await sendTradeResult(closedTrade, currentPrice);
      }
    }
  }
}

function getTimeFrameMs(timeFrame) {
  const msPerMinute = 60 * 1000;
  const msPerHour = 60 * msPerMinute;
  const msPerDay = 24 * msPerHour;
  
  const timeFrames = {
    '3m': 3 * msPerMinute,
    '5m': 5 * msPerMinute,
    '10m': 10 * msPerMinute,
    '30m': 30 * msPerMinute,
    '1h': 1 * msPerHour,
    '1d': 1 * msPerDay
  };
  
  return timeFrames[timeFrame] || 5 * msPerMinute;
}

// === TÌM TÍN HIỆU GIAO DỊCH ===
async function findTradingSignals() {
  if (!canPlaceTrade()) {
    console.log(`⏸️ Tạm dừng tìm tín hiệu: Đã đạt ${dailyTradeCount}/100 lệnh hoặc vốn < $5`);
    return;
  }
  
  const symbols = await fetchAllowedSymbols();
  console.log(`🔍 Quét ${symbols.length} coin được phép: ${symbols.map(s => s.symbol).join(', ')}`);
  
  for (const symbolData of symbols) {
    const symbol = symbolData.symbol;
    
    for (const [timeFrame, config] of Object.entries(TIME_FRAMES)) {
      const klines = await fetchKlines(symbol, config.interval);
      if (klines.length < 20) continue;
      
      const analysis = analyzeTrend(klines);
      const signalScore = calculateSignalScore(analysis, timeFrame);
      
      // Chỉ giao dịch khi tín hiệu đủ mạnh
      if (signalScore >= 65 || signalScore <= 35) {
        const direction = signalScore >= 65 ? 'UP' : 'DOWN';
        
        // Kiểm tra xem đã có lệnh cho symbol này chưa
        const hasActiveTrade = Array.from(activeTrades.values())
          .some(trade => trade.symbol === symbol && trade.timeFrame === timeFrame);
        
        if (!hasActiveTrade) {
          const amount = calculateTradeAmount(signalScore);
          
          // Kiểm tra lại điều kiện vào lệnh
          if (amount >= 5 && capital >= amount) {
            const trade = placeTrade(symbol, direction, amount, timeFrame, signalScore);
            
            if (trade) {
              await sendTradeAlert(symbol, direction, timeFrame, analysis, signalScore);
              // Nghỉ giữa các lệnh
              await new Promise(resolve => setTimeout(resolve, 1000));
              break; // Mỗi coin chỉ vào 1 lệnh
            }
          } else {
            console.log(`❌ Bỏ qua ${symbol}: Số tiền $${amount.toFixed(2)} không hợp lệ hoặc vốn không đủ`);
          }
        }
      }
    }
  }
}

// === BÁO CÁO HÀNG NGÀY ===
let lastReportSent = 0; // Thêm biến để track lần báo cáo cuối

async function sendDailyReport() {
  const now = Date.now();
  // Chỉ gửi báo cáo mỗi 6 giờ (21600000 ms)
  if (now - lastReportSent < 21600000) {
    return;
  }
  
  const today = new Date().toDateString();
  const todayTrades = tradeHistory.filter(t => 
    new Date(t.exitTime).toDateString() === today
  );
  
  const totalTrades = todayTrades.length;
  const winningTrades = todayTrades.filter(t => t.pnl > 0).length;
  const totalPnl = todayTrades.reduce((sum, t) => sum + t.pnl, 0);
  const winRate = totalTrades > 0 ? (winningTrades / totalTrades * 100) : 0;
  
  const message = 
    `📊 **BÁO CÁO GIAO DỊCH 6H**\n\n` +
    `**Thời gian:** ${new Date().toLocaleString('vi-VN')}\n` +
    `**Coin được phép:** BTC, ETH, SOL, DOGE\n` +
    `**Tổng lệnh:** ${totalTrades}/100\n` +
    `**Lệnh thắng:** ${winningTrades}\n` +
    `**Tỷ lệ thắng:** ${winRate.toFixed(1)}%\n` +
    `**Lợi nhuận:** $${totalPnl.toFixed(2)}\n` +
    `**Vốn hiện tại:** $${capital.toFixed(2)}\n` +
    `**Biến động vốn:** ${((capital - 100) / 100 * 100).toFixed(2)}%`;

  await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  
  // Cập nhật thời gian gửi báo cáo cuối
  lastReportSent = now;
  console.log(`📊 Đã gửi báo cáo 6h | Lần tiếp theo: ${new Date(now + 21600000).toLocaleString('vi-VN')}`);
}
// === VÒNG LẶP CHÍNH ===
async function mainLoop() {
  try {
    console.log(`🚀 Bot đang chạy | Vốn: $${capital.toFixed(2)} | Lệnh hôm nay: ${dailyTradeCount}/100`);
    
    // Kiểm tra và đóng lệnh cũ
    await checkAndCloseTrades();
    
    // Tìm tín hiệu mới (chạy ít thường xuyên hơn)
    if (Math.random() < 0.4) { // 40% cơ hội mỗi lần chạy
      await findTradingSignals();
    }
          await sendDailyReport();


    console.log(`✅ Đã quét 4 coin chính | Lệnh đang mở: ${activeTrades.size} | Vốn: $${capital.toFixed(2)}`);
    
  } catch (error) {
    console.error('Lỗi vòng lặp chính:', error);
  }
}

// === KHỞI CHẠY ===
(async () => {
  // Gửi thông báo khởi động
  await bot.sendMessage(chatId, 
    `🤖 **BOT DỰ ĐOÁN MEXC ĐÃ KHỞI ĐỘNG**\n\n` +
    `💰 Vốn ban đầu: $${capital}\n` +
    `💰 Lệnh tối thiểu: $5 (theo quy định sàn)\n` +
    `🎯 Coin được phép: BTC, ETH, SOL, DOGE\n` +
    `📊 Khung hỗ trợ: 3m, 5m, 10m, 30m, 1h, 1d\n` +
    `🎯 Tối đa: 100 lệnh/ngày\n` +
    `🔔 Đang theo dõi 4 coin chính...`,
    { parse_mode: 'Markdown' }
  );
  
  // Chạy vòng lặp chính
  setInterval(mainLoop, pollInterval);
  mainLoop(); // Chạy ngay lập tức
})();