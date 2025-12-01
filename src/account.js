// src/account.js - ĐÃ TÍCH HỢP API THẬT
import { CONFIG } from './config.js';
import { sendMessageWithAutoDelete } from './telegram.js';
import { 
  getCurrentPrice,
  openPosition as apiOpenPosition, // Sửa tên để tránh conflict
  closePosition as apiClosePosition,
  getPosition as apiGetPosition,
  getFuturesBalance,
  checkAndTransferBalance,
  getContractInfo,
  roundContracts, // Dùng roundContracts thống nhất
  calculateContracts,
  calculateDCAPositionSize,
  getOpenPositions // Thêm import
} from './mexc-api.js';
import { logTrade, logError, logDebug } from './logger.js';

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

// Lấy position thực tế từ API (cập nhật với data mới từ mexc-api)
async function syncPositionFromAPI(symbol) {
  try {
    const apiPos = await apiGetPosition(symbol);
    if (!apiPos) return null;

    console.log(`🔄 Syncing position ${symbol}:`, apiPos);

    return {
      symbol: apiPos.symbol,
      side: apiPos.side,
      entryPrice: apiPos.entryPrice,
      quantity: apiPos.quantity, // contracts
      coins: apiPos.coins, // mới
      notional: apiPos.notional,
      margin: apiPos.marginUsed, // dùng marginUsed chính xác
      leverage: CONFIG.LEVERAGE,
      roi: apiPos.roi,
      pnl: apiPos.pnl,
      lastPrice: apiPos.lastPrice,
      maxRoi: apiPos.roi > 0 ? apiPos.roi : null,
      dcaIndex: 0,
      cutCount: 0,
      inHodlMode: false,
      initialMargin: apiPos.marginUsed // dùng marginUsed
    };
  } catch (error) {
    console.error(`❌ Lỗi sync position ${symbol}:`, error);
    return null;
  }
}

// =========================================================
//            UPDATE POSITION — API THẬT
// =========================================================
async function checkPositionExists(symbol) {
  try {
    const apiPos = await apiGetPosition(symbol);
    return apiPos !== null;
  } catch (error) {
    console.error(`❌ Lỗi check position ${symbol}:`, error);
    return false;
  }
}

