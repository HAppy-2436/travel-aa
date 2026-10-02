/**
 * 演示数据模块
 * 用于在没有云环境时提供模拟数据，方便展示Demo
 */

const DEMO_ROOMS = [
  {
    _id: 'demo_room_1',
    name: '国庆东京行',
    destination: '东京',
    roomCode: '888666',
    startDate: '2024-10-01',
    endDate: '2024-10-07',
    creator: 'user_1',
    members: [
      { id: 'user_1', name: '小明', avatar: '' },
      { id: 'user_2', name: '小红', avatar: '' },
      { id: 'user_3', name: '小李', avatar: '' },
      { id: 'user_4', name: '小王', avatar: '' }
    ],
    billCount: 8,
    totalExpense: 12580.50,
    createdAt: new Date('2024-10-01'),
    updatedAt: new Date('2024-10-07')
  },
  {
    _id: 'demo_room_2',
    name: '周末杭州游',
    destination: '杭州',
    roomCode: '123456',
    startDate: '2024-09-14',
    endDate: '2024-09-16',
    creator: 'user_1',
    members: [
      { id: 'user_1', name: '小明', avatar: '' },
      { id: 'user_5', name: '小张', avatar: '' }
    ],
    billCount: 5,
    totalExpense: 2860.00,
    createdAt: new Date('2024-09-14'),
    updatedAt: new Date('2024-09-16')
  }
];

