// 云函数：移除房间成员（V2 成员管理）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const { roomId, memberId } = event;

  try {
    if (!roomId || !memberId) {
      return { success: false, error: '参数错误' };
    }

    const { data: room } = await db.collection('rooms').doc(roomId).get();

    // 仅房主或本人可移除
    if (room.creator !== openid && memberId !== openid) {
      return { success: false, error: '仅房主或本人可移除成员' };
    }

    // 不允许移除房主
    if (room.creator === memberId) {
      return { success: false, error: '不能移除房主' };
    }

    await db.collection('rooms').doc(roomId).update({
      data: {
        members: room.members.filter(m => m.id !== memberId),
        updatedAt: new Date()
      }
    });

    return { success: true };
  } catch (err) {
    console.error('移除成员失败', err);
    return { success: false, error: err.message };
  }
};
