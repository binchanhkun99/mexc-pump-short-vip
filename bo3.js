// mexc-prediction-bot.js
// Bot dự đoán tăng/giảm (binary-style) cho MEXC: S/R + xác nhận, vốn giả, tracking P&L
// Tín hiệu "ít mà chuẩn": chỉ vào khi có chạm vùng + nến đảo chiều + RSI cực trị + volume tương đối
// © Use at your own risk — mô phỏng GIÁO DỤC, KHÔNG PHẢI LỜI KHUYÊN ĐẦU TƯ

import dotenv from 'dotenv';
import axios from 'axios';
import https from 'https';
import TelegramBot from 'node-telegram-bot-api';

dotenv.config();

/* ============== CẤU HÌNH ============== */
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN_BO || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID_BO || '';
if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error('❌ Thiếu TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID trong .env');
  process.exit(1);
}

const POLL_MS = parseInt(process.env.POLL_MS || '5000', 10);
const LOOKBACK_MIN = parseInt(process.env.LOOKBACK_MIN || '600', 10);

const FAKE_START_BALANCE = parseFloat(process.env.FAKE_START_BALANCE || '100');
const RISK_PER_TRADE = parseFloat(process.env.RISK_PER_TRADE || '0.03');
const MIN_STAKE = parseFloat(process.env.MIN_STAKE || '5');
const MAX_TRADES_PER_DAY = parseInt(process.env.MAX_TRADES_PER_DAY || '100', 10);
const SYMBOLS = (process.env.SYMBOLS || 'BTC_USDT,ETH_USDT,SOL_USDT,DOGE_USDT')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// payout mặc định — có thể ghi đè qua .env
const PAYOUT = {
  '3m': parseFloat(process.env.PAYOUT_3M || '0.75'),
  '5m': parseFloat(process.env.PAYOUT_5M || '0.75'),
  '10m': parseFloat(process.env.PAYOUT_10M || '0.82'),
  '30m': parseFloat(process.env.PAYOUT_30M || '0.87'),
  '1h': parseFloat(process.env.PAYOUT_1H || '0.87'),
  '1d': parseFloat(process.env.PAYOUT_1D || '0.87'),
};

const ACTIVE_TFS = (process.env.ACTIVE_TFS || '3m,5m,10m,30m,1h,1d')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const SR_TOUCH_ATR_MULT = parseFloat(process.env.SR_TOUCH_ATR_MULT || '0.25');
const MIN_CONFLUENCE_SCORE = parseInt(process.env.MIN_CONFLUENCE_SCORE || '3', 10);
const COOLDOWN_MINUTES = parseInt(process.env.COOLDOWN_MINUTES || '20', 10);

// Kích hoạt xác nhận: RSI, volume, pattern đảo chiều
const USE_RSI = (process.env.USE_RSI || 'true') === 'true';
const USE_VOL = (process.env.USE_VOL || 'true') === 'true';
const USE_REVERSE_CANDLE = (process.env.USE_REVERSE_CANDLE || 'true') === 'true';

// RSI tham số
const RSI_PERIOD = parseInt(process.env.RSI_PERIOD || '14', 10);
const RSI_OVERSOLD = parseFloat(process.env.RSI_OVERSOLD || '28');
const RSI_OVERBOUGHT = parseFloat(process.env.RSI_OVERBOUGHT || '72');

// agent axios
const axiosInstance = axios.create({
  timeout: 10000,
  httpsAgent: new https.Agent({ keepAlive: true }),
});

// Telegram
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

// Múi giờ: Asia/Bangkok (UTC+7)
const TZ_OFFSET_MIN = 7 * 60;

/* ============== TRẠNG THÁI VỐN & LỆNH ============== */
let balance = FAKE_START_BALANCE;
let dayKey = getDayKey(); // YYYY-MM-DD theo UTC+7
let tradesToday = 0;

const openTrades = []; // {id, symbol, tf, direction, entryPrice, stake, openTime, expireTime}
const history = [];    // {id, symbol, tf, direction, entryPrice, exitPrice, stake, pnl, outcome, openTime, closeTime}

