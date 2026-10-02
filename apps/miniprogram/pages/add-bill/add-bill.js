// pages/add-bill/add-bill.js
const db = require('../../utils/db');
const AI = require('../../utils/ai');
const CTRIP = require('../../utils/ctrip');
const { CATEGORIES } = require('../../utils/categories');

Page({
  data: {
    roomId: '',
    members: [],
    categories: CATEGORIES,
    activeTab: 'ai',
    // 编辑模式（V2：记错账可改）
    isEdit: false,
    editBillId: '',
    // 多币种（出境游）
    currencies: [
      { id: 'CNY', name: '人民币', symbol: '¥' },
      { id: 'JPY', name: '日元', symbol: 'JP¥' },
      { id: 'USD', name: '美元', symbol: '$' },
      { id: 'KRW', name: '韩元', symbol: '₩' },
      { id: 'THB', name: '泰铢', symbol: '฿' },
      { id: 'EUR', name: '欧元', symbol: '€' },
      { id: 'HKD', name: '港币', symbol: 'HK$' }
    ],
    form: {
      amount: '',
      description: '',
      category: 'food',
      payer: '',
      payerName: '',
      splitType: 'equal',
      currency: 'CNY'
    },
    customTotal: '0.00',
    ocrImage: '',
    ocrResult: null,
    ocrLoading: false,
    submitting: false,
    // AI 一句话记账
    aiText: '',
    aiParsed: null,
    aiLoading: false,
    voiceBusy: false,
    aiSamples: [
      '打车去机场八十六块，我垫的，和小红小李平分',
      '昨天晚饭花了328，我先垫的，跟小红小李平分',
      '小红请客吃居酒屋520',
      '迪士尼门票2800，小王付的，四个人AA',
      '药妆店扫货花了12000日元，我垫的'
    ],
    // 携程订单导入（V2）
    orderText: '',
    orderDrafts: [],
    orderSamples: CTRIP.CTrip_SAMPLES.map(s => ({ label: s.label, text: s.text }))
  },

  onLoad(options) {
    if (options.roomId) {
      this.setData({ roomId: options.roomId });
    }
    if (options.members) {
      try {
        const members = JSON.parse(decodeURIComponent(options.members));
        const processed = members.map(m => ({ ...m, customAmount: '' }));
        this.setData({
          members: processed,
          'form.payer': members[0] ? members[0].id : '',
          'form.payerName': members[0] ? members[0].name : ''
        });
      } catch (e) {
        console.error('解析成员数据失败', e);
      }
    }
    // V2：编辑模式 —— 携带原账单数据预填
    if (options.bill) {
      try {
        const bill = JSON.parse(decodeURIComponent(options.bill));
        this.setData({
          isEdit: true,
          editBillId: bill._id || bill.id,
          'form.amount': String(bill.amount),
          'form.description': bill.description || '',
          'form.category': bill.category || 'other',
          'form.payer': bill.payer || '',
          'form.payerName': bill.payerName || '',
          'form.splitType': bill.splitType || 'equal',
          'form.currency': bill.currency || 'CNY',
          activeTab: 'manual'
        });
        wx.setNavigationBarTitle({ title: '编辑账单' });
      } catch (e) {
        console.error('解析账单数据失败', e);
      }
    }
    // V2：订单导入入口
    if (options.tab === 'order') {
      this.setData({ activeTab: 'order' });
    }
  },

  // ========== 切换Tab ==========
  switchTab(e) {
    this.setData({ activeTab: e.currentTarget.dataset.tab });
  },

  // ========== AI 一句话记账 ==========
  onAiInput(e) {
    this.setData({ aiText: e.detail.value });
  },

  useAiSample(e) {
    const text = e.currentTarget.dataset.text;
    this.setData({ aiText: text });
    this.parseAiText();
  },

  clearAi() {
    this.setData({ aiText: '', aiParsed: null });
  },

  /**
   * AI 解析一句话 → 结构化账单，并自动填充表单
   * 本地规则引擎毫秒级解析、离线可用；配置 LLM 后可升级为 AI.parseWithLLM
   */
  parseAiText() {
    const text = (this.data.aiText || '').trim();
    if (!text) {
      wx.showToast({ title: '先输入一句话吧', icon: 'none' });
      return;
    }

    this.setData({ aiLoading: true });

    const members = this.data.members.length ? this.data.members : [{ id: 'me', name: '我' }];
    const parsed = AI.parseBillText(text, members, { meName: members[0].name });

    // 展示字段
    const cat = CATEGORIES.find(c => c.id === parsed.category);
    parsed.categoryName = cat ? cat.name : '其他';
    parsed.splitLabel = parsed.splitType === 'equal' ? '均分' : parsed.splitType === 'treat' ? '请客' : '自定义';

    // 自动填充表单
    this.setData({
      aiParsed: parsed,
      aiLoading: false,
      'form.amount': parsed.amount != null ? String(parsed.amount) : this.data.form.amount,
      'form.description': parsed.description || this.data.form.description,
      'form.category': parsed.category || this.data.form.category,
      'form.payer': parsed.payerId || this.data.form.payer,
      'form.payerName': parsed.payerName || this.data.form.payerName,
      'form.splitType': parsed.splitType === 'custom' ? 'custom' : parsed.splitType,
      'form.currency': parsed.currency || this.data.form.currency
    });

    if (parsed.needManual) {
      wx.showToast({ title: '没识别到金额，请补充', icon: 'none' });
    } else {
      wx.showToast({ title: 'AI 解析完成，已填入表单', icon: 'success' });
    }
  },

  // ========== 语音记账（会听） ==========
  /**
   * 语音 → 文本 → 归一化 → 同一 NL 解析管线
   * 优先使用微信同声传译插件（WechatSI，需在 app.json 声明并开通）；
   * 未开通时降级为手动输入，演示永不翻车
   */
  startVoiceInput() {
    let plugin = null;
    try { plugin = requirePlugin('WechatSI'); } catch (e) { plugin = null; }

    if (!plugin || !plugin.record) {
      wx.showModal({
        title: '🎙️ 语音记账',
        content: '语音插件（WechatSI）未开通时，可直接在输入框口述一句话，如「打车去机场八十六块，我垫的，和小红小李平分」——口语数字会自动归一化解析。',
        confirmText: '去输入',
        success: (res) => {
          if (res.confirm) this.setData({ activeTab: 'ai' });
        }
      });
      return;
    }

    this.setData({ voiceBusy: true });
    plugin.record.onStart = () => wx.showLoading({ title: '聆听中…' });
    plugin.record.onRecognize = (res) => {
      wx.hideLoading();
      const text = AI.normalizeSpeech(res.result || '');
      this.setData({ aiText: text, voiceBusy: false });
      this.parseAiText();
    };
    plugin.record.onError = () => {
      wx.hideLoading();
      this.setData({ voiceBusy: false });
      wx.showToast({ title: '语音识别失败，请手动输入', icon: 'none' });
    };
    try { plugin.record.start(); } catch (e) {
      this.setData({ voiceBusy: false });
      wx.showToast({ title: '语音启动失败', icon: 'none' });
    }
  },

  // ========== 多币种 ==========
  selectCurrency(e) {
    this.setData({ 'form.currency': e.currentTarget.dataset.id });
  },

  // ========== 携程订单导入（会读单） ==========
  onOrderInput(e) {
    this.setData({ orderText: e.detail.value });
  },

  useOrderSample(e) {
    const text = e.currentTarget.dataset.text;
    this.setData({ orderText: text });
    this.parseOrderText();
  },

  /**
   * 订单文本 → 账单草稿预览（确认后批量入账）
   */
  parseOrderText() {
    const text = (this.data.orderText || '').trim();
    if (!text) {
      wx.showToast({ title: '先粘贴订单文本吧', icon: 'none' });
      return;
    }
    const members = this.data.members.length ? this.data.members : [{ id: 'me', name: '我' }];
    const drafts = CTRIP.importOrders(text, members, { payerId: this.data.form.payer });
    if (!drafts.length) {
      wx.showToast({ title: '未识别到有效订单（需含金额）', icon: 'none' });
      return;
    }
    this.setData({ orderDrafts: drafts });
    wx.showToast({ title: `识别到 ${drafts.length} 笔订单`, icon: 'success' });
  },

  /**
   * 确认导入订单 → 批量入账
   */
  async importOrderBills() {
    const drafts = this.data.orderDrafts || [];
    if (!drafts.length) return;

    this.setData({ submitting: true });
    try {
      for (const d of drafts) {
        await db.addBill(this.data.roomId, {
          amount: d.amount,
          description: d.description,
          category: d.category,
          payer: d.payer,
          payerName: d.payerName,
          splitType: d.splitType,
          splits: d.splits,
          currency: d.currency,
          rate: d.rate,
          cnyAmount: d.cnyAmount,
          orderNo: d.orderNo,
          source: 'ctrip',
          imageUrl: ''
        });
      }
      wx.showToast({ title: `已导入 ${drafts.length} 笔订单`, icon: 'success' });
      setTimeout(() => wx.navigateBack(), 1000);
    } catch (e) {
      wx.showToast({ title: '导入失败: ' + e.message, icon: 'none' });
    }
    this.setData({ submitting: false });
  },

  // ========== 手动输入 ==========
  onAmountInput(e) {
    this.setData({ 'form.amount': e.detail.value });
  },

  onDescInput(e) {
    this.setData({ 'form.description': e.detail.value });
  },

  selectCategory(e) {
    this.setData({ 'form.category': e.currentTarget.dataset.id });
  },

  selectPayer(e) {
    this.setData({
      'form.payer': e.currentTarget.dataset.id,
      'form.payerName': e.currentTarget.dataset.name
    });
  },

  selectSplitType(e) {
    const type = e.currentTarget.dataset.type;
    this.setData({ 'form.splitType': type });

    if (type === 'equal') {
      const members = this.data.members.map(m => ({ ...m, customAmount: '' }));
      this.setData({ members, customTotal: '0.00' });
    }
  },

  onCustomAmount(e) {
    const index = e.currentTarget.dataset.index;
    const value = e.detail.value;
    const members = [...this.data.members];
    members[index].customAmount = value;

    const total = members.reduce((sum, m) => sum + (parseFloat(m.customAmount) || 0), 0);
    this.setData({ members, customTotal: total.toFixed(2) });
  },

  /**
   * 生成分摊数据
   */
  generateSplits() {
    const { form, members } = this.data;
    const amount = parseFloat(form.amount);

    if (form.splitType === 'equal') {
      // 最大余额法均分：分摊合计恒等于账单金额（修复均分尾差）
      const amounts = AI.allocateEvenly(amount, members.length);
      return members.map((m, i) => ({
        memberId: m.id,
        memberName: m.name,
        amount: amounts[i]
      }));
    } else if (form.splitType === 'custom') {
      return members.map(m => ({
        memberId: m.id,
        memberName: m.name,
        amount: parseFloat(m.customAmount) || 0
      }));
    } else {
      return members.map(m => ({
        memberId: m.id,
        memberName: m.name,
        amount: m.id === form.payer ? amount : 0
      }));
    }
  },

  /**
   * 提交账单
   */
  async submitBill() {
    const { form } = this.data;
    const amount = parseFloat(form.amount);

    if (!amount || amount <= 0) {
      wx.showToast({ title: '请输入正确的金额', icon: 'none' });
      return;
    }
    if (!form.payer) {
      wx.showToast({ title: '请选择付款人', icon: 'none' });
      return;
    }

    // 校验分摊合计（防止自定义分摊账不平）
    const checkSplits = this.generateSplits();
    const splitSum = checkSplits.reduce((s, x) => s + x.amount, 0);
    if (Math.abs(splitSum - amount) > 0.01) {
      wx.showToast({ title: '分摊合计 ¥' + splitSum.toFixed(2) + ' 与账单金额不符', icon: 'none' });
      return;
    }

    this.setData({ submitting: true });
    try {
      const splits = this.generateSplits();
      // 多币种：记账时快照汇率与人民币折算额（结算按快照折算，不漂移）
      const currency = form.currency || 'CNY';
      const rate = currency === 'CNY' ? 1 : (AI.getRates()[currency] || 1);
      const cnyAmount = AI.toCNY(amount, currency);

      const payload = {
        amount,
        description: form.description,
        category: form.category,
        payer: form.payer,
        payerName: form.payerName,
        splitType: form.splitType,
        splits,
        currency,
        rate,
        cnyAmount,
        imageUrl: ''
      };

      if (this.data.isEdit && this.data.editBillId) {
        await db.updateBill(this.data.editBillId, payload);
        wx.showToast({ title: '已保存修改', icon: 'success' });
      } else {
        await db.addBill(this.data.roomId, payload);
        wx.showToast({ title: '记账成功！', icon: 'success' });
      }
      setTimeout(() => wx.navigateBack(), 1000);
    } catch (e) {
      wx.showToast({ title: '记账失败: ' + e.message, icon: 'none' });
    }
    this.setData({ submitting: false });
  },

  // ========== OCR识别 ==========
  chooseImage() {
    const that = this;
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const tempPath = res.tempFiles[0].tempFilePath;
        that.setData({
          ocrImage: tempPath,
          ocrResult: null,
          ocrLoading: true
        });
        that.doOCR(tempPath);
      }
    });
  },

  /**
   * 执行OCR识别
   */
  async doOCR(imagePath) {
    try {
      wx.showLoading({ title: '识别中...' });

      // 调用OCR（自动上传图片、识别、删除临时文件）
      const result = await db.recognizeBill(imagePath);

      wx.hideLoading();

      if (result.success) {
        // 识别成功，填充表单
        this.setData({
          ocrResult: {
            amount: result.amount || '',
            merchant: result.merchant || '',
            time: result.time || '',
            confidence: result.confidence || 0,
            imageType: result.imageType || 'unknown'
          },
          ocrLoading: false,
          // 自动填充到表单
          'form.amount': result.amount ? String(result.amount) : '',
          'form.description': result.merchant || '',
          'form.category': result.category || 'other'
        });

        if (result.needManual) {
          wx.showToast({ title: '请补充金额信息', icon: 'none' });
        } else {
          wx.showToast({ title: '识别成功！', icon: 'success' });
        }
      } else {
        throw new Error(result.error || '识别失败');
      }
    } catch (e) {
      console.error('OCR识别失败', e);
      wx.hideLoading();
      this.setData({
        ocrLoading: false,
        ocrResult: {
          amount: '',
          merchant: '',
          time: '',
          confidence: 0,
          needManual: true
        }
      });
      wx.showToast({ title: '识别失败，请手动输入', icon: 'none' });
    }
  },

  onOcrAmountInput(e) {
    this.setData({
      'ocrResult.amount': e.detail.value,
      'form.amount': e.detail.value
    });
  },

  onOcrMerchantInput(e) {
    this.setData({
      'ocrResult.merchant': e.detail.value,
      'form.description': e.detail.value
    });
  },

  onOcrTimeInput(e) {
    this.setData({ 'ocrResult.time': e.detail.value });
  },

  /**
   * 确认OCR账单入账
   */
  async confirmOcrBill() {
    // 复用手动提交逻辑
    this.submitBill();
  }
});
