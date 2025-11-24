// src/account.js
import { CONFIG } from './config.js';
import { sendMessageWithAutoDelete } from './telegram.js';

export const accountState = {
  walletBalance: CONFIG.ACCOUNT_BALANCE_START,
  equity: CONFIG.ACCOUNT_BALANCE_START,
  baseCapital: CONFIG.ACCOUNT_BASE_CAPITAL,
  realizedPnl: 0,
};

export const positions = new Map(); // key: symbol

// ---------- Helper formatting ----------
function formatUsd(v) {
  if (Math.abs(v) >= 1) return v.toFixed(2);
  if (Math.abs(v) >= 0.01) return v.toFixed(4);
  return v.toFixed(6);
}

function formatPct(v) {
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

// ---------- Equity ----------
export function recomputeEquity() {
  let unrealized = 0;
  for (const pos of positions.values()) unrealized += pos.pnl || 0;
  accountState.equity = accountState.walletBalance + unrealized;
}

// ---------- Notify ----------
export async function notifyPositionEvent(title, symbol, bodyLines) {
  const msg =
    `${title}: [${symbol}](https://mexc.co/futures/${symbol}?type=swap)\n` +
    bodyLines.join('\n') +
    `\n\n💰 Balance: $${formatUsd(accountState.walletBalance)} | Equity: $${formatUsd(accountState.equity)}\n` +
    `📊 Open positions: ${positions.size}`;
  await sendMessageWithAutoDelete(msg, {
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
  });
}

// ---------- ROI SHORT ----------
function calcShortRoi(entryPrice, currentPrice) {
  if (!entryPrice || !currentPrice) return 0;
  const priceChange = entryPrice - currentPrice;
  return (priceChange / entryPrice) * CONFIG.LEVERAGE * 100;
}

// ---------- Update position với giá mới ----------
export async function updatePositionWithPrice(symbol, currentPrice, ma10) {
  const pos = positions.get(symbol);
  if (!pos) return;

  pos.lastPrice = currentPrice;
  pos.roi = calcShortRoi(pos.entryPrice, currentPrice);
  pos.pnl = pos.margin * (pos.roi / 100);
  if (pos.maxRoi === null || pos.roi > pos.maxRoi) pos.maxRoi = pos.roi;

  recomputeEquity();

  const unrealizedLoss = pos.pnl < 0 ? -pos.pnl : 0;
  const lossRatioToBalance =
    accountState.walletBalance > 0 ? unrealizedLoss / accountState.walletBalance : 0;

  // 1) lệnh âm >= 60% balance => ngừng DCA, chuyển sang gồng lỗ
  if (!pos.inHodlMode && lossRatioToBalance >= CONFIG.MAX_LOSS_RATIO_FOR_HODL) {
    pos.inHodlMode = true;
    await notifyPositionEvent('🛡 BẮT ĐẦU GỒNG LỖ', symbol, [
      `• ROI hiện tại: ${formatPct(pos.roi)} (P/L: $${formatUsd(pos.pnl)})`,
      `• Lỗ ~${(lossRatioToBalance * 100).toFixed(1)}% tài khoản ⇒ Dừng DCA, chờ hồi chốt lời.`,
    ]);
  }

  // 2) DCA khi chưa vào chế độ gồng lỗ
  if (!pos.inHodlMode && pos.dcaIndex < CONFIG.DCA_PLAN.length) {
    const plan = CONFIG.DCA_PLAN[pos.dcaIndex];
    if (pos.roi <= plan.roiTrigger) {
      const addMargin = accountState.walletBalance * plan.addPercent;
      if (addMargin > 0) {
        const addNotional = addMargin * CONFIG.LEVERAGE;
        const addQty = addNotional / currentPrice;

        const newNotional = pos.notional + addNotional;
        const newEntry =
          (pos.entryPrice * pos.notional + currentPrice * addNotional) / newNotional;

        pos.margin += addMargin;
        pos.notional = newNotional;
        pos.quantity += addQty;
        pos.entryPrice = newEntry;
        pos.dcaIndex += 1;

        pos.roi = calcShortRoi(pos.entryPrice, currentPrice);
        pos.pnl = pos.margin * (pos.roi / 100);
        recomputeEquity();

        await notifyPositionEvent('➕ DCA', symbol, [
          `• DCA level: ${pos.dcaIndex}/${CONFIG.DCA_PLAN.length}`,
          `• Thêm margin: $${formatUsd(addMargin)} (${(plan.addPercent * 100).toFixed(2)}% account)`,
          `• Entry mới: $${formatUsd(pos.entryPrice)}`,
          `• ROI sau DCA: ${formatPct(pos.roi)} (P/L: $${formatUsd(pos.pnl)})`,
        ]);
      }
    }
  }

  // 3) Equity < 25% vốn cơ sở => cắt 10% lệnh, tối đa 3 lần
  const equityThreshold = accountState.baseCapital * CONFIG.EQUITY_CUT_RATIO;
  if (accountState.equity < equityThreshold && pos.cutCount < CONFIG.MAX_PARTIAL_CUTS) {
    const cutPortion = CONFIG.PARTIAL_CUT_PERCENT;
    const pnlToRealize = (pos.pnl || 0) * cutPortion;

    pos.quantity *= 1 - cutPortion;
    pos.margin *= 1 - cutPortion;
    pos.notional *= 1 - cutPortion;
    pos.pnl *= 1 - cutPortion;

    pos.cutCount += 1;

    accountState.walletBalance += pnlToRealize;
    accountState.realizedPnl += pnlToRealize;
    recomputeEquity();

    await notifyPositionEvent('✂️ PARTIAL STOP LOSS', symbol, [
      `• Cắt ${(cutPortion * 100).toFixed(0)}% vị thế (Lần ${pos.cutCount}/${CONFIG.MAX_PARTIAL_CUTS})`,
      `• P/L đã chốt: $${formatUsd(pnlToRealize)} (${formatPct(pos.roi)})`,
      `• Vị thế còn lại: margin ~$${formatUsd(pos.margin)}, notional ~$${formatUsd(
        pos.notional
      )}`,
    ]);
  }

  // 4) Take profit theo trend (trailing + MA10)
  const enoughProfit = pos.roi >= CONFIG.MIN_PROFIT_ROI_FOR_TRAIL;
  const droppedFromMax =
    pos.maxRoi !== null && pos.maxRoi - pos.roi >= CONFIG.TRAIL_DROP_FROM_MAX_ROI;
  const priceCrossUpMA10 = ma10 && currentPrice > ma10;

  if (enoughProfit && (droppedFromMax || priceCrossUpMA10)) {
    const closePnl = pos.pnl || 0;
    accountState.walletBalance += closePnl;
    accountState.realizedPnl += closePnl;
    positions.delete(symbol);
    recomputeEquity();

    await notifyPositionEvent('✅ TAKE PROFIT', symbol, [
      `• ROI chốt: ${formatPct(pos.roi)} (P/L: $${formatUsd(closePnl)})`,
      `• Max ROI trước đó: ${
        pos.maxRoi !== null ? formatPct(pos.maxRoi) : 'N/A'
      }`,
      priceCrossUpMA10
        ? '• Lý do: Giá cắt lên MA10 (trend đảo chiều)'
        : '• Lý do: Trailing stop theo ROI',
    ]);
  }
}

// ---------- Mở lệnh SHORT ----------
export async function openShortPosition(symbol, currentPrice, context) {
  // Nếu đã mở tối đa 3 lệnh -> KHÔNG mở thêm, nhưng vẫn phải gửi tín hiệu
  if (positions.size >= CONFIG.MAX_OPEN_POSITIONS) {
    await notifyPositionEvent('⚠️ FULL VỊ THẾ', symbol, [
      `• Bot đã mở tối đa ${CONFIG.MAX_OPEN_POSITIONS} lệnh.`,
      `• KHÔNG mở thêm vị thế mới.`,
      `• Đây chỉ là tín hiệu SHORT giúp bạn vào tay nếu muốn.`,
      `• Điểm vào lệnh tham chiếu: $${formatUsd(currentPrice)}`,
      `• Lý do tín hiệu: ${context}`,
    ]);
    return; // Không mở lệnh mô phỏng
  }

  // Nếu đã có lệnh với coin này rồi -> không mở thêm lệnh mới
  if (positions.has(symbol)) return;

  // Margin = 0.5% tài khoản (hoặc % bạn cấu hình)
  const margin = accountState.walletBalance * CONFIG.ENTRY_PERCENT; 
  if (margin <= 0) return;

  const notional = margin * CONFIG.LEVERAGE;
  const quantity = notional / currentPrice;

  const pos = {
    symbol,
    side: 'short',
    entryPrice: currentPrice,
    quantity,
    notional,
    margin,
    leverage: CONFIG.LEVERAGE,
    openedAt: Date.now(),
    lastPrice: currentPrice,
    pnl: 0,
    roi: 0,
    maxRoi: null,
    dcaIndex: 0,
    inHodlMode: false,
    cutCount: 0,
  };

  positions.set(symbol, pos);
  recomputeEquity();

  // Gửi log về telegram
  await notifyPositionEvent('🚀 OPEN SHORT', symbol, [
    `• Entry SHORT: $${formatUsd(currentPrice)}`,
    `• Margin: $${formatUsd(margin)} (${(CONFIG.ENTRY_PERCENT * 100).toFixed(2)}% tài khoản)`,
    `• Đòn bẩy: x${CONFIG.LEVERAGE}`,
    `• Notional ~ $${formatUsd(notional)}`,
    `• Lý do vào lệnh: ${context}`,
  ]);
}
