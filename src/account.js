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
  getOpenPositions, // Thêm import
  calculatePartialCloseSize 
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
// Thay thế hàm calcShortRoi hiện tại bằng:
function calcShortRoi(entry, price, margin) {
  if (!margin || margin <= 0) return 0;
  
  // P/L cho SHORT: (entry - price) * số lượng
  // Nhưng chúng ta cần biết số lượng, nên tính dựa trên margin
  // Ước lượng: P/L ≈ (entry - price)/entry * notional
  // notional = margin * leverage
  const leverage = CONFIG.LEVERAGE;
  const notional = margin * leverage;
  const priceChangePct = (entry - price) / entry;
  const pnl = priceChangePct * notional;
  
  // ROI = P/L / margin * 100%
  const roi = (pnl / margin) * 100;
  
  console.log(`🔧 calcShortRoi: entry=${entry}, price=${price}, margin=${margin}, pnl=${pnl.toFixed(4)}, roi=${roi.toFixed(2)}%`);
  
  return roi;
}
// Lấy position thực tế từ API (cập nhật với data mới từ mexc-api)
async function syncPositionFromAPI(symbol) {
  try {
    const apiPos = await apiGetPosition(symbol);
    if (!apiPos) return null;

    // Lấy position hiện tại trong memory (nếu có)
    const existingPos = positions.get(symbol);
     const safePos = {
      symbol: apiPos.symbol || symbol,
      side: apiPos.side || "SHORT",
      entryPrice: apiPos.entryPrice || 0,
      quantity: apiPos.quantity || 0,
      coins: apiPos.coins || 0,
      notional: apiPos.notional || apiPos.positionSize || 0,
      margin: apiPos.margin || apiPos.marginUsed || 0, // ✅ Dùng margin (có trong getPosition return)
      leverage: CONFIG.LEVERAGE,
      roi: apiPos.roi || 0,
      pnl: apiPos.totalPnl || apiPos.pnl || 0, // ✅ Dùng totalPnl thay vì pnl (unrealized)
      realizedPnl: apiPos.realizedPnl || 0,
      totalPnl: apiPos.totalPnl || apiPos.pnl || 0,
      lastPrice: apiPos.lastPrice || 0,
      maxRoi: (apiPos.roi > 0 ? apiPos.roi : null) || null,
      // Giữ trạng thái quản lý
      dcaIndex: existingPos?.dcaIndex || 0,
      cutCount: existingPos?.cutCount || 0,
      inHodlMode: existingPos?.inHodlMode || false,
      initialMargin: existingPos?.initialMargin || apiPos.margin || apiPos.marginUsed || 0,
    };


    return safePos;
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
  let pos = positions.get(symbol);
  if (!pos) return;
  
  // Lấy position mới nhất từ API với P/L chính xác
  const apiPos = await syncPositionFromAPI(symbol);
  if (!apiPos) {
    // Position đã đóng trên API -> xóa khỏi memory
    console.log(`🗑️ Position ${symbol} đã đóng trên API, xóa khỏi memory`);
    positions.delete(symbol);
    recomputeEquity();
    return;
  }

  // Debug log để kiểm tra P/L
  console.log(`🔍 API Position data for ${symbol}:`, {
    roi: apiPos.roi,
    pnl: apiPos.pnl,
    totalPnl: apiPos.totalPnl,
    realizedPnl: apiPos.realizedPnl,
    marginUsed: apiPos.marginUsed,
    entryPrice: apiPos.entryPrice,
    quantity: apiPos.quantity
  });

  // Nếu chưa có position trong memory (sync từ API khi khởi động)
  if (!pos) {
    positions.set(symbol, apiPos);
    pos = apiPos;
    console.log(`🔄 Đã sync position ${symbol} từ API với P/L: $${apiPos.totalPnl?.toFixed(4) || apiPos.pnl?.toFixed(4)}`);
  } else {
    // Lưu lại các trạng thái quản lý trước khi cập nhật
    const savedState = {
      dcaIndex: pos.dcaIndex,
      cutCount: pos.cutCount,
      inHodlMode: pos.inHodlMode,
      maxRoi: pos.maxRoi,
      initialMargin: pos.initialMargin
    };

    // Cập nhật data thực tế từ API
    Object.assign(pos, {
      entryPrice: apiPos.entryPrice,
      quantity: apiPos.quantity,
      coins: apiPos.coins,
      margin: apiPos.marginUsed, // Dùng marginUsed từ API
      notional: apiPos.positionSize,
      pnl: apiPos.totalPnl || apiPos.pnl, // Ưu tiên totalPnl
      lastPrice: apiPos.lastPrice,
      roi: apiPos.roi
    });

    // Khôi phục trạng thái quản lý
    Object.assign(pos, savedState);
  }

  // Cập nhật max ROI
  if (pos.maxRoi === null || pos.roi > pos.maxRoi) {
    pos.maxRoi = pos.roi;
  }

  // Recompute equity với P/L thực tế
  recomputeEquity();

  // Debug log sau khi update
  console.log(`📊 Updated position ${symbol}:`, {
    roi: pos.roi.toFixed(2) + '%',
    pnl: '$' + pos.pnl.toFixed(4),
    margin: '$' + pos.margin.toFixed(4),
    maxRoi: pos.maxRoi?.toFixed(2) + '%',
    dcaIndex: pos.dcaIndex,
    inHodlMode: pos.inHodlMode
  });

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
  
  const prevTrigger = pos.dcaIndex > 0 ? CONFIG.DCA_PLAN[pos.dcaIndex - 1].roiTrigger : Infinity;
  const shouldDCA = pos.roi <= plan.roiTrigger && pos.roi > prevTrigger;
  
  console.log(`🎯 DCA CHECK for ${symbol}:`, {
    dcaIndex: pos.dcaIndex,
    currentROI: pos.roi?.toFixed(2) + '%',
    currentTrigger: plan.roiTrigger + '%',
    prevTrigger: prevTrigger === Infinity ? '∞' : prevTrigger + '%',
    roiRange: `(${prevTrigger === Infinity ? '-∞' : prevTrigger}%, ${plan.roiTrigger}%]`,
    inRange: shouldDCA,
    condition1: `ROI ≤ ${plan.roiTrigger}%: ${pos.roi <= plan.roiTrigger}`,
    condition2: `ROI > ${prevTrigger === Infinity ? '-∞' : prevTrigger + '%'}: ${pos.roi > prevTrigger}`
  });
  
  if (shouldDCA) {
    if (!pos.initialMargin) pos.initialMargin = pos.margin;
    
    const addMargin = pos.initialMargin * (2 ** pos.dcaIndex);
    
    // Check balance
    await checkAndTransferBalance();
    const currentBalance = await getFuturesBalance();
    if (currentBalance < addMargin) {
      console.log(`⚠️ Không đủ balance cho DCA ${symbol}: ${currentBalance} < ${addMargin}`);
      return;
    }
    
    const contractInfo = await getContractInfo(symbol);
    const addQty = await calculateDCAPositionSize(symbol, addMargin / currentBalance);
    
    if (addQty <= 0) {
      console.log(`⚠️ Quantity DCA quá nhỏ: ${addQty}`);
      return;
    }
    
    console.log(`💰 Executing DCA Level ${pos.dcaIndex + 1} for ${symbol}:`, {
      addMargin: '$' + addMargin.toFixed(4),
      addQty: addQty,
      currentROI: pos.roi?.toFixed(2) + '%',
      marginMultiplier: `x${2 ** pos.dcaIndex}`
    });
    
    const dcaResult = await apiOpenPosition(symbol, addQty, 'SHORT', `DCA_${pos.dcaIndex + 1}`, contractInfo);
    
    if (dcaResult.success) {
      // Chờ API cập nhật
      await new Promise(r => setTimeout(r, 800));
      
      // Lấy lại position từ API sau khi DCA
      const updatedApiPos = await syncPositionFromAPI(symbol);
      if (updatedApiPos) {
        // ✅ TĂNG dcaIndex ngay sau khi DCA thành công
        const newDcaIndex = pos.dcaIndex + 1;
        
        // Cập nhật position với data mới từ API
        const savedState = {
          dcaIndex: newDcaIndex, 
          cutCount: pos.cutCount,
          inHodlMode: pos.inHodlMode,
          maxRoi: Math.max(pos.maxRoi || 0, updatedApiPos.roi),
          initialMargin: pos.initialMargin + addMargin
        };
        
        Object.assign(pos, updatedApiPos);
        Object.assign(pos, savedState);
        
        // Cập nhật balance
        accountState.walletBalance -= addMargin;
        recomputeEquity();
        
        console.log(`✅ DCA Level ${pos.dcaIndex}/${CONFIG.DCA_PLAN.length} completed for ${symbol}:`, {
          newEntry: pos.entryPrice.toFixed(6),
          newROI: pos.roi?.toFixed(2) + '%',
          newMargin: '$' + pos.margin.toFixed(4),
          nextTrigger: newDcaIndex < CONFIG.DCA_PLAN.length 
            ? CONFIG.DCA_PLAN[newDcaIndex].roiTrigger + '%' 
            : 'MAX'
        });
        
      await notifyPositionEvent("➕ DCA", symbol, [
        `• DCA cấp số nhân: x${2 ** (pos.dcaIndex - 1)}`,
        `• Entry cũ: $${usd(plan.oldEntry || pos.entryPrice)}`,
        `• Giá DCA: $${usd(price)}`,
        `• Entry mới: $${usd(pos.entryPrice)}`,
        `• Total P/L: $${usd(pos.totalPnl || pos.pnl)} (${pct(pos.roi)})`, // ✅ FIX
        `• Unrealized: $${usd(pos.unrealizedPnl || pos.pnl)}`, // Thêm chi tiết
        `• Realized: $${usd(pos.realizedPnl || 0)}`,
        `• Margin thêm: $${usd(addMargin)}`,
        `• DCA Level ${pos.dcaIndex}/${CONFIG.DCA_PLAN.length}`,
      ]);
      }
    } else {
      console.log(`❌ DCA ${symbol} thất bại:`, dcaResult.error);
      await notifyPositionEvent("❌ DCA THẤT BẠI", symbol, [
        `• Lỗi: ${dcaResult.error}`,
        `• Không thêm margin: $${usd(addMargin)}`,
      ]);
    }
  } else {
    console.log(`⏸️  Skip DCA for ${symbol}: ROI ${pos.roi?.toFixed(2)}% not in range (${prevTrigger === Infinity ? '-∞' : prevTrigger}%, ${plan.roiTrigger}%]`);
  }
}
  // =========================================================
  //      3) PARTIAL CUT — API THẬT
  // =========================================================
  const cutThreshold = accountState.baseCapital * CONFIG.PARTIAL_CUT_RATIO;
  if (accountState.equity < cutThreshold && pos.cutCount < CONFIG.MAX_PARTIAL_CUTS) {
    const portion = 0.5; // 50% cut
    const closeQty = await calculatePartialCloseSize(symbol, portion);
    
    if (closeQty > 0) {
      // Lấy balance trước khi cut
      const balanceBefore = accountState.walletBalance;
      
      const closeResult = await apiClosePosition(symbol, closeQty, 'SHORT');
      
      if (closeResult.success) {
        // Chờ API cập nhật
        await new Promise(r => setTimeout(r, 800));
        
        // Lấy lại position từ API sau khi cut
        const updatedApiPos = await syncPositionFromAPI(symbol);
        if (updatedApiPos) {
          // Lưu trạng thái quản lý
          const savedState = {
            dcaIndex: pos.dcaIndex,
            cutCount: pos.cutCount + 1, // Tăng cut count
            inHodlMode: pos.inHodlMode,
            maxRoi: pos.maxRoi,
            initialMargin: pos.initialMargin * (1 - portion) // Giảm initial margin
          };
          
          // Cập nhật data từ API
          Object.assign(pos, updatedApiPos);
          Object.assign(pos, savedState);
          
          // Tính P/L thực từ sự thay đổi balance
          const balanceAfter = await getFuturesBalance();
          const realizedPnlFromCut = balanceAfter - balanceBefore;
          
          accountState.walletBalance = balanceAfter;
          accountState.realizedPnl += realizedPnlFromCut;
          recomputeEquity();
          
          console.log(`✂️ Partial cut successful for ${symbol}:`, {
            cutPnl: '$' + realizedPnlFromCut.toFixed(4),
            newQuantity: pos.quantity,
            newMargin: pos.margin.toFixed(4),
            newROI: pos.roi.toFixed(2) + '%',
            cutCount: pos.cutCount
          });

          await notifyPositionEvent("✂️ PARTIAL STOP LOSS", symbol, [
            `• Cắt ${(portion * 100).toFixed(1)}% vị thế`,
            `• Đã chốt: $${usd(realizedPnlFromCut)} ở ROI ${pct(pos.roi)}`,
            `• Cắt lần ${pos.cutCount}/${CONFIG.MAX_PARTIAL_CUTS}`,
            `• Equity: $${usd(accountState.equity)} < $${usd(cutThreshold)}`,
          ]);
        }
      } else {
        console.log(`❌ Partial cut ${symbol} thất bại:`, closeResult.error);
      }
    }
  }

  // =========================================================
  //           4) TAKE PROFIT - API THẬT (SỬA P/L)
  // =========================================================
  const enoughProfit = pos.roi >= CONFIG.MIN_PROFIT_ROI_FOR_TRAIL;
  const droppedFromMax = pos.maxRoi !== null && (pos.maxRoi - pos.roi) >= CONFIG.TRAIL_DROP_FROM_MAX_ROI;
  const priceCrossUpMA10 = ma10 && price > ma10;

  if (enoughProfit && (droppedFromMax || priceCrossUpMA10)) {
    // Lấy balance trước khi TP
    const balanceBefore = accountState.walletBalance;
    const positionBefore = { ...pos }; // Lưu position trước khi đóng
    
    // Close toàn bộ position thực tế
    const closeResult = await apiClosePosition(symbol, pos.quantity, 'SHORT');
    
    if (closeResult.success) {
      // Chờ API cập nhật
      await new Promise(r => setTimeout(r, 1000));
      
      // Lấy balance sau khi TP
      const balanceAfter = await getFuturesBalance();
      const realizedPnl = balanceAfter - balanceBefore;
      
      // Cập nhật account với P/L thực tế
      accountState.walletBalance = balanceAfter;
      accountState.realizedPnl += realizedPnl;
      
      // Xóa position khỏi memory
      positions.delete(symbol);
      recomputeEquity();
      
      console.log(`✅ Take profit successful for ${symbol}:`, {
        realizedPnl: '$' + realizedPnl.toFixed(4),
        roiAtClose: positionBefore.roi.toFixed(2) + '%',
        maxRoi: positionBefore.maxRoi?.toFixed(2) + '%',
        balanceChange: '$' + (balanceAfter - balanceBefore).toFixed(4)
      });

      const reason = priceCrossUpMA10 ? "Giá chạm/cắt MA10 → Trend đảo" : "Trailing Stop theo ROI";
      
      await notifyPositionEvent("✅ TAKE PROFIT", symbol, [
        `• ROI chốt: ${pct(positionBefore.roi)} (P/L $${usd(realizedPnl)})`,
        `• Max ROI trước đó: ${pct(positionBefore.maxRoi)}`,
        `• ${reason}`,
        `• Entry: $${usd(positionBefore.entryPrice)} → Exit: $${usd(price)}`,
      ]);
    } else {
      console.log(`❌ Take profit ${symbol} thất bại:`, closeResult.error);
      await notifyPositionEvent("❌ TP THẤT BẠI", symbol, [
        `• Lỗi khi đóng position: ${closeResult.error}`,
        `• ROI hiện tại: ${pct(pos.roi)}`,
      ]);
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
// Thêm hàm calcLongRoi (sau calcShortRoi):
function calcLongRoi(entry, price, margin) {
  if (!margin || margin <= 0) return 0;
  
  const leverage = CONFIG.LEVERAGE;
  const notional = margin * leverage;
  const priceChangePct = (price - entry) / entry;
  const pnl = priceChangePct * notional;
  
  // ROI = P/L / margin * 100%
  const roi = (pnl / margin) * 100;
  
  console.log(`🔧 calcLongRoi: entry=${entry}, price=${price}, margin=${margin}, pnl=${pnl.toFixed(4)}, roi=${roi.toFixed(2)}%`);
  
  return roi;
}
// Sync tất cả positions từ API khi khởi động (cập nhật với data mới)
// Trong hàm syncAllPositionsFromAPI
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
          // ✅ SỬA: Tính ROI với đủ 3 tham số
          if (pos.side === "short") {
            pos.roi = calcShortRoi(pos.entryPrice, pos.lastPrice, pos.marginUsed || pos.margin);
          } else if (pos.side === "long") {
            // Nếu cần tính ROI cho LONG
            pos.roi = calcLongRoi(pos.entryPrice, pos.lastPrice, pos.marginUsed || pos.margin);
          }
          
          if (pos.roi > 0) pos.maxRoi = pos.roi;
          
          positions.set(symbol, pos);
          console.log(`✅ Đã sync position: ${symbol}, Qty: ${pos.quantity} contracts, PnL: $${pos.pnl.toFixed(4)}, ROI: ${pos.roi.toFixed(2)}%, Margin: $${pos.margin.toFixed(4)}`);
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