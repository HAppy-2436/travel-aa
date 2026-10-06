// 云函数：删除账单
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const { billId } = event;

  try {
    // 1. 获取账单
    const { data: bill } = await db.collection('bills').doc(billId).get();

    // 2. 权限校验：只有创建者或付款人可以删除
    if (bill.createdBy !== openid && bill.payer !== openid) {
      return { success: false, error: '无权删除此账单' };
    }

    // 3. 删除账单
    await db.collection('bills').doc(billId).remove();

    // 4. 更新房间统计
    //
    // ⚠️ 口径必须与 addBill 一致：addBill 用 `_.inc(bill.cnyAmount)`（**人民币**），
    //    而这里早期用 `_.inc(-bill.amount)`（**原币**）——
    //    删一笔 24000 JPY（rate 0.048）会让房间总消费凭空少 24000 而非 1152（差 20.8 倍）。
    //    更稳妥的是删完按库内剩余账单重算（见下方 recompute），避免长期增量漂移。
    const deduct = Number.isFinite(Number(bill.cnyAmount)) ? Number(bill.cnyAmount) : Number(bill.amount) || 0;

    await db.collection('rooms').doc(bill.roomId).update({
      data: {
        billCount: _.inc(-1),
        totalExpense: _.inc(-deduct),
        updatedAt: new Date()
      }
    });

    // 4'. 重算校验：把房间统计拉回"由剩余账单重新累加"的真值。
    //     增量更新在并发/历史数据下会漂移，重算是最终一致性保障。
    //     ⚠️ 单次查询上限 100 条：**只有没被截断时**才敢用重算结果覆盖 billCount，
    //        否则账单超过 100 笔会把数量写小。被截断时保留增量值（宁可略漂，不可明显错）。
    try {
      const MAX = 100;       // 云数据库单次查询上限
      const { data: rest } = await db.collection('bills')
        .where({ roomId: bill.roomId }).limit(MAX).get();
      const truncated = rest.length >= MAX;
      const total = rest.reduce((s, b) => s + (Number(b.cnyAmount) || Number(b.amount) || 0), 0);
      const patch = { totalExpense: Math.round(total * 100) / 100, updatedAt: new Date() };
      if (!truncated) patch.billCount = rest.length;
      await db.collection('rooms').doc(bill.roomId).update({ data: patch });
    } catch (e) {
      // 重算失败不影响主流程（增量值已经写入）
      console.log('房间统计重算失败，保留增量结果', e);
    }

    // 5. 删除关联的凭证图片（如果有）
    if (bill.imageUrl) {
      try {
        await cloud.deleteFile({ fileList: [bill.imageUrl] });
      } catch (e) {
        // 图片删除失败不影响主流程
        console.log('删除凭证图片失败', e);
      }
    }

    return { success: true };
  } catch (err) {
    console.error('删除账单失败', err);
    return { success: false, error: err.message };
  }
};
