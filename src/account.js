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
import { get7DayBottomPrice } from "./bottom-check.js";

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

function calculateMexcAppROI(unrealizedPnl, currentMargin) {
  if (!currentMargin || currentMargin <= 0 || !isFinite(unrealizedPnl)) return 0;
  return (unrealizedPnl / currentMargin) * 100;
}


// Helper để sync một position từ API
async function syncPositionFromAPI(symbol) {
  try {
    const apiPos = await apiGetPosition(symbol);
    if (!apiPos) return null;

    const existingPos = positions.get(symbol);

    // Tính ROI đúng theo app MEXC
    return {
      symbol: apiPos.symbol ?? symbol,
      side: apiPos.side ?? "SHORT",
      
      entryPrice: Number(apiPos.entryPrice ?? 0),
      quantity: Number(apiPos.quantity ?? 0),
      coins: Number(apiPos.coins ?? 0),
      
      currentMargin: Number(apiPos.currentMargin ?? 0),
      unrealizedPnl: Number(apiPos.unrealizedPnl ?? 0),
      
      realizedPnl: Number(apiPos.realizedPnl ?? 0),
      lastPrice: Number(apiPos.lastPrice ?? 0),
      
      // Giữ lại state từ existing position
      dcaIndex: existingPos?.dcaIndex ?? 0,
      cutCount: existingPos?.cutCount ?? 0,
      inHodlMode: existingPos?.inHodlMode ?? false,
      totalInvestedMargin: existingPos?.totalInvestedMargin ?? apiPos.currentMargin ?? 0,
      initialMargin: existingPos?.initialMargin ?? apiPos.currentMargin ?? 0,
      realizedPnlCumulative: existingPos?.realizedPnlCumulative ?? 0,
      maxRoi: existingPos?.maxRoi,
      lastROI: existingPos?.lastROI ?? calculateMexcAppROI(apiPos.unrealizedPnl, apiPos.currentMargin),
      
      positionId: apiPos.positionId,
    };
  } catch (error) {
    console.error(`❌ Lỗi sync position ${symbol}:`, error);
    return null;
  }
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
    `\nOpen positions: ${positions.size}`;

  await sendMessageWithAutoDelete(msg, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  });
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
  // Nếu chưa có position trong memory -> sync từ API
  let pos = positions.get(symbol);
  if (!pos) {
    const bootPos = await syncPositionFromAPI(symbol);
    if (!bootPos) return;
    positions.set(symbol, bootPos);
    pos = bootPos;
  }

  // Lấy position mới nhất từ API
  const apiPos = await syncPositionFromAPI(symbol);
  if (!apiPos) {
    console.log(`🗑️ Position ${symbol} đã đóng, xóa khỏi memory`);
    positions.delete(symbol);
    await recomputeEquity();
    return;
  }

  //  TÍNH ROI HIỆN TẠI THEO APP MEXC
  const currentROI = calculateMexcAppROI(apiPos.unrealizedPnl, apiPos.currentMargin);
  
  // Debug log
  console.log(`🔍 ${symbol}:`, {
    currentMargin: `$${apiPos.currentMargin.toFixed(4)}`,
    unrealizedPnl: `$${apiPos.unrealizedPnl.toFixed(4)}`,
    currentROI: `${currentROI.toFixed(2)}%`,
    lastROI: `${pos.lastROI?.toFixed(2) || 'N/A'}%`,
    dcaIndex: pos.dcaIndex,
    cutCount: pos.cutCount
  });

  // Lưu lại các trạng thái quản lý trước khi cập nhật
  const savedState = {
    dcaIndex: pos.dcaIndex,
    cutCount: pos.cutCount,
    inHodlMode: pos.inHodlMode,
    maxRoi: pos.maxRoi,
    totalInvestedMargin: pos.totalInvestedMargin,
    initialMargin: pos.initialMargin,
    realizedPnlCumulative: pos.realizedPnlCumulative,
    lastROI: pos.lastROI,
  };

  // Cập nhật data market từ API
  Object.assign(pos, {
    entryPrice: Number(apiPos.entryPrice ?? pos.entryPrice ?? 0),
    quantity: Number(apiPos.quantity ?? pos.quantity ?? 0),
    coins: Number(apiPos.coins ?? pos.coins ?? 0),

    currentMargin: Number(apiPos.currentMargin ?? pos.currentMargin ?? 0),
    unrealizedPnl: Number(apiPos.unrealizedPnl ?? pos.unrealizedPnl ?? 0),
    
    lastPrice: Number(apiPos.lastPrice ?? price ?? pos.lastPrice ?? 0),
    
    realizedPnlCumulative: Number(pos.realizedPnlCumulative ?? 0),
    totalInvestedMargin: Number(pos.totalInvestedMargin ?? 0),
  });

  // Khôi phục trạng thái quản lý
  Object.assign(pos, savedState);
  
  // Đảm bảo default values
  pos.dcaIndex ??= 0;
  pos.cutCount ??= 0;
  pos.inHodlMode ??= false;
  pos.initialMargin ??= pos.currentMargin ?? 0;
  pos.totalInvestedMargin ??= pos.currentMargin ?? 0;
  pos.realizedPnlCumulative ??= 0;
  pos.maxRoi ??= null;
  pos.lastROI ??= currentROI;

  // Cập nhật max ROI
  if (pos.maxRoi === null || currentROI > Number(pos.maxRoi)) {
    pos.maxRoi = currentROI;
  }

  // Recompute equity với P/L thực tế
  await recomputeEquity();

  // --- Loss ratio for HODL ---
  const unrealizedLoss = pos.unrealizedPnl < 0 ? -pos.unrealizedPnl : 0;
  const lossRatio = unrealizedLoss / Math.max(accountState.walletBalance, 1);

  // =========================================================
  //              1) HODL MODE WHEN LOSS TOO HIGH
  // =========================================================
  if (!pos.inHodlMode && lossRatio >= CONFIG.MAX_LOSS_RATIO_FOR_HODL) {
    pos.inHodlMode = true;
    await notifyPositionEvent("🛡 BẮT ĐẦU GỒNG LỖ", symbol, [
      `• ROI hiện tại: ${pct(currentROI)} (P/L: $${usd(pos.unrealizedPnl)})`,
      `• Lỗ ${(lossRatio * 100).toFixed(2)}% tài khoản`,
      `• Dừng DCA – chỉ chờ hồi để chốt.`,
    ]);
  }

  // =========================================================
  //              2) DCA (MULTIPLIER x2 margin hiện tại)
  // =========================================================
  if (!pos.inHodlMode && pos.dcaIndex < CONFIG.DCA_PLAN.length) {
    const plan = CONFIG.DCA_PLAN[pos.dcaIndex];
    const lastROI = Number(pos.lastROI ?? currentROI);
    const now = currentROI;
    const trigger = Number(plan.roiTrigger);

    // Cross-down: từ trên ngưỡng -> xuống dưới/đúng ngưỡng
    const crossedDown = lastROI > trigger && currentROI <= trigger;

    if (crossedDown) {
      // === LOGIC ĐẶC BIỆT: Nếu DCA lần thứ 3 và ROI hồi về -5% đến -10% ===
      if (pos.dcaIndex === 2) { // index 2 = lần DCA thứ 3
        const roiRecovering = pos.lastROI < currentROI; // ROI đang tăng (ít âm hơn)
        const roiInRange = currentROI >= -10 && currentROI <= -5;
        
        if (roiRecovering && roiInRange) {
          console.log(`⚠️ [DCA3 RECOVERY] ${symbol}:`, {
            ROI: currentROI.toFixed(2) + "%",
            lastROI: pos.lastROI.toFixed(2) + "%",
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
              
              // Giữ totalInvestedMargin
              const savedTotalInvestedMargin = pos.totalInvestedMargin;
              
              // Reset DCA về 0
              pos.dcaIndex = 0;
              const newROI = calculateMexcAppROI(pos.unrealizedPnl, pos.currentMargin);
              pos.lastROI = newROI;
              
              // Cập nhật position từ API
              const updatedApiPos = await syncPositionFromAPI(symbol);
              if (updatedApiPos) {
                const savedState2 = {
                  dcaIndex: 0, // RESET
                  cutCount: pos.cutCount,
                  inHodlMode: pos.inHodlMode,
                  maxRoi: pos.maxRoi,
                  totalInvestedMargin: savedTotalInvestedMargin, // GIỮ NGUYÊN
                  initialMargin: pos.initialMargin,
                  lastROI: currentROI,
                  realizedPnlCumulative: pos.realizedPnlCumulative + (closeResult.pnl || 0),
                };
                
                Object.assign(pos, updatedApiPos);
                Object.assign(pos, savedState2);
                
                const { totalBalance: balanceAfter } = await getFuturesBalance();
                const realizedPnl = balanceAfter - balanceBefore;
                
                console.log(`✂️ [DCA3 HALF CUT] ${symbol}:`, {
                  closedQty: closeQty,
                  realizedPnl: "$" + realizedPnl.toFixed(4),
                  newDCAIndex: 0,
                  totalInvestedMargin: "$" + savedTotalInvestedMargin.toFixed(4),
                  newMargin: "$" + Number(pos.currentMargin ?? 0).toFixed(4),
                });
                
                await notifyPositionEvent("✂️ DCA3 RECOVERY CUT", symbol, [
                  `• Đã DCA 3 lần, ROI hồi phục về -5→-10%`,
                  `• Cắt 50% volume, chốt: $${usd(realizedPnl)}`,
                  `• Reset DCA index về 0`,
                  `• ROI hiện tại: ${pct(currentROI)} (trước: ${pct(pos.lastROI)})`,
                  `• Điều kiện: ROI hồi về -5→-10%`,
                ]);
                
                return; // Không thực hiện DCA tiếp
              }
            }
          }
        }
      }
      
      // === DCA BÌNH THƯỜNG: margin hiện tại × 2 ===
      const currentMargin = Number((pos.currentMargin || 0).toFixed(4));
      const addMargin = currentMargin; 

      // Check balance
      await checkAndTransferBalance();
      const { totalBalance } = await getFuturesBalance();
      if (totalBalance < addMargin) {
        console.log(`⚠️ Không đủ balance cho DCA ${symbol}: ${totalBalance} < ${addMargin}`);
        pos.lastROI = now;
        return;
      }

      const contractInfo = await getContractInfo(symbol);
      const addQty = await calculateDCAPositionSize(symbol, addMargin / totalBalance);

      if (addQty <= 0) {
        console.log(`⚠️ Quantity DCA quá nhỏ: ${addQty}`);
        pos.lastROI = now;
        return;
      }

      console.log(` Executing DCA Level ${pos.dcaIndex + 1} for ${symbol}:`, {
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

          // ✅ CẬP NHẬT totalInvestedMargin (cộng dồn vốn đầu tư)
          const newTotalInvestedMargin = pos.totalInvestedMargin + addMargin;

          const savedState2 = {
            dcaIndex: newDcaIndex,
            cutCount: pos.cutCount,
            inHodlMode: pos.inHodlMode,
            maxRoi: Math.max(Number(pos.maxRoi ?? 0), currentROI),
            totalInvestedMargin: newTotalInvestedMargin, // CỘNG DỒN
            initialMargin: Number(pos.initialMargin ?? 0), // Giữ initialMargin cũ
            realizedPnlCumulative: pos.realizedPnlCumulative,
            lastROI: currentROI,
          };

          Object.assign(pos, updatedApiPos);
          Object.assign(pos, savedState2);

          console.log(`✅ DCA Level ${newDcaIndex}/${CONFIG.DCA_PLAN.length} completed for ${symbol}:`, {
            currentMargin: "$" + currentMargin.toFixed(4),
            addMargin: "$" + addMargin.toFixed(4),
            totalInvestedMargin: "$" + newTotalInvestedMargin.toFixed(4),
            newEntry: Number(pos.entryPrice ?? 0).toFixed(6),
            newROI: currentROI.toFixed(2) + "%",
            newMargin: "$" + Number(pos.currentMargin ?? 0).toFixed(4),
            nextTrigger: newDcaIndex < CONFIG.DCA_PLAN.length
              ? CONFIG.DCA_PLAN[newDcaIndex].roiTrigger + "%"
              : "MAX",
          });

          await notifyPositionEvent("➕ DCA", symbol, [
            `• DCA nhân đôi margin hiện tại: x2`,
            `• Margin hiện tại: $${usd(currentMargin)}`,
            `• Margin thêm: $${usd(addMargin)}`,
            `• Tổng vốn đầu tư: $${usd(newTotalInvestedMargin)}`,
            `• Giá DCA: $${usd(price)}`,
            `• Entry mới: $${usd(pos.entryPrice)}`,
            `• Unrealized P/L: $${usd(pos.unrealizedPnl)} (${pct(currentROI)})`,
            `• Realized cummulative: $${usd(pos.realizedPnlCumulative)}`,
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
  const cutThreshold = Number(accountState.baseCapital) * Number(CONFIG.EQUITY_CUT_RATIO);
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
          // ✅ GIỮ NGUYÊN totalInvestedMargin (vốn đã đầu tư không giảm)
          const savedTotalInvestedMargin = pos.totalInvestedMargin;
          
          const savedState3 = {
            dcaIndex: pos.dcaIndex,
            cutCount: pos.cutCount + 1,
            inHodlMode: pos.inHodlMode,
            maxRoi: pos.maxRoi,
            totalInvestedMargin: savedTotalInvestedMargin, // GIỮ NGUYÊN
            initialMargin: pos.initialMargin,
            lastROI: currentROI,
            realizedPnlCumulative: pos.realizedPnlCumulative + (closeResult.pnl || 0),
          };

          Object.assign(pos, updatedApiPos);
          Object.assign(pos, savedState3);

          const { totalBalance: balanceAfter } = await getFuturesBalance();
          const realizedPnlFromCut = balanceAfter - balanceBefore;

          await recomputeEquity();

          console.log(`✂️ Partial cut successful for ${symbol}:`, {
            cutPnl: "$" + realizedPnlFromCut.toFixed(4),
            newQuantity: pos.quantity,
            newMargin: Number(pos.currentMargin ?? 0).toFixed(4),
            newROI: currentROI.toFixed(2) + "%",
            totalInvestedMargin: "$" + savedTotalInvestedMargin.toFixed(4),
            cutCount: pos.cutCount,
          });

          await notifyPositionEvent("✂️ PARTIAL STOP LOSS", symbol, [
            `• Cắt ${(portion * 100).toFixed(1)}% vị thế`,
            `• Đã chốt: $${usd(realizedPnlFromCut)} ở ROI ${pct(currentROI)}`,
            `• Vốn đầu tư: $${usd(savedTotalInvestedMargin)} (giữ nguyên)`,
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
  const enoughProfit = currentROI >= CONFIG.MIN_PROFIT_ROI_FOR_TRAIL;
  const droppedFromMax = pos.maxRoi !== null &&
    Number(pos.maxRoi ?? 0) - currentROI >= CONFIG.TRAIL_DROP_FROM_MAX_ROI;
  const priceCrossUpMA10 = ma10 && price > ma10;

  if (enoughProfit && (droppedFromMax || priceCrossUpMA10)) {
    const { totalBalance: balanceBefore } = await getFuturesBalance();

    const closeResult = await apiClosePosition(symbol, pos.quantity, "SHORT");

    if (closeResult.success) {
      await new Promise((r) => setTimeout(r, 1000));

      const { totalBalance: balanceAfter } = await getFuturesBalance();
      const realizedPnl = balanceAfter - balanceBefore;

      // ✅ TÍNH ROI TRADE (PnL / Tổng vốn đầu tư)
      const tradeROI = pos.totalInvestedMargin > 0 
        ? (realizedPnl / pos.totalInvestedMargin) * 100 
        : 0;

      positions.delete(symbol);
      await recomputeEquity();

      console.log(`✅ Take profit successful for ${symbol}:`, {
        realizedPnl: "$" + realizedPnl.toFixed(4),
        roiAtClose: currentROI.toFixed(2) + "%",
        tradeROI: tradeROI.toFixed(2) + "%", // ROI của toàn trade
        maxRoi: pos.maxRoi == null ? null : Number(pos.maxRoi).toFixed(2) + "%",
        totalInvestedMargin: "$" + pos.totalInvestedMargin.toFixed(4),
        balanceChange: "$" + (balanceAfter - balanceBefore).toFixed(4),
      });

      const reason = priceCrossUpMA10 ? "Giá chạm/cắt MA10 → Trend đảo" : "Trailing Stop theo ROI";

      await notifyPositionEvent("✅ TAKE PROFIT", symbol, [
        `• ROI tại close: ${pct(currentROI)} (Unrealized P/L: $${usd(pos.unrealizedPnl)})`,
        `• Trade ROI: ${pct(tradeROI)} (Realized P/L: $${usd(realizedPnl)})`,
        `• Vốn đầu tư: $${usd(pos.totalInvestedMargin)}`,
        `• Max ROI trước đó: ${pct(pos.maxRoi ?? 0)}`,
        `• ${reason}`,
        `• Entry: $${usd(pos.entryPrice)} → Exit: $${usd(price)}`,
      ]);
    } else {
      console.log(`❌ Take profit ${symbol} thất bại:`, closeResult.error);
      await notifyPositionEvent("❌ TP THẤT BẠI", symbol, [
        `• Lỗi khi đóng position: ${closeResult.error}`,
        `• ROI hiện tại: ${pct(currentROI)}`,
      ]);
    }
  }

  // ✅ update lastROI cuối hàm cho lần tick sau
  pos.lastROI = currentROI;
}
// =========================================================
//        BACKGROUND TASK: CHECK BOTTOM SAFETY (RETRY)
// =========================================================
async function monitorBottomSafety(symbol) {
  // Chỉ chạy loop nếu position vẫn còn mở
  if (!positions.has(symbol)) return;

  logDebug(`🛡️ Starting bottom check monitor for ${symbol}...`);

  // Loop retry mãi mãi nếu gặp lỗii 510/429
  // Nếu check ra kết quả:
  // - Safe: Stop loop
  // - Unsafe: Close position ngay lập tức
  
  const checkInterval = 15000; // 15s

  const loop = async () => {
    if (!positions.has(symbol)) return; // Position đã đóng -> dừng

    try {
      // Gọi get7DayBottomPrice với throwError = true để bắt lỗi 510
      const bottomData = await get7DayBottomPrice(symbol, false, true); 

      if (!bottomData) {
         // Null data but valid call? -> retry next loop
         setTimeout(loop, checkInterval);
         return;
      }

      // Có data -> Check logic
      const pos = positions.get(symbol);
      const comparePrice = pos.lastPrice || pos.entryPrice; 
      
      const aboveBottomPct = ((comparePrice - bottomData.bottomPrice) / bottomData.bottomPrice) * 100;
      const isSafe = aboveBottomPct >= CONFIG.MIN_ABOVE_BOTTOM_PCT;

      if (isSafe) {
        console.log(`✅ [BOTTOM_MONITOR_PASS] ${symbol}: +${aboveBottomPct.toFixed(2)}% above bottom. Keeping position.`);
        return; // Dừng check loop
      } else {
        // FAIL -> Close immediately
        console.warn(`🚨 [BOTTOM_MONITOR_FAIL] ${symbol}: Only +${aboveBottomPct.toFixed(2)}% above bottom (Required: ${CONFIG.MIN_ABOVE_BOTTOM_PCT}%). CLOSING POSITION!`);
        
        await notifyPositionEvent("🚨 BOTTOM SAFETY TRIGGER", symbol, [
            `• Bottom Check sau khi vào lệnh phát hiện rủi ro.`,
            `• Giá đáy 7 ngày: $${usd(bottomData.bottomPrice)}`,
            `• Chênh lệch: +${aboveBottomPct.toFixed(2)}% (Mức an toàn: ${CONFIG.MIN_ABOVE_BOTTOM_PCT}%)`,
            `• ĐÓNG LỆNH KHẨN CẤP!`
        ]);

        const closeResult = await apiClosePosition(symbol, pos.quantity, "SHORT");
        if (closeResult.success) {
            positions.delete(symbol);
            await recomputeEquity();
            console.log(`✅ [BOTTOM_MONITOR] Position ${symbol} closed successfully.`);
        } else {
            console.error(`❌ [BOTTOM_MONITOR] Failed to close ${symbol}: ${closeResult.error}`);
        }
        return; // Stop check loop
      }

    } catch (err) {
      // Check lỗi 510, 429
      const msg = err.message || "";
      if (msg.includes("510") || msg.includes("429") || msg.includes("Too Many Requests")) {
        console.log(`⏳ [BOTTOM_MONITOR_WAIT] ${symbol}: API busy (510/429), retrying in 15s...`);
        setTimeout(loop, checkInterval);
      } else {
        // Lỗi khác (network, 500...) -> Log và vẫn retry? 
        console.error(`⚠️ [BOTTOM_MONITOR_ERR] ${symbol}: ${msg}. Retrying...`);
        setTimeout(loop, checkInterval);
      }
    }
  };

  loop();
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
      initialMargin: actualMargin,
      
      totalInvestedMargin: actualMargin,     // Dùng tính ROI
      currentMargin: actualMargin,           // Hiện tại từ API
      
      leverage: CONFIG.LEVERAGE,
      // pnl: 0,
      // realizedPnl: 0,
      lastPrice: price,
      lastROI: 0,

      unrealizedPnl: 0,                   // PnL chưa chốt
      
      realizedPnlCumulative: 0,           // PnL đã chốt

      maxRoi: null,
      dcaIndex: 0,
      cutCount: 0,
      inHodlMode: false,
      
      // THÊM: peak invested margin
      peakInvestedMargin: actualMargin,
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
    
    // ----------------------------------------------------
    // START BOTTOM CHECK MONITOR (Async)
    // ----------------------------------------------------
    monitorBottomSafety(symbol);
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

// Sync all positions from API khi khởi động
export async function syncAllPositionsFromAPI() {
  try {
    console.log("🔄 Syncing positions từ API...");

    const apiPositions = await getOpenPositions();
    console.log(`📊 API returned ${apiPositions.length} positions`);

    const activeSymbols = new Set();

    // 1) Update/Add positions còn mở
    for (const apiPosRaw of apiPositions) {
      const symbol = apiPosRaw.symbol;
      const holdVol = Number(apiPosRaw.holdVol || apiPosRaw.volume || 0);

      if (!symbol || holdVol === 0) continue;

      activeSymbols.add(symbol);

      // Lấy position chi tiết từ API
      const apiPos = await apiGetPosition(symbol);
      if (!apiPos) continue;

      const existingPos = positions.get(symbol);

      //  TÍNH ROI ĐÚNG THEO APP MEXC
      const unrealizedROI = calculateMexcAppROI(apiPos.unrealizedPnl, apiPos.currentMargin);

      // Tạo position object với state đầy đủ
      const safePos = {
        symbol: apiPos.symbol ?? symbol,
        side: apiPos.side ?? "SHORT",

        entryPrice: Number(apiPos.entryPrice ?? 0),
        quantity: Number(apiPos.quantity ?? 0),
        coins: Number(apiPos.coins ?? 0),

        //  Các field để tính ROI đúng
        currentMargin: Number(apiPos.currentMargin ?? 0),
        unrealizedPnl: Number(apiPos.unrealizedPnl ?? 0),
        
        //  ROI tính đúng (không dùng apiPos.roi)
        // unrealizedROI: unrealizedROI,
        
        // Field tracking
        realizedPnlCumulative: Number(existingPos?.realizedPnlCumulative ?? apiPos.realizedPnl ?? 0),
        totalInvestedMargin: Number(existingPos?.totalInvestedMargin ?? apiPos.currentMargin ?? 0),
        initialMargin: Number(existingPos?.initialMargin ?? apiPos.currentMargin ?? 0),

        leverage: CONFIG.LEVERAGE,
        lastPrice: Number(apiPos.lastPrice ?? 0),
        
        //  State quản lý (giữ từ existing nếu có)
        dcaIndex: existingPos?.dcaIndex ?? 0,
        cutCount: existingPos?.cutCount ?? 0,
        inHodlMode: existingPos?.inHodlMode ?? false,
        maxRoi: existingPos?.maxRoi ?? (unrealizedROI > 0 ? unrealizedROI : null),
        lastROI: existingPos?.lastROI ?? unrealizedROI,
        
        //  Field API
        positionId: apiPos.positionId,
        marginRatio: apiPos.marginRatio || 0,
      };

      positions.set(symbol, safePos);

      console.log(
        `✅ Đã sync position: ${symbol}, ` +
        `Qty: ${safePos.quantity} contracts, ` +
        `Margin: $${safePos.currentMargin.toFixed(4)}, ` +
        `Unrealized PnL: $${safePos.unrealizedPnl.toFixed(4)}, ` +
        `ROI: ${unrealizedROI.toFixed(2)}%`
      );
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
    const currentMargin = Number(pos.currentMargin ?? 0);
    const unrealizedPnl = Number(pos.unrealizedPnl ?? 0);

    // ✅ ROI đúng kiểu app MEXC
    const appROI = calculateMexcAppROI(unrealizedPnl, currentMargin);

    // ROI của toàn trade (đã chốt)
    const tradeROI =
      pos.totalInvestedMargin > 0
        ? (pos.realizedPnlCumulative / pos.totalInvestedMargin) * 100
        : 0;

    console.log(
      `• ${symbol} | ${pos.side}` +
      ` | Qty: ${Number(pos.quantity ?? 0)}` +
      ` | Entry: $${Number(pos.entryPrice ?? 0).toFixed(6)}` +
      ` | Margin: $${currentMargin.toFixed(4)}` +
      ` | U-PnL: $${unrealizedPnl.toFixed(4)}` +
      ` | ROI(app): ${appROI.toFixed(2)}%` +
      ` | TradeROI: ${tradeROI.toFixed(2)}%` +
      ` | DCA: ${pos.dcaIndex}` +
      ` | Cut: ${pos.cutCount}` +
      ` | HODL: ${pos.inHodlMode ? "ON" : "OFF"}`
    );
  }

  console.log(
    `\n Wallet: $${Number(accountState.walletBalance).toFixed(2)}` +
    ` | Equity: $${Number(accountState.equity).toFixed(2)}\n`
  );
}
