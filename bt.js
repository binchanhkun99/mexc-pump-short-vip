// bt_mexc_15m.js
// Backtest fake-pump short theo khung 15 phút (Futures MEXC)

import axios from "axios";

// ============== Indicator Functions ==============
function ema(values, period) {
  const k = 2 / (period + 1);
  const out = [];
  let prev = values[0];
  out[0] = prev;
  for (let i = 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function macd(values, fast = 12, slow = 26, signal = 9) {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const macdLine = values.map((_, i) => emaFast[i] - emaSlow[i]);
  const signalLine = ema(macdLine, signal);
  const hist = macdLine.map((v, i) => v - signalLine[i]);
  return { macdLine, signalLine, hist };
}

function rsi(values, period = 14) {
  const rsis = Array(values.length).fill(null);
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = values[i] - values[i - 1];
    if (ch >= 0) gain += ch; else loss -= ch;
  }
  let avgG = gain / period, avgL = loss / period;
  rsis[period] = 100 - 100 / (1 + avgG / (avgL || 1e-12));
  for (let i = period + 1; i < values.length; i++) {
    const ch = values[i] - values[i - 1];
    const g = Math.max(0, ch);
    const l = Math.max(0, -ch);
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
    const rs = avgG / (avgL || 1e-12);
    rsis[i] = 100 - 100 / (1 + rs);
  }
  return rsis;
}

function mean(arr, start, end) {
  if (start > end) return NaN;
  let s = 0, n = 0;
  for (let i = start; i <= end; i++) { s += arr[i]; n++; }
  return n ? s / n : NaN;
}

// ============== Fetch Data from MEXC Futures ==============
async function fetchKlines(symbol, startSec, endSec) {
  const url = `https://contract.mexc.com/api/v1/contract/kline/${symbol}`;
  const res = await axios.get(url, {
    params: { interval: "Min15", start: startSec, end: endSec },
  });
  if (!res.data?.success || !res.data.data) return [];
  const { time, open, high, low, close, vol } = res.data.data;
  return time.map((t, i) => ({
    time: t * 1000,
    open: +open[i],
    high: +high[i],
    low: +low[i],
    close: +close[i],
    volume: +vol[i],
  }));
}

async function fetchRecent15m(symbol = "AIC_USDT", periods = 500) {
  const now = Math.floor(Date.now() / 1000);
  const fifteenMin = 15 * 60;
  const start = now - periods * fifteenMin;
  const candles = await fetchKlines(symbol, start, now);
  return candles.sort((a, b) => a.time - b.time);
}

// ============== Backtest Logic ==============
async function run() {
  const SYMBOL = "AIC_USDT";
  const candles = await fetchRecent15m(SYMBOL, 1500);

  if (candles.length < 210) {
    console.log("Không đủ nến để tính EMA200:", candles.length);
    return;
  }

  const closes = candles.map(c => c.close);
  const ema200 = ema(closes, 200);
  const macd1 = macd(closes, 12, 26, 9);
  const rsi1 = rsi(closes, 14);

  candles.forEach((c, i) => {
    c.ema200 = ema200[i];
    c.macd = macd1.macdLine[i];
    c.signal = macd1.signalLine[i];
    c.hist = macd1.hist[i];
    c.rsi = rsi1[i];
  });

  // --- Config ---
  const cfg = {
    wickRatio: 0.8,    // upper wick / body >= 0.8
    volLookback: 20,
    volMul: 2.0,
    tpPct: 0.04,
    slPct: 0.02,
    timeoutBars: 8     // 8 * 15m = 2 giờ
  };

  const trades = [];
  const volArr = candles.map(c => c.volume);

  for (let i = 2; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    const body = Math.abs(c.close - c.open);
    const upper = c.high - Math.max(c.close, c.open);
    const isGreen = c.close > c.open;
    const longUpper = upper > 0 && body > 0 && (upper / body) >= cfg.wickRatio;

    const volMean = mean(volArr, Math.max(0, i - cfg.volLookback), i - 1);
    const volSpike = c.volume > volMean * cfg.volMul;

    const macdDecreasing = c.hist < p.hist && p.hist < candles[i - 2].hist;
    const trendDown = c.close < c.ema200;

    // tín hiệu fake pump
    const pumpLike = isGreen && longUpper && volSpike && trendDown && c.rsi > 60;
    const confirmDump = !isGreen && macdDecreasing && trendDown && p.rsi > 60;
    const signal = pumpLike || confirmDump;

    if (signal) {
         const utc = new Date(c.time).toISOString();
  const local = new Date(c.time).toLocaleString();
  console.log(`Signal UTC=${utc} | VN=${local} | close=${c.close}`);
      const entryIdx = Math.min(candles.length - 1, i + 1);
      const entry = candles[entryIdx].open;
      const sl = entry * (1 + cfg.slPct);
      const tp = entry * (1 - cfg.tpPct);

      let exitIdx = null, exitPrice = null, reason = "Timeout";
      for (let j = entryIdx; j < Math.min(candles.length, entryIdx + cfg.timeoutBars); j++) {
        const k = candles[j];
        if (k.low <= tp) { exitIdx = j; exitPrice = tp; reason = "TP"; break; }
        if (k.high >= sl) { exitIdx = j; exitPrice = sl; reason = "SL"; break; }
      }
      if (exitIdx == null) {
        exitIdx = Math.min(candles.length - 1, entryIdx + cfg.timeoutBars - 1);
        exitPrice = candles[exitIdx].close;
      }

      const pnl = (entry - exitPrice) / entry;
      trades.push({
        t_signal: new Date(c.time).toLocaleString(),
        entry,
        exit: exitPrice,
        reason,
        pnl,
      });
      i = exitIdx; // tránh lệnh chồng
    }
  }

  const wins = trades.filter(t => t.pnl > 0).length;
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);

  console.log("=== BACKTEST SUMMARY (MEXC Futures 15m) ===");
  console.log("Symbol:", SYMBOL, "| Candles:", candles.length);
  console.log("Trades:", trades.length, "| Wins:", wins, "| PnL:", (totalPnl * 100).toFixed(2) + "%");
  console.table(trades.map(t => ({
    t_signal: t.t_signal,
    entry: +t.entry.toFixed(6),
    exit: +t.exit.toFixed(6),
    reason: t.reason,
    pnlPct: +(t.pnl * 100).toFixed(2),
  })));
}

run().catch(e => console.error(e?.response?.data || e.message));
