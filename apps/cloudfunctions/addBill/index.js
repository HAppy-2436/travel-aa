// 云函数：添加/编辑账单（V2：edit + 多币种）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;

  const {
    roomId,
    amount,
    description,
    category,
    payer,
    payerName,
    splitType,
    splits,
    imageUrl,
    // V2 多币种 / 订单来源
    currency,
    rate,
    orderNo,
    source,
    // V2 编辑模式
    edit,
    billId,
    // V3：私账 / 抹零 / 占位单（不补这几个字段，小程序端记的私账会被当成集体账、
    //     抹零差额会丢、占位单会以 0 元身份混进结算）
    scope,
    roundedLoss,
    status,
    needsCompletion
  } = event;

  try {
    // ===== 编辑账单 =====
    if (edit && billId) {
      const { data: old } = await db.collection('bills').doc(billId).get();
      const finalAmount = amount != null ? Math.round(amount * 100) / 100 : old.amount;
      const finalSplits = splits || old.splits;
      const totalSplit = finalSplits.reduce((sum, s) => sum + (s.amount || 0), 0);
      if (Math.abs(totalSplit - finalAmount) > 0.05) {
        return { success: false, error: `分摊金额总和(${totalSplit.toFixed(2)})与账单金额(${finalAmount})不符` };
      }
      const cur = (currency || old.currency || 'CNY').toUpperCase();
      const finalRate = cur === 'CNY' ? 1 : (Number(rate) || old.rate || 1);
      const cnyAmount = Math.round(finalAmount * finalRate * 100) / 100;

      const patch = {
        amount: finalAmount,
        ...(scope ? { scope } : {}),
        ...(roundedLoss != null ? { roundedLoss: Number(roundedLoss) || 0 } : {}),
        ...(status ? { status } : {}),
        ...(needsCompletion != null ? { needsCompletion: !!needsCompletion } : {}),
        description: description != null ? description : old.description,
        category: category || old.category,
        payer: payer || old.payer,
        payerName: payerName != null ? payerName : old.payerName,
        splitType: splitType || old.splitType,
        splits: finalSplits.map(s => ({
          memberId: s.memberId,
          memberName: s.memberName,
          amount: Math.round(s.amount * 100) / 100
        })),
        currency: cur,
        rate: finalRate,
        cnyAmount,
        updatedAt: new Date()
      };

      await db.collection('bills').doc(billId).update({ data: patch });

      // 房间统计差额修正
      const delta = cnyAmount - (old.cnyAmount || old.amount || 0);
      await db.collection('rooms').doc(old.roomId).update({
        data: { totalExpense: _.inc(delta), updatedAt: new Date() }
      });

      return { success: true, bill: { ...old, ...patch, _id: billId } };
    }

    // ===== 新增账单 =====
    if (!roomId || !amount || amount <= 0) {
      return { success: false, error: '参数错误：金额必须大于0' };
    }
    if (!payer) {
      return { success: false, error: '请选择付款人' };
    }
    if (!splits || splits.length === 0) {
      return { success: false, error: '请选择分摊方式' };
    }

    // 2. 校验分摊金额总和
    const totalSplit = splits.reduce((sum, s) => sum + (s.amount || 0), 0);
    if (Math.abs(totalSplit - amount) > 0.05) {
      return { success: false, error: `分摊金额总和(${totalSplit.toFixed(2)})与账单金额(${amount})不符` };
    }

    // 3. 验证房间权限
    const { data: room } = await db.collection('rooms').doc(roomId).get();
    const isMember = room.members.some(m => m.id === openid);
    if (!isMember) {
      return { success: false, error: '您不是该房间成员' };
    }

    // 4. 创建账单（多币种：记账时快照汇率与折算额）
    const cur = (currency || 'CNY').toUpperCase();
    const finalRate = cur === 'CNY' ? 1 : (Number(rate) || 1);
    const bill = {
      roomId,
      payer,
      payerName,
      amount: Math.round(amount * 100) / 100,
      description: description || '未命名消费',
      category: category || 'other',
      splitType: splitType || 'equal',
      splits: splits.map(s => ({
        memberId: s.memberId,
        memberName: s.memberName,
        amount: Math.round(s.amount * 100) / 100
      })),
      imageUrl: imageUrl || '',
      currency: cur,
      rate: finalRate,
      cnyAmount: Math.round(amount * finalRate * 100) / 100,
      orderNo: orderNo || '',
      source: source || '',
      // 归属：私账(人情账) 不进 AA，也不计入房间总消费
      scope: scope || (splitType === 'sole' ? 'personal' : 'group'),
      roundedLoss: Number(roundedLoss) || 0,
      ...(status ? { status } : {}),
      ...(needsCompletion ? { needsCompletion: true } : {}),
      createdAt: new Date(),
      createdBy: openid
    };

    const { _id } = await db.collection('bills').add({ data: bill });

    // 5. 更新房间统计（按人民币折算额）
    await db.collection('rooms').doc(roomId).update({
      data: {
        billCount: _.inc(1),
        totalExpense: _.inc(bill.cnyAmount),
        updatedAt: new Date()
      }
    });

    return { success: true, bill: { ...bill, _id } };
  } catch (err) {
    console.error('添加账单失败', err);
    return { success: false, error: err.message };
  }
};