const lastTradeTime = new Map(); // key `${symbol}_${tf}` -> timestamp ms

/* ============== TIỆN ÍCH THỜI GIAN ============== */
function getBangkokNow() {
  const now = new Date();
  return new Date(now.getTime() + TZ_OFFSET_MIN * 60000 - now.getTimezoneOffset() * 60000);
}
function getDayKey(d = getBangkokNow()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/* ============== API MEXC ============== */
async function fetchMexc1mKlines(symbol, minutesBack = LOOKBACK_MIN) {
  const now = Math.floor(Date.now() / 1000);
  const start = now - minutesBack * 60;
  try {
    const { data } = await axiosInstance.get(`https://contract.mexc.com/api/v1/contract/kline/${symbol}`, {
      params: { interval: 'Min1', start, end: now },
    });
    if (!data?.success || !data?.data?.time?.length) return [];
    const { time, open, high, low, close, vol } = data.data;
    const rows = time.map((t, i) => ({
      time: t * 1000,
      open: +open[i],
      high: +high[i],
      low: +low[i],
      close: +close[i],
      volume: +vol[i],
    }));
    return rows.sort((a, b) => a.time - b.time);
  } catch (e) {
    console.warn('fetchMexc1mKlines error', symbol, e.message);
    return [];
  }
}

/* ============== CHUYỂN KHUNG THỜI GIAN ============== */
function tfSpec(tf) {
  const specs = { '3m': 3, '5m': 5, '10m': 10, '30m': 30, '1h': 60, '1d': 1440 };
  return { minutes: specs[tf] || 3 };
}
function aggregate(candles1m, tf) {
  const { minutes } = tfSpec(tf);
  if (!candles1m.length) return [];
  const out = [];
  let bucket = null;
  for (const c of candles1m) {
    const bucketStart = Math.floor(c.time / 60000 / minutes) * minutes * 60000; // ms
    if (!bucket || bucket.time !== bucketStart) {
      if (bucket) out.push(bucket);
      bucket = {
        time: bucketStart,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      };
    } else {
      bucket.high = Math.max(bucket.high, c.high);
      bucket.low = Math.min(bucket.low, c.low);
      bucket.close = c.close;
      bucket.volume += c.volume;
    }
  }
  if (bucket) out.push(bucket);
  return out;
}

/* ============== CHỈ BÁO & VÙNG S/R ============== */
function rsi(candles, period = 14) {
  if (candles.length < period + 1) return [];
  const closes = candles.map(c => c.close);
  const out = Array(closes.length).fill(null);
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  out[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));
  }
  return out;
}
function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    trs.push(tr);
  }
  let out = trs[0];
  const alpha = 1 / period;
  for (let i = 1; i < trs.length; i++) out = alpha * trs[i] + (1 - alpha) * out;
  return out;
}
// pivot-based SR zones từ khung lớn hơn (conservative), với merge
function detectSR(candles, left = 5, right = 5) {
  const zones = []; // {type: 'res'|'sup', price}
  for (let i = left; i < candles.length - right; i++) {
    const c = candles[i];
    let isHigh = true, isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (candles[j].high > c.high) isHigh = false;
      if (candles[j].low < c.low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) zones.push({ type: 'res', price: c.high });
    if (isLow) zones.push({ type: 'sup', price: c.low });
  }
  // gộp các đỉnh/đáy gần nhau (cluster)
  zones.sort((a, b) => a.price - b.price);
  const merged = [];
  const mergeDist = (candles[candles.length - 1].close) * 0.002; // 0.2%
  for (const z of zones) {
    if (!merged.length) { merged.push({ ...z }); continue; }
    const last = merged[merged.length - 1];
    if (Math.abs(last.price - z.price) <= mergeDist && last.type === z.type) {
      last.price = (last.price + z.price) / 2;
    } else {
      merged.push({ ...z });
    }
  }
  return merged;
}
// nến đảo chiều cơ bản: pinbar/engulfing tại vùng
function isBearishReversal(c, p) {
  if (!p) return false;
  const body = Math.abs(c.close - c.open);
  const upper = c.high - Math.max(c.open, c.close);
  const lower = Math.min(c.open, c.close) - c.low;
  const total = c.high - c.low || 1e-9;
  const shootingStar = upper > body * 2 && body / total < 0.5 && c.close < c.open;
  const bearishEngulf = p.close > p.open && c.close < c.open && c.open >= p.close && c.close <= p.open;
  return shootingStar || bearishEngulf;
}
function isBullishReversal(c, p) {
  if (!p) return false;
  const body = Math.abs(c.close - c.open);
  const upper = c.high - Math.max(c.open, c.close);
  const lower = Math.min(c.open, c.close) - c.low;
  const total = c.high - c.low || 1e-9;
  const hammer = lower > body * 2 && body / total < 0.5 && c.close > c.open;
  const bullishEngulf = p.close < p.open && c.close > c.open && c.open <= p.close && c.close >= p.open;
  return hammer || bullishEngulf;
}

