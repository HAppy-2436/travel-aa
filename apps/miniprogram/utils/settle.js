/**
 * 结算算法模块
 * 使用贪心算法生成最少转账次数的结算方案
 *
 * 说明：均分/分摊统一使用共享 AI 引擎的最大余额法（utils/ai.js#allocateEvenly），
 * 贪心结算逻辑与 server/app.js、demo/index.html 保持同一实现口径，改动请三处同步。
 *
 * V2：多币种结算 —— 外币账单按记账时快照汇率折算人民币（utils/ai.js#billCNY），
 * 分摊明细按同一比例折算，保证折算后账恒平。
 */
const { allocateEvenly, billCNY, isSettleable, isPersonalBill, groupSpend } = require('./ai');

/**
 * 计算最简转账方案
 * @param {Array} members - 成员列表 [{id, name, avatar}]
 * @param {Array} bills - 账单列表 [{payer, amount, currency?, rate?, cnyAmount?, splits: [{memberId, amount}]}]
 * @returns {Object} { balances: [{id, name, amount}], transfers: [{from, to, amount}], currencies, hasForeign }
 */
function calculateSettlement(members, bills) {
  // 1. 计算每个人的净余额（统一折算人民币）
  const balanceMap = {};
  members.forEach(m => {
    balanceMap[m.id] = { ...m, amount: 0 };
  });

  /* 只结算「集体账」：私账（人情账）不进 AA，占位单/作废单也不参与。
     ⚠️ 判据一律走共享内核（isSettleable / isPersonalBill），不在这里另写一套 ——
        三端口径只用一份代码，否则网页说私账、小程序说集体账。 */
  const settleable = (bills || []).filter(b => isSettleable(b) && !isPersonalBill(b));

  settleable.forEach(bill => {
    const cny = billCNY(bill);
    const rawAmount = Number(bill.amount) || 0;
    // 外币账单：分摊明细按 "折算额/原币额" 同比例折算，sum(折算分摊) === 折算账单额
    //
    // ⚠️ 调整单（多退少补 / 暂估改价）的 amount 恒为 0，rawAmount>0 不成立，
    //    早期实现会退化成 scale=1 —— 把"原币口径的 splits"当人民币直接扣减，
    //    而贷方走 billCNY（已折算）→ **单侧折算**，日元偏差 1/0.048 ≈ 20.8 倍。
    //    且两侧 Σ 恰好都为 0，所以"账恒平"断言与全部测试都不会发现。
    //    修法：amount 为 0 时改用账单自身快照汇率（调整单的 rate 沿用原账单汇率）。
    const scale = rawAmount > 0 ? cny / rawAmount : (Number(bill.rate) > 0 ? Number(bill.rate) : 1);
    // 付款人应收金额
    if (balanceMap[bill.payer]) {
      balanceMap[bill.payer].amount += cny;
    }
    // 每个人应付金额
    bill.splits.forEach(split => {
      if (balanceMap[split.memberId]) {
        balanceMap[split.memberId].amount -= split.amount * scale;
      }
    });
  });

  // 2. 转换为数组，去除余额为0的人
  const balances = Object.values(balanceMap)
    .map(b => ({ ...b, amount: Math.round(b.amount * 100) / 100 }))
    .filter(b => Math.abs(b.amount) > 0.01);

  // 3. 贪心算法：每次让最多应收的人和最多应付的人结算
  // 注意：必须复制对象再扣减，否则贪心过程会把 balances 里的展示金额清零
  const transfers = [];
  const debtors = balances.filter(b => b.amount < -0.01).map(b => ({ ...b })).sort((a, b) => a.amount - b.amount);
  const creditors = balances.filter(b => b.amount > 0.01).map(b => ({ ...b })).sort((a, b) => b.amount - a.amount);

  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const debtor = debtors[i];
    const creditor = creditors[j];
    const settleAmount = Math.min(-debtor.amount, creditor.amount);

    if (settleAmount > 0.01) {
      transfers.push({
        from: debtor.id,
        fromName: debtor.name,
        fromAvatar: debtor.avatar,
        to: creditor.id,
        toName: creditor.name,
        toAvatar: creditor.avatar,
        amount: Math.round(settleAmount * 100) / 100
      });
    }

    debtor.amount += settleAmount;
    creditor.amount -= settleAmount;

    if (Math.abs(debtor.amount) < 0.01) i++;
    if (Math.abs(creditor.amount) < 0.01) j++;
  }

  // 4. 币种汇总（有外币时提示折算结算）
  const currencies = [...new Set(settleable.map(b => (b && b.currency) || 'CNY'))];
  const hasForeign = currencies.some(c => c !== 'CNY');

  return {
    balances: balances.sort((a, b) => b.amount - a.amount),
    transfers,
    /* ⚠️ 这里的「总消费」必须和 `balances/transfers` 同一口径（只算集体账）。
       以前是 bills.reduce(...) 把**全部**账单求和 → 私账把钱撑进"旅行总消费"，
       可是下面各人收支又只算集体账，于是"总额 ≠ 各人之和"，也对不上网页端。
       统一用内核 groupSpend()。 */
    totalExpense: Math.round(groupSpend(bills).total * 100) / 100,
    currencies,
    hasForeign
  };
}

/**
 * 生成账单分享文本
 */
function generateShareText(roomInfo, settlement) {
  let text = `✈️ 【${roomInfo.name || '旅行AA'}】结算单\n`;
  text += `━━━━━━━━━━━━━━━\n`;
  text += `📍 ${roomInfo.destination || ''} \n`;
  text += `📅 ${roomInfo.startDate || ''} ~ ${roomInfo.endDate || ''}\n`;
  text += `👥 ${roomInfo.memberCount || 0}人\n`;
  text += `💰 总消费: ¥${settlement.totalExpense.toFixed(2)}\n`;
  if (settlement.hasForeign) {
    text += `💱 含 ${settlement.currencies.filter(c => c !== 'CNY').join('/')} 消费，已按记账汇率折算人民币结算\n`;
  }
  text += `━━━━━━━━━━━━━━━\n\n`;

  text += `💳 各人收支:\n`;
  settlement.balances.forEach(b => {
    const sign = b.amount >= 0 ? '+' : '';
    text += `  ${b.name}: ${sign}¥${b.amount.toFixed(2)}\n`;
  });

  text += `\n🔄 最简转账方案(${settlement.transfers.length}笔):\n`;
  settlement.transfers.forEach((t, i) => {
    text += `  ${i + 1}. ${t.fromName} → ${t.toName}: ¥${t.amount.toFixed(2)}\n`;
  });

  text += `\n━━━━━━━━━━━━━━━\n`;
  text += `由 TravelAA 旅行AA记账小程序 生成`;
  return text;
}

module.exports = {
  calculateSettlement,
  generateShareText,
  // 再导出共享引擎的最大余额法均分，保持调用方单入口
  allocateEvenly
};
