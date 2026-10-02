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

      // AI 消费小作文（模板保底，离线可用）
      const narrative = await AI.generateNarrative({ room, bills, members: room.members });

      this.setData({
        room,
        members: room.members,
        bills,
        billCount: bills.length,
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
    // 生成分享图片
    this.drawBillImage();
    this.setData({ showPreview: true });
  },

  hidePreview() {
    this.setData({ showPreview: false });
  },

  // 绘制账单图片
  drawBillImage() {
    const ctx = wx.createCanvasContext('billCanvas');
    const { room, settlement } = this.data;
    const W = 600, H = 800;

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
    ctx.fillText(room.name || '旅行AA', W / 2, 85);

    // 房间信息
    ctx.setFillStyle('#333333');
    ctx.setTextAlign('left');
    ctx.setFontSize(16);
    let y = 190;

    if (room.destination) {
      ctx.fillText(`📍 ${room.destination}`, 30, y);
      y += 30;
    }
    ctx.fillText(`👥 ${room.members.length}人 · 📝 ${this.data.billCount}笔`, 30, y);
    y += 30;
    ctx.fillText(`💰 总消费: ¥${settlement.totalExpense.toFixed(2)}`, 30, y);
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
    settlement.balances.forEach(b => {
      ctx.setFillStyle('#333333');
      ctx.fillText(b.name, 30, y);
      ctx.setFillStyle(b.amount >= 0 ? '#07C160' : '#FA5151');
      ctx.setTextAlign('right');
      ctx.fillText(`${b.amount >= 0 ? '+' : ''}¥${b.amount.toFixed(2)}`, W - 30, y);
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
    ctx.fillText(`🔄 最简转账方案 (${settlement.transfers.length}笔)`, 30, y);
    y += 35;

    ctx.setFontSize(16);
    settlement.transfers.forEach((t, i) => {
      ctx.setFillStyle('#333333');
      ctx.fillText(`${i + 1}. ${t.fromName} → ${t.toName}`, 30, y);
      ctx.setFillStyle('#FF6B35');
      ctx.setTextAlign('right');
      ctx.fillText(`¥${t.amount.toFixed(2)}`, W - 30, y);
      ctx.setTextAlign('left');
      y += 30;
    });

    // 底部
    y = H - 60;
    ctx.setFillStyle('#999999');
    ctx.setFontSize(12);
    ctx.setTextAlign('center');
    ctx.fillText('由 TravelAA 旅行AA记账小程序 生成', W / 2, y);

    ctx.draw();
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
