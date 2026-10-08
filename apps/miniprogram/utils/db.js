/**
 * 数据库操作封装
 * 功能：房间管理、账单管理、实时同步、演示模式
 */

const demo = require('./demo');
/* 共享内核：离队/私账这类"口径"必须走它，别在页面里另写一份 */
const AI = require('./ai');

// 演示模式标记
let _isDemo = false;

function setDemoMode(val) { _isDemo = val; }
function isDemo() { return _isDemo; }

// 云数据库引用
let db = null;
let _ = null;

function initDB() {
  if (!db && !_isDemo) {
    try {
      db = wx.cloud.database();
      _ = db.command;
    } catch (e) {
      console.warn('云开发未初始化，切换到演示模式');
      _isDemo = true;
    }
  }
}

// ============ 用户 ============

/**
 * 获取用户openid
 */
async function getOpenid() {
  if (_isDemo) return 'demo_user_1';

  const app = getApp();
  if (app.globalData.openid) return app.globalData.openid;

  try {
    const { result } = await wx.cloud.callFunction({ name: 'login' });
    app.globalData.openid = result.openid;
    return result.openid;
  } catch (e) {
    console.error('获取openid失败', e);
    return null;
  }
}

// ============ 房间管理 ============

/**
 * 创建房间（调用云函数）
 */
async function createRoom(roomData) {
  if (_isDemo) {
    return {
      _id: 'demo_' + Date.now(),
      name: roomData.name || '新旅行',
      destination: roomData.destination || '',
      roomCode: generateRoomCode(),
      members: [{
        id: 'demo_user_1',
        name: roomData.creatorName || '房主',
        avatar: roomData.creatorAvatar || '',
        joinedAt: new Date()
      }],
      billCount: 0,
      totalExpense: 0
    };
  }

  initDB();
  const { result } = await wx.cloud.callFunction({
    name: 'createRoom',
    data: roomData
  });

  if (!result.success) throw new Error(result.error);
  return result.room;
}

/**
 * 加入房间（调用云函数）
 */
async function joinRoom(roomCode, userInfo) {
  if (_isDemo) {
    const room = demo.getDemoRoomDetail('demo_room_1');
    return room;
  }

  initDB();
  const { result } = await wx.cloud.callFunction({
    name: 'joinRoom',
    data: {
      roomCode,
      nickName: userInfo.nickName,
      avatarUrl: userInfo.avatarUrl
    }
  });

  if (!result.success) throw new Error(result.error);
  return result.room;
}

/**
 * 获取我的房间列表
 */
async function getMyRooms() {
  if (_isDemo) return demo.getDemoRooms();

  initDB();
  const openid = await getOpenid();
  const { data } = await db.collection('rooms')
    .where({ 'members.id': openid })
    .orderBy('updatedAt', 'desc')
    .limit(20)
    .get();
  return data;
}

/**
 * 获取房间详情
 */
async function getRoomDetail(roomId) {
  if (_isDemo) return demo.getDemoRoomDetail(roomId);

  initDB();
  const { data } = await db.collection('rooms').doc(roomId).get();
  return data;
}

/**
 * 监听房间变化（实时同步）
 * @param {string} roomId - 房间ID
 * @param {Function} callback - 数据变化回调
 * @returns {Function} 取消监听函数
 */
function watchRoom(roomId, callback) {
  if (_isDemo) {
    // 演示模式：返回空的取消函数
    return () => {};
  }

  initDB();
  const watcher = db.collection('rooms')
    .doc(roomId)
    .watch({
      onChange: (snapshot) => {
        console.log('房间数据变化', snapshot.docs);
        callback(snapshot.docs[0] || null);
      },
      onError: (err) => {
        console.error('监听房间失败', err);
      }
    });

  return () => watcher.close();
}

/**
 * 监听房间账单变化（实时同步）
 * @param {string} roomId - 房间ID
 * @param {Function} callback - 账单列表变化回调
 * @returns {Function} 取消监听函数
 */
