// app.js
const db = require('./utils/db');

App({
  onLaunch: function () {
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力');
      this.enableDemoMode();
      return;
    }

    try {
      wx.cloud.init({
        // 替换为你的云开发环境ID
        env: 'travel-aa-env',
        traceUser: true,
      });
      console.log('云开发初始化成功');
    } catch (e) {
      console.log('云开发初始化失败，启用演示模式', e);
      this.enableDemoMode();
    }

    // 获取用户信息
    this.globalData.db = wx.cloud.database();
    this.getUserInfo();
  },

  enableDemoMode: function () {
    db.setDemoMode(true);
    this.globalData.isDemo = true;
    console.log('✅ 已启用演示模式 - 使用演示数据');
  },

  getUserInfo: function () {
    const that = this;
    wx.getSetting({
      success: res => {
        if (res.authSetting['scope.userInfo']) {
          wx.getUserInfo({
            success: res => {
              that.globalData.userInfo = res.userInfo;
            }
          });
        }
      }
    });
  },

  globalData: {
    userInfo: null,
    openid: null,
    db: null,
    isDemo: false,
    currentRoomId: null,
    // 旅行目的地列表（用于快速选择）
    destinations: [
      '东京', '大阪', '首尔', '曼谷', '清迈',
      '新加坡', '巴厘岛', '巴黎', '伦敦', '纽约',
      '悉尼', '迪拜', '马尔代夫', '普吉岛', '济州岛',
      '台北', '香港', '澳门', '丽江', '大理',
      '成都', '重庆', '西安', '杭州', '厦门',
      '三亚', '青岛', '桂林', '张家界', '拉萨'
    ]
  }
});
