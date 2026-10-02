// 云函数入口文件 - settle
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

/**
 * 贪心算法计算最简转账方案
 * V2：多币种账单按记账快照汇率（currency/rate/cnyAmount）折算人民币，
 * 分摊明细同比例折算，折算后账恒平；与 apps/miniprogram/utils/settle.js 同一口径
 */
function billCNY(bill) {
  if (!bill) return 0;
  if (bill.cnyAmount != null) return Math.round(Number(bill.cnyAmount) * 100) / 100;
  if (bill.currency && bill.currency !== 'CNY' && bill.rate != null) {
    return Math.round(Number(bill.amount) * Number(bill.rate) * 100) / 100;
  }
  return Math.round(Number(bill.amount || 0) * 100) / 100;
}

function calculateSettlement(members, bills) {
  const balanceMap = {};
  members.forEach(m => {
    balanceMap[m.id] = { ...m, amount: 0 };
  });

  const currencies = new Set();
  bills.forEach(bill => {
    if (!bill || !bill.splits) return;
    currencies.add(bill.currency || 'CNY');
    const cny = billCNY(bill);
    const rawAmount = Number(bill.amount) || 0;
    const scale = rawAmount > 0 ? cny / rawAmount : 1;
    if (balanceMap[bill.payer]) {
      balanceMap[bill.payer].amount += cny;
    }
    bill.splits.forEach(split => {
      if (balanceMap[split.memberId]) {
        balanceMap[split.memberId].amount -= split.amount * scale;
      }
    });
  });

  const balances = Object.values(balanceMap)
    .map(b => ({ ...b, amount: Math.round(b.amount * 100) / 100 }))
    .filter(b => Math.abs(b.amount) > 0.01);

  // 贪心匹配（复制对象再扣减，保留 balances 展示金额）
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
        to: creditor.id,
        toName: creditor.name,
        amount: Math.round(settleAmount * 100) / 100
      });
    }

    debtor.amount += settleAmount;
    creditor.amount -= settleAmount;

    if (Math.abs(debtor.amount) < 0.01) i++;
    if (Math.abs(creditor.amount) < 0.01) j++;
  }

  return {
    balances: balances.sort((a, b) => b.amount - a.amount),
    transfers,
    totalExpense: Math.round(bills.reduce((sum, b) => sum + billCNY(b), 0) * 100) / 100,
    currencies: [...currencies],
    hasForeign: [...currencies].some(c => c !== 'CNY')
  };
}

// 云函数入口函数
exports.main = async (event, context) => {
  const { roomId } = event;

  try {
    // 获取房间信息
    const roomDoc = await db.collection('rooms').doc(roomId).get();
    const room = roomDoc.data;

    // 获取所有账单
    const { data: bills } = await db.collection('bills')
      .where({ roomId })
      .get();

    // 计算结算
    const settlement = calculateSettlement(room.members, bills);

    return {
      success: true,
      ...settlement
    };
  } catch (err) {
    return {
      success: false,
      error: err.message
    };
  }
};
