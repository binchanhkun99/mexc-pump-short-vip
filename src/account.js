// src/account.js - ĐÃ TÍCH HỢP API THẬT
import { CONFIG } from './config.js';
import { sendMessageWithAutoDelete } from './telegram.js';
import { 
  getCurrentPrice,
  openPosition as apiOpenPosition,
  closePosition as apiClosePosition,
  getPosition as apiGetPosition,
  getFuturesBalance,
  checkAndTransferBalance,
  getContractInfo,
  roundVolume
} from './mexc-api.js';

export const accountState = {
  walletBalance: 0, // Sẽ lấy từ API thật
  equity: 0,
  baseCapital: CONFIG.ACCOUNT_BASE_CAPITAL,
  realizedPnl: 0,
};

export const positions = new Map();

// Khởi tạo balance từ API
export async function initializeAccount() {
  try {
    const balance = await getFuturesBalance();
    accountState.walletBalance = balance;
    accountState.equity = balance;
    console.log(`💰 Balance thực tế: $${balance}`);
  } catch (error) {
    console.error('❌ Lỗi khởi tạo account:', error);
  }
}

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

// Lấy position thực tế từ API
async function syncPositionFromAPI(symbol) {
  try {
    const apiPos = await apiGetPosition(symbol);
    if (!apiPos) return null;

    return {
      symbol: apiPos.symbol,
      side: apiPos.side,
      entryPrice: apiPos.entryPrice,
      quantity: apiPos.quantity,
      notional: apiPos.notional,
      margin: apiPos.margin,
      leverage: CONFIG.LEVERAGE,
      roi: apiPos.roi,
      pnl: apiPos.pnl,
      lastPrice: apiPos.lastPrice,
      maxRoi: apiPos.roi > 0 ? apiPos.roi : null,
      dcaIndex: 0,
      cutCount: 0,
      inHodlMode: false,
      initialMargin: apiPos.margin
    };
  } catch (error) {
    console.error(`❌ Lỗi sync position ${symbol}:`, error);
    return null;
  }
}

