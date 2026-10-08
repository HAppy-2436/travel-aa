// pages/capture/capture.js
//
// 记账方式总入口（对齐网页端的「截图也行 / 票据识别」这条路径）。
//
// 为什么单独一页：以前**票据识别 UI 完全缺失** ——
//   utils/db.recognizeBill() 与 ocr 云函数都已就绪，但没有任何页面调用它，
//   7 个相关方法成了死代码，用户也找不到"拍张照就记账"的入口。
const db = require('../../utils/db');
const AI = require('../../utils/ai');
const { getCategoryById } = require('../../utils/categories');

Page({
  data: {
    roomId: '',
    room: {},
    mode: 'ocr',            // ocr 拍照识别 / manual 手填
    imagePath: '',
    busy: false,
    result: null,
    resultSourceText: '',
    /* 识别结果可编辑：OCR 会错，必须让人改得动（不改就只能重拍） */
    draft: { amount: '', description: '', category: 'food', payer: '', payerName: '' },
    members: [],
    categories: []
  },

  onLoad(options) {
    if (options.roomId) {
      this.setData({ roomId: options.roomId, categories: AI.CATEGORIES || [] });
      this.loadRoom();
    }
  },

  async loadRoom() {
    try {
      const room = await db.getRoomDetail(this.data.roomId);
      const me = (getApp().globalData && getApp().globalData.userInfo) || {};
      const members = (room && room.members) || [];
      const myId = me.id || me.openid || (members[0] && members[0].id) || '';
      /* 默认付款人＝**还在队里**的第一个人（有人先走之后，默认不该落到已离队的人身上） */
      const active = AI.activeMemberIds({ members }, new Date().toISOString());
      const def = members.find(m => m.id === myId && active.indexOf(m.id) >= 0)
        || members.find(m => active.indexOf(m.id) >= 0)
        || members[0] || {};
      this.setData({
        room,
        members,
        'draft.payer': def.id || '',
        'draft.payerName': def.name || ''
      });
    } catch (e) {
      console.error('加载房间失败', e);
      wx.showToast({ title: '加载房间失败', icon: 'none' });
    }
  },

  /* 拍照 / 从相册选一张票据，直接走 OCR */
  chooseAndRecognize() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['camera', 'album'],
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0];
        if (file) {
          this.setData({ imagePath: file.tempFilePath });
          this.recognize(file.tempFilePath);
        }
      },
      fail: () => { /* 用户取消，不提示 */ }
    });
  },

  async recognize(filePath) {
    this.setData({ busy: true, result: null });
    try {
      const r = await db.recognizeBill(filePath);
      if (!r || !r.success) throw new Error((r && r.error) || '识别失败');
      const draft = Object.assign({}, this.data.draft, {
        amount: r.amount != null ? String(r.amount) : '',
        description: r.merchant || '票据消费',
        category: r.category || 'food'
      });
      this.setData({
        busy: false,
        result: r,
        draft,
        resultSourceText: r.needManual
          ? '没看清金额，请手动补一下'
          : ('识别置信度 ' + (r.confidence || 0) + '%')
      });
      /* 演示模式（无云环境）也能走完整条链路 —— db.recognizeBill 会返回样例数据 */
    } catch (e) {
      this.setData({ busy: false });
      wx.showToast({ title: '识别失败：' + e.message, icon: 'none' });
    }
  },

  onAmountInput(e) { this.setData({ 'draft.amount': e.detail.value }); },
  onDescInput(e) { this.setData({ 'draft.description': e.detail.value }); },
  selectCategory(e) { this.setData({ 'draft.category': e.currentTarget.dataset.id }); },
  selectPayer(e) {
    this.setData({
      'draft.payer': e.currentTarget.dataset.id,
      'draft.payerName': e.currentTarget.dataset.name
    });
  },

  /* 确认入账：分摊口径与手填页一致（均分给**还在队里**的人 / 私账自己承担） */
  async confirm() {
    const { draft, members, roomId } = this.data;
    const amount = parseFloat(draft.amount);
    if (!amount || amount <= 0) {
      wx.showToast({ title: '请输入正确的金额', icon: 'none' });
      return;
    }
    if (!draft.payer) {
      wx.showToast({ title: '请选择付款人', icon: 'none' });
      return;
    }
    const active = AI.activeMemberIds({ members }, new Date().toISOString());
    const sharers = members.filter(m => active.indexOf(m.id) >= 0);
    const base = sharers.length ? sharers : members;
    const parts = AI.allocateEvenly(amount, base.length);
    const splits = members.map((m) => {
      const i = base.map(x => x.id).indexOf(m.id);
      return { memberId: m.id, memberName: m.name, amount: i < 0 ? 0 : parts[i] };
    });

    this.setData({ busy: true });
    try {
      await db.addBill(roomId, {
        amount,
        description: draft.description || '票据消费',
        category: draft.category || 'food',
        payer: draft.payer,
        payerName: draft.payerName,
        splitType: 'equal',
        splits,
        currency: 'CNY',
        rate: 1,
        cnyAmount: amount,
        imageUrl: '',
        source: 'ocr',
        scope: 'group'
      });
      wx.showToast({ title: '已入账', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 900);
    } catch (e) {
      this.setData({ busy: false });
      wx.showToast({ title: '入账失败：' + e.message, icon: 'none' });
    }
  },

  /* 识别不准时退回手填页（那边有完整的分类/币种/分摊选项） */
  goManual() {
    const members = JSON.stringify(this.data.members || []);
    const pre = JSON.stringify({
      amount: this.data.draft.amount,
      description: this.data.draft.description,
      category: this.data.draft.category
    });
    wx.navigateTo({
      url: `/pages/add-bill/add-bill?roomId=${this.data.roomId}&members=${encodeURIComponent(members)}&bill=${encodeURIComponent(pre)}&fromOcr=1`
    });
  }
});
