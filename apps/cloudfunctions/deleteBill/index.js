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
    await db.collection('rooms').doc(bill.roomId).update({
      data: {
        billCount: _.inc(-1),
        totalExpense: _.inc(-bill.amount),
        updatedAt: new Date()
      }
    });

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
