// src/account.js - ĐÃ TÍCH HỢP API THẬT
import { CONFIG } from "./config.js";
import { sendMessageWithAutoDelete } from "./telegram.js";
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
  calculatePartialCloseSize,
} from "./mexc-api.js";
import { logTrade, logError, logDebug } from "./logger.js";

export const accountState = {
  availableBalance: 0,
  positionMargin: 0,
  walletBalance: 0, // tổng tiền = available + margin
  equity: 0, // tổng tài sản có tính PnL
  baseCapital: CONFIG.ACCOUNT_BASE_CAPITAL,
  realizedPnl: 0,
};
export const positions = new Map();

// Khởi tạo balance từ API
export async function initializeAccount() {
  try {
    const { available, margin, totalBalance, equity } = await getFuturesBalance();

    accountState.availableBalance = available;
    accountState.positionMargin = margin;
    accountState.walletBalance = totalBalance;
    accountState.equity = equity;
  } catch (error) {
    console.error("❌ Lỗi khởi tạo account:", error);
  }
}

// ---------- Helper ----------
function usd(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "0.00";
  if (Math.abs(n) >= 1) return n.toFixed(2);
  if (Math.abs(n) >= 0.01) return n.toFixed(4);
  return n.toFixed(6);
}

function pct(v) {
  const n = Number(v ?? 0);
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

// ---------- Equity ----------
export async function recomputeEquity() {
  const { available, margin, totalBalance, equity } = await getFuturesBalance();

  accountState.availableBalance = available;
  accountState.positionMargin = margin;
  accountState.walletBalance = totalBalance; // available + margin
  accountState.equity = equity; // từ API
}

// ---------- Notify ----------
export async function notifyPositionEvent(title, symbol, body) {
  await recomputeEquity();
  const msg =
    `${title}: [${symbol}](https://mexc.co/futures/${symbol}?type=swap)\n` +
    body.join("\n") +
    `\n\nBalance: $${usd(accountState.walletBalance)} | Equity: $${usd(accountState.equity)}` +
    `\nLãi đã rút : $250 - Lỗ: 0` +
    `\nOpen positions: ${positions.size}`;

  await sendMessageWithAutoDelete(msg, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  });
}

// ---------- ROI SHORT ----------
function calcShortRoi(entry, price, margin) {
  const m = Number(margin ?? 0);
  const e = Number(entry ?? 0);
  const p = Number(price ?? 0);
  if (!m || m <= 0 || !e || e <= 0) return 0;

  const leverage = CONFIG.LEVERAGE;
  const notional = m * leverage;
  const priceChangePct = (e - p) / e;
  const pnl = priceChangePct * notional;
  const roi = (pnl / m) * 100;

  console.log(
    `🔧 calcShortRoi: entry=${e}, price=${p}, margin=${m}, pnl=${pnl.toFixed(4)}, roi=${roi.toFixed(2)}%`
  );

  return roi;
}

// ---------- ROI LONG ----------
function calcLongRoi(entry, price, margin) {
  const m = Number(margin ?? 0);
  const e = Number(entry ?? 0);
  const p = Number(price ?? 0);
  if (!m || m <= 0 || !e || e <= 0) return 0;

  const leverage = CONFIG.LEVERAGE;
  const notional = m * leverage;
  const priceChangePct = (p - e) / e;
  const pnl = priceChangePct * notional;
  const roi = (pnl / m) * 100;

  console.log(
    `🔧 calcLongRoi: entry=${e}, price=${p}, margin=${m}, pnl=${pnl.toFixed(4)}, roi=${roi.toFixed(2)}%`
  );

  return roi;
}