const DEMO_BILLS = {
  'demo_room_1': [
    {
      _id: 'bill_1',
      roomId: 'demo_room_1',
      payer: 'user_1',
      payerName: '小明',
      amount: 3200.00,
      description: '酒店4晚',
      category: 'hotel',
      splitType: 'equal',
      splits: [
        { memberId: 'user_1', amount: 800 },
        { memberId: 'user_2', amount: 800 },
        { memberId: 'user_3', amount: 800 },
        { memberId: 'user_4', amount: 800 }
      ],
      createdAt: new Date('2024-10-01T14:30:00')
    },
    {
      _id: 'bill_2',
      roomId: 'demo_room_1',
      payer: 'user_2',
      payerName: '小红',
      amount: 1560.00,
      description: '机票(4人)',
      category: 'transport',
      splitType: 'equal',
      splits: [
        { memberId: 'user_1', amount: 390 },
        { memberId: 'user_2', amount: 390 },
        { memberId: 'user_3', amount: 390 },
        { memberId: 'user_4', amount: 390 }
      ],
      createdAt: new Date('2024-10-01T08:00:00')
    },
    {
      _id: 'bill_3',
      roomId: 'demo_room_1',
      payer: 'user_1',
      payerName: '小明',
      amount: 680.00,
      description: '浅草寺附近晚餐',
      category: 'food',
      splitType: 'equal',
      splits: [
        { memberId: 'user_1', amount: 170 },
        { memberId: 'user_2', amount: 170 },
        { memberId: 'user_3', amount: 170 },
        { memberId: 'user_4', amount: 170 }
      ],
      createdAt: new Date('2024-10-02T19:30:00')
    },
    {
      _id: 'bill_4',
      roomId: 'demo_room_1',
      payer: 'user_3',
      payerName: '小李',
      amount: 450.00,
      description: '地铁+出租车',
      category: 'transport',
      splitType: 'equal',
      splits: [
        { memberId: 'user_1', amount: 112.50 },
        { memberId: 'user_2', amount: 112.50 },
        { memberId: 'user_3', amount: 112.50 },
        { memberId: 'user_4', amount: 112.50 }
      ],
      createdAt: new Date('2024-10-03T16:00:00')
    },
    {
      _id: 'bill_5',
      roomId: 'demo_room_1',
      payer: 'user_4',
      payerName: '小王',
      amount: 2800.00,
      description: '迪士尼门票',
      category: 'ticket',
      splitType: 'equal',
      splits: [
        { memberId: 'user_1', amount: 700 },
        { memberId: 'user_2', amount: 700 },
        { memberId: 'user_3', amount: 700 },
        { memberId: 'user_4', amount: 700 }
      ],
      createdAt: new Date('2024-10-04T09:00:00')
    },
    {
      _id: 'bill_6',
      roomId: 'demo_room_1',
      payer: 'user_2',
      payerName: '小红',
      amount: 520.00,
      description: '银座购物午餐',
      category: 'food',
      splitType: 'treat',
      splits: [
        { memberId: 'user_1', amount: 0 },
        { memberId: 'user_2', amount: 520 },
        { memberId: 'user_3', amount: 0 },
        { memberId: 'user_4', amount: 0 }
      ],
      createdAt: new Date('2024-10-05T12:30:00')
    },
    {
      _id: 'bill_7',
      roomId: 'demo_room_1',
      payer: 'user_1',
      payerName: '小明',
      amount: 2100.00,
      description: '药妆店扫货',
      category: 'shopping',
      splitType: 'custom',
      splits: [
        { memberId: 'user_1', amount: 800 },
        { memberId: 'user_2', amount: 600 },
        { memberId: 'user_3', amount: 400 },
        { memberId: 'user_4', amount: 300 }
      ],
      createdAt: new Date('2024-10-06T15:00:00')
    },
    {
      _id: 'bill_8',
      roomId: 'demo_room_1',
      payer: 'user_3',
      payerName: '小李',
      amount: 1270.50,
      description: '居酒屋聚餐',
      category: 'food',
      splitType: 'equal',
      splits: [
        { memberId: 'user_1', amount: 317.63 },
        { memberId: 'user_2', amount: 317.63 },
        { memberId: 'user_3', amount: 317.62 },
        { memberId: 'user_4', amount: 317.62 }
      ],
      createdAt: new Date('2024-10-07T20:00:00')
    }
  ],
  'demo_room_2': [
    {
      _id: 'bill_10',
      roomId: 'demo_room_2',
      payer: 'user_1',
      payerName: '小明',
      amount: 1200.00,
      description: '西湖边民宿',
      category: 'hotel',
      splitType: 'equal',
      splits: [
        { memberId: 'user_1', amount: 600 },
        { memberId: 'user_5', amount: 600 }
      ],
      createdAt: new Date('2024-09-14T14:00:00')
    },
    {
      _id: 'bill_11',
      roomId: 'demo_room_2',
      payer: 'user_5',
      payerName: '小张',
      amount: 460.00,
      description: '高铁票',
      category: 'transport',
      splitType: 'equal',
      splits: [
        { memberId: 'user_1', amount: 230 },
        { memberId: 'user_5', amount: 230 }
      ],
      createdAt: new Date('2024-09-14T08:00:00')
    },
    {
      _id: 'bill_12',
      roomId: 'demo_room_2',
      payer: 'user_1',
      payerName: '小明',
      amount: 380.00,
      description: '楼外楼午餐',
      category: 'food',
      splitType: 'equal',
      splits: [
        { memberId: 'user_1', amount: 190 },
        { memberId: 'user_5', amount: 190 }
      ],
      createdAt: new Date('2024-09-15T12:00:00')
    },
    {
      _id: 'bill_13',
      roomId: 'demo_room_2',
      payer: 'user_5',
      payerName: '小张',
      amount: 520.00,
      description: '灵隐寺+西湖游船',
      category: 'ticket',
      splitType: 'equal',
      splits: [
        { memberId: 'user_1', amount: 260 },
        { memberId: 'user_5', amount: 260 }
      ],
      createdAt: new Date('2024-09-15T09:00:00')
    },
    {
      _id: 'bill_14',
      roomId: 'demo_room_2',
      payer: 'user_1',
      payerName: '小明',
      amount: 300.00,
      description: '晚餐+宵夜',
      category: 'food',
      splitType: 'equal',
      splits: [
        { memberId: 'user_1', amount: 150 },
        { memberId: 'user_5', amount: 150 }
      ],
      createdAt: new Date('2024-09-16T19:00:00')
    }
  ]
};

/**
 * 获取演示房间列表
 */
function getDemoRooms() {
  return DEMO_ROOMS;
}

/**
 * 获取演示房间详情
 */
function getDemoRoomDetail(roomId) {
  return DEMO_ROOMS.find(r => r._id === roomId) || DEMO_ROOMS[0];
}

/**
 * 获取演示账单
 */
function getDemoBills(roomId) {
  return DEMO_BILLS[roomId] || [];
}

/**
 * 判断是否使用演示模式
 * 在云开发环境不可用时自动启用
 */
function isDemoMode() {
  try {
    wx.cloud;
    return false;
  } catch (e) {
    return true;
  }
}

module.exports = {
  getDemoRooms,
  getDemoRoomDetail,
  getDemoBills,
  isDemoMode,
  DEMO_ROOMS,
  DEMO_BILLS
};