/* ============== LOGIC VÀO LỆNH ============== */
function evaluateSignal(tfCandles, tf, direction, zones) {
  if (tfCandles.length < Math.max(RSI_PERIOD + 5, 25)) return { ok: false, reason: 'not-enough-candles' };

  const current = tfCandles[tfCandles.length - 1];
  const prev = tfCandles[tfCandles.length - 2];
  const tfAtr = atr(tfCandles.slice(-100));
  if (!tfAtr) return { ok: false, reason: 'no-atr' };

  const tolerance = tfAtr * SR_TOUCH_ATR_MULT;
  const nearRes = zones
    .filter(z => z.type === 'res')
    .some(z => Math.abs(current.high - z.price) <= tolerance || Math.abs(current.close - z.price) <= tolerance);
  const nearSup = zones
    .filter(z => z.type === 'sup')
    .some(z => Math.abs(current.low - z.price) <= tolerance || Math.abs(current.close - z.price) <= tolerance);

  const rsiArr = USE_RSI ? rsi(tfCandles, RSI_PERIOD) : [];
  const currRSI = USE_RSI ? (rsiArr[rsiArr.length - 1] ?? 50) : 50;

  const volAvg = USE_VOL
    ? tfCandles.slice(-20, -1).reduce((s, c) => s + c.volume, 0) / 19
    : 0;
  const volOK = USE_VOL ? current.volume > volAvg * 1.3 : true;

  const revBear = USE_REVERSE_CANDLE ? isBearishReversal(current, prev) : true;
  const revBull = USE_REVERSE_CANDLE ? isBullishReversal(current, prev) : true;

  let score = 0;
  if (direction === 'DOWN') {
    if (nearRes) score++;
    if (USE_RSI && currRSI >= RSI_OVERBOUGHT) score++;
    if (volOK) score++;
    if (revBear) score++;
  } else {
    if (nearSup) score++;
    if (USE_RSI && currRSI <= RSI_OVERSOLD) score++;
    if (volOK) score++;
    if (revBull) score++;
  }

  return { ok: score >= MIN_CONFLUENCE_SCORE, score, currRSI, volOK, tolerance, tfAtr };
}

/* ============== LỆNH & PNL ============== */
let tradeSeq = 1;

