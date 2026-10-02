// pages/index/index.js
const db = require('../../utils/db');
const app = getApp();

Page({
  data: {
    rooms: [],
    destinations: [],
    showCreate: false,
    showJoin: false,
    creating: false,
    joining: false,
    joinCode: '',
    joinName: '',
    form: {
      name: '',
      destination: '',
      startDate: '',
      endDate: '',
      creatorName: ''
    }
  },

  onLoad() {
    this.setData({
      destinations: app.globalData.destinations
    });
  },

  onShow() {
    this.loadRooms();
  },

  async loadRooms() {
    try {
      const rooms = await db.getMyRooms();
      this.setData({ rooms });
    } catch (e) {
      console.error('加载房间失败', e);
    }
  },

  // ========== 创建房间 ==========
  showCreateModal() {
    this.setData({
      showCreate: true,
      form: {
        name: '',
        destination: '',
        startDate: '',
        endDate: '',
        creatorName: (app.globalData.userInfo && app.globalData.userInfo.nickName) || ''
      }
    });
  },

  hideCreateModal() {
    this.setData({ showCreate: false });
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({
      [`form.${field}`]: e.detail.value
    });
  },

  onDateChange(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({
      [`form.${field}`]: e.detail.value
    });
  },

  selectDest(e) {
    this.setData({
      'form.destination': e.currentTarget.dataset.dest
    });
  },

  async createRoom() {
    const { form } = this.data;
    if (!form.name) {
      wx.showToast({ title: '请输入旅行名称', icon: 'none' });
      return;
    }
    if (!form.creatorName) {
      wx.showToast({ title: '请输入你的昵称', icon: 'none' });
      return;
    }

    this.setData({ creating: true });
    try {
      const room = await db.createRoom({
        name: form.name,
        destination: form.destination,
        startDate: form.startDate,
        endDate: form.endDate,
        creatorName: form.creatorName,
        creatorAvatar: (app.globalData.userInfo && app.globalData.userInfo.avatarUrl) || ''
      });

      wx.showToast({ title: '创建成功！', icon: 'success' });
      this.hideCreateModal();
      this.loadRooms();

      // 显示房间号
      wx.showModal({
        title: '房间创建成功',
        content: `房间号: ${room.roomCode}\n分享给朋友让他们加入吧！`,
        showCancel: false,
        confirmText: '知道了'
      });
    } catch (e) {
      wx.showToast({ title: '创建失败: ' + e.message, icon: 'none' });
    }
    this.setData({ creating: false });
  },

  // ========== 加入房间 ==========
  showJoinModal() {
    this.setData({
      showJoin: true,
      joinCode: '',
      joinName: (app.globalData.userInfo && app.globalData.userInfo.nickName) || ''
    });
  },

  hideJoinModal() {
    this.setData({ showJoin: false });
  },

  onJoinCodeInput(e) {
    this.setData({ joinCode: e.detail.value });
  },

  onJoinNameInput(e) {
    this.setData({ joinName: e.detail.value });
  },

  async joinRoom() {
    const { joinCode, joinName } = this.data;
    if (!joinCode || joinCode.length !== 6) {
      wx.showToast({ title: '请输入6位房间号', icon: 'none' });
      return;
    }
    if (!joinName) {
      wx.showToast({ title: '请输入你的昵称', icon: 'none' });
      return;
    }

    this.setData({ joining: true });
    try {
      const room = await db.joinRoom(joinCode, {
        nickName: joinName,
        avatarUrl: (app.globalData.userInfo && app.globalData.userInfo.avatarUrl) || ''
      });

      wx.showToast({ title: '加入成功！', icon: 'success' });
      this.hideJoinModal();
      this.loadRooms();

      // 跳转到房间
      wx.navigateTo({
        url: `/pages/room/room?id=${room._id}`
      });
    } catch (e) {
      wx.showToast({ title: e.message || '加入失败', icon: 'none' });
    }
    this.setData({ joining: false });
  },

  goToRoom(e) {
    const roomId = e.currentTarget.dataset.roomid;
    wx.navigateTo({
      url: `/pages/room/room?id=${roomId}`
    });
  },

  onShareAppMessage() {
    return {
      title: 'TravelAA - 旅行AA神器',
      path: '/pages/index/index'
    };
  }
});
