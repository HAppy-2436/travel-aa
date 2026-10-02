// pages/room/room.js
const db = require('../../utils/db');
const AI = require('../../utils/ai');
const { calculateSettlement } = require('../../utils/settle');
const { getCategoryById } = require('../../utils/categories');

Page({
  data: {
    roomId: '',
    room: {},
    bills: [],
    filteredBills: [],
    filterType: 'all',
    // V2：预算 & AI 审计
    budgetInfo: null,
    auditInfo: null
  },

  // 实时同步句柄
  _unwatchRoom: null,
  _unwatchBills: null,

  onLoad(options) {
    if (options.id) {
      this.setData({ roomId: options.id });
      this.loadRoomData();
      this.startWatching();
    }
  },

  onUnload() {
    // 页面卸载时取消监听
    this.stopWatching();
  },

  /**
   * 开始实时监听数据变化
   */
  startWatching() {
    const { roomId } = this.data;

    // 监听房间信息变化
    this._unwatchRoom = db.watchRoom(roomId, (room) => {
      if (room) {
        console.log('房间信息已更新', room);
        this.setData({ room });
      }
    });

    // 监听账单列表变化
    this._unwatchBills = db.watchBills(roomId, (bills) => {
      console.log('账单列表已更新', bills.length);
      const processedBills = this.processBills(bills);
      this.setData({
        bills: processedBills,
        filteredBills: this.data.filterType === 'all'
          ? processedBills
          : processedBills.filter(b => b.category === this.data.filterType)
      });
      this.refreshInsight();
    });
  },

  /**
   * V2：预算状态 + AI 审计（本地共享引擎计算，离线可用）
   */
  refreshInsight() {
    const { room, bills } = this.data;
    if (!room || !room.members) return;
    const budgetInfo = AI.budgetStatus(bills, room.members, room.budget || 0, {
      room: { startDate: room.startDate, endDate: room.endDate }
    });
    const auditInfo = AI.auditBills(bills, room.members);
    this.setData({ budgetInfo, auditInfo });
  },

  /**
   * 停止实时监听
   */
  stopWatching() {
    if (this._unwatchRoom) {
      this._unwatchRoom();
      this._unwatchRoom = null;
    }
    if (this._unwatchBills) {
      this._unwatchBills();
      this._unwatchBills = null;
    }
  },

  /**
   * 加载初始数据（非实时）
   */
  async loadRoomData() {
    wx.showLoading({ title: '加载中...' });
    try {
      const [room, bills] = await Promise.all([
        db.getRoomDetail(this.data.roomId),
        db.getRoomBills(this.data.roomId)
      ]);

      const processedBills = this.processBills(bills);

      this.setData({
        room,
        bills: processedBills,
        filteredBills: processedBills
      });
      this.refreshInsight();
    } catch (e) {
      console.error('加载失败', e);
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
    wx.hideLoading();
  },

  /**
   * 处理账单显示数据
   */
  processBills(bills) {
    return bills.map(bill => {
      const cat = getCategoryById(bill.category);
      let splitLabel = '';
      if (bill.splitType === 'equal') {
        splitLabel = `均分${bill.splits.length}人`;
      } else if (bill.splitType === 'treat') {
        splitLabel = '请客';
      } else {
        splitLabel = '自定义分摊';
      }

      const date = new Date(bill.createdAt);
      const timeStr = `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

      return {
        ...bill,
        categoryIcon: cat.icon,
        splitLabel,
        timeStr,
        // 多币种展示：外币显示原币 + 折算
        amountLabel: bill.currency && bill.currency !== 'CNY'
          ? `${bill.currency} ${bill.amount}（≈¥${AI.billCNY(bill).toFixed(2)}）`
          : `¥${bill.amount}`,
        sourceIcon: bill.source === 'ctrip' ? '🧳' : ''
      };
    });
  },

  /**
   * 筛选账单
   */
  setFilter(e) {
    const type = e.currentTarget.dataset.type;
    const filtered = type === 'all'
      ? this.data.bills
      : this.data.bills.filter(b => b.category === type);

    this.setData({
      filterType: type,
      filteredBills: filtered
    });
  },

  /**
   * 复制房间号
   */
  copyRoomCode() {
    wx.setClipboardData({
      data: this.data.room.roomCode,
      success: () => {
        wx.showToast({ title: '房间号已复制', icon: 'success' });
      }
    });
  },

  /**
   * 分享房间
   */
  onShareAppMessage() {
    const room = this.data.room;
    return {
      title: `${room.name} - TravelAA旅行记账`,
      path: `/pages/room/room?id=${this.data.roomId}`
    };
  },

  /**
   * 跳转到记账页
   */
  goToAddBill() {
    const members = JSON.stringify(this.data.room.members || []);
    wx.navigateTo({
      url: `/pages/add-bill/add-bill?roomId=${this.data.roomId}&members=${encodeURIComponent(members)}`
    });
  },

  /**
   * 跳转到结算页
   */
  goToSettle() {
    wx.navigateTo({
      url: `/pages/settle/settle?roomId=${this.data.roomId}`
    });
  },

  // ========== V2：预算管理 ==========

  /**
   * 设置旅行预算（输入即预警超支）
   */
  setBudgetPrompt() {
    const current = (this.data.room && this.data.room.budget) || '';
    wx.showModal({
      title: '设置旅行预算',
      editable: true,
      placeholderText: '如：20000（元）',
      content: current ? String(current) : '',
      success: async (res) => {
        if (!res.confirm) return;
        const budget = parseFloat(res.content);
        if (isNaN(budget) || budget < 0) {
          wx.showToast({ title: '请输入有效金额', icon: 'none' });
          return;
        }
        try {
          await db.setBudget(this.data.roomId, budget);
          this.setData({ 'room.budget': budget });
          this.refreshInsight();
          wx.showToast({ title: '预算已更新', icon: 'success' });
        } catch (e) {
          wx.showToast({ title: '设置失败: ' + e.message, icon: 'none' });
        }
      }
    });
  },

  // ========== V2：AI 账单审计 ==========

  /**
   * 查看 AI 审计详情
   */
  showAuditDetail() {
    const audit = this.data.auditInfo;
    if (!audit) return;
    const lines = [audit.summary];
    audit.issues.slice(0, 5).forEach((x, i) => {
      lines.push(`${i + 1}. ${x.message}\n   建议：${x.suggestion}`);
    });
    wx.showModal({
      title: `🔍 AI 账单审计（${audit.score} 分）`,
      content: lines.join('\n'),
      showCancel: false
    });
  },

  // ========== V2：成员管理 ==========

  /**
   * 长按移除成员（有未结清余额时禁止）
   */
  removeMember(e) {
    const { id, name } = e.currentTarget.dataset;
    const { room, bills } = this.data;
    wx.showModal({
      title: '移除成员',
      content: `确定将「${name}」移出房间吗？`,
      success: async (res) => {
        if (!res.confirm) return;
        // 未结清余额检查
        const settlement = calculateSettlement(room.members, bills);
        const bal = settlement.balances.find(b => b.id === id);
        if (bal && Math.abs(bal.amount) > 0.01) {
          wx.showToast({ title: `${name} 尚有 ¥${bal.amount.toFixed(2)} 未结清，不能移除`, icon: 'none' });
          return;
        }
        try {
          await db.removeMember(this.data.roomId, id);
          const members = room.members.filter(m => m.id !== id);
          this.setData({ 'room.members': members });
          this.refreshInsight();
          wx.showToast({ title: '已移除', icon: 'success' });
        } catch (err) {
          wx.showToast({ title: '移除失败: ' + err.message, icon: 'none' });
        }
      }
    });
  },

  // ========== V2：账单编辑 / 订单导入 ==========

  editBill(e) {
    const bill = e.currentTarget.dataset.bill;
    const members = JSON.stringify(this.data.room.members || []);
    wx.navigateTo({
      url: `/pages/add-bill/add-bill?roomId=${this.data.roomId}&members=${encodeURIComponent(members)}&bill=${encodeURIComponent(JSON.stringify(bill))}`
    });
  },

  goImportOrders() {
    const members = JSON.stringify(this.data.room.members || []);
    wx.navigateTo({
      url: `/pages/add-bill/add-bill?roomId=${this.data.roomId}&members=${encodeURIComponent(members)}&tab=order`
    });
  },

  /**
   * 删除账单
   */
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
            // 实时监听会自动更新数据
          } catch (e) {
            wx.showToast({ title: '删除失败: ' + e.message, icon: 'none' });
          }
        }
      }
    });
  }
});
