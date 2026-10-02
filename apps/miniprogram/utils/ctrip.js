/**
 * TravelAA 携程行程订单导入模块（三端复用：微信小程序 / 浏览器 Demo / Node Server）
 *
 * 赛道契合的核心叙事：把携程行程订单（机票/酒店/火车票/门票/租车）一键变成 AA 账单 ——
 * 「机酒门票消费自动入账」，旅行记账从"手动补录"升级为"行程即账本"。
 *
 * 能力清单：
 *  1. parseOrderText  订单确认文本 → 结构化订单（类型/订单号/金额/日期/出行人）
 *  2. parseOrders     批量订单文本 → 订单数组（空行/分隔线切分）
 *  3. orderToBill     订单 → AA 账单草稿（分类映射、全员分摊、汇率快照）
 *  4. importOrders    一步导入：文本 + 成员 → 账单草稿数组
 *  5. CTrip_SAMPLES   内置示例订单（演示一键导入）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TravelCTrip = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ============ 订单类型识别词典 ============

  var TYPE_KEYWORDS = {
    flight: ['航班', '机票', '经济舱', '公务舱', '头等舱', '登机', '起飞', '乘机人', '航站楼', '值机'],
    hotel: ['酒店', '入住', '退房', '房型', '大床房', '双床', '民宿', '间夜', '客房'],
    train: ['车次', '高铁', '动车', '火车', '座位', '检票', '候车', '车厢'],
    ticket: ['门票', '景区', '乐园', '演出', '成人票', '儿童票', '游玩日期', '观光', '索道'],
    car: ['租车', '取车', '还车', '车型', '租赁']
  };

  var TYPE_META = {
    flight: { name: '机票', category: 'transport', icon: '✈️' },
    hotel: { name: '酒店', category: 'hotel', icon: '🏨' },
    train: { name: '火车票', category: 'transport', icon: '🚄' },
    ticket: { name: '门票', category: 'ticket', icon: '🎫' },
    car: { name: '租车', category: 'transport', icon: '🚗' },
    other: { name: '其他', category: 'other', icon: '📦' }
  };

  // ============ 示例订单（演示一键导入） ============

  var CTrip_SAMPLES = [
    {
      id: 'flight',
      label: '✈️ 机票订单（东京往返）',
      text: '【携程旅行】订单支付成功\n' +
        '订单号：1034567890\n' +
        '上海浦东T2 → 东京成田T1 往返机票\n' +
        '航班 MU523 2024-10-01 08:25 起飞\n' +
        '乘机人：小明、小红、小李、小王\n' +
        '实付金额：¥6240.00'
    },
    {
      id: 'hotel',
      label: '🏨 酒店订单（新宿 4 晚）',
      text: '【携程旅行】酒店订单确认\n' +
        '订单号：H9876543210\n' +
        '东京新宿格拉斯丽酒店 高级大床房 4晚\n' +
        '入住：2024-10-01 退房：2024-10-05\n' +
        '入住人：小明\n' +
        '订单总额：¥3200.00'
    },
    {
      id: 'ticket',
      label: '🎫 门票订单（迪士尼 x4）',
      text: '【携程旅行】门票订单\n' +
        '订单号：T2468101214\n' +
        '东京迪士尼乐园 一日票 成人票 x4\n' +
        '游玩日期：2024-10-04\n' +
        '游客：小明、小红、小李、小王\n' +
        '支付金额：¥2800.00'
    }
  ];

  // ============ 基础解析 ============

  function round2(n) { return Math.round(n * 100) / 100; }

  function detectType(text) {
    var full = String(text || '');
    var best = { type: 'other', score: 0 };
    Object.keys(TYPE_KEYWORDS).forEach(function (type) {
      var score = 0;
      TYPE_KEYWORDS[type].forEach(function (kw) {
        if (full.indexOf(kw) !== -1) score += kw.length >= 3 ? 3 : 2;
      });
      if (score > best.score) best = { type: type, score: score };
    });
    return best.type;
  }

  function extractOrderNo(text) {
    var m = String(text || '').match(/(?:订单号|订单编号|order\s*no\.?|单号)[：:\s]*([A-Za-z0-9-]{5,})/i);
    return m ? m[1] : '';
  }

  function extractAmount(text) {
    var full = String(text || '');
    var patterns = [
      /(?:实付(?:金额)?|支付金额|订单总额|总额|合计|总计|金额|总价)[：:\s]*[¥￥$]?([0-9]+(?:\.[0-9]{1,2})?)/,
      /[¥￥$]([0-9]+(?:\.[0-9]{1,2})?)/,
      /([0-9]+\.[0-9]{2})\s*元/
    ];
    for (var i = 0; i < patterns.length; i++) {
      var m = full.match(patterns[i]);
      if (m) {
        var v = parseFloat(m[1]);
        if (v > 0 && v < 10000000) return round2(v);
      }
    }
    return null;
  }

  function extractCurrency(text) {
    var lower = String(text || '').toLowerCase();
    if (/美元|美金|usd|\$/.test(lower)) return 'USD';
    if (/日元|日币|jpy|円/.test(lower)) return 'JPY';
    if (/韩元|krw|₩/.test(lower)) return 'KRW';
    if (/泰铢|thb/.test(lower)) return 'THB';
    if (/欧元|eur|€/.test(lower)) return 'EUR';
    if (/英镑|gbp|£/.test(lower)) return 'GBP';
    if (/港币|港元|hkd|hk\$/.test(lower)) return 'HKD';
    return 'CNY';
  }

  function extractDate(text) {
    var full = String(text || '');
    var patterns = [
      /(?:入住|起飞|出发|游玩|使用|出行|发车)日期?[：:\s]*(\d{4}[-/]\d{1,2}[-/]\d{1,2})/,
      /(?:入住|起飞|出发|游玩|使用|出行|发车)[：:\s]*(\d{4}[-/]\d{1,2}[-/]\d{1,2})/,
      /(\d{4}[-/]\d{1,2}[-/]\d{1,2})/
    ];
    for (var i = 0; i < patterns.length; i++) {
      var m = full.match(patterns[i]);
      if (m) return m[1].replace(/\//g, '-');
    }
    return '';
  }

  function extractTravelers(text) {
    var m = String(text || '').match(/(?:出行人|乘客|乘机人|入住人|游客|旅客)[：:\s]*([^\n]+)/);
    if (!m) return [];
    return m[1].split(/[、,，\/\s]+/).map(function (s) { return s.trim(); }).filter(function (s) {
      return s.length >= 1 && s.length <= 12;
    });
  }

  function extractTitle(text, type) {
    var lines = String(text || '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      // 跳过表头/系统行/订单号行
      if (/(订单支付成功|订单确认|订单号|携程|实付|支付金额|订单总额|金额|^[【\[])/.test(line)) continue;
      // 跳过纯日期/纯航班号行
      if (/^[\d\s\-/:]+$/.test(line)) continue;
      // 商品名通常含空格或"→"或"票/房/晚"
      return line.substring(0, 30);
    }
    return (TYPE_META[type] || TYPE_META.other).name;
  }

  /**
   * 订单确认文本 → 结构化订单
   * @param {string} text - 订单文本（短信/复制的订单页）
   * @returns {Object} { type, typeMeta, orderNo, title, amount, currency, date, travelers, confidence, raw }
   */
  function parseOrderText(text) {
    text = String(text || '').trim();
    var type = detectType(text);
    var amount = extractAmount(text);
    var orderNo = extractOrderNo(text);
    var date = extractDate(text);
    var travelers = extractTravelers(text);

    var confidence = 0;
    if (amount !== null) confidence += 50;
    if (type !== 'other') confidence += 20;
    if (orderNo) confidence += 15;
    if (date) confidence += 10;
    if (travelers.length) confidence += 5;

    return {
      success: amount !== null,
      needManual: amount === null,
      type: type,
      typeMeta: TYPE_META[type] || TYPE_META.other,
      orderNo: orderNo,
      title: extractTitle(text, type),
      amount: amount,
      currency: extractCurrency(text),
      date: date,
      travelers: travelers,
      confidence: Math.min(100, confidence),
      raw: text
    };
  }

  /**
   * 批量订单文本 → 订单数组（空行 / 分隔线 / 新的"【"头 切分）
   */
  function parseOrders(text) {
    var raw = String(text || '').trim();
    if (!raw) return [];
    var chunks = raw.split(/\n\s*\n|\n?-{5,}\n|(?=\n?【)/).map(function (s) { return s.trim(); }).filter(Boolean);
    var orders = [];
    chunks.forEach(function (chunk) {
      var o = parseOrderText(chunk);
      if (o.amount !== null || chunk.length > 15) orders.push(o);
    });
    return orders;
  }

  /**
   * 订单 → AA 账单草稿
   * - 分类映射：机票/火车/租车→transport，酒店→hotel，门票→ticket
   * - 分摊默认全员均分（可传 options.splitWith 覆盖）
   * - 付款人默认 options.payerId（下单人/代付人）
   * - 汇率快照：currency + rate + cnyAmount（多币种结算依据）
   */
  function orderToBill(order, members, options) {
    options = options || {};
    members = members && members.length ? members : [];
    var meta = TYPE_META[order.type] || TYPE_META.other;
    var amount = Number(order.amount) || 0;

    // 均分尾差安全分摊（最大余额法，分摊合计恒等于订单金额）
    var targets = options.splitWith && options.splitWith.length
      ? members.filter(function (m) { return options.splitWith.indexOf(m.id) !== -1; })
      : members;
    if (!targets.length) targets = members;

    var shares = [];
    if (targets.length && amount > 0) {
      var totalCents = Math.round(amount * 100);
      var base = Math.floor(totalCents / targets.length);
      var remainder = totalCents - base * targets.length;
      shares = targets.map(function (m, i) {
        return {
          memberId: m.id,
          memberName: m.name,
          amount: (base + (i < remainder ? 1 : 0)) / 100
        };
      });
    }

    var payer = options.payerId
      ? members.filter(function (m) { return m.id === options.payerId; })[0]
      : members[0];

    var rate = order.currency && order.currency !== 'CNY'
      ? (options.rates ? options.rates[order.currency] : null) : 1;
    if (rate == null) rate = 1;

    return {
      amount: amount,
      currency: order.currency || 'CNY',
      rate: rate,
      cnyAmount: round2(amount * rate),
      description: order.title || meta.name,
      category: meta.category,
      payer: payer ? payer.id : '',
      payerName: payer ? payer.name : '',
      splitType: 'equal',
      splits: shares,
      orderNo: order.orderNo || '',
      orderType: order.type,
      orderDate: order.date || '',
      source: 'ctrip',
      imageUrl: ''
    };
  }

  /**
   * 一步导入：订单文本 + 成员 → 账单草稿数组
   */
  function importOrders(text, members, options) {
    var orders = parseOrders(text);
    return orders
      .filter(function (o) { return o.amount !== null; })
      .map(function (o) { return orderToBill(o, members, options); });
  }

  return {
    TYPE_META: TYPE_META,
    CTrip_SAMPLES: CTrip_SAMPLES,
    parseOrderText: parseOrderText,
    parseOrders: parseOrders,
    orderToBill: orderToBill,
    importOrders: importOrders
  };
});
