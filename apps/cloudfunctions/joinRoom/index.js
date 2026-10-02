// 云函数：加入房间
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const { roomCode, nickName, avatarUrl } = event;

  try {
    // 1. 校验房间号
    if (!roomCode || roomCode.length !== 6) {
      return { success: false, error: '请输入6位房间号' };
    }

    // 2. 查找房间
    const { data: rooms } = await db.collection('rooms')
      .where({ roomCode })
      .get();

    if (rooms.length === 0) {
      return { success: false, error: '房间不存在，请检查房间号' };
    }

    const room = rooms[0];

    // 3. 检查是否已在房间中
    const existingMember = room.members.find(m => m.id === openid);
    if (existingMember) {
      return { success: true, room, message: '已在房间中' };
    }

    // 4. 检查房间人数上限
    if (room.members.length >= 20) {
      return { success: false, error: '房间人数已达上限(20人)' };
    }

    // 5. 加入房间
    const newMember = {
      id: openid,
      name: nickName || '新成员',
      avatar: avatarUrl || '',
      joinedAt: new Date()
    };

    await db.collection('rooms').doc(room._id).update({
      data: {
        members: _.push(newMember),
        updatedAt: new Date()
      }
    });

    // 6. 记录邀请日志
    await db.collection('invitations').add({
      data: {
        roomId: room._id,
        roomCode,
        memberId: openid,
        memberName: nickName,
        joinedAt: new Date()
      }
    });

    // 7. 返回更新后的房间
    const { data: updatedRoom } = await db.collection('rooms').doc(room._id).get();

    return { success: true, room: updatedRoom, message: '加入成功' };
  } catch (err) {
    console.error('加入房间失败', err);
    return { success: false, error: err.message };
  }
};
