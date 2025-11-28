// src/account.js
import { CONFIG } from './config.js';
import { sendMessageWithAutoDelete } from './telegram.js';

export const accountState = {
  walletBalance: CONFIG.ACCOUNT_BALANCE_START,
  equity: CONFIG.ACCOUNT_BALANCE_START,
  baseCapital: CONFIG.ACCOUNT_BASE_CAPITAL,
  realizedPnl: 0,
};

export const positions = new Map();

// ---------- Helper ----------
function usd(v) {
  if (!isFinite(v)) return "0.00";
  if (Math.abs(v) >= 1) return v.toFixed(2);
  if (Math.abs(v) >= 0.01) return v.toFixed(4);
  return v.toFixed(6);
}
function pct(v) {
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

// ---------- Equity ----------
export function recomputeEquity() {
  let unrealized = 0;
  for (const pos of positions.values()) unrealized += pos.pnl || 0;
  accountState.equity = accountState.walletBalance + unrealized;
}

// ---------- Notify ----------
export async function notifyPositionEvent(title, symbol, body) {
  const msg =
    `${title}: [${symbol}](https://mexc.co/futures/${symbol}?type=swap)\n` +
    body.join('\n') +
    `\n\nBalance: $${usd(accountState.walletBalance)} | Equity: $${usd(accountState.equity)}` +
    `\nLãi đã rút : $159 - Lỗ: 0`+
    `\nOpen positions: ${positions.size}`;
  await sendMessageWithAutoDelete(msg, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  });
}

// ---------- ROI SHORT ----------
function calcShortRoi(entry, price) {
  return ((entry - price) / entry) * CONFIG.LEVERAGE * 100;
}