function watchBills(roomId, callback) {
  if (_isDemo) {
    return () => {};
  }

  initDB();
  const watcher = db.collection('bills')
    .where({ roomId })
    .orderBy('createdAt', 'desc')
    .watch({
      onChange: (snapshot) => {
        console.log('账单数据变化', snapshot.docs);
        callback(snapshot.docs);
      },
      onError: (err) => {
        console.error('监听账单失败', err);
      }
    });

  return () => watcher.close();
}

// ============ 账单管理 ============

/**
 * 添加账单（调用云函数）
 */
async function addBill(roomId, billData) {
  if (_isDemo) {
    const bill = {
      _id: 'bill_' + Date.now(),
      roomId,
      ...billData,
      createdAt: new Date()
    };
    // 演示模式也真正落库：让 Demo 全流程可交互
    if (!demo.DEMO_BILLS[roomId]) demo.DEMO_BILLS[roomId] = [];
    demo.DEMO_BILLS[roomId].unshift(bill);
    return bill;
  }

  initDB();
  const { result } = await wx.cloud.callFunction({
    name: 'addBill',
    data: {
      roomId,
      ...billData
    }
  });

  if (!result.success) throw new Error(result.error);
  return result.bill;
}

/**
 * 编辑账单（V2：产品闭环 —— 记错账可改）
 */
async function updateBill(billId, billData) {
  if (_isDemo) {
    Object.keys(demo.DEMO_BILLS).forEach(roomId => {
      const list = demo.DEMO_BILLS[roomId];
      const idx = list.findIndex(b => b._id === billId);
      if (idx !== -1) list[idx] = { ...list[idx], ...billData };
    });
    return;
  }

  initDB();
  const { result } = await wx.cloud.callFunction({
    name: 'addBill',
    data: { billId, edit: true, ...billData }
  });

  if (!result.success) throw new Error(result.error);
  return result.bill;
}

/**
 * 获取房间账单列表
 */
async function getRoomBills(roomId) {
  if (_isDemo) return demo.getDemoBills(roomId);

  initDB();
  const { data } = await db.collection('bills')
    .where({ roomId })
    .orderBy('createdAt', 'desc')
    .limit(100)
    .get();
  return data;
}

/**
 * 删除账单（调用云函数）
 */
async function deleteBill(billId) {
  if (_isDemo) {
    Object.keys(demo.DEMO_BILLS).forEach(roomId => {
      demo.DEMO_BILLS[roomId] = demo.DEMO_BILLS[roomId].filter(b => b._id !== billId);
    });
    return;
  }

  initDB();
  const { result } = await wx.cloud.callFunction({
    name: 'deleteBill',
    data: { billId }
  });

  if (!result.success) throw new Error(result.error);
}

// ============ V2：预算 / 成员 / 结清 ============

/**
 * 设置旅行预算
 */
async function setBudget(roomId, budget) {
  if (_isDemo) {
    const room = demo.DEMO_ROOMS.find(r => r._id === roomId);
    if (room) room.budget = budget;
    return budget;
  }

  initDB();
  await db.collection('rooms').doc(roomId).update({ data: { budget } });
  return budget;
}

/**
 * 标记房间已结清（结算闭环）
 */
async function markSettled(roomId) {
  if (_isDemo) {
    const room = demo.DEMO_ROOMS.find(r => r._id === roomId);
    if (room) room.settledAt = new Date().toISOString();
    return room ? room.settledAt : '';
  }

  initDB();
  const settledAt = new Date().toISOString();
  await db.collection('rooms').doc(roomId).update({ data: { settledAt } });
  return settledAt;
}

/**
 * 「有人先走」：标记 / 取消某位成员离队（只改时间戳，不动任何账单）
 *
 * 语义与网页端、服务端一致（判据在共享内核 AI.toggleMemberLeave / AI.activeMembers）：
 *   · 打一个 leftAt：之后新建的账单只分摊给还在队里的人；
 *   · 历史账单的 splits 保持不变（那是事实，不追溯改）；
 *   · 他仍在成员表里参与结算。
 * @returns {{left:boolean, leftAt:string, members:Array}}
 */
