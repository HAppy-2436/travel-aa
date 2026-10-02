// 云函数入口文件 - createRoom
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 生成6位房间号
function generateRoomCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// 云函数入口函数
exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;

  const {
    name,
    destination,
    startDate,
    endDate,
    creatorName,
    creatorAvatar,
    budget,
    baseCurrency
  } = event;

  // 生成唯一房间号（检查是否重复）
  let roomCode;
  let isUnique = false;
  while (!isUnique) {
    roomCode = generateRoomCode();
    const { data } = await db.collection('rooms')
      .where({ roomCode })
      .get();
    if (data.length === 0) isUnique = true;
  }

  const room = {
    name: name || '新旅行',
    destination: destination || '',
    startDate: startDate || '',
    endDate: endDate || '',
    roomCode,
    creator: openid,
    members: [{
      id: openid,
      name: creatorName || '房主',
      avatar: creatorAvatar || '',
      joinedAt: new Date()
    }],
    billCount: 0,
    totalExpense: 0,
    // V2：旅行预算 / 本位币（结算折算人民币）
    budget: Number(budget) || 0,
    baseCurrency: baseCurrency || 'CNY',
    settledAt: '',
    createdAt: new Date(),
    updatedAt: new Date()
  };

  const result = await db.collection('rooms').add({ data: room });

  return {
    success: true,
    room: {
      ...room,
      _id: result._id
    }
  };
};
