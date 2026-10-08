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
    needsCompletion,
    // V3：调整单（多退少补 / 暂估改价）——amount 恒为 0、splits 零和
    isAdjustment,
    adjustsBillId
  } = event;

  try {
    // ===== 编辑账单 =====
    if (edit && billId) {
      const { data: old } = await db.collection('bills').doc(billId).get();
      const isAdjRow = old.isAdjustment === true || old.isAdjustment === 1 || old.isAdjustment === '1';
      const finalAmount = amount != null ? Math.round(amount * 100) / 100 : old.amount;
      const finalSplits = splits || old.splits;
      /* 口径对齐：按分严格相等（容差 0）；调整单要求零和 */
      const splitCents = finalSplits.reduce((sum, s) => sum + Math.round((Number(s.amount) || 0) * 100), 0);
      const amountCents = Math.round((Number(finalAmount) || 0) * 100);
      if (isAdjRow ? splitCents !== 0 : splitCents !== amountCents) {
        return {
          success: false,
          error: isAdjRow
            ? `调整单的分摊必须零和（合计 ${(splitCents / 100).toFixed(2)} ≠ 0）`
            : `分摊金额总和(${(splitCents / 100).toFixed(2)})与账单金额(${(amountCents / 100).toFixed(2)})不符`
        };
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

      // 房间统计差额修正（只对"计入集体消费"的账单生效，私账/调整单不动统计）
      const oldCounts = (old.scope || 'group') !== 'personal' && !isAdjRow;
      const delta = cnyAmount - (old.cnyAmount || old.amount || 0);
      await db.collection('rooms').doc(old.roomId).update({
        data: oldCounts ? { totalExpense: _.inc(delta), updatedAt: new Date() } : { updatedAt: new Date() }
      });

      return { success: true, bill: { ...old, ...patch, _id: billId } };
    }

    // ===== 新增账单 =====
    const adjustment = isAdjustment === true || isAdjustment === 1 || isAdjustment === '1';
    /* 调整单（多退少补 / 暂估改价）金额恒为 0 —— 不能再被"金额必须大于0"一刀拒掉，
       否则小程序端做的多退少补永远同步不到云端（网页/服务端都已经放行）。 */
    if (!roomId || (!adjustment && (!amount || amount <= 0)) || (adjustment && Number(amount) !== 0)) {
      return { success: false, error: adjustment ? '参数错误：调整单金额必须为 0' : '参数错误：金额必须大于0' };
    }
    if (!payer) {
      return { success: false, error: '请选择付款人' };
    }
    if (!splits || splits.length === 0) {
      return { success: false, error: '请选择分摊方式' };
    }

    // 2. 校验分摊金额总和
    //
    // ⚠️ 口径对齐服务端与内核：**按分严格相等**（容差 0），而不是 0.05 ——
    //    0.05 的容差会让"分摊合计 ≠ 金额"的账落库，结算时那几分钱就凭空消失/多出（账恒平被破坏）。
    //    调整单则要求**零和**（它不改总额，只在成员之间搬）。
    const splitCents = splits.reduce((sum, s) => sum + Math.round((Number(s.amount) || 0) * 100), 0);
    const amountCents = Math.round((Number(amount) || 0) * 100);
    if (adjustment) {
      if (splitCents !== 0) {
        return { success: false, error: `调整单的分摊必须零和（合计 ${(splitCents / 100).toFixed(2)} ≠ 0），否则会把账改不平` };
      }
      if (!adjustsBillId) {
        return { success: false, error: '调整单必须说明它调整的是哪一笔（adjustsBillId）' };
      }
    } else if (splitCents !== amountCents) {
      return { success: false, error: `分摊金额总和(${(splitCents / 100).toFixed(2)})与账单金额(${(amountCents / 100).toFixed(2)})不符` };
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
      /* 调整单：把标记与被调整账单一起落库，否则云端把它当普通 0 元账单、
         内核的 effectiveShares 找不到它，多退少补在云端等于没发生 */
      ...(adjustment ? { isAdjustment: true, adjustsBillId: String(adjustsBillId) } : {}),
      roundedLoss: Number(roundedLoss) || 0,
      ...(status ? { status } : {}),
      ...(needsCompletion ? { needsCompletion: true } : {}),
      createdAt: new Date(),
      createdBy: openid
    };

    const { _id } = await db.collection('bills').add({ data: bill });

    // 5. 更新房间统计（按人民币折算额）
    //
    // ⚠️ 口径必须和网页/服务端一致：**私账不进"集体消费"**，调整单金额恒为 0 也不计笔数。
    //    以前这里无条件 `_.inc(1)` + `_.inc(cnyAmount)`，而上面第 131 行的注释却写着
    //    "私账…不计入房间总消费" —— 注释与代码相反，私账被算进了房间总消费。
    const countsInGroup = bill.scope !== 'personal' && !bill.isAdjustment;
    await db.collection('rooms').doc(roomId).update({
      data: {
        billCount: _.inc(countsInGroup ? 1 : 0),
        totalExpense: _.inc(countsInGroup ? bill.cnyAmount : 0),
        updatedAt: new Date()
      }
    });

    return { success: true, bill: { ...bill, _id } };
  } catch (err) {
    console.error('添加账单失败', err);
    return { success: false, error: err.message };
  }
};
