// pages/history/history.js
const db = require('../../utils/db');
const AI = require('../../utils/ai');
const { CATEGORIES, getCategoryById } = require('../../utils/categories');

Page({
  data: {
    roomId: '',
    members: [],
    bills: [],
    filteredBills: [],
    categoryStats: [],
    dailyInfo: null,
    filterType: 'all',
    filterOptions: [{ id: 'all', name: '全部', icon: '📋' }].concat(CATEGORIES)
  },

  onLoad(options) {
    if (options.roomId) {
      this.setData({ roomId: options.roomId });
      this.loadData();
    }
  },

  async loadData() {
    try {
      const [bills, room] = await Promise.all([
        db.getRoomBills(this.data.roomId),
        db.getRoomDetail(this.data.roomId)
      ]);
      this.setData({ members: room.members || [] });

      // 处理账单
      const processedBills = bills.map(bill => {
        const cat = getCategoryById(bill.category);
        const date = new Date(bill.createdAt);
        return {
          ...bill,
          categoryIcon: cat.icon,
          timeStr: `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`,
          amountLabel: bill.currency && bill.currency !== 'CNY'
            ? `${bill.currency} ${bill.amount}`
            : `¥${bill.amount}`
        };
      });

      // 统计分类
      const totalAmount = bills.reduce((sum, b) => sum + AI.billCNY(b), 0);
      const categoryMap = {};
      CATEGORIES.forEach(c => {
        categoryMap[c.id] = { ...c, amount: 0 };
      });

      bills.forEach(bill => {
        if (categoryMap[bill.category]) {
          categoryMap[bill.category].amount += AI.billCNY(bill);
        }
      });

      const categoryStats = Object.values(categoryMap)
        .map(c => ({
          ...c,
          percent: totalAmount > 0 ? (c.amount / totalAmount * 100) : 0
        }))
        .sort((a, b) => b.amount - a.amount);

      // V2：每日消费分析（AI 引擎）
      const dailyInfo = AI.dailyStats(bills);

      this.setData({
        bills: processedBills,
        filteredBills: processedBills,
        categoryStats,
        dailyInfo
      });
    } catch (e) {
      console.error('加载失败', e);
    }
  },

  // V2：分类筛选
  setFilter(e) {
    const type = e.currentTarget.dataset.type;
    this.setData({
      filterType: type,
      filteredBills: type === 'all'
        ? this.data.bills
        : this.data.bills.filter(b => b.category === type)
    });
  },

  // V2：编辑账单
  editBill(e) {
    const bill = e.currentTarget.dataset.bill;
    const members = JSON.stringify(this.data.members || []);
    wx.navigateTo({
      url: `/pages/add-bill/add-bill?roomId=${this.data.roomId}&members=${encodeURIComponent(members)}&bill=${encodeURIComponent(JSON.stringify(bill))}`
    });
  },

  // V2：删除账单
  deleteBill(e) {
    const { id } = e.currentTarget.dataset;
    wx.showModal({
      title: '删除确认',
      content: '确定要删除这条账单吗？',
      success: async (res) => {
        if (res.confirm) {
          try {
            await db.deleteBill(id);
            wx.showToast({ title: '已删除', icon: 'success' });
            this.loadData();
          } catch (err) {
            wx.showToast({ title: '删除失败: ' + err.message, icon: 'none' });
          }
        }
      }
    });
  }
});
