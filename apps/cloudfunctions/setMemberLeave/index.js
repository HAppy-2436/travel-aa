// 云函数：「有人先走」—— 标记 / 取消某位成员离队
//
// 语义（与网页端、小程序端、Node 服务端完全一致）：
//   · 只在成员上打一个 leftAt 时间戳，**不动任何账单** —— 历史账单的 splits 是事实；
//   · 之后新建的账单由客户端用共享内核 AI.activeMembers(room) 算分摊对象，
//     所以服务端不需要"重算历史"；
//   · 离队的人仍在 members 里，结算照算（他之前该摊的一分不少）。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const { roomId, memberId, leave, leftAt } = event;

  try {
    if (!roomId || !memberId) {
      return { success: false, error: '参数错误：缺少 roomId / memberId' };
    }

    const { data: room } = await db.collection('rooms').doc(roomId).get();
    const members = room.members || [];
    const target = members.find(m => m.id === memberId);
    if (!target) return { success: false, error: '该成员不在房间里' };

    // 权限：房主可以标记任何人；其他人只能标记自己（避免"被离队"）
    if (room.creator !== openid && memberId !== openid) {
      return { success: false, error: '只有房主可以标记其他成员，其他人只能标记自己' };
    }

    const want = leave === undefined || leave === null ? !target.leftAt : !!leave;
    const stamp = want ? (leftAt || new Date().toISOString()) : '';
    const next = members.map(m => (m.id === memberId ? { ...m, leftAt: stamp } : m));

    await db.collection('rooms').doc(roomId).update({
      data: { members: next, updatedAt: new Date() }
    });

    return { success: true, left: !!stamp, leftAt: stamp, members: next };
  } catch (err) {
    console.error('标记成员离队失败', err);
    return { success: false, error: err.message };
  }
};
