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
      //
      // ⚠️ 口径：统计只看「集体账」——私账（人情账）单独一块、不混进总消费。
      //    以前这里把全部账单求和（含私账），和网页端算出来的"总消费"不是一个数。
      //    统一用共享内核 AI.groupExpenseBills()，三端只有一份口径。
      const groupBills = AI.groupExpenseBills(bills);
      const totalAmount = groupBills.reduce((sum, b) => sum + AI.billCNY(b), 0);
      const categoryMap = {};
      CATEGORIES.forEach(c => {
        categoryMap[c.id] = { ...c, amount: 0 };
      });

      groupBills.forEach(bill => {
        if (categoryMap[bill.category]) {
          categoryMap[bill.category].amount += AI.billCNY(bill);
        }
      });

      const categoryStats = Object.values(categoryMap)
        .map(c => ({
          ...c,
          percent: totalAmount > 0 ? (c.amount / totalAmount * 100) : 0,
          /* ⚠️ WXML 表达式**不支持函数调用**：{{item.amount.toFixed(2)}} 在真机上不渲染。
             一律在 JS 里先算成字符串（下面 dailyInfo / 每日列表同理）。 */
          amountText: (Math.round(c.amount * 100) / 100).toFixed(2),
          percentText: (totalAmount > 0 ? c.amount / totalAmount * 100 : 0).toFixed(1)
        }))
        .sort((a, b) => b.amount - a.amount);

      // V2：每日消费分析（AI 引擎；内部已是集体账口径）
      const dailyInfo = AI.dailyStats(groupBills);
      if (dailyInfo) {
        dailyInfo.dailyAvgText = (Number(dailyInfo.dailyAvg) || 0).toFixed(2);
        if (dailyInfo.maxDay) dailyInfo.maxDay.totalText = (Number(dailyInfo.maxDay.total) || 0).toFixed(2);
        dailyInfo.days = (dailyInfo.days || []).map(d => ({
          ...d,
          totalText: (Number(d.total) || 0).toFixed(2)
        }));
      }

      this.setData({
        bills: processedBills,
        filteredBills: processedBills,
        categoryStats,
        dailyInfo,
        groupTotalText: totalAmount.toFixed(2),
        groupCount: groupBills.length
      });
    } catch (e) {
      console.error('加载失败', e);
    }
  },

  /* Bug#2：记账/删账后回到本页必须看到最新数据。
     以前没有 onShow，只有在 onLoad 时加载一次 → 「记完账返回统计页还是旧数字」。 */
  onShow() {
    if (this.data.roomId) this.loadData();
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