// =========================================================
//            UPDATE POSITION — API THẬT
// =========================================================
export async function updatePositionWithPrice(symbol, price, ma10) {
  // Sync position thực tế từ API
  const apiPos = await syncPositionFromAPI(symbol);
  if (!apiPos) {
    // Position đã đóng trên API nhưng vẫn trong memory -> xóa
    if (positions.has(symbol)) {
      const removedPos = positions.get(symbol);
      console.log(`🗑️ Position ${symbol} đã đóng trên API, xóa khỏi memory`);
      positions.delete(symbol);
    }
    return;
  }

  // Cập nhật từ API data
  let pos = positions.get(symbol);
  if (!pos) {
    // Position mới từ API (có thể đã mở từ trước)
    positions.set(symbol, apiPos);
    pos = apiPos;
    console.log(`🔄 Đã sync position ${symbol} từ API`);
  } else {
    // Cập nhật data thực tế
    Object.assign(pos, {
      entryPrice: apiPos.entryPrice,
      quantity: apiPos.quantity,
      margin: apiPos.margin,
      notional: apiPos.notional,
      pnl: apiPos.pnl,
      lastPrice: apiPos.lastPrice,
      roi: apiPos.roi
    });
  }

  // Cập nhật max ROI
  if (pos.maxRoi === null || pos.roi > pos.maxRoi) {
    pos.maxRoi = pos.roi;
  }

  recomputeEquity();

  // --- Loss ratio for HODL ---
  const unrealizedLoss = pos.pnl < 0 ? -pos.pnl : 0;
  const lossRatio = unrealizedLoss / Math.max(accountState.walletBalance, 1);

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
  //              2) DCA (MULTIPLIER x2) - API THẬT
  // =========================================================
  if (!pos.inHodlMode && pos.dcaIndex < CONFIG.DCA_PLAN.length) {
    const plan = CONFIG.DCA_PLAN[pos.dcaIndex];

    if (pos.roi <= plan.roiTrigger) {
      if (!pos.initialMargin) pos.initialMargin = pos.margin;

      const addMargin = pos.initialMargin * (2 ** pos.dcaIndex);

      // Check balance thực tế
      await checkAndTransferBalance();
      const currentBalance = await getFuturesBalance();
      if (currentBalance < addMargin) {
        console.log(`⚠️ Không đủ balance cho DCA ${symbol}: ${currentBalance} < ${addMargin}`);
        return;
      }

      const addNotional = addMargin * CONFIG.LEVERAGE;
      
      // Lấy contract info để tính quantity chính xác
      const contractInfo = await getContractInfo(symbol);
      const addQty = roundVolume(addNotional / price, contractInfo.volumePrecision, contractInfo.quantityUnit);

      if (addQty <= 0) {
        console.log(`⚠️ Quantity DCA quá nhỏ: ${addQty}`);
        return;
      }

      // Mở position DCA thực tế
      const dcaResult = await apiOpenPosition(symbol, addQty, 'SHORT', `DCA_${pos.dcaIndex + 1}`);
      
      if (dcaResult.success) {
        // Cập nhật local position data (weighted average)
        const oldEntry = pos.entryPrice;
        const costOld = pos.entryPrice * pos.quantity;
        const costAdd = price * addQty;

        const newQty = pos.quantity + addQty;
        const newEntry = (costOld + costAdd) / newQty;

        pos.entryPrice = newEntry;
        pos.quantity = newQty;
        pos.margin += addMargin;
        pos.notional += addNotional;
        pos.dcaIndex++;

        // Cập nhật balance
        accountState.walletBalance -= addMargin;
        recomputeEquity();

        await notifyPositionEvent("➕ DCA", symbol, [
          `• DCA cấp số nhân: x${2 ** (pos.dcaIndex - 1)}`,
          `• Entry cũ: $${usd(oldEntry)}`,
          `• Giá DCA: $${usd(price)}`,
          `• Entry mới: $${usd(newEntry)}`,
          `• P/L hiện tại: $${usd(pos.pnl)} (${pct(pos.roi)})`,
          `• Margin thêm: $${usd(addMargin)}`,
          `• DCA Level ${pos.dcaIndex}/${CONFIG.DCA_PLAN.length}`,
        ]);
      } else {
        console.log(`❌ DCA ${symbol} thất bại:`, dcaResult.error);
      }
    }
  }

  // =========================================================
  //      3) PARTIAL CUT — API THẬT
  // =========================================================
  const cutThreshold = accountState.baseCapital * CONFIG.EQUITY_CUT_RATIO;

  if (accountState.equity < cutThreshold && pos.cutCount < CONFIG.MAX_PARTIAL_CUTS) {
    const portion = CONFIG.PARTIAL_CUT_PERCENT;
    const closeQty = pos.quantity * portion;

    // Close partial thực tế
    const closeResult = await apiClosePosition(symbol, closeQty, 'SHORT');
    
    if (closeResult.success) {
      const closePartPnl = closeResult.pnl;

      // Cập nhật local position
      pos.quantity *= (1 - portion);
      pos.margin *= (1 - portion);
      pos.notional *= (1 - portion);
      pos.pnl *= (1 - portion);
      pos.cutCount++;

      // Cập nhật balance
      accountState.walletBalance += closePartPnl;
      accountState.realizedPnl += closePartPnl;
      recomputeEquity();

      await notifyPositionEvent("✂️ PARTIAL STOP LOSS", symbol, [
        `• Cắt ${(portion * 100).toFixed(1)}% vị thế`,
        `• Đã chốt: $${usd(closePartPnl)} ở ROI ${pct(pos.roi)}`,
        `• Cắt lần ${pos.cutCount}/${CONFIG.MAX_PARTIAL_CUTS}`,
        `• Equity: $${usd(accountState.equity)} < $${usd(cutThreshold)}`,
      ]);
    } else {
      console.log(`❌ Partial cut ${symbol} thất bại:`, closeResult.error);
    }
  }

  // =========================================================
  //           4) TAKE PROFIT - API THẬT
  // =========================================================
  const enoughProfit = pos.roi >= CONFIG.MIN_PROFIT_ROI_FOR_TRAIL;
  const droppedFromMax = pos.maxRoi !== null && (pos.maxRoi - pos.roi) >= CONFIG.TRAIL_DROP_FROM_MAX_ROI;
  const priceCrossUpMA10 = ma10 && price > ma10;

  if (enoughProfit && (droppedFromMax || priceCrossUpMA10)) {
    // Close toàn bộ position thực tế
    const closeResult = await apiClosePosition(symbol, pos.quantity, 'SHORT');
    
    if (closeResult.success) {
      const closePnl = closeResult.pnl;

      // Cập nhật account
      accountState.walletBalance += closePnl;
      accountState.realizedPnl += closePnl;
      positions.delete(symbol);
      recomputeEquity();

      const reason = priceCrossUpMA10 ? "Giá chạm/cắt MA10 → Trend đảo" : "Trailing Stop theo ROI";
      
      await notifyPositionEvent("✅ TAKE PROFIT", symbol, [
        `• ROI chốt: ${pct(pos.roi)} (P/L $${usd(closePnl)})`,
        `• Max ROI trước đó: ${pct(pos.maxRoi)}`,
        `• ${reason}`,
      ]);
    } else {
      console.log(`❌ Take profit ${symbol} thất bại:`, closeResult.error);
    }
  }
}

