// 云函数：初始化数据库
// 首次部署后运行一次，创建集合和索引
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event, context) => {
  const results = {};

  try {
    // 1. 创建 rooms 集合
    try {
      await db.createCollection('rooms');
      results.rooms = 'created';
    } catch (e) {
      results.rooms = 'exists';
    }

    // 2. 创建 bills 集合
    try {
      await db.createCollection('bills');
      results.bills = 'created';
    } catch (e) {
      results.bills = 'exists';
    }

    // 3. 创建 invitations 集合（邀请记录）
    try {
      await db.createCollection('invitations');
      results.invitations = 'created';
    } catch (e) {
      results.invitations = 'exists';
    }

    // 4. rooms 集合索引
    try {
      await db.collection('rooms').createIndex({
        keys: { roomCode: 1 },
        unique: true
      });
      results.idx_roomCode = 'created';
    } catch (e) {
      results.idx_roomCode = e.message;
    }

    try {
      await db.collection('rooms').createIndex({
        keys: { 'members.id': 1, updatedAt: -1 }
      });
      results.idx_members = 'created';
    } catch (e) {
      results.idx_members = e.message;
    }

    // 5. bills 集合索引
    try {
      await db.collection('bills').createIndex({
        keys: { roomId: 1, createdAt: -1 }
      });
      results.idx_bills = 'created';
    } catch (e) {
      results.idx_bills = e.message;
    }

    // 6. invitations 集合索引
    try {
      await db.collection('invitations').createIndex({
        keys: { roomCode: 1, createdAt: -1 }
      });
      results.idx_invitations = 'created';
    } catch (e) {
      results.idx_invitations = e.message;
    }

    return { success: true, results };
  } catch (err) {
    return { success: false, error: err.message };
  }
};