// Lấy position thực tế từ API (cập nhật với data mới từ mexc-api)
async function syncPositionFromAPI(symbol) {
  try {
    const apiPos = await apiGetPosition(symbol);
    if (!apiPos) return null;

    const existingPos = positions.get(symbol);

    const roiValue = Number(apiPos.roi ?? 0);
    const marginValue = Number(apiPos.margin ?? apiPos.marginUsed ?? 0);
    const notionalValue = Number(apiPos.notional ?? apiPos.positionSize ?? 0);

    const safePos = {
      symbol: apiPos.symbol ?? symbol,
      side: apiPos.side ?? "SHORT",

      entryPrice: Number(apiPos.entryPrice ?? 0),
      quantity: Number(apiPos.quantity ?? 0),
      coins: Number(apiPos.coins ?? 0),

      notional: notionalValue,
      margin: marginValue,
      marginUsed: Number(apiPos.marginUsed ?? apiPos.margin ?? marginValue),

      leverage: CONFIG.LEVERAGE,

      roi: roiValue,
      pnl: Number(apiPos.totalPnl ?? apiPos.pnl ?? 0),
      realizedPnl: Number(apiPos.realizedPnl ?? 0),
      totalPnl: Number(apiPos.totalPnl ?? apiPos.pnl ?? 0),

      lastPrice: Number(apiPos.lastPrice ?? 0),

      dcaIndex: existingPos?.dcaIndex ?? 0,
      cutCount: existingPos?.cutCount ?? 0,
      inHodlMode: existingPos?.inHodlMode ?? false,
      initialMargin: existingPos?.initialMargin ?? marginValue,
      maxRoi: existingPos?.maxRoi ?? (roiValue > 0 ? roiValue : null),
      
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
  // Nếu chưa có position trong memory -> sync từ API (tránh undefined / return sớm)
  let pos = positions.get(symbol);
  if (!pos) {
    const bootPos = await syncPositionFromAPI(symbol);
    if (!bootPos) return;
    positions.set(symbol, bootPos);
    pos = bootPos;
  }

  // Lấy position mới nhất từ API (safePos)
  const apiPos = await syncPositionFromAPI(symbol);
  if (!apiPos) {
    positions.delete(symbol);
    await recomputeEquity();
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
    quantity: apiPos.quantity,
  });

  // Giữ ROI cũ để cross-down và kiểm tra recovery
  const oldRoi = Number(pos.roi ?? 0);
  const oldLastRoi = Number(pos.lastRoi ?? oldRoi);

  // Lưu lại các trạng thái quản lý trước khi cập nhật
  const savedState = {
    dcaIndex: pos.dcaIndex,
    cutCount: pos.cutCount,
    inHodlMode: pos.inHodlMode,
    maxRoi: pos.maxRoi,
    initialMargin: pos.initialMargin,
    lastRoi: pos.lastRoi,
  };

  // Cập nhật data market từ API (KHÔNG overwrite state quản lý)
  Object.assign(pos, {
    entryPrice: Number(apiPos.entryPrice ?? pos.entryPrice ?? 0),
    quantity: Number(apiPos.quantity ?? pos.quantity ?? 0),
    coins: Number(apiPos.coins ?? pos.coins ?? 0),

    margin: Number(apiPos.margin ?? apiPos.marginUsed ?? pos.margin ?? 0),
    notional: Number(apiPos.notional ?? apiPos.positionSize ?? pos.notional ?? 0),
    marginUsed: Number(apiPos.marginUsed ?? apiPos.margin ?? pos.marginUsed ?? 0),

    pnl: Number(apiPos.totalPnl ?? apiPos.pnl ?? pos.pnl ?? 0),
    totalPnl: Number(apiPos.totalPnl ?? apiPos.pnl ?? pos.totalPnl ?? 0),
    realizedPnl: Number(apiPos.realizedPnl ?? pos.realizedPnl ?? 0),

    lastPrice: Number(apiPos.lastPrice ?? price ?? pos.lastPrice ?? 0),
    roi: Number(apiPos.roi ?? pos.roi ?? 0),
  });

  // Khôi phục trạng thái quản lý + đảm bảo default không undefined
  Object.assign(pos, savedState);
  pos.dcaIndex ??= 0;
  pos.cutCount ??= 0;
  pos.inHodlMode ??= false;
  pos.initialMargin ??= pos.margin ?? 0;
  pos.maxRoi ??= null;

  // init lastRoi chắc chắn là number
  if (!Number.isFinite(Number(pos.lastRoi))) pos.lastRoi = oldRoi;

  // Cập nhật max ROI
  if (pos.maxRoi === null || Number(pos.roi ?? 0) > Number(pos.maxRoi)) {
    pos.maxRoi = Number(pos.roi ?? 0);
  }

  // Recompute equity với P/L thực tế
  await recomputeEquity();

  // Debug log sau khi update 
  console.log(`Updated position ${symbol}:`, {
    roi: Number(pos.roi ?? 0).toFixed(2) + "%",
    pnl: "$" + Number(pos.pnl ?? 0).toFixed(4),
    margin: "$" + Number(pos.margin ?? 0).toFixed(4),
    maxRoi: pos.maxRoi == null ? null : Number(pos.maxRoi).toFixed(2) + "%",
    dcaIndex: pos.dcaIndex,
    inHodlMode: pos.inHodlMode,
    lastRoi: Number(pos.lastRoi ?? 0).toFixed(2) + "%",
  });

  // --- Loss ratio for HODL ---
  const unrealizedLoss = Number(pos.pnl ?? 0) < 0 ? -Number(pos.pnl ?? 0) : 0;
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
  //              2) DCA (MULTIPLIER x2 margin hiện tại)
  // =========================================================
  if (!pos.inHodlMode && pos.dcaIndex < CONFIG.DCA_PLAN.length) {
    const plan = CONFIG.DCA_PLAN[pos.dcaIndex];
    const last = Number(pos.lastRoi ?? 0);
    const now = Number(pos.roi ?? 0);
    const trigger = Number(plan.roiTrigger);

    // Cross-down: từ trên ngưỡng -> xuống dưới/đúng ngưỡng
    const crossedDown = last > trigger && now <= trigger;

    if (crossedDown) {
      // === LOGIC ĐẶC BIỆT: Nếu DCA lần thứ 3 và ROI hồi về -5% đến -10% ===
      if (pos.dcaIndex === 2) { // index 2 = lần DCA thứ 3
        const currentRoi = Number(pos.roi ?? 0);
        
        // Điều kiện ROI:
        // ROI đang hồi (tăng) và nằm trong khoảng -5% đến -10%
        const roiRecovering = oldLastRoi < currentRoi; // ROI đang tăng (ít âm hơn)
        const roiInRange = currentRoi >= -10 && currentRoi <= -5;
        
        if (roiRecovering && roiInRange) {
          console.log(`⚠️ [DCA3 RECOVERY] ${symbol}:`, {
            ROI: currentRoi.toFixed(2) + "%",
            lastROI: oldLastRoi.toFixed(2) + "%",
            recovering: true,
            inRange: true
          });
          
          // Cắt 1/2 volume
          const closeQty = await calculatePartialCloseSize(symbol, 0.5);
          
          if (closeQty > 0) {
            const { totalBalance: balanceBefore } = await getFuturesBalance();
            const closeResult = await apiClosePosition(symbol, closeQty, "SHORT");
            
            if (closeResult.success) {
              await new Promise(r => setTimeout(r, 800));
              
              // Giữ initialMargin ban đầu
              const savedInitialMargin = pos.initialMargin;
              
              // Reset DCA về 0
              pos.dcaIndex = 0;
              pos.lastRoi = currentRoi; // Update để tránh trigger DCA lại ngay
              
              // Cập nhật position từ API
              const updatedApiPos = await syncPositionFromAPI(symbol);
              if (updatedApiPos) {
                const savedState2 = {
                  dcaIndex: 0, // RESET
                  cutCount: pos.cutCount,
                  inHodlMode: pos.inHodlMode,
                  maxRoi: pos.maxRoi,
                  initialMargin: savedInitialMargin, // GIỮ NGUYÊN initialMargin
                  lastRoi: currentRoi,
                };
                
                Object.assign(pos, updatedApiPos);
                Object.assign(pos, savedState2);
                
                const { totalBalance: balanceAfter } = await getFuturesBalance();
                const realizedPnl = balanceAfter - balanceBefore;
                
                console.log(`✂️ [DCA3 HALF CUT] ${symbol}:`, {
                  closedQty: closeQty,
                  realizedPnl: "$" + realizedPnl.toFixed(4),
                  newDCAIndex: 0,
                  initialMargin: "$" + savedInitialMargin.toFixed(4),
                  newMargin: "$" + Number(pos.margin ?? 0).toFixed(4),
                });
                
                await notifyPositionEvent("✂️ DCA3 RECOVERY CUT", symbol, [
                  `• Đã DCA 3 lần, ROI hồi phục về -5→-10%`,
                  `• Cắt 50% volume, chốt: $${usd(realizedPnl)}`,
                  `• Reset DCA index về 0`,
                  `• ROI hiện tại: ${pct(currentRoi)} (trước: ${pct(oldLastRoi)})`,
                  `• Điều kiện: ROI hồi về -5→-10%`,
                ]);
                
                return; // Không thực hiện DCA tiếp
              }
            }
          }
        }
      }
      
      // === DCA BÌNH THƯỜNG: margin hiện tại × 2 ===
      const currentMargin = Number((pos.margin || pos.marginUsed || 0).toFixed(4));
      const addMargin = currentMargin * 2; 

      // Check balance
      await checkAndTransferBalance();
      const { totalBalance } = await getFuturesBalance();
      if (totalBalance < addMargin) {
        console.log(`⚠️ Không đủ balance cho DCA ${symbol}: ${totalBalance} < ${addMargin}`);
        pos.lastRoi = now;
        return;
      }

      const contractInfo = await getContractInfo(symbol);
      const addQty = await calculateDCAPositionSize(symbol, addMargin / totalBalance);

      if (addQty <= 0) {
        console.log(`⚠️ Quantity DCA quá nhỏ: ${addQty}`);
        pos.lastRoi = now;
        return;
      }

      console.log(`💰 Executing DCA Level ${pos.dcaIndex + 1} for ${symbol}:`, {
        currentMargin: "$" + currentMargin.toFixed(4),
        addMargin: "$" + addMargin.toFixed(4),
        addQty,
        currentROI: now.toFixed(2) + "%",
        multiplier: "x2",
      });

      const dcaResult = await apiOpenPosition(
        symbol,
        addQty,
        "SHORT",
        `DCA_${pos.dcaIndex + 1}`,
        contractInfo
      );

      if (dcaResult.success) {
        await new Promise((r) => setTimeout(r, 800));

        const updatedApiPos = await syncPositionFromAPI(symbol);
        if (updatedApiPos) {
          const newDcaIndex = pos.dcaIndex + 1;

          const savedState2 = {
            dcaIndex: newDcaIndex,
            cutCount: pos.cutCount,
            inHodlMode: pos.inHodlMode,
            maxRoi: Math.max(Number(pos.maxRoi ?? 0), Number(updatedApiPos.roi ?? 0)),
            initialMargin: Number(pos.initialMargin ?? 0), // Giữ initialMargin cũ
            lastRoi: Number(updatedApiPos.roi ?? now),
          };

          Object.assign(pos, updatedApiPos);
          Object.assign(pos, savedState2);

          console.log(`✅ DCA Level ${newDcaIndex}/${CONFIG.DCA_PLAN.length} completed for ${symbol}:`, {
            currentMargin: "$" + currentMargin.toFixed(4),
            addMargin: "$" + addMargin.toFixed(4),
            newEntry: Number(pos.entryPrice ?? 0).toFixed(6),
            newROI: Number(pos.roi ?? 0).toFixed(2) + "%",
            newMargin: "$" + Number(pos.margin ?? 0).toFixed(4),
            nextTrigger: newDcaIndex < CONFIG.DCA_PLAN.length
              ? CONFIG.DCA_PLAN[newDcaIndex].roiTrigger + "%"
              : "MAX",
          });

          await notifyPositionEvent("➕ DCA", symbol, [
            `• DCA nhân đôi margin hiện tại: x2`,
            `• Margin hiện tại: $${usd(currentMargin)}`,
            `• Margin thêm: $${usd(addMargin)}`,
            `• Giá DCA: $${usd(price)}`,
            `• Entry mới: $${usd(pos.entryPrice)}`,
            `• Total P/L: $${usd(pos.totalPnl || pos.pnl)} (${pct(pos.roi)})`,
            `• Unrealized: $${usd(pos.unrealizedPnl || pos.pnl)}`,
            `• Realized: $${usd(pos.realizedPnl || 0)}`,
            `• DCA Level ${pos.dcaIndex}/${CONFIG.DCA_PLAN.length}`,
          ]);

          return;
        }
      } else {
        console.log(`❌ DCA ${symbol} thất bại:`, dcaResult.error);
        await notifyPositionEvent("❌ DCA THẤT BẠI", symbol, [
          `• Lỗi: ${dcaResult.error}`,
          `• Không thêm margin: $${usd(addMargin)}`,
        ]);
      }
    }
  }

  // =========================================================
  //      3) PARTIAL CUT — API THẬT
  // =========================================================
  const cutThreshold = accountState.baseCapital * CONFIG.EQUITY_CUT_RATIO;
  if (accountState.equity < cutThreshold && pos.cutCount < CONFIG.MAX_PARTIAL_CUTS) {
    const portion = 0.5;
    const closeQty = await calculatePartialCloseSize(symbol, portion);

    if (closeQty > 0) {
      const { totalBalance: balanceBefore } = await getFuturesBalance();

      const closeResult = await apiClosePosition(symbol, closeQty, "SHORT");

      if (closeResult.success) {
        await new Promise((r) => setTimeout(r, 800));

        const updatedApiPos = await syncPositionFromAPI(symbol);
        if (updatedApiPos) {
          const savedState3 = {
            dcaIndex: pos.dcaIndex,
            cutCount: pos.cutCount + 1,
            inHodlMode: pos.inHodlMode,
            maxRoi: pos.maxRoi,
            initialMargin: Number(pos.initialMargin ?? 0) * (1 - portion),
            lastRoi: Number(pos.roi ?? 0),
          };

          Object.assign(pos, updatedApiPos);
          Object.assign(pos, savedState3);

          const { totalBalance: balanceAfter } = await getFuturesBalance();
          const realizedPnlFromCut = balanceAfter - balanceBefore;

          await recomputeEquity();

          console.log(`✂️ Partial cut successful for ${symbol}:`, {
            cutPnl: "$" + realizedPnlFromCut.toFixed(4),
            newQuantity: pos.quantity,
            newMargin: Number(pos.margin ?? 0).toFixed(4),
            newROI: Number(pos.roi ?? 0).toFixed(2) + "%",
            cutCount: pos.cutCount,
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
  //           4) TAKE PROFIT - API THẬT
  // =========================================================
  const enoughProfit = pos.roi >= CONFIG.MIN_PROFIT_ROI_FOR_TRAIL;
  const droppedFromMax = pos.maxRoi !== null &&
    Number(pos.maxRoi ?? 0) - Number(pos.roi ?? 0) >= CONFIG.TRAIL_DROP_FROM_MAX_ROI;
  const priceCrossUpMA10 = ma10 && price > ma10;

  if (enoughProfit && (droppedFromMax || priceCrossUpMA10)) {
    const { totalBalance: balanceBefore } = await getFuturesBalance();
    const positionBefore = { ...pos };

    const closeResult = await apiClosePosition(symbol, pos.quantity, "SHORT");

    if (closeResult.success) {
      await new Promise((r) => setTimeout(r, 1000));

      const { totalBalance: balanceAfter } = await getFuturesBalance();
      const realizedPnl = balanceAfter - balanceBefore;

      positions.delete(symbol);
      await recomputeEquity();

      console.log(`✅ Take profit successful for ${symbol}:`, {
        realizedPnl: "$" + realizedPnl.toFixed(4),
        roiAtClose: Number(positionBefore.roi ?? 0).toFixed(2) + "%",
        maxRoi: positionBefore.maxRoi == null ? null : Number(positionBefore.maxRoi).toFixed(2) + "%",
        balanceChange: "$" + (balanceAfter - balanceBefore).toFixed(4),
      });

      const reason = priceCrossUpMA10 ? "Giá chạm/cắt MA10 → Trend đảo" : "Trailing Stop theo ROI";

      await notifyPositionEvent("✅ TAKE PROFIT", symbol, [
        `• ROI chốt: ${pct(positionBefore.roi)} (P/L $${usd(realizedPnl)})`,
        `• Max ROI trước đó: ${pct(positionBefore.maxRoi ?? 0)}`,
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

  // ✅ update lastRoi cuối hàm cho lần tick sau
  pos.lastRoi = Number(pos.roi ?? 0);
}
// =========================================================
//               OPEN SHORT POSITION - API THẬT
// =========================================================
export async function openShortPosition(symbol, price, context) {
  try {
    await checkAndTransferBalance();
    const { totalBalance, available } = await getFuturesBalance();
    logDebug(`Balance for ${symbol}`, { totalBalance, available });

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

    const margin = totalBalance * CONFIG.ENTRY_PERCENT;
    if (margin <= 0) {
      await notifyPositionEvent("❌ MARGIN=0", symbol, [
        `• Balance quá thấp: $${usd(totalBalance)}`,
      ]);
      return;
    }

    const notional = margin * CONFIG.LEVERAGE;
    logDebug(`Calculations for ${symbol}`, {
      balance: totalBalance,
      entryPercent: CONFIG.ENTRY_PERCENT,
      margin,
      leverage: CONFIG.LEVERAGE,
      notional,
      price,
    });

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
      margin,
      notional,
      price,
      contractSize: contractInfo.contractSize,
      rawContracts,
      roundedQuantity: qty,
      contractInfo,
    });

    if (qty <= 0 || qty < contractInfo.minQuantity) {
      await notifyPositionEvent("❌ LỖI SỐ LƯỢNG", symbol, [
        `• Quantity tính được = ${qty} contracts < min=${contractInfo.minQuantity}`,
        `• Không thể mở lệnh (rounding/contractSize error).`,
        `• Context: ${context}`,
      ]);
      return;
    }

    const actualCoins = qty * contractInfo.contractSize;
    const actualNotional = actualCoins * price;
    const actualMargin = actualNotional / CONFIG.LEVERAGE;
    const marginDiff = Math.abs(actualMargin - margin);
    logDebug(`Margin verification for ${symbol}`, {
      actualMargin: actualMargin.toFixed(4),
      diff: marginDiff.toFixed(4),
    });

    if (marginDiff > margin * 0.1) {
      console.warn(
        `⚠️ Margin diff >10%: target=${margin.toFixed(4)}, actual=${actualMargin.toFixed(4)}`
      );
    }

    logTrade(`Opening position for ${symbol}`, {
      symbol,
      price,
      qty,
      margin,
      notional,
      context,
      actualMargin,
    });

    const openResult = await apiOpenPosition(symbol, qty, "SHORT", context, contractInfo);
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

    // Tạo position local (đủ state quản lý, tránh undefined)
    const pos = {
      symbol,
      side: "SHORT",
      entryPrice: price,
      quantity: qty,
      coins: actualCoins,
      notional: actualNotional,
      margin: actualMargin,
      marginUsed: actualMargin,
      leverage: CONFIG.LEVERAGE,
      roi: 0,
      pnl: 0,
      realizedPnl: 0,
      totalPnl: 0,
      lastPrice: price,
      lastRoi: 0,

      maxRoi: null,
      dcaIndex: 0,
      cutCount: 0,
      inHodlMode: false,
      initialMargin: actualMargin,
    };

    positions.set(symbol, pos);
    await recomputeEquity();

    logTrade(`Successfully opened position for ${symbol}`, {
      orderId: openResult.orderId,
      positionId: openResult.positionId,
      entryPrice: price,
      quantity: qty,
      margin: actualMargin.toFixed(4),
      notional: actualNotional.toFixed(4),
    });

    await notifyPositionEvent("🚀 OPEN SHORT", symbol, [
      `• Entry: $${usd(price)}`,
      `• Margin: $${usd(actualMargin)} (target: $${usd(margin)})`,
      `• Notional: $${usd(actualNotional)}`,
      `• Qty: ${qty} contracts (${actualCoins.toFixed(2)} coins)`,
      `• Order ID: ${openResult.orderId}`,
      `• Position ID: ${openResult.positionId || "N/A"}`,
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

// =========================================================
//        SYNC ALL POSITIONS FROM API WHEN STARTING
// =========================================================
export async function syncAllPositionsFromAPI() {
  try {
    console.log("🔄 Syncing positions từ API...");

    const apiPositions = await getOpenPositions();
    console.log(`📊 API returned ${apiPositions.length} positions`);

    const activeSymbols = new Set();

    // 1) Update/Add positions còn mở
    for (const apiPosRaw of apiPositions) {
      const symbol = apiPosRaw.symbol;
      const holdVol = Number(apiPosRaw.holdVol ?? apiPosRaw.volume ?? 0);

      if (!symbol || holdVol === 0) continue;

      activeSymbols.add(symbol);

      const safePos = await syncPositionFromAPI(symbol);
      if (safePos) {
        // Nếu API không trả roi chuẩn, có thể tự tính lại theo side (optional)
        if (safePos.side === "SHORT") {
          safePos.roi = calcShortRoi(safePos.entryPrice, safePos.lastPrice, safePos.marginUsed ?? safePos.margin);
        } else if (safePos.side === "LONG") {
          safePos.roi = calcLongRoi(safePos.entryPrice, safePos.lastPrice, safePos.marginUsed ?? safePos.margin);
        }

        // cập nhật maxRoi sau khi tính roi
        if (safePos.maxRoi === null || Number(safePos.roi ?? 0) > Number(safePos.maxRoi)) {
          safePos.maxRoi = Number(safePos.roi ?? 0);
        }

        positions.set(symbol, safePos);

        console.log(
          `✅ Đã sync position: ${symbol}, Qty: ${safePos.quantity} contracts, PnL: $${Number(
            safePos.pnl ?? 0
          ).toFixed(4)}, ROI: ${Number(safePos.roi ?? 0).toFixed(2)}%, Margin: $${Number(
            safePos.margin ?? 0
          ).toFixed(4)}`
        );
      }
    }

    // 2) Xóa positions không còn trên API (đã đóng)
    for (const symbol of [...positions.keys()]) {
      if (!activeSymbols.has(symbol)) {
        console.log(`🗑️ Removing ${symbol} (no longer in API)`);
        positions.delete(symbol);
      }
    }

    console.log(`✅ Đã sync ${positions.size} positions từ API`);
    await recomputeEquity();
  } catch (error) {
    console.error("❌ Lỗi sync positions:", error);
  }
}

// Utility function để log trạng thái positions
export function logPositionsStatus() {
  console.log(`\n📊 POSITIONS STATUS (${positions.size} positions):`);
  for (const [symbol, pos] of positions.entries()) {
    console.log(
      `   ${symbol}: ${pos.side} | Qty: ${Number(pos.quantity ?? 0)} contracts | Entry: $${Number(
        pos.entryPrice ?? 0
      ).toFixed(6)} | PnL: $${Number(pos.pnl ?? 0).toFixed(4)} | ROI: ${pct(
        pos.roi ?? 0
      )} | Margin: $${Number(pos.margin ?? 0).toFixed(4)}`
    );
  }
  console.log(
    `   Wallet: $${usd(accountState.walletBalance)} | Equity: $${usd(accountState.equity)}\n`
  );
}