// =========================================================
//               OPEN SHORT POSITION - API THẬT
// =========================================================
export async function openShortPosition(symbol, price, context) {
  // Check balance trước khi mở lệnh
  await checkAndTransferBalance();
  const currentBalance = await getFuturesBalance();
  
  if (positions.size >= CONFIG.MAX_OPEN_POSITIONS) {
    await notifyPositionEvent("⚠️ FULL VỊ THẾ", symbol, [
      `• Đã đủ ${CONFIG.MAX_OPEN_POSITIONS} lệnh.`,
      `• KHÔNG mở thêm lệnh.`,
      `• Entry tham chiếu: $${usd(price)}`,
      `• Lý do tín hiệu: ${context}`,
    ]);
    return;
  }

  if (positions.has(symbol)) {
    console.log(`⚠️ Đã có position ${symbol}, bỏ qua`);
    return;
  }

  const margin = currentBalance * CONFIG.ENTRY_PERCENT;
  const notional = margin * CONFIG.LEVERAGE;
  
  // Lấy contract info để tính quantity chính xác
  const contractInfo = await getContractInfo(symbol);
  const qty = roundVolume(notional / price, contractInfo.volumePrecision, contractInfo.quantityUnit);

  if (qty <= 0) {
    await notifyPositionEvent("❌ LỖI SỐ LƯỢNG", symbol, [
      `• Quantity tính được = ${qty}`,
      `• Không thể mở lệnh.`,
      `• Context: ${context}`,
    ]);
    return;
  }

  // Mở lệnh thực tế
  const openResult = await apiOpenPosition(symbol, qty, 'SHORT', context);
  
  if (!openResult.success) {
    await notifyPositionEvent("❌ LỖI MỞ LỆNH", symbol, [
      `• Không thể mở lệnh SHORT`,
      `• Lỗi: ${openResult.error}`,
      `• Context: ${context}`,
    ]);
    return;
  }

  // Tạo position local
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
    initialMargin: margin
  };

  positions.set(symbol, pos);
  accountState.walletBalance -= margin;
  recomputeEquity();

  await notifyPositionEvent("🚀 OPEN SHORT", symbol, [
    `• Entry: $${usd(price)}`,
    `• Margin: $${usd(margin)}`,
    `• Notional: $${usd(notional)}`,
    `• Qty: ${usd(qty)}`,
    `• Order ID: ${openResult.orderId}`,
    `• Position ID: ${openResult.positionId || 'N/A'}`,
    `• Lý do: ${context}`,
  ]);
}

// Sync tất cả positions từ API khi khởi động
export async function syncAllPositionsFromAPI() {
  try {
    console.log('🔄 Syncing positions từ API...');
    
    // Lấy tất cả positions từ API
    const { getOpenPositions } = await import('./mexc-api.js');
    const apiPositions = await getOpenPositions();
    
    // Clear positions cũ
    positions.clear();
    
    // Thêm các positions đang mở
    for (const apiPos of apiPositions) {
      if (parseFloat(apiPos.holdVol || 0) !== 0) {
        const symbol = apiPos.symbol;
        const price = await getCurrentPrice(symbol);
        
        const pos = {
          symbol,
          side: apiPos.positionType === 2 ? "short" : "long",
          entryPrice: parseFloat(apiPos.openAvgPrice || 0),
          quantity: Math.abs(parseFloat(apiPos.holdVol || 0)),
          notional: Math.abs(parseFloat(apiPos.holdVol || 0)) * price,
          margin: parseFloat(apiPos.im || 0),
          leverage: CONFIG.LEVERAGE,
          roi: 0,
          pnl: parseFloat(apiPos.unrealised || 0),
          lastPrice: price,
          maxRoi: null,
          dcaIndex: 0,
          cutCount: 0,
          inHodlMode: false,
          initialMargin: parseFloat(apiPos.im || 0)
        };
        
        // Tính ROI
        pos.roi = calcShortRoi(pos.entryPrice, price);
        if (pos.roi > 0) pos.maxRoi = pos.roi;
        
        positions.set(symbol, pos);
        console.log(`✅ Đã sync position: ${symbol}, Qty: ${pos.quantity}, PnL: $${pos.pnl}`);
      }
    }
    
    console.log(`✅ Đã sync ${positions.size} positions từ API`);
    recomputeEquity();
    
  } catch (error) {
    console.error('❌ Lỗi sync positions:', error);
  }
}

// Utility function để log trạng thái positions
export function logPositionsStatus() {
  console.log(`\n📊 POSITIONS STATUS (${positions.size} positions):`);
  for (const [symbol, pos] of positions.entries()) {
    console.log(`   ${symbol}: ${pos.side} | Qty: ${pos.quantity} | Entry: $${pos.entryPrice} | PnL: $${pos.pnl} | ROI: ${pct(pos.roi)}`);
  }
  console.log(`   Wallet: $${usd(accountState.walletBalance)} | Equity: $${usd(accountState.equity)}\n`);
}