function stakeSize() {
  const riskStake = Math.max(MIN_STAKE, Math.round(balance * RISK_PER_TRADE * 100) / 100);
  return Math.min(riskStake, balance);
}
function canTrade(symbol, tf) {
  const key = `${symbol}_${tf}`;
  const last = lastTradeTime.get(key) || 0;
  if (Date.now() - last < COOLDOWN_MINUTES * 60 * 1000) return false;
  if (tradesToday >= MAX_TRADES_PER_DAY) return false;
  return true;
}
function openPrediction(symbol, tf, direction, price, minutes) {
  const stake = stakeSize();
  if (stake < MIN_STAKE || stake > balance) return null;

  const id = `T${String(tradeSeq++).padStart(6, '0')}`;
  const now = Date.now();
  const expireTime = now + minutes * 60 * 1000;

  balance = Math.round((balance - stake) * 100) / 100;
  tradesToday++;

  const t = { id, symbol, tf, direction, entryPrice: price, stake, openTime: now, expireTime };
  openTrades.push(t);
  lastTradeTime.set(`${symbol}_${tf}`, now);
  return t;
}
function settleTrade(trade, exitPrice) {
  const payout = PAYOUT[trade.tf] ?? 0.75;
  const won = (trade.direction === 'UP')
    ? (exitPrice > trade.entryPrice)
    : (exitPrice < trade.entryPrice);

  // Fix: gain = stake + (stake * payout) nếu WIN (stake gốc + profit)
  const gain = won ? trade.stake + (trade.stake * payout) : 0;
  const pnl = Math.round((gain - trade.stake) * 100) / 100;  // Net profit = stake * payout nếu WIN

  balance = Math.round((balance + gain) * 100) / 100;  // Cộng full gain (stake + profit)

  const rec = {
    id: trade.id,
    symbol: trade.symbol,
    tf: trade.tf,
    direction: trade.direction,
    entryPrice: trade.entryPrice,
    exitPrice,
    stake: trade.stake,
    pnl,
    outcome: won ? 'WIN' : 'LOSE',
    openTime: trade.openTime,
    closeTime: trade.expireTime,
  };
  history.push(rec);
  return rec;
}