async function setMemberLeave(roomId, memberId, leave, leftAt) {
  if (_isDemo) {
    const room = demo.DEMO_ROOMS.find(r => r._id === roomId);
    if (!room) throw new Error('房间不存在');
    const out = AI.toggleMemberLeave(room, memberId, leftAt);
    if (leave === true && !out.left) out.member.leftAt = leftAt || new Date().toISOString();
    if (leave === false && out.left) delete out.member.leftAt;
    return { left: !!(out.member && out.member.leftAt), leftAt: (out.member && out.member.leftAt) || '', members: room.members };
  }

  initDB();
  const { result } = await wx.cloud.callFunction({
    name: 'setMemberLeave',
    data: { roomId, memberId, leave, leftAt: leftAt || '' }
  });
  if (!result.success) throw new Error(result.error);
  return result;
}

/**
 * 移除成员（有未结清余额时由调用方拦截）
 */
async function removeMember(roomId, memberId) {
  if (_isDemo) {
    const room = demo.DEMO_ROOMS.find(r => r._id === roomId);
    if (room) room.members = room.members.filter(m => m.id !== memberId);
    return;
  }

  initDB();
  const { result } = await wx.cloud.callFunction({
    name: 'removeMember',
    data: { roomId, memberId }
  });

  if (!result.success) throw new Error(result.error);
}

// ============ OCR识别 ============

/**
 * 上传图片并OCR识别
 * @param {string} filePath - 本地图片路径
 * @returns {Object} OCR识别结果
 */
async function recognizeBill(filePath) {
  if (_isDemo) {
    // 演示模式返回模拟数据
    return {
      success: true,
      amount: 128.50,
      merchant: '示例商户',
      time: '2024-10-01 14:30',
      category: 'food',
      imageType: 'wechat',
      confidence: 92,
      needManual: false
    };
  }

  initDB();

  // 1. 上传图片到云存储
  const timestamp = Date.now();
  const openid = await getOpenid();
  const cloudPath = `ocr/${timestamp}_${openid}.jpg`;

  const { fileID } = await wx.cloud.uploadFile({
    cloudPath,
    filePath: filePath
  });

  // 2. 调用OCR云函数
  const { result } = await wx.cloud.callFunction({
    name: 'ocr',
    data: { fileID }
  });

  // OCR云函数会自动删除临时图片
  return result;
}

// ============ 结算 ============

/**
 * 调用服务端结算计算
 */
async function calculateSettlement(roomId) {
  if (_isDemo) {
    // 演示模式使用本地计算
    const room = demo.getDemoRoomDetail(roomId);
    const bills = demo.getDemoBills(roomId);
    return localCalculateSettlement(room.members, bills);
  }

  initDB();
  const { result } = await wx.cloud.callFunction({
    name: 'settle',
    data: { roomId }
  });

  if (!result.success) throw new Error(result.error);
  return result;
}

/**
 * 本地结算计算（备用）
 * V2：统一委托 utils/settle.js（多币种折算 + 贪心最简转账），消除重复实现
 */
const settleAlgo = require('./settle');

function localCalculateSettlement(members, bills) {
  return settleAlgo.calculateSettlement(members, bills);
}

// ============ 工具函数 ============

function generateRoomCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// ============ 导出 ============

module.exports = {
  // 初始化
  setDemoMode,
  isDemo,

  // 用户
  getOpenid,

  // 房间
  createRoom,
  joinRoom,
  getMyRooms,
  getRoomDetail,
  watchRoom,
  watchBills,

  // 账单
  addBill,
  getRoomBills,
  deleteBill,
  updateBill,

  // V2：预算 / 成员 / 结清
  setBudget,
  markSettled,
  setMemberLeave,
  removeMember,

  // OCR
  recognizeBill,

  // 结算
  calculateSettlement,
  localCalculateSettlement
};