export async function updatePositionWithPrice(symbol, price, ma10) {
  // Sync position thực tế từ API
  const pos = positions.get(symbol);
  if (!pos) return;
  
  const apiPos = await syncPositionFromAPI(symbol);
  if (!apiPos) {
    // Position đã đóng trên API -> xóa khỏi memory
    console.log(`🗑️ Position ${symbol} đã đóng trên API, xóa khỏi memory`);
    positions.delete(symbol);
    recomputeEquity();
    return;
  }

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
      roi: apiPos.roi,
      coins: apiPos.coins // mới
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
  //              2) DCA (MULTIPLIER x2) - API THẬT, SỬA CÔNG THỨC
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

      // SỬA: Dùng calculateDCAPositionSize để tính contracts đúng
      const addQty = await calculateDCAPositionSize(symbol, addMargin / currentBalance); // dcaPercent = addMargin / balance
      if (addQty <= 0) {
        console.log(`⚠️ Quantity DCA quá nhỏ hoặc contractSize=0: ${addQty}`);
        await notifyPositionEvent("❌ DCA THẤT BẠI", symbol, [
          `• addQty=0 (contractSize=0 hoặc rounding error)`,
          `• Không thêm margin: $${usd(addMargin)}`,
        ]);
        return;
      }

      const addNotional = addQty * price * contractInfo.contractSize; // Verify notional sau rounding
      
      // Mở position DCA thực tế (dùng openPosition với contractInfo)
      const contractInfo = await getContractInfo(symbol);
      const dcaResult = await apiOpenPosition(symbol, addQty, 'SHORT', `DCA_${pos.dcaIndex + 1}`, contractInfo);
      
      if (dcaResult.success) {
        // Cập nhật local position data (weighted average)
        const oldEntry = pos.entryPrice;
        const costOld = pos.entryPrice * pos.quantity * contractInfo.contractSize; // coins * price
        const costAdd = price * addQty * contractInfo.contractSize;

        const newQty = pos.quantity + addQty; // contracts
        const newCoins = newQty * contractInfo.contractSize;
        const newEntry = (costOld + costAdd) / newCoins / contractInfo.contractSize; // weighted entry price

        pos.entryPrice = newEntry;
        pos.quantity = newQty;
        pos.margin += addMargin;
        pos.notional += addNotional;
        pos.dcaIndex++;

        // Cập nhật balance
        accountState.walletBalance -= addMargin;
        recomputeEquity();

        // THÊM: Log calculations như test_2
        console.log(`💰 DCA calc for ${symbol}:
  - addMargin: $${addMargin}
  - addNotional: $${addNotional.toFixed(4)}
  - addQty (contracts): ${addQty}
  - Actual add margin: $${(addNotional / CONFIG.LEVERAGE).toFixed(4)}`);

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
        await notifyPositionEvent("❌ DCA THẤT BẠI", symbol, [
          `• Lỗi: ${dcaResult.error}`,
          `• Không thêm margin: $${usd(addMargin)}`,
        ]);
      }
    }
  }

  // Sync lại position sau DCA để margin chính xác
  const updatedPos = await syncPositionFromAPI(symbol);
  if (updatedPos) {
    Object.assign(pos, updatedPos);
    console.log(`🔄 Synced position after DCA: margin=${pos.margin.toFixed(4)}`);
  }

  // =========================================================
  //      3) PARTIAL CUT — API THẬT
  // =========================================================
  const cutThreshold = accountState.baseCapital * CONFIG.PARTIAL_CUT_RATIO;
  if (accountState.equity < cutThreshold && pos.cutCount < CONFIG.MAX_PARTIAL_CUTS) {
    const portion = 0.5; // 50% cut
    const closeQty = await calculatePartialCloseSize(symbol, portion);
    if (closeQty > 0) {
      const closeResult = await apiClosePosition(symbol, closeQty, 'SHORT');
      
      if (closeResult.success) {
        const closePartPnl = closeResult.pnl * portion; // Approx
        pos.quantity -= closeQty;
        pos.margin *= (1 - portion); // Update margin
        pos.cutCount++;
        accountState.walletBalance += closePartPnl;
        accountState.realizedPnl += closePartPnl;
        recomputeEquity();

        // Sync lại sau cut
        const updatedPos = await syncPositionFromAPI(symbol);
        if (updatedPos) Object.assign(pos, updatedPos);

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
//               OPEN SHORT POSITION - API THẬT, SỬA CÔNG THỨC
// =========================================================
export async function openShortPosition(symbol, price, context) {
  try {
    // Check balance trước khi mở lệnh
    await checkAndTransferBalance();
    const currentBalance = await getFuturesBalance();
    logDebug(`Balance for ${symbol}`, { balance: currentBalance });

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
      logDebug(`Đã có position ${symbol}, bỏ qua`);
      return;
    }

    const margin = currentBalance * CONFIG.ENTRY_PERCENT; // Ví dụ: 0.5% = 0.75$
    if (margin <= 0) {
      await notifyPositionEvent("❌ MARGIN=0", symbol, [`• Balance quá thấp: $${currentBalance}`]);
      return;
    }

    const notional = margin * CONFIG.LEVERAGE;
    logDebug(`Calculations for ${symbol}`, {
      balance: currentBalance,
      entryPercent: CONFIG.ENTRY_PERCENT,
      margin: margin,
      leverage: CONFIG.LEVERAGE,
      notional: notional,
      price: price
    });
  
    // SỬA: Lấy contract info & tính contracts đúng
    const contractInfo = await getContractInfo(symbol);
    if (contractInfo.contractSize <= 0) {
      await notifyPositionEvent("❌ CONTRACT_SIZE=0", symbol, [
        `• Không thể mở lệnh (contractSize=0)`,
        `• Context: ${context}`,
      ]);
      return;
    }

    const rawContracts = calculateContracts(margin, CONFIG.LEVERAGE, price, contractInfo.contractSize);
    const qty = roundContracts(rawContracts, contractInfo.volumePrecision, contractInfo.quantityUnit);

    logDebug(`Quantity calculation for ${symbol}`, {
      margin: margin,
      notional: notional,
      price: price,
      contractSize: contractInfo.contractSize,
      rawContracts: rawContracts,
      roundedQuantity: qty, // contracts
      contractInfo: contractInfo
    });

    if (qty <= 0 || qty < contractInfo.minQuantity) {
      await notifyPositionEvent("❌ LỖI SỐ LƯỢNG", symbol, [
        `• Quantity tính được = ${qty} contracts < min=${contractInfo.minQuantity}`,
        `• Không thể mở lệnh (rounding/contractSize error).`,
        `• Context: ${context}`,
      ]);
      return;
    }

    // THÊM: Verify actual margin sau rounding
    const actualCoins = qty * contractInfo.contractSize;
    const actualNotional = actualCoins * price;
    const actualMargin = actualNotional / CONFIG.LEVERAGE;
    const marginDiff = Math.abs(actualMargin - margin);
    logDebug(`Margin verification for ${symbol}`, { actualMargin: actualMargin.toFixed(4), diff: marginDiff.toFixed(4) });

    if (marginDiff > margin * 0.1) { // >10% diff → warn
      console.warn(`⚠️ Margin diff >10%: target=${margin.toFixed(4)}, actual=${actualMargin.toFixed(4)}`);
    }

    logTrade(`Opening position for ${symbol}`, {
      symbol, price, qty, margin, notional, context, actualMargin
    });

    // Mở lệnh thực tế (dùng openPosition với contractInfo)
    const openResult = await apiOpenPosition(symbol, qty, 'SHORT', context, contractInfo);
    logDebug(`Open position result for ${symbol}`, openResult);

    if (!openResult.success) {
      logError(`Failed to open position for ${symbol}`, openResult);
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
      quantity: qty, // contracts
      coins: actualCoins, // mới
      notional: actualNotional,
      margin: actualMargin, // dùng actual
      leverage: CONFIG.LEVERAGE,
      roi: 0,
      pnl: 0,
      maxRoi: null,
      dcaIndex: 0,
      cutCount: 0,
      inHodlMode: false,
      initialMargin: actualMargin
    };

    positions.set(symbol, pos);
    accountState.walletBalance -= actualMargin; // Dùng actual
    recomputeEquity();

    logTrade(`Successfully opened position for ${symbol}`, {
      orderId: openResult.orderId,
      positionId: openResult.positionId,
      entryPrice: price,
      quantity: qty,
      margin: actualMargin.toFixed(4),
      notional: actualNotional.toFixed(4)
    });
    await notifyPositionEvent("🚀 OPEN SHORT", symbol, [
      `• Entry: $${usd(price)}`,
      `• Margin: $${usd(actualMargin)} (target: $${usd(margin)})`,
      `• Notional: $${usd(actualNotional)}`,
      `• Qty: ${qty} contracts (${actualCoins.toFixed(2)} coins)`,
      `• Order ID: ${openResult.orderId}`,
      `• Position ID: ${openResult.positionId || 'N/A'}`,
      `• Lý do: ${context}`,
    ]);
  } catch (error) {
    logError(`Unexpected error in openShortPosition for ${symbol}`, error);
    
    await notifyPositionEvent("❌ LỖI HỆ THỐNG", symbol, [
      `• Lỗi không xác định khi mở lệnh`,
      `• Error: ${error.message}`,
      `• Context: ${context}`,
    ]);
  }
}

// Sync tất cả positions từ API khi khởi động (cập nhật với data mới)
export async function syncAllPositionsFromAPI() {
  try {
    console.log('🔄 Syncing positions từ API...');
    
    const apiPositions = await getOpenPositions();
    
    console.log(`📊 API returned ${apiPositions.length} positions`);
    
    // Clear positions cũ
    positions.clear();
    
    // Sync từng position
    for (const apiPosRaw of apiPositions) {
      const symbol = apiPosRaw.symbol;
      const holdVol = parseFloat(apiPosRaw.holdVol || apiPosRaw.volume || 0);
      
      if (holdVol !== 0) {
        console.log(`🔄 Syncing active position: ${symbol}, volume: ${holdVol}`);
        
        // Dùng getPosition để tính đầy đủ
        const pos = await apiGetPosition(symbol);
        if (pos) {
          // Tính ROI nếu SHORT
          if (pos.side === "short") {
            pos.roi = calcShortRoi(pos.entryPrice, pos.lastPrice);
          }
          if (pos.roi > 0) pos.maxRoi = pos.roi;
          
          positions.set(symbol, pos);
          console.log(`✅ Đã sync position: ${symbol}, Qty: ${pos.quantity} contracts, PnL: $${pos.pnl.toFixed(4)}, Margin: $${pos.margin.toFixed(4)}`);
        }
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
    console.log(`   ${symbol}: ${pos.side} | Qty: ${pos.quantity} contracts | Entry: $${pos.entryPrice.toFixed(6)} | PnL: $${pos.pnl.toFixed(4)} | ROI: ${pct(pos.roi)} | Margin: $${pos.margin.toFixed(4)}`);
  }
  console.log(`   Wallet: $${usd(accountState.walletBalance)} | Equity: $${usd(accountState.equity)}\n`);
}