/* ============== THÔNG BÁO TELEGRAM (HTML SAFE) ============== */
function escapeHtml(text = '') {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
async function tgSend(text, extra = {}) {
  try {
    await bot.sendMessage(TELEGRAM_CHAT_ID, text, { parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
  } catch (e) {
    console.warn('Telegram send fail', e.message);
  }
}
function fmtMoney(n) { return (n >= 0 ? '+' : '') + '$' + n.toFixed(2); }
function fmtTime(ts) { return new Date(ts).toLocaleString('en-GB', { hour12: false }); }

/* ============== VÒNG LẶP CHÍNH ============== */
async function mainLoop() {
  try {
    // reset theo ngày (UTC+7)
    const nowKey = getDayKey();
    if (nowKey !== dayKey) {
      dayKey = nowKey;
      tradesToday = 0;
      await tgSend(
        `📅 Reset phiên <b>${escapeHtml(dayKey)}</b> — Balance: <b>$${balance.toFixed(2)}</b> | Lịch sử hôm qua: ${history.length} lệnh`
      );
    }

    // lấy 1m candles cho từng symbol một lần
    const all1m = {};
    await Promise.all(SYMBOLS.map(async sym => {
      all1m[sym] = await fetchMexc1mKlines(sym, LOOKBACK_MIN);
    }));

    for (const symbol of SYMBOLS) {
      const oneMin = all1m[symbol];
      if (!oneMin?.length) continue;

      // khung lớn để lấy SR (ví dụ 30m)
      const bigTF = aggregate(oneMin, '30m');
      const zones = detectSR(bigTF, 5, 5);

      for (const tf of ACTIVE_TFS) {
        const tfCandles = aggregate(oneMin, tf);
        if (tfCandles.length < 30) continue;

        // đóng lệnh đến hạn ở tf này
        for (let i = openTrades.length - 1; i >= 0; i--) {
          const tr = openTrades[i];
          if (tr.symbol !== symbol || tr.tf !== tf) continue;
          if (Date.now() >= tr.expireTime) {
            // tìm close của candle tf có time >= expireTime
            const after = tfCandles.find(c => c.time >= tr.expireTime);
            const exitPrice = after ? after.close : tfCandles[tfCandles.length - 1].close;
            const rec = settleTrade(tr, exitPrice);
            openTrades.splice(i, 1);
            await tgSend(
              `✅ <b>ĐÓNG LỆNH</b> ${escapeHtml(rec.id)} ${escapeHtml(rec.symbol)} ${escapeHtml(rec.tf)}\n` +
              `KQ: <b>${escapeHtml(rec.outcome)}</b> ${fmtMoney(rec.pnl)} | Balance: <b>$${balance.toFixed(2)}</b>\n` +
              `Entry: <b>${rec.entryPrice.toFixed(6)}</b> → Exit: <b>${rec.exitPrice.toFixed(6)}</b>\n` +
              `Stake: $${rec.stake.toFixed(2)} | Open: ${fmtTime(rec.openTime)} | Close: ${fmtTime(rec.closeTime)}`
            );
          }
        }

        // nếu hết slot ngày hoặc đang cooldown thì bỏ qua
        if (tradesToday >= MAX_TRADES_PER_DAY) continue;
        if (!canTrade(symbol, tf)) continue;

        // tạo 2 hướng kiểm tra
        const longSig = evaluateSignal(tfCandles, tf, 'UP', zones);
        const shortSig = evaluateSignal(tfCandles, tf, 'DOWN', zones);

        const price = tfCandles[tfCandles.length - 1].close;
        const minutes = tfSpec(tf).minutes;

        // Ưu tiên tín hiệu có score cao hơn, và chỉ lấy 1 lệnh/tf/symbol/đợt
        const candidates = [];
        if (longSig.ok) candidates.push({ dir: 'UP', score: longSig.score, note: longSig });
        if (shortSig.ok) candidates.push({ dir: 'DOWN', score: shortSig.score, note: shortSig });
        candidates.sort((a, b) => b.score - a.score);

        if (candidates.length) {
          const best = candidates[0];
          const trade = openPrediction(symbol, tf, best.dir, price, minutes);
          if (trade) {
            const rsiTxt = USE_RSI ? `RSI=${(best.note.currRSI ?? 0).toFixed(1)}` : '';
            const volTxt = USE_VOL ? (best.note.volOK ? 'Vol>MA ✅' : 'Vol~MA') : '';
            await tgSend(
              `🎯 <b>MỞ LỆNH</b> ${escapeHtml(trade.id)} <a href="https://mexc.com/futures/${escapeHtml(symbol)}?type=swap">${escapeHtml(symbol)}</a> (${escapeHtml(tf)})\n` +
              `Hướng: <b>${escapeHtml(trade.direction)}</b> | Entry: <b>${trade.entryPrice.toFixed(6)}</b> | Stake: <b>$${trade.stake.toFixed(2)}</b>\n` +
              `Điểm hợp lưu: <b>${best.score}</b> (min ${MIN_CONFLUENCE_SCORE}) ${rsiTxt ? '| ' + escapeHtml(rsiTxt) : ''} ${volTxt ? '| ' + escapeHtml(volTxt) : ''}\n` +
              `T/gian: <b>${minutes}</b> phút | Hết hạn: ${fmtTime(trade.expireTime)}\n` +
              `Payout: <b>${Math.round((PAYOUT[tf] ?? 0.75) * 100)}%</b> | Balance sau đặt: <b>$${balance.toFixed(2)}</b>\n` +
              `📌 Vùng tham chiếu: ${zones.length} SR (khung 30m) | Cooldown: ${COOLDOWN_MINUTES}m`
            );
          }
        }
      }
    }
  } catch (e) {
    console.error('mainLoop error', e);
  }
}

/* ============== KHỞI CHẠY ============== */
(async () => {
  await tgSend(
    `🚀 <b>MEXC Prediction GPT Bot</b> 24/7 khởi động\n` +
    `Vốn giả: <b>$${balance.toFixed(2)}</b> | Symbols: ${SYMBOLS.join(', ')}\n` +
    `TF: ${ACTIVE_TFS.join(', ')} | Payout: ${Object.entries(PAYOUT).map(([k,v])=>`${escapeHtml(k)}:${Math.round(v*100)}%`).join(' ')}\n` +
    `Giới hạn: <b>${MAX_TRADES_PER_DAY}</b> lệnh/ngày | Min stake: <b>$${MIN_STAKE.toFixed(2)}</b> | Rủi ro: <b>${Math.round(RISK_PER_TRADE*100)}%</b>\n` +
    `Múi giờ: Asia/Bangkok (UTC+7)`
  );

  setInterval(mainLoop, POLL_MS);
  await mainLoop();
})();