// pages/settle/settle.js
const db = require('../../utils/db');
const AI = require('../../utils/ai');
const { calculateSettlement, generateShareText } = require('../../utils/settle');
const { getCategoryById } = require('../../utils/categories');

Page({
  data: {
    roomId: '',
    room: {},
    members: [],
    bills: [],
    billCount: 0,
    settlement: {
      balances: [],
      transfers: [],
      totalExpense: 0,
      currencies: ['CNY'],
      hasForeign: false
    },
    // V2：AI 小作文 & 结清状态
    narrative: '',
    settledAt: '',
    showPreview: false
  },

  onLoad(options) {
    if (options.roomId) {
      this.setData({ roomId: options.roomId });
      this.loadAndCalculate();
    }
  },

  async loadAndCalculate() {
    wx.showLoading({ title: '计算中...' });
    try {
      const [room, bills] = await Promise.all([
        db.getRoomDetail(this.data.roomId),
        db.getRoomBills(this.data.roomId)
      ]);

      // 计算结算方案（V2：外币按记账快照汇率折算人民币）
      const settlement = calculateSettlement(room.members, bills);

      /* ⚠️ WXML 表达式**不支持函数调用**：`{{settlement.totalExpense.toFixed(2)}}`
         这类写法在真机上直接不渲染（数值空白）。一律在 JS 里先算成字符串。
         顺便把「待转出 / 待收到」的角色也算好 —— 与网页端一致：
         付款方看到"待转出"、收款方看到"待收到"、与我无关的行不显示按钮。 */
      const me = (getApp().globalData && getApp().globalData.userInfo) || {};
      const myId = me.id || me.openid || '';
      settlement.totalExpenseText = (Number(settlement.totalExpense) || 0).toFixed(2);
      settlement.balances = (settlement.balances || []).map(b => ({
        ...b,
        isMe: b.id === myId,
        amountText: (b.amount >= 0 ? '+' : '') + '¥' + Math.abs(Number(b.amount) || 0).toFixed(2),
        typeText: b.amount >= 0 ? '应收款 · RECEIVE' : '应付款 · PAY'
      }));
      settlement.transfers = (settlement.transfers || []).map(t => {
        const role = t.from === myId ? 'out' : (t.to === myId ? 'in' : 'other');
        return {
          ...t,
          amountText: (Number(t.amount) || 0).toFixed(2),
          role,
          roleText: role === 'out' ? '待转出' : (role === 'in' ? '待收到' : '与我无关')
        };
      });

      // AI 消费小作文（模板保底，离线可用）
      const narrative = await AI.generateNarrative({ room, bills, members: room.members });

      this.setData({
        room,
        members: room.members,
        bills,
        billCount: settlement.balances.length ? bills.length : bills.length,
        settlement,
        narrative,
        settledAt: room.settledAt || ''
      });
    } catch (e) {
      console.error('计算失败', e);
      wx.showToast({ title: '计算失败', icon: 'none' });
    }
    wx.hideLoading();
  },

  /* Bug#2：记完账回到结算页必须重算，否则看到的是上一次的数字。
     以前只有 onLoad，返回时不会重新加载。 */
  onShow() {
    if (this.data.roomId) this.loadAndCalculate();
  },

  // V2：标记已结清（结算闭环）
  async markSettled() {
    try {
      const settledAt = await db.markSettled(this.data.roomId);
      this.setData({ settledAt });
      wx.showToast({ title: '已标记结清 🎉', icon: 'success' });
    } catch (e) {
      wx.showToast({ title: '操作失败: ' + e.message, icon: 'none' });
    }
  },

  // V2：复制 AI 小作文
  copyNarrative() {
    wx.setClipboardData({
      data: this.data.narrative,
      success: () => wx.showToast({ title: '小作文已复制', icon: 'success' })
    });
  },

  // 复制账单文本
  copyBillText() {
    const text = generateShareText(this.data.room, this.data.settlement);
    wx.setClipboardData({
      data: text,
      success: () => {
        wx.showToast({ title: '账单已复制', icon: 'success' });
      }
    });
  },

  // 分享账单
  shareBill() {
    /* Bug#7：以前直接 setData({showPreview:true}) 但 WXML 里既没有 <canvas>、
       也没有预览层 → 点了"分享结算"什么都没发生。
       现在：WXML 里有 canvas + 预览弹层，图上画好再展示，可保存到相册。 */
    this.drawBillImage();
    this.setData({ showPreview: true, previewReady: true });
  },

  hidePreview() {
    this.setData({ showPreview: false });
  },

  // 预览层的点击穿透保护（catchtap 需要一个存在的处理函数，否则会冒泡关掉弹层）
  noop() {},

  /* 绘制账单图片。
     ⚠️ 用 `saveImage` 里的 canvasToTempFilePath 需要 canvas 节点已挂载且画过 —— 
        所以这里先 draw()，成功回调里再置 previewReady。 */
  drawBillImage() {
    const ctx = wx.createCanvasContext('billCanvas');
    const { room, settlement } = this.data;
    const W = 600, H = 800;
    if (!ctx) return;
    const r = room || {};
    const members = r.members || [];

    // 背景
    ctx.setFillStyle('#FFFFFF');
    ctx.fillRect(0, 0, W, H);

    // 顶部渐变
    const grd = ctx.createLinearGradient(0, 0, W, 160);
    grd.addColorStop(0, '#FF6B35');
    grd.addColorStop(1, '#FF8F65');
    ctx.setFillStyle(grd);
    ctx.fillRect(0, 0, W, 160);

    // 标题
    ctx.setFillStyle('#FFFFFF');
    ctx.setFontSize(32);
    ctx.setTextAlign('center');
    ctx.fillText('✈️ TravelAA 结算单', W / 2, 50);

    ctx.setFontSize(18);
    ctx.fillText(r.name || '旅行AA', W / 2, 85);

    // 房间信息
    ctx.setFillStyle('#333333');
    ctx.setTextAlign('left');
    ctx.setFontSize(16);
    let y = 190;

    if (r.destination) {
      ctx.fillText(`📍 ${r.destination}`, 30, y);
      y += 30;
    }
    ctx.fillText(`👥 ${members.length}人 · 📝 ${this.data.billCount}笔`, 30, y);
    y += 30;
    ctx.fillText(`💰 总消费: ¥${settlement.totalExpenseText || settlement.totalExpense}`, 30, y);
    y += 50;

    // 分割线
    ctx.setStrokeStyle('#E8E8E8');
    ctx.setLineWidth(1);
    ctx.moveTo(30, y);
    ctx.lineTo(W - 30, y);
    ctx.stroke();
    y += 30;

    // 各人收支
    ctx.setFillStyle('#FF6B35');
    ctx.setFontSize(20);
    ctx.fillText('📊 各人收支', 30, y);
    y += 35;

    ctx.setFontSize(16);
    (settlement.balances || []).forEach(b => {
      ctx.setFillStyle('#333333');
      ctx.fillText(b.name || '', 30, y);
      ctx.setFillStyle(b.amount >= 0 ? '#07C160' : '#FA5151');
      ctx.setTextAlign('right');
      ctx.fillText(`${b.amount >= 0 ? '+' : '-'}¥${Math.abs(Number(b.amount) || 0).toFixed(2)}`, W - 30, y);
      ctx.setTextAlign('left');
      y += 30;
    });

    y += 20;

    // 分割线
    ctx.moveTo(30, y);
    ctx.lineTo(W - 30, y);
    ctx.stroke();
    y += 30;

    // 转账方案
    ctx.setFillStyle('#FF6B35');
    ctx.setFontSize(20);
    ctx.fillText(`🔄 最简转账方案 (${(settlement.transfers || []).length}笔)`, 30, y);
    y += 35;

    ctx.setFontSize(16);
    (settlement.transfers || []).forEach((t, i) => {
      ctx.setFillStyle('#333333');
      ctx.fillText(`${i + 1}. ${t.fromName} → ${t.toName}`, 30, y);
      ctx.setFillStyle('#FF6B35');
      ctx.setTextAlign('right');
      ctx.fillText(`¥${(Number(t.amount) || 0).toFixed(2)}`, W - 30, y);
      ctx.setTextAlign('left');
      y += 30;
    });

    // 底部
    y = H - 60;
    ctx.setFillStyle('#999999');
    ctx.setFontSize(12);
    ctx.setTextAlign('center');
    ctx.fillText('由 TravelAA 旅行AA记账小程序 生成', W / 2, y);

    /* 画完再置 previewReady：canvasToTempFilePath 必须等 draw 完成，
       否则拿到空图（旧代码还少了 canvas 节点，整个分享链路是死的）。 */
    ctx.draw(false, () => {
      this.setData({ previewReady: true });
    });
  },

  // 保存图片
  saveImage() {
    wx.canvasToTempFilePath({
      canvasId: 'billCanvas',
      success: (res) => {
        wx.saveImageToPhotosAlbum({
          filePath: res.tempFilePath,
          success: () => {
            wx.showToast({ title: '已保存到相册', icon: 'success' });
            this.setData({ showPreview: false });
          },
          fail: () => {
            wx.showToast({ title: '保存失败', icon: 'none' });
          }
        });
      }
    });
  },

  onShareAppMessage() {
    return {
      title: `${this.data.room.name} - 结算单`,
      path: `/pages/settle/settle?roomId=${this.data.roomId}`
    };
  }
});