// =========================================================
//            UPDATE POSITION — MẸ CỦA CHIẾN LƯỢC
// =========================================================
export async function updatePositionWithPrice(symbol, price, ma10) {
  const pos = positions.get(symbol);
  if (!pos) return;

  // --- Update basic ROI ---
  pos.lastPrice = price;
  pos.roi = calcShortRoi(pos.entryPrice, price);
  pos.pnl = pos.margin * (pos.roi / 100);

  if (pos.maxRoi === null || pos.roi > pos.maxRoi) pos.maxRoi = pos.roi;

  recomputeEquity();

  // --- Loss ratio for HODL ---
  const unrealizedLoss = pos.pnl < 0 ? -pos.pnl : 0;
  const lossRatio = unrealizedLoss / accountState.walletBalance;

  // =========================================================
  //              1) HODL MODE WHEN LOSS TOO HIGH
  // =========================================================
  if (!pos.inHodlMode && lossRatio >= CONFIG.MAX_LOSS_RATIO_FOR_HODL) {
    pos.inHodlMode = true;
    await notifyPositionEvent("🛡 BẮT ĐẦU GỒNG LỖ", symbol, [
      `• ROI hiện tại: ${pct(pos.roi)} (P/L: $${usd(pos.pnl)})`,
      `• Lỗ ${(lossRatio * 100).toFixed(2)}% tài khoản`,
      `• Dừng DCA – chỉ chờ hồi để chốt.`,
    ]);
  }

  // =========================================================
  //              2) DCA (MULTIPLIER x2)
  // =========================================================
if (!pos.inHodlMode && pos.dcaIndex < CONFIG.DCA_PLAN.length) {
  const plan = CONFIG.DCA_PLAN[pos.dcaIndex];

  if (pos.roi <= plan.roiTrigger) {

    const oldEntry = pos.entryPrice;        // Entry cũ
    const dcaPrice = price;                 // Giá DCA lần này

    const addQty = pos.quantity * CONFIG.DCA_MULTIPLIER;
    const addNotional = addQty * price;
    const addMargin = addNotional / CONFIG.LEVERAGE;

    // Recalculate entry price (WAP)
    const costOld = pos.entryPrice * pos.quantity;
    const costAdd = price * addQty;

    const newQty = pos.quantity + addQty;
    const newEntry = (costOld + costAdd) / newQty;

    // Apply to position
    pos.entryPrice = newEntry;
    pos.quantity = newQty;
    pos.margin += addMargin;
    pos.notional += addNotional;

    pos.dcaIndex++;

    // Recompute ROI / PNL
    pos.roi = calcShortRoi(pos.entryPrice, price);
    pos.pnl = pos.margin * (pos.roi / 100);

    recomputeEquity();

    await notifyPositionEvent("➕ DCA", symbol, [
      `• DCA cấp số nhân: x${CONFIG.DCA_MULTIPLIER}`,
      `• Entry cũ: $${usd(oldEntry)}`,
      `• Giá DCA: $${usd(dcaPrice)}`,
      `• Entry mới: $${usd(newEntry)}`,           
      `• P/L hiện tại: $${usd(pos.pnl)} (${pct(pos.roi)})`,  
      `• Margin thêm: $${usd(addMargin)}`,
      `• DCA Level ${pos.dcaIndex}/${CONFIG.DCA_PLAN.length}`,
    ]);
  }
}

  // =========================================================
  //      3) PARTIAL CUT — WHEN EQUITY < 25% VỐN CƠ SỞ
  // =========================================================
  const cutThreshold = accountState.baseCapital * CONFIG.EQUITY_CUT_RATIO;

  if (accountState.equity < cutThreshold && pos.cutCount < CONFIG.MAX_PARTIAL_CUTS) {
    const portion = CONFIG.PARTIAL_CUT_PERCENT;

    const closePartPnl = pos.pnl * portion;

    pos.quantity *= (1 - portion);
    pos.margin *= (1 - portion);
    pos.notional *= (1 - portion);
    pos.pnl *= (1 - portion);

    pos.cutCount++;

    accountState.walletBalance += closePartPnl;
    accountState.realizedPnl += closePartPnl;

    recomputeEquity();

    await notifyPositionEvent("✂️ PARTIAL STOP LOSS", symbol, [
      `• Cắt ${portion * 100}% vị thế`,
      `• Đã chốt: $${usd(closePartPnl)} ở ROI ${pct(pos.roi)}`,
      `• Cắt lần ${pos.cutCount}/${CONFIG.MAX_PARTIAL_CUTS}`,
    ]);
  }

  // =========================================================
  //           4) TRAILING STOP ROI + MA10 (bản CŨ)
  // =========================================================
  const enoughProfit = pos.roi >= CONFIG.MIN_PROFIT_ROI_FOR_TRAIL;
  const droppedFromMax = pos.maxRoi - pos.roi >= CONFIG.TRAIL_DROP_FROM_MAX_ROI;
  const priceCrossUpMA10 = ma10 && price > ma10;

  if (enoughProfit && (droppedFromMax || priceCrossUpMA10)) {
    const closePnl = pos.pnl || 0;

    accountState.walletBalance += closePnl;
    accountState.realizedPnl += closePnl;
    positions.delete(symbol);
    recomputeEquity();

    await notifyPositionEvent("✅ TAKE PROFIT", symbol, [
      `• ROI chốt: ${pct(pos.roi)} (P/L $${usd(closePnl)})`,
      `• Max ROI trước đó: ${pct(pos.maxRoi)}`,
      priceCrossUpMA10
        ? "• Giá chạm/cắt MA10 → Trend đảo"
        : "• Trailing Stop theo ROI",
    ]);
  }
}

// =========================================================
//               OPEN SHORT POSITION
// =========================================================
export async function openShortPosition(symbol, price, context) {
  if (positions.size >= CONFIG.MAX_OPEN_POSITIONS) {
    await notifyPositionEvent("⚠️ FULL VỊ THẾ", symbol, [
      `• Đã đủ ${CONFIG.MAX_OPEN_POSITIONS} lệnh.`,
      `• KHÔNG mở thêm lệnh.`,
      `• Entry tham chiếu: $${usd(price)}`,
      `• Lý do tín hiệu: ${context}`,
    ]);
    return;
  }

  if (positions.has(symbol)) return;

  const margin = accountState.walletBalance * CONFIG.ENTRY_PERCENT;
  const notional = margin * CONFIG.LEVERAGE;
  const qty = notional / price;

  const pos = {
    symbol,
    side: "short",
    entryPrice: price,
    quantity: qty,
    notional,
    margin,
    leverage: CONFIG.LEVERAGE,

    roi: 0,
    pnl: 0,
    maxRoi: null,

    dcaIndex: 0,
    cutCount: 0,
    inHodlMode: false,
  };

  positions.set(symbol, pos);
  recomputeEquity();

  await notifyPositionEvent("🚀 OPEN SHORT", symbol, [
    `• Entry: $${usd(price)}`,
    `• Margin: $${usd(margin)}`,
    `• Notional: $${usd(notional)}`,
    `• Qty: ${usd(qty)}`,
    `• Lý do: ${context}`,
  ]);
}
