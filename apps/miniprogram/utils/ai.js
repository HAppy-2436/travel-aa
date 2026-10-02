/**
 * TravelAA 共享 AI 引擎（三端复用：微信小程序 / 浏览器 Demo / Node Server）
 *
 * 设计原则：规则引擎保底（本地、毫秒级、离线可用）+ LLM 接口可选（长尾表达兜底）。
 * 现场演示永不依赖网络——这是黑客松演示不翻车的关键设计。
 *
 * 能力清单：
 *  1. parseBillText   自然语言一句话 → 结构化账单（金额/币种/分类/付款人/分摊）
 *  2. classifyExpense 智能消费分类（关键词加权打分）
 *  3. allocateEvenly  均分尾差修复（最大余额法，分摊合计恒等于账单金额）
 *  4. buildSplits     依据解析结果生成分摊明细
 *  5. generateInsight AI 消费洞察（人均/日均/大额/省钱建议）
 *  6. generateTripReport 旅行消费报告（分享文案）
 *  7. parseWithLLM    LLM 解析接口（可选，配置后启用，失败自动回退规则引擎）
 *
 * V2 扩展能力（参赛增强，见 docs/扩展方案.md）：
 *  8. normalizeSpeech 语音/口语文本归一化（中文数字金额、口语词 → 规范文本）
 *  9. toCNY/getRates  多币种汇率折算（记账快照汇率，结算统一折算）
 * 10. auditBills      AI 账单审计（重复/账不平/异常大额/漏归类检出）
 * 11. budgetStatus    预算管理（燃烧率/超支预测/安全日均/预警）
 * 12. dailyStats      每日消费分析（按天聚合/最贵一天/消费趋势）
 * 13. generateNarrative 旅行消费小作文（模板保底 + LLM 可选）
 * 14. buildLLMPrompt/repairJSON/mergeParse —— LLM 双轨工程化（few-shot + JSON 修复 + 结果融合）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TravelAI = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ============ 常量 ============

  var CATEGORIES = {
    food: { id: 'food', name: '餐饮', icon: '🍜' },
    transport: { id: 'transport', name: '交通', icon: '🚗' },
    hotel: { id: 'hotel', name: '住宿', icon: '🏨' },
    ticket: { id: 'ticket', name: '门票', icon: '🎫' },
    shopping: { id: 'shopping', name: '购物', icon: '🛍️' },
    other: { id: 'other', name: '其他', icon: '📦' }
  };

  // 分类关键词词典（关键词越长权重越高，长词优先命中更精确）
  var CATEGORY_KEYWORDS = {
    food: ['餐厅', '饭店', '美食', '咖啡', '奶茶', '火锅', '外卖', '美团', '饿了么', '居酒屋', '寿司', '拉面', '烧烤', '早餐', '午餐', '晚餐', '宵夜', '午饭', '晚饭', '早饭', '聚餐', '吃饭', '吃', '喝', '小吃', '甜品', '蛋糕', '便利店', '超市', '食堂', '外卖', '海底捞', '肯德基', '麦当劳', '星巴克'],
    transport: ['打车', '出租车', '滴滴', '网约车', '地铁', '公交', '高铁', '火车', '机票', '飞机', '航班', '机场', '专车', '拼车', '加油', '停车', '过路费', '轮船', '船票', '大巴', '包车', '租车', '骑行', '单车', '磁悬浮'],
    hotel: ['酒店', '民宿', '宾馆', '旅馆', '住宿', '青旅', '客栈', '度假村', '温泉', '入住', '退房', '房费', '携程订房', 'airbnb'],
    ticket: ['门票', '景区', '景点', '公园', '博物馆', '展览', '演出', '演唱会', '音乐会', '迪士尼', '环球影城', '游乐场', '索道', '游船', '滑雪', '温泉票', '动物园', '植物园', '表演', '电影'],
    shopping: ['购物', '商场', '超市', '药妆', '扫货', '免税店', '伴手礼', '纪念品', '特产', '礼品', '手信', '淘宝', '京东', '代购', '奥特莱斯', '便利店', '买']
  };

  // 币种词典（出境游场景）
  var CURRENCY_WORDS = {
    '美元': 'USD', '美金': 'USD', '美刀': 'USD', 'usd': 'USD', '$': 'USD',
    '日元': 'JPY', '日币': 'JPY', '日圆': 'JPY', 'jpy': 'JPY', '円': 'JPY',
    '韩元': 'KRW', '韩币': 'KRW', '₩': 'KRW',
    '泰铢': 'THB', '铢': 'THB',
    '欧元': 'EUR', '欧': 'EUR', '€': 'EUR',
    '英镑': 'GBP', '£': 'GBP',
    '港币': 'HKD', '港元': 'HKD', 'hk$': 'HKD',
    '澳门币': 'MOP', '澳币': 'MOP',
    '新币': 'SGD', '新加坡元': 'SGD',
    '人民币': 'CNY', 'rmb': 'CNY', '¥': 'CNY', '￥': 'CNY'
  };

  // 展示用粗略汇率（P2 多币种结算预留，仅用于折算展示）
  var CNY_RATES = { CNY: 1, USD: 7.2, JPY: 0.048, KRW: 0.0053, THB: 0.2, EUR: 7.8, GBP: 9.1, HKD: 0.92, MOP: 0.89, SGD: 5.3 };

  var CN_NUM = { '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };

  // ============ 基础工具 ============

  function round2(n) { return Math.round(n * 100) / 100; }

  function escapeReg(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  // ============ 1. 智能分类 ============

  /**
   * 智能消费分类：关键词加权打分
   * @returns {Object} { category, confidence, matched }
   */
  function classifyExpense(text) {
    var full = String(text || '').toLowerCase();
    var best = { category: 'other', score: 0, matched: '' };

    Object.keys(CATEGORY_KEYWORDS).forEach(function (cat) {
      var score = 0, matched = '';
      CATEGORY_KEYWORDS[cat].forEach(function (kw) {
        if (full.indexOf(kw.toLowerCase()) !== -1) {
          // 长关键词更精确，权重更高
          var w = kw.length >= 3 ? 3 : kw.length === 2 ? 2 : 1;
          if (w > score) { score = w; matched = kw; }
        }
      });
      if (score > best.score) { best = { category: cat, score: score, matched: matched }; }
    });

    return {
      category: best.category,
      confidence: best.score > 0 ? Math.min(95, 60 + best.score * 10) : 40,
      matched: best.matched
    };
  }

  // ============ 2. 均分尾差修复（最大余额法） ============

  /**
   * 将 amount 精确均分给 n 个人，sum(结果) === amount 恒成立
   * @param {number} amount - 总金额
   * @param {number} n - 人数
   * @returns {number[]} 每人金额（单位元，两位小数）
   */
  function allocateEvenly(amount, n) {
    if (!n || n <= 0) return [];
    var totalCents = Math.round(Number(amount) * 100);
    var base = Math.floor(totalCents / n);
    var remainder = totalCents - base * n; // 余下的"分"，依次补 0.01
    var result = [];
    for (var i = 0; i < n; i++) {
      result.push((base + (i < remainder ? 1 : 0)) / 100);
    }
    return result;
  }

  // ============ 3. 自然语言记账解析 ============

  var MONEY_UNITS = '(?:块钱|块|元|圆|蚊)';

  /**
   * 金额提取（按置信度优先级匹配）
   */
  function extractAmount(text) {
    var patterns = [
      // 显式语义词："花了328"、"实付¥128.5"、"一共240"
      { re: /(?:实付|应付|支付|付款|消费|合计|总计|总额|共计|花了|花掉|收了|付了|掏了|出|一共|总共|人均)[^\d]{0,6}[¥￥$]?(\d+(?:\.\d{1,2})?)/, take: 1 },
      // "3个人240" → 取人数后面的金额
      { re: /\d+\s*[个人][^0-9]{0,6}(\d+(?:\.\d{1,2})?)/, take: 1 },
      // "¥128.5"
      { re: /[¥￥$](\d+(?:\.\d{1,2})?)/, take: 1 },
      // "86块 / 328元"
      { re: new RegExp('(\\d+(?:\\.\\d{1,2})?)\\s*' + MONEY_UNITS), take: 1 },
      // "12000日元"
      { re: /(\d+(?:\.\d{1,2})?)\s*(?:美元|美金|日元|日币|韩元|泰铢|欧元|英镑|港币|港元|新币|新加坡元|人民币)/, take: 1 },
      // 金额式小数："128.50"
      { re: /(\d+\.\d{2})/, take: 1 },
      // 裸数字兜底（排除"3个人"的人数；避免 lookbehind 以兼容小程序 JS 引擎）
      { re: /(^|[^0-9.])(\d{1,7}(?:\.\d{1,2})?)(?!\s*[个人])/, take: 2 }
    ];
    for (var i = 0; i < patterns.length; i++) {
      var m = text.match(patterns[i].re);
      if (m) {
        var v = parseFloat(m[patterns[i].take]);
        if (v > 0 && v < 10000000) return v;
      }
    }
    return null;
  }

  /**
   * 币种识别
   */
  function extractCurrency(text) {
    var lower = text.toLowerCase();
    var keys = Object.keys(CURRENCY_WORDS);
    for (var i = 0; i < keys.length; i++) {
      if (lower.indexOf(keys[i].toLowerCase()) !== -1) {
        return CURRENCY_WORDS[keys[i]];
      }
    }
    return 'CNY';
  }

  /**
   * 人数识别（"3个人AA"、"四个人平分"）
   */
  function extractPersonCount(text) {
    var m = text.match(/([一二两三四五六七八九十\d])\s*个?人/);
    if (!m) return null;
    var raw = m[1];
    var n = /\d/.test(raw) ? parseInt(raw, 10) : CN_NUM[raw];
    return n > 0 && n <= 50 ? n : null;
  }

  /**
   * 付款人识别：代词映射 + 成员名匹配
   */
  function extractPayer(text, members, meName) {
    // 1) "我垫的 / 我付的 / 我请客 / 我出的"
    if (new RegExp('我(?:先)?(?:垫|付|出|掏|请|买)').test(text) || /算我的|我买单/.test(text)) {
      var me = members.filter(function (m) { return m.name === meName; })[0] || members[0];
      return me ? { id: me.id, name: me.name, isMe: true } : null;
    }
    // 2) "小红付的 / 小王垫了 / 小李请客"
    for (var i = 0; i < members.length; i++) {
      var name = escapeReg(members[i].name);
      if (new RegExp(name + '(?:同学|师傅)?[^，。,]{0,4}?(?:垫|付|出|掏|请|买单|买)').test(text)) {
        return { id: members[i].id, name: members[i].name, isMe: members[i].name === meName };
      }
    }
    // 3) "付款人：小红" / "付的小红"
    var m2 = text.match(/(?:付款人|付款| payer)[：::\s]*([\u4e00-\u9fa5A-Za-z]{1,6})/);
    if (m2) {
      for (var j = 0; j < members.length; j++) {
        if (m2[1].indexOf(members[j].name) !== -1) {
          return { id: members[j].id, name: members[j].name, isMe: members[j].name === meName };
        }
      }
    }
    return null;
  }

  /**
   * 分摊方式与分摊对象识别
   */
  function extractSplit(text, members, payer) {
    var isTreat = /请客|我请|买单|算我的|不用还|不用给|ta?请了?|招待/.test(text);
    var isCustom = /(?:出|付|转)\s*[¥￥$]?\d|(?:比例|按份|各出各)/.test(text);
    var isExplicitEqual = /平分|均分|均摊|平摊|aa|a\s*a|对半|一人一半|大家分|平一下/.test(text.toLowerCase()) || /a{2}/i.test(text);

    var splitType = isTreat ? 'treat' : (isCustom ? 'custom' : (isExplicitEqual ? 'equal' : 'equal'));

    // 句中提到的成员 = 分摊对象
    var mentioned = [];
    members.forEach(function (m) {
      if (text.indexOf(m.name) !== -1) mentioned.push(m);
    });

    var splitWith;
    if (splitType === 'treat') {
      splitWith = payer ? [payer.id] : (mentioned[0] ? [mentioned[0].id] : []);
    } else {
      // "和小红小李平分" → 付款人通常也参与分摊，未提及时补上
      splitWith = mentioned.map(function (m) { return m.id; });
      if (payer && splitWith.indexOf(payer.id) === -1) splitWith.unshift(payer.id);
      if (splitWith.length === 0) splitWith = members.map(function (m) { return m.id; });
    }

    return { splitType: splitType, splitWith: splitWith, mentionedNames: mentioned.map(function (m) { return m.name; }) };
  }

  /**
   * 消费说明清洗：剔除金额/付款/分摊等语义片段，保留名词性描述
   */
  function extractDescription(text, category) {
    var desc = text;
    var dropPatterns = [
      /[¥￥$]?\d+(?:\.\d{1,2})?\s*(?:块钱|块|元|圆|蚊)?/g,               // 金额
      /\d+\s*[个人][^，。,]{0,6}/g,                                    // 人数短语
      /(?:美元|美金|日元|日币|韩元|泰铢|欧元|英镑|港币|港元|新币|新加坡元|人民币)/g,
      /(?:我|俺|本人)(?:先)?(?:垫|付|出|掏|请|买)(?:了|的)?(?:钱)?/g,   // 我付语义
      /[\u4e00-\u9fa5A-Za-z]{1,4}(?:同学|师傅)?(?:先)?(?:垫|付|出|掏|请|买)(?:了|的)?(?:单)?/g, // 成员付语义
      /(?:付款人|付款|实付|应付|支付)[：::\s]*/g,
      /(?:和|跟|与|同)[^，。,]{0,8}?(?:平分|均分|均摊|平摊|分|aa|A\s*A)/gi, // 分摊语义
      /(?:平分|均分|均摊|平摊|对半|一人一半|大家分|按比例|比例|自定义|均分一下)/g,
      /(?:请客|我请|买单|算我的|不用还|不用给|招待)/g,
      /(?:昨天|今天|前天|大前天|上午|中午|下午|晚上|早上|夜里|凌晨|傍晚|周[一二三四五六日天]|上周|本周|[0-9]{1,2}[：:][0-9]{2})/g,
      /(?:花了|花掉|收了|付了|掏了|一共|总共|共计|合计|总计|总额|的|了|去|到)/g
    ];
    dropPatterns.forEach(function (p) { desc = desc.replace(p, ' '); });
    desc = desc.replace(/[,，。、；;：:！!？?~～\s]+/g, ' ').trim();
    // 纯中文说明去空格："打车 机场" → "打车机场"
    if (/^[\u4e00-\u9fa5\s]+$/.test(desc)) desc = desc.replace(/\s+/g, '');

    if (desc.length < 2) {
      var cat = CATEGORIES[category] || CATEGORIES.other;
      desc = cat.name + '消费';
    }
    return desc.substring(0, 20);
  }

  /**
   * 一句话 → 结构化账单（核心入口）
   *
   * @param {string} text - 自然语言输入，如"打车去机场86块，我垫的，和小红小李平分"
   * @param {Array}  members - 房间成员 [{id, name}]
   * @param {Object} [options] - { meName: 当前用户昵称, rates: 汇率表 }
   * @returns {Object} 结构化账单 + 置信度 + 逐字段命中情况
   */
  function parseBillText(text, members, options) {
    options = options || {};
    members = members && members.length ? members : [{ id: 'me', name: options.meName || '我' }];
    var meName = options.meName || members[0].name;

    // 语音/口语归一化："八十六块" → "86元"，再走规则解析（会听能力）
    text = normalizeSpeech(String(text || '').trim());
    var currency = extractCurrency(text);
    var amount = extractAmount(text);
    var cls = classifyExpense(text);
    var payer = extractPayer(text, members, meName);
    var split = extractSplit(text, members, payer);
    var personCount = extractPersonCount(text);
    var description = extractDescription(text, cls.category);

    // 显式人数优先："四个人AA" → 取前 N 位成员；否则用句中点名逻辑
    if (split.splitType === 'equal' && personCount) {
      split.splitWith = personCount >= members.length
        ? members.map(function (m) { return m.id; })
        : members.slice(0, personCount).map(function (m) { return m.id; });
    } else if (split.splitType === 'equal' && split.mentionedNames.length === 0) {
      split.splitWith = members.map(function (m) { return m.id; });
    }

    // 置信度 = 各字段命中加权
    var confidence = 0;
    var fields = {
      amount: amount !== null,
      category: cls.category !== 'other',
      payer: !!payer,
      split: split.splitType === 'treat' || split.mentionedNames.length > 0 || !!personCount,
      description: description.length >= 2
    };
    if (fields.amount) confidence += 40;
    if (fields.category) confidence += 15;
    if (fields.payer) confidence += 20;
    if (fields.split) confidence += 15;
    if (fields.description) confidence += 10;

    // 汇率折算（展示用）
    var rate = (options.rates || CNY_RATES)[currency] || 1;
    var cnyAmount = amount !== null ? round2(amount * rate) : null;

    return {
      success: amount !== null,
      needManual: amount === null,
      amount: amount,
      currency: currency,
      cnyAmount: cnyAmount,
      description: description,
      category: cls.category,
      categoryConfidence: cls.confidence,
      payerId: payer ? payer.id : (members[0] ? members[0].id : ''),
      payerName: payer ? payer.name : (members[0] ? members[0].name : ''),
      splitType: split.splitType,
      splitWith: split.splitWith,
      personCount: personCount || split.splitWith.length,
      confidence: Math.min(100, confidence),
      fields: fields,
      raw: text
    };
  }

  // ============ 4. 分摊明细生成 ============

  /**
   * 依据解析结果生成分摊明细（自动处理均分尾差）
   * @returns {Array} [{memberId, memberName, amount}]
   */
  function buildSplits(parsed, members) {
    var amount = Number(parsed.amount) || 0;
    var byId = {};
    members.forEach(function (m) { byId[m.id] = m; });

    if (parsed.splitType === 'treat') {
      return members.map(function (m) {
        return { memberId: m.id, memberName: m.name, amount: m.id === parsed.payerId ? round2(amount) : 0 };
      });
    }

    var targets = (parsed.splitWith && parsed.splitWith.length
      ? parsed.splitWith.map(function (id) { return byId[id]; }).filter(Boolean)
      : members);

    if (parsed.splitType === 'custom' && parsed.customAmounts) {
      return targets.map(function (m) {
        return { memberId: m.id, memberName: m.name, amount: round2(parsed.customAmounts[m.id] || 0) };
      });
    }

    // equal：最大余额法，sum === amount
    var amounts = allocateEvenly(amount, targets.length);
    return targets.map(function (m, i) {
      return { memberId: m.id, memberName: m.name, amount: amounts[i] };
    });
  }

  // ============ 5. AI 消费洞察 ============

  /**
   * AI 消费洞察：统计 + 建议 + 一段可分享的摘要
   * @param {Object} ctx - { room: {name, destination, startDate, endDate}, bills, members }
   */
  function generateInsight(ctx) {
    var room = ctx.room || {};
    var bills = ctx.bills || [];
    var members = ctx.members || [];
    var total = round2(bills.reduce(function (s, b) { return s + (Number(b.amount) || 0); }, 0));
    var n = Math.max(1, members.length);
    var perPerson = round2(total / n);

    // 天数
    var days = 1;
    if (room.startDate && room.endDate) {
      var d1 = new Date(room.startDate), d2 = new Date(room.endDate);
      if (!isNaN(d1) && !isNaN(d2)) days = Math.max(1, Math.round((d2 - d1) / 86400000) + 1);
    } else if (bills.length > 1) {
      var times = bills.map(function (b) { return new Date(b.createdAt || b.created_at || Date.now()).getTime(); });
      days = Math.max(1, Math.ceil((Math.max.apply(null, times) - Math.min.apply(null, times)) / 86400000) + 1);
    }
    var dailyAvg = round2(total / days);

    // 分类统计
    var catMap = {};
    bills.forEach(function (b) {
      var c = b.category || 'other';
      catMap[c] = (catMap[c] || 0) + (Number(b.amount) || 0);
    });
    var top = Object.keys(catMap).sort(function (a, b) { return catMap[b] - catMap[a]; });
    var topCat = top[0] ? CATEGORIES[top[0]] || CATEGORIES.other : null;
    var topPct = total > 0 && top[0] ? Math.round(catMap[top[0]] / total * 100) : 0;

    // 最大单笔
    var largest = bills.reduce(function (acc, b) {
      return (!acc || Number(b.amount) > Number(acc.amount)) ? b : acc;
    }, null);

    // 人均垫付（谁垫得最多）
    var paidMap = {};
    bills.forEach(function (b) {
      var key = b.payerName || b.payer || '未知';
      paidMap[key] = (paidMap[key] || 0) + (Number(b.amount) || 0);
    });
    var topPayer = Object.keys(paidMap).sort(function (a, b) { return paidMap[b] - paidMap[a]; })[0] || '';

    // 启发式建议
    var tips = [];
    if (topCat && topPct >= 40) {
      tips.push('「' + topCat.name + '」占比 ' + topPct + '%，是本次旅行的消费大头，复盘时可优先看这一项。');
    }
    if (largest && total > 0 && Number(largest.amount) / total >= 0.3) {
      tips.push('最大单笔「' + (largest.description || largest.desc || '消费') + '」¥' + Number(largest.amount).toFixed(2) + ' 占总支出 ' + Math.round(Number(largest.amount) / total * 100) + '%，建议确认是否已正确分摊。');
    }
    if (days >= 3) {
      tips.push('人均 ¥' + perPerson.toFixed(2) + '（' + days + ' 天日均 ¥' + dailyAvg.toFixed(2) + '），可与同行伙伴的预算做对照。');
    }
    if (topPayer) {
      tips.push(topPayer + ' 垫付最多，结算时记得优先转账给 TA。');
    }
    if (tips.length === 0) {
      tips.push('消费结构整体均衡，记账很清晰，直接一键结算即可。');
    }

    var summary = '🤖 AI 消费洞察：本次「' + (room.name || '旅行') + '」共 ' + bills.length + ' 笔消费，合计 ¥' + total.toFixed(2) +
      '，人均 ¥' + perPerson.toFixed(2) + (days > 1 ? '，日均 ¥' + dailyAvg.toFixed(2) : '') +
      (topCat ? '。消费大头是' + topCat.name + '（' + topPct + '%）' : '') + '。';

    return {
      total: total,
      perPerson: perPerson,
      dailyAvg: dailyAvg,
      days: days,
      billCount: bills.length,
      topCategory: topCat ? { id: topCat.id, name: topCat.name, icon: topCat.icon, amount: round2(catMap[top[0]]), percent: topPct } : null,
      largestBill: largest ? { description: largest.description || largest.desc || '', amount: Number(largest.amount) } : null,
      topPayer: topPayer,
      tips: tips,
      summary: summary
    };
  }

  // ============ 6. 旅行消费报告（分享文案） ============

  function generateTripReport(room, bills, members) {
    var insight = generateInsight({ room: room, bills: bills, members: members });
    var text = '✈️ 【' + (room.name || '旅行AA') + '】AI 旅行消费报告\n';
    text += '━━━━━━━━━━━━━━━\n';
    if (room.destination) text += '📍 ' + room.destination + '\n';
    if (room.startDate) text += '📅 ' + room.startDate + ' ~ ' + (room.endDate || '') + '\n';
    text += '👥 ' + members.length + ' 人 · ' + bills.length + ' 笔消费\n';
    text += '💰 总消费 ¥' + insight.total.toFixed(2) + ' · 人均 ¥' + insight.perPerson.toFixed(2) + '\n';
    if (insight.topCategory) {
      text += '🏆 消费大头 ' + insight.topCategory.icon + ' ' + insight.topCategory.name + '（' + insight.topCategory.percent + '%）\n';
    }
    text += '━━━━━━━━━━━━━━━\n\n';
    text += insight.summary + '\n\n';
    text += '💡 AI 建议：\n';
    insight.tips.forEach(function (t, i) { text += '  ' + (i + 1) + '. ' + t + '\n'; });
    text += '\n由 TravelAA · AI 旅行记账官 生成';
    return text;
  }

  // ============ 7. LLM 解析接口（可选，V2 工程化强化） ============

  /**
   * 构造 LLM 解析 Prompt（few-shot + 严格 JSON 输出约定）
   * 可直接贴给任意 OpenAI 兼容接口（server 端 /api/ai/parse?mode=llm 使用同一份）
   */
  function buildLLMPrompt(text, members, meName) {
    var names = (members || []).map(function (m) { return m.name; }).join('、') || '我';
    return [
      '你是旅行AA记账的自然语言解析器。把用户的一句话解析为记账JSON，只输出JSON，不要任何解释。',
      '字段约定：',
      '{"amount":数字(必填),"currency":"CNY|USD|JPY|KRW|THB|EUR|GBP|HKD|SGD","category":"food|transport|hotel|ticket|shopping|other",',
      '"payerName":"付款人(必须是成员之一或空)","splitType":"equal|custom|treat","splitWith":["参与分摊的成员名"],"description":"不超过15字的消费说明"}',
      '成员列表：[' + names + ']；当前用户：' + (meName || '我') + '。',
      '示例1：输入「打车去机场86块，我垫的，和小红小李平分」输出 {"amount":86,"currency":"CNY","category":"transport","payerName":"' + (meName || '我') + '","splitType":"equal","splitWith":["' + (meName || '我') + '","小红","小李"],"description":"打车去机场"}',
      '示例2：输入「小红请客吃居酒屋520」输出 {"amount":520,"currency":"CNY","category":"food","payerName":"小红","splitType":"treat","splitWith":["小红"],"description":"居酒屋聚餐"}',
      '示例3：输入「迪士尼门票2800，小王付的，四个人AA」输出 {"amount":2800,"currency":"CNY","category":"ticket","payerName":"小王","splitType":"equal","splitWith":["全员"],"description":"迪士尼门票"}',
      '输入：「' + text + '」'
    ].join('\n');
  }

  /**
   * LLM 输出 JSON 修复：剥离 code fence、尾逗号、中文引号/冒号、单引号、注释等常见脏格式
   * 无法修复时返回 null（绝不抛异常，保证调用链安全）
   */
  function repairJSON(raw) {
    var s = String(raw || '').trim();
    s = s.replace(/```json/gi, '').replace(/```/g, '').trim();
    // 截取首个 { 到最后一个 } 之间的内容（LLM 常夹带解释文字）
    var a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a !== -1 && b > a) s = s.substring(a, b + 1);
    // 整行注释
    s = s.replace(/^\s*\/\/.*$/gm, '');
    // 中文标点 → JSON 标点（仅结构符号）
    s = s.replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, '"')
      .replace(/：/g, ':').replace(/，\s*/g, ',').replace(/【/g, '[').replace(/】/g, ']');
    // 单引号属性名/字符串值 → 双引号
    s = s.replace(/([{,]\s*)'([^']*)'(\s*:)/g, '$1"$2"$3');
    s = s.replace(/:\s*'([^']*)'/g, ': "$1"');
    // 尾逗号
    s = s.replace(/,\s*([}\]])/g, '$1');
    try {
      return JSON.parse(s);
    } catch (e) {
      return null;
    }
  }

  /**
   * LLM 结果与规则引擎结果融合：
   * LLM 有效字段覆盖规则结果，无效/缺失字段回退规则结果（保证永不返回半成品）
   */
  function mergeParse(ruleResult, llmRaw, members) {
    var llm;
    try { llm = repairJSON(llmRaw); } catch (e) { return null; }
    if (!llm || typeof llm !== 'object') return null;

    var byName = {};
    (members || []).forEach(function (m) { byName[m.name] = m; });

    var out = Object.assign({}, ruleResult);

    // amount：必须为正数
    var amt = Number(llm.amount);
    if (isFinite(amt) && amt > 0) { out.amount = round2(amt); out.success = true; out.needManual = false; }

    // currency
    if (llm.currency && CNY_RATES[String(llm.currency).toUpperCase()]) {
      out.currency = String(llm.currency).toUpperCase();
      out.cnyAmount = out.amount != null ? round2(out.amount * (CNY_RATES[out.currency] || 1)) : null;
    }

    // category
    if (llm.category && CATEGORIES[llm.category]) out.category = llm.category;

    // payerName → payerId
    if (llm.payerName && byName[llm.payerName]) {
      out.payerName = llm.payerName;
      out.payerId = byName[llm.payerName].id;
    }

    // splitType
    if (llm.splitType && ['equal', 'custom', 'treat'].indexOf(llm.splitType) !== -1) {
      out.splitType = llm.splitType;
    }

    // splitWith：成员名 → 成员 id；含"全员"时兜底为全部成员
    if (Array.isArray(llm.splitWith) && llm.splitWith.length) {
      var ids = [];
      llm.splitWith.forEach(function (n) {
        if (byName[n]) ids.push(byName[n].id);
      });
      if (!ids.length || llm.splitWith.indexOf('全员') !== -1) {
        ids = (members || []).map(function (m) { return m.id; });
      }
      if (ids.length) out.splitWith = ids;
    }

    // description
    if (llm.description && String(llm.description).trim()) {
      out.description = String(llm.description).trim().substring(0, 20);
    }

    out.source = 'llm';
    out.confidence = Math.max(out.confidence || 0, 92);
    return out;
  }

  /**
   * LLM 兜底解析（配置后启用；失败自动回退规则引擎）
   * 接入方式：options.llmCall = async (prompt) => string，由宿主注入网络实现。
   * 规则引擎与 LLM 双轨设计保证演示永不失败。
   */
  async function parseWithLLM(text, members, options) {
    options = options || {};
    if (typeof options.llmCall === 'function') {
      try {
        var prompt = buildLLMPrompt(text, members, options.meName);
        var out = await options.llmCall(prompt);
        var merged = mergeParse(parseBillText(text, members, options), out, members);
        if (merged && merged.amount) {
          return merged;
        }
      } catch (e) {
        // 回退规则引擎
      }
    }
    var ruleResult = parseBillText(text, members, options);
    ruleResult.source = 'rule';
    return ruleResult;
  }

  // ============ 8. 语音/口语文本归一化（会听） ============

  var CN_DIGIT = { '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
  var CN_UNIT = { '十': 10, '百': 100, '千': 1000 };

  /**
   * 中文数字 → 阿拉伯数字（支持口语省略："一百五"→150、"三千二"→3200、"两万五"→25000）
   */
  function cnNumToNumber(s) {
    if (!s) return null;
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    var total = 0, section = 0, num = 0, hasUnit = false;

    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (CN_DIGIT[ch] !== undefined) {
        num = CN_DIGIT[ch];
      } else if (CN_UNIT[ch]) {
        hasUnit = true;
        section += (num === 0 ? 1 : num) * CN_UNIT[ch];
        num = 0;
      } else if (ch === '万') {
        hasUnit = true;
        total += (section + num) * 10000;
        section = 0; num = 0;
      } else {
        return null;
      }
    }

    // 口语省略："一百五" = 150（末位裸数字在百/千/万位后按上一级计）
    var last = s[s.length - 1];
    if (hasUnit && CN_DIGIT[last] !== undefined && s.length >= 2) {
      var prev = s[s.length - 2];
      if (prev === '百' || prev === '千' || prev === '万') {
        num = CN_DIGIT[last] * (prev === '百' ? 10 : prev === '千' ? 100 : 1000);
      }
    }

    total += section + num;
    return total > 0 ? total : null;
  }

  /**
   * 语音/口语输入归一化：中文数字金额 → 阿拉伯数字，口语词规范
   * "打车去机场八十六块我垫的" → "打车去机场86元我垫的"
   */
  function normalizeSpeech(text) {
    var s = String(text || '').trim();
    if (!s) return s;

    // 去掉典型语音填充词
    s = s.replace(/(?:嗯+|呃+|啊+)[，,\s]*/g, '').replace(/(?:那个|就是说|然后呢?)[，,\s]*/g, '');

    // 全角数字/字母 → 半角
    s = s.replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); });
    s = s.replace(/[Ａ-Ｚａ-ｚ]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); });

    // 中文数字 + 金额单位/币种词 → 阿拉伯数字
    var moneyWords = '块钱|块|元|圆|蚊|美元|美金|日元|日币|韩元|泰铢|欧元|英镑|港币|港元|新币|新加坡元|人民币';
    s = s.replace(new RegExp('([零一二两三四五六七八九十百千万]+)\\s*(?=(' + moneyWords + '))', 'g'), function (m, cn) {
      var n = cnNumToNumber(cn);
      return n !== null ? String(n) : m;
    });

    // 口语量词规范："86块" → "86元"
    s = s.replace(/(\d+(?:\.\d+)?)\s*(?:块钱|块|圆|蚊)/g, '$1元');

    // 口语量词/表达规范
    s = s.replace(/AA制|ａａ制/gi, 'AA')
      .replace(/平摊一下|均摊一下|平分一下/g, '平分')
      .replace(/我(?:先)?垫(?:付)?(?:了)?(?:的)?/g, '我垫的')
      .replace(/人均(?:是|要|花)?/g, '人均');

    return s.trim();
  }

  // ============ 9. 多币种汇率折算（会算账） ============

  // 运行时汇率覆盖（可接实时汇率 API；记账时建议把所用 rate 快照进账单）
  var _rateOverrides = {};

  function getRates(overrides) {
    var r = {};
    Object.keys(CNY_RATES).forEach(function (k) { r[k] = CNY_RATES[k]; });
    Object.keys(_rateOverrides).forEach(function (k) { r[k] = _rateOverrides[k]; });
    Object.keys(overrides || {}).forEach(function (k) { r[k] = overrides[k]; });
    return r;
  }

  function setRates(overrides) {
    Object.keys(overrides || {}).forEach(function (k) { _rateOverrides[k] = overrides[k]; });
  }

  /**
   * 折算人民币：toCNY(12000, 'JPY') → 576
   */
  function toCNY(amount, currency, rates) {
    var rate = getRates(rates)[currency] || 1;
    return round2((Number(amount) || 0) * rate);
  }

  /**
   * 账单折算人民币：优先用记账时快照的 cnyAmount/rate，其次按币种折算
   */
  function billCNY(bill, rates) {
    if (!bill) return 0;
    if (bill.cnyAmount != null) return round2(Number(bill.cnyAmount));
    if (bill.currency && bill.currency !== 'CNY') {
      if (bill.rate != null) return round2((Number(bill.amount) || 0) * Number(bill.rate));
      return toCNY(bill.amount, bill.currency, rates);
    }
    return round2(Number(bill.amount) || 0);
  }

  // ============ 10. AI 账单审计（会复盘） ============

  function billTime(b) {
    var t = new Date(b && (b.createdAt || b.created_at) || 0).getTime();
    return isNaN(t) ? 0 : t;
  }

  /** 账单所属自然日（YYYY-MM-DD，本地时区），用于手账/每日统计 */
  function billDayKey(b) {
    var t = billTime(b);
    if (!t) return '';
    var d = new Date(t);
    var m = d.getMonth() + 1;
    var day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
  }

  function simText(a, b) {
    a = String(a || '').trim(); b = String(b || '').trim();
    if (!a || !b) return false;
    return a === b || a.indexOf(b) !== -1 || b.indexOf(a) !== -1;
  }

  /**
   * AI 账单审计：重复账单 / 账不平 / 异常大额 / 漏归类
   * @returns {Object} { issues, score, checked, summary }
   */
  function auditBills(bills, members) {
    bills = bills || [];
    var issues = [];

    // 1) 疑似重复账单：同金额 + 说明相近 + 时间差 < 10 分钟
    for (var i = 0; i < bills.length; i++) {
      for (var j = i + 1; j < bills.length; j++) {
        var a = bills[i], b = bills[j];
        var sameAmount = Math.abs(billCNY(a) - billCNY(b)) < 0.01;
        var closeTime = billTime(a) && billTime(b) && Math.abs(billTime(a) - billTime(b)) < 10 * 60 * 1000;
        if (sameAmount && closeTime && simText(a.description || a.desc, b.description || b.desc)) {
          issues.push({
            type: 'duplicate', severity: 'high',
            billIds: [a._id || a.id, b._id || b.id],
            message: '疑似重复账单：「' + (a.description || a.desc || '消费') + '」¥' + billCNY(a).toFixed(2) + ' 在 10 分钟内录入了两次',
            suggestion: '确认是否重复记账，如是请删除其中一笔'
          });
        }
      }
    }

    // 2) 账不平：分摊合计 ≠ 账单金额
    bills.forEach(function (b) {
      if (!b.splits || !b.splits.length) return;
      var sum = b.splits.reduce(function (s, x) { return s + (Number(x.amount) || 0); }, 0);
      var amt = Number(b.amount) || 0;
      if (Math.abs(sum - amt) > 0.01) {
        issues.push({
          type: 'unbalanced', severity: 'high',
          billIds: [b._id || b.id],
          message: '「' + (b.description || b.desc || '消费') + '」分摊合计 ¥' + sum.toFixed(2) + ' 与账单金额 ¥' + amt.toFixed(2) + ' 不符',
          suggestion: '重新分摊该笔账单，保证分摊合计恒等于账单金额'
        });
      }
    });

    // 3) 异常大额：超过均值 4 倍且绝对值较大，或单笔占比 > 50%
    if (bills.length >= 3) {
      var amounts = bills.map(function (b) { return billCNY(b); });
      var total = amounts.reduce(function (s, x) { return s + x; }, 0);
      var avg = total / bills.length;
      bills.forEach(function (b) {
        var amt = billCNY(b);
        if ((amt > avg * 4 && amt >= 500) || (total > 0 && amt / total > 0.5)) {
          issues.push({
            type: 'anomaly', severity: 'medium',
            billIds: [b._id || b.id],
            message: '「' + (b.description || b.desc || '消费') + '」¥' + amt.toFixed(2) + ' 显著高于本次其他消费（均值 ¥' + avg.toFixed(2) + '）',
            suggestion: '复核金额与分摊对象是否正确（如机票/酒店整单代付）'
          });
        }
      });
    }

    // 4) 漏归类：other 且金额不小
    bills.forEach(function (b) {
      if ((b.category || 'other') === 'other' && billCNY(b) >= 200) {
        issues.push({
          type: 'uncategorized', severity: 'low',
          billIds: [b._id || b.id],
          message: '「' + (b.description || b.desc || '消费') + '」¥' + billCNY(b).toFixed(2) + ' 未归类',
          suggestion: '补充消费分类，便于生成消费洞察'
        });
      }
    });

    var score = 100;
    issues.forEach(function (x) { score -= x.severity === 'high' ? 15 : x.severity === 'medium' ? 8 : 3; });
    score = Math.max(0, score);

    var summary = issues.length === 0
      ? '✅ AI 审计通过：' + bills.length + ' 笔账单未发现问题，账目清晰，可放心结算。'
      : '🔍 AI 审计发现 ' + issues.length + ' 个问题（高 ' + issues.filter(function (x) { return x.severity === 'high'; }).length +
        ' / 中 ' + issues.filter(function (x) { return x.severity === 'medium'; }).length +
        ' / 低 ' + issues.filter(function (x) { return x.severity === 'low'; }).length + '），账目健康度 ' + score + ' 分。';

    return { issues: issues, score: score, checked: bills.length, summary: summary };
  }

  // ============ 11. 预算管理（会算账） ============

  /**
   * 预算状态：已花/剩余/燃烧率/超支预测/安全日均/预警
   * @param {number|Object} budget - 总预算（元）或 { total }
   * @param {Object} [options] - { days: 已过天数, totalDays: 行程总天数, room }
   */
  function budgetStatus(bills, members, budget, options) {
    options = options || {};
    bills = bills || [];
    var total = (typeof budget === 'object' && budget) ? Number(budget.total) || 0 : Number(budget) || 0;
    var spent = round2(bills.reduce(function (s, b) { return s + billCNY(b); }, 0));
    var n = Math.max(1, (members || []).length || 1);

    // 天数推算
    var totalDays = options.totalDays || 0;
    var elapsed = options.days || 0;
    var room = options.room || {};
    if (!totalDays && room.startDate && room.endDate) {
      var d1 = new Date(room.startDate), d2 = new Date(room.endDate);
      if (!isNaN(d1) && !isNaN(d2)) totalDays = Math.max(1, Math.round((d2 - d1) / 86400000) + 1);
    }
    if (!totalDays) totalDays = elapsed || 1;
    if (!elapsed) {
      if (bills.length > 1) {
        var times = bills.map(function (b) { return billTime(b) || Date.now(); });
        elapsed = Math.max(1, Math.ceil((Math.max.apply(null, times) - Math.min.apply(null, times)) / 86400000) + 1);
      } else elapsed = 1;
    }
    elapsed = Math.min(elapsed, totalDays);

    var remaining = round2(total - spent);
    var percent = total > 0 ? Math.round(spent / total * 100) : 0;
    var dailyAvg = round2(spent / elapsed);
    var forecast = round2(dailyAvg * totalDays);
    var daysLeft = Math.max(1, totalDays - elapsed + 1);
    var safeDaily = round2(Math.max(0, remaining) / daysLeft);
    var willExceed = total > 0 && forecast > total;

    var alert = 'ok';
    if (total > 0 && percent >= 100) alert = 'danger';
    else if (total > 0 && (willExceed || percent >= 80)) alert = 'warn';

    var tips = [];
    if (total > 0) {
      tips.push(percent >= 100
        ? '预算已用完（' + percent + '%），建议压缩后续开支或追加预算。'
        : '预算已用 ' + percent + '%，剩余 ¥' + remaining.toFixed(2) + '（人均剩余 ¥' + round2(remaining / n).toFixed(2) + '）。');
      if (willExceed) {
        tips.push('按当前日均 ¥' + dailyAvg.toFixed(2) + ' 的速度，' + totalDays + ' 天预计花 ¥' + forecast.toFixed(2) + '，将超预算 ¥' + round2(forecast - total).toFixed(2) + '。');
        tips.push('后续每天控制在 ¥' + safeDaily.toFixed(2) + ' 以内即可回到预算线。');
      } else {
        tips.push('按当前速度全程预计 ¥' + forecast.toFixed(2) + '，预算可控，剩余天日均上限 ¥' + safeDaily.toFixed(2) + '。');
      }
    } else {
      tips.push('尚未设置旅行预算，设置后可自动预警超支。');
    }

    return {
      budget: round2(total), spent: spent, remaining: remaining, percent: percent,
      perPersonBudget: round2(total / n), perPersonSpent: round2(spent / n),
      days: elapsed, totalDays: totalDays, dailyAvg: dailyAvg,
      forecast: forecast, willExceed: willExceed, safeDaily: safeDaily,
      alert: alert, tips: tips
    };
  }

  // ============ 12. 每日消费分析（会复盘） ============

  var WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  function dayKey(b) {
    var d = new Date(b && (b.createdAt || b.created_at) || 0);
    if (isNaN(d)) return '';
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }

  /**
   * 每日消费分析：按天聚合 + 最贵一天 + 消费趋势
   */
  function dailyStats(bills) {
    bills = bills || [];
    var map = {};
    var byCategory = {};
    var total = 0;

    bills.forEach(function (b) {
      var k = dayKey(b) || '未知日期';
      if (!map[k]) map[k] = { date: k, total: 0, count: 0, byCategory: {} };
      var amt = billCNY(b);
      map[k].total += amt;
      map[k].count += 1;
      total += amt;
      var c = b.category || 'other';
      map[k].byCategory[c] = round2((map[k].byCategory[c] || 0) + amt);
      byCategory[c] = round2((byCategory[c] || 0) + amt);
    });

    var days = Object.keys(map).sort().map(function (k) {
      var d = map[k];
      d.total = round2(d.total);
      var dt = new Date(k + 'T00:00:00');
      d.weekday = isNaN(dt) ? '' : WEEKDAYS[dt.getDay()];
      return d;
    });

    var maxDay = days.reduce(function (acc, d) { return (!acc || d.total > acc.total) ? d : acc; }, null);

    // 趋势：后半程日均 vs 前半程日均
    var trend = 'flat';
    if (days.length >= 2) {
      var mid = Math.ceil(days.length / 2);
      var firstAvg = days.slice(0, mid).reduce(function (s, d) { return s + d.total; }, 0) / mid;
      var rest = days.slice(mid);
      var restAvg = rest.reduce(function (s, d) { return s + d.total; }, 0) / Math.max(1, rest.length);
      trend = restAvg > firstAvg * 1.15 ? 'up' : restAvg < firstAvg * 0.85 ? 'down' : 'flat';
    }

    return {
      days: days, total: round2(total), dailyAvg: round2(total / Math.max(1, days.length)),
      maxDay: maxDay, trend: trend, byCategory: byCategory
    };
  }

  // ============ 13. 旅行消费小作文（会复盘） ============

  /**
   * 旅行消费小作文：模板保底（离线）+ LLM 可选（options.llmCall）
   */
  async function generateNarrative(ctx, options) {
    options = options || {};
    if (typeof options.llmCall === 'function') {
      try {
        var llmInsight = generateInsight(ctx);
        var out = await options.llmCall(
          '你是旅行博主，为下面这次旅行写一段80字以内的消费小结（轻松幽默、有数字、结尾给一句省钱建议）：\n' +
          llmInsight.summary + '\n' + llmInsight.tips.join('；')
        );
        if (out && String(out).trim().length > 10) return String(out).trim();
      } catch (e) { /* 回退模板 */ }
    }
    var ins = generateInsight(ctx);
    var room = (ctx && ctx.room) || {};
    var parts = [];
    parts.push('这次「' + (room.name || '旅行') + '」' + (room.destination ? '去了' + room.destination : '') +
      '，' + ins.days + ' 天一共花了 ¥' + ins.total.toFixed(2) + '，' + ((ctx && ctx.members) || []).length + ' 个人摊下来人均 ¥' + ins.perPerson.toFixed(2) + '。');
    if (ins.topCategory) {
      parts.push('最能花的是' + ins.topCategory.name + '，占了 ' + ins.topCategory.percent + '%，' +
        (ins.largestBill ? '单笔最大「' + ins.largestBill.description + '」¥' + ins.largestBill.amount.toFixed(2) + '。' : ''));
    }
    if (ins.tips.length) parts.push('给下次的建议：' + ins.tips[0]);
    return parts.join('');
  }

  // ============ 13. 旅行专属记账语义（V3） ============
  //
  // 这一组函数是"旅行 AA"相对通用记账软件的差异化所在。全部为纯函数，
  // 小程序 / 网页 Demo / 服务端三端复用。
  //
  // 核心不变量（务必保持）：**任何账单的 splits 合计必须等于账单人民币金额**。
  // 下面这些能力（代购不摊、多退少补、暂估改价、抹零）都靠"零和补偿账单"实现，
  // 从而在不破坏账恒平的前提下表达复杂语义。

  /** 抹零/汇兑损耗 的虚拟成员 id（不计入房间成员，仅用于承载差额） */
  var LOSS_MEMBER_ID = '__loss__';
  var LOSS_MEMBER_NAME = '抹零损耗';

  /**
   * 各币种的"顺手凑整"台阶
   * 出境游真实现象：日币 12780 想记成 12800、韩元动辄上万要凑到千位。
   */
  var ROUND_STEPS = {
    CNY: 1,      // 凑到元（分太细，凑整到整数元）
    JPY: 100,    // 日元最小面额感知强，凑到百位
    KRW: 1000,   // 韩元数额大，凑到千位
    THB: 10, VND: 1000, IDR: 1000, PHP: 10, MYR: 1,
    USD: 1, EUR: 1, GBP: 1, HKD: 1, MOP: 1, SGD: 1, AUD: 1, CAD: 1
  };

  /** 取某币种的凑整台阶（未知币种按 1） */
  function roundStepOf(currency) {
    var c = String(currency || 'CNY').toUpperCase();
    return ROUND_STEPS[c] || 1;
  }

  /**
   * 智能凑整（抹零）
   *
   * @param {number} amount    原金额（原币）
   * @param {string} currency  币种
   * @param {Object} [opts]    { mode: 'nearest'|'up'|'down', step: 手动指定台阶 }
   * @returns {Object} { original, rounded, loss, step, mode, changed }
   *          loss = rounded - original（正数代表多记了，作为"损耗"由全员分摊）
   *
   * 注意：返回的 rounded 才是**入账金额**，loss 是差额。
   * 两者相加恒等于 rounded 本身（loss 已含在 rounded 里），
   * 所以分摊时把 loss 作为一笔损耗分摊即可保持账恒平。
   */
  function smartRound(amount, currency, opts) {
    opts = opts || {};
    var step = Number(opts.step) > 0 ? Number(opts.step) : roundStepOf(currency);
    var mode = opts.mode || 'nearest';
    var raw = Number(amount) || 0;
    var rounded;
    if (step <= 0 || raw === 0) {
      rounded = raw;
    } else if (mode === 'up') {
      rounded = Math.ceil(raw / step) * step;
    } else if (mode === 'down') {
      rounded = Math.floor(raw / step) * step;
    } else {
      rounded = Math.round(raw / step) * step;
    }
    rounded = round2(rounded);
    var loss = round2(rounded - raw);
    return {
      original: round2(raw),
      rounded: rounded,
      loss: loss,
      step: step,
      mode: mode,
      changed: Math.abs(loss) > 0.004
    };
  }

  /**
   * 把"抹零差额"并入分摊明细，保证合计仍等于账单金额。
   *
   * 做法：对传入的 splits 做整体缩放，使合计等于 targetAmount；
   * 差额单独落在 LOSS_MEMBER_ID 上，让用户能看见"这笔差额去哪了"。
   *
   * @param {Array}  splits       [{memberId, memberName, amount}]
   * @param {number} targetAmount 目标合计（账单金额）
   * @param {Object} [opts]       { lossId, lossName, distributeLoss: Boolean }
   * @returns {Array} 新的 splits（含损耗行）
   */
  function applyRoundingLoss(splits, targetAmount, opts) {
    opts = opts || {};
    var lossId = opts.lossId || LOSS_MEMBER_ID;
    var lossName = opts.lossName || LOSS_MEMBER_NAME;
    var target = round2(Number(targetAmount) || 0);

    var plain = (splits || []).filter(function (s) { return s && s.memberId !== lossId; });
    if (!plain.length) return splits || [];

    var sum = plain.reduce(function (s, x) { return s + (Number(x.amount) || 0); }, 0);
    var diff = round2(target - sum);

    if (Math.abs(diff) <= 0.004) {
      // 差额可忽略：直接把尾差补在最后一个非损耗成员上，保证严格相等
      var rest = target - plain.slice(0, -1).reduce(function (s, x) { return s + (Number(x.amount) || 0); }, 0);
      var out0 = plain.map(function (x, i) {
        return { memberId: x.memberId, memberName: x.memberName, amount: i === plain.length - 1 ? round2(rest) : round2(Number(x.amount) || 0) };
      });
      return out0;
    }

    var out = plain.map(function (x) {
      return { memberId: x.memberId, memberName: x.memberName, amount: round2(Number(x.amount) || 0) };
    });
    // 损耗作为独立一行，正负都保留（正=凑多了，负=凑少了）
    out.push({ memberId: lossId, memberName: lossName, amount: diff, isLoss: true });
    return out;
  }

  /**
   * 代购 / 不参与分摊：只由垫付人承担，其余人 0
   *
   * @param {Object} bill   账单（需含 payer / payerName / amount）
   * @param {Array}  members 房间成员
   * @returns {Array} splits
   */
  function buildSoleSplits(bill, members) {
    members = members || [];
    var amount = round2(Number(bill && bill.amount) || 0);
    var payerId = bill && bill.payer;
    // 垫付人可能已退房，兜底保证一定有一行承担全额
    if (!members.some(function (m) { return m.id === payerId; })) {
      return [{ memberId: payerId || LOSS_MEMBER_ID, memberName: (bill && bill.payerName) || '垫付人', amount: amount }];
    }
    return members.map(function (m) {
      return {
        memberId: m.id,
        memberName: m.name,
        amount: m.id === payerId ? amount : 0
      };
    });
  }

  /**
   * 判断账单是否"不参与 AA 分摊"（代购 / 私人消费）
   */
  function isSoleBill(bill) {
    if (!bill) return false;
    if (bill.sole === true || bill.splitType === 'sole') return true;
    if (bill.splits && bill.splits.length) {
      var payer = bill.payer;
      return bill.splits.every(function (s) {
        return Math.abs(Number(s.amount) || 0) < 0.005 || s.memberId === payer;
      });
    }
    return false;
  }

  /**
   * 多退少补：把某账单里"并未参与"的人从分摊中剔除，并要求其退款。
   *
   * 语义（零和）：退出者**退还自己的那份**，钱**退给当初垫付的人**。
   * 这与暂估改价（差额也在垫付人处冲抵）保持一致 —— 调整单的对手方永远是垫付人。
   *
   * 例：小明垫 480 房租，三人均摊各 160。小李退出 →
   *     小李 -160（欠款清零），小明 +160（收回自己替小李垫的那份）
   *     小明净额 320、小红 160、小李 0，合计 480 不变。
   *
   * @param {Object} bill          原账单
   * @param {Array}  excludeIds    要剔除（退款）的成员 id
   * @param {Object} [opts]        { ts }
   * @returns {Object} 调整单（零和）
   *
   * 关键：这**不是**删除原账单，而是记一笔"调整"。历史保留，账恒平不变。
   */
  function buildAdjustmentForExclusion(bill, excludeIds, opts) {
    opts = opts || {};
    var ex = {};
    (excludeIds || []).forEach(function (id) { if (id) ex[id] = true; });

    var base = (bill && bill.splits) || [];
    var payer = bill && bill.payer;
    var payName = (bill && bill.payerName) || '垫付人';

    // 按成员聚合（同一人可能既"被退出"又是"垫付人"，必须累加而非追加重复行）
    var acc = {};
    var order = [];
    function add(memberId, memberName, amount, flags) {
      if (!memberId) return;
      if (!acc[memberId]) { acc[memberId] = { memberId: memberId, memberName: memberName || memberId, amount: 0 }; order.push(memberId); }
      if (memberName) acc[memberId].memberName = memberName;
      acc[memberId].amount = round2(acc[memberId].amount + amount);
      if (flags) Object.keys(flags).forEach(function (k) { acc[memberId][k] = flags[k]; });
    }

    var totalBack = 0;
    var names = [];
    base.forEach(function (s) {
      if (!ex[s.memberId]) return;
      var amt = round2(Number(s.amount) || 0);
      totalBack = round2(totalBack + amt);
      names.push(s.memberName || s.memberId);
      add(s.memberId, s.memberName, -amt, { isRefund: true });
    });

    // 退款给垫付人，抵消退出者的欠款（零和）
    if (payer && totalBack > 0) add(payer, payName, totalBack, { isPayerSettle: true });

    var splits = order.map(function (id) {
      var row = acc[id];
      // 净额归零的行没有意义（如垫付人自己也退出且恰好冲平），保留以免改变语义
      return {
        memberId: row.memberId,
        memberName: row.memberName,
        amount: row.amount,
        isRefund: !!row.isRefund,
        isPayerSettle: !!row.isPayerSettle
      };
    });

    return {
      isAdjustment: true,
      adjustsBillId: (bill && (bill.id || bill._id)) || null,
      reason: 'exclude',
      amount: 0,
      currency: (bill && bill.currency) || 'CNY',
      rate: 1,
      cnyAmount: 0,
      description: '多退少补 · ' + (names.join('、') || '部分成员') + '退出分摊',
      category: (bill && bill.category) || 'other',
      source: 'adjust',
      splits: splits,
      delta: totalBack,          // 退款总额（非零！）
      totalDelta: 0,             // 总额变化量：排除成员不改总额 → 恒为 0
      summary: '退还 ' + (names.join('、') || '部分成员') + ' 合计 ¥' + totalBack.toFixed(2) +
        '，退回垫付人 ' + payName,
      createdAt: opts.ts || new Date().toISOString()
    };
  }

  /**
   * 暂估改价 / 二次分摊：金额变动时生成**零和**补偿单。
   *
   * ============ 统一公式（看懂这一条就懂全部调整单） ============
   *   设各人在原账单里的份额为 base[i]，调整后应为 target[i]
   *   份额变化 Δ[i] = target[i] − base[i]
   *   垫付人的抵消额 = −Σ Δ[i]
   *
   * 为什么垫付人要抵消 ΣΔ：调整单只能"重新分配"，不能凭空产生消费，
   * 所以自身必须零和；而份额变化的总和只能由当初掏钱的那个人来镜像
   * （钱是他垫的，多退少补都经他的手）。
   *
   * 举例 3200 → 3560（4 人、小明垫付）：
   *   每人 800 → 890，Δ = +90，ΣΔ = 360
   *   小明那行 = +90（自己新增的份额）− 360（收回新增总额）= −270
   *   净效果：小明已垫 3200，实际应收 3×890 = 2670，故本次只追加 −270 ✓
   *
   * @param {Object} oldBill   原账单（含 splits）
   * @param {number} newAmount 新金额（原币）
   * @param {Array}  members   成员（用于名称）
   * @param {Object} [opts]    { ts }
   * @returns {Object} 补偿单（零和）
   */
  function buildAdjustmentForReestimate(oldBill, newAmount, members, opts) {
    opts = opts || {};
    var oldAmt = Number(oldBill && oldBill.amount) || 0;
    var newAmt = round2(Number(newAmount) || 0);
    var delta = round2(newAmt - oldAmt);

    var base = (oldBill && oldBill.splits) || [];
    var participants = base.filter(function (s) { return Math.abs(Number(s.amount) || 0) > 0.004; });
    var payer = oldBill && oldBill.payer;
    var payName = (oldBill && oldBill.payerName) || '垫付人';

    // 两类操作语义统一表述（实现上无需分支，见下方 wantTotal = delta）：
    //   ① 重新分配（排除成员）：总额不变 ⇒ delta = 0 ⇒ 调整单零和
    //   ② 金额变化（暂估改价 / 补记）：总额真变 ⇒ 调整单合计 = delta
    var kind = opts.kind || 'adjust';

    // 先算出每个人的 Δ[i]
    var deltas = [];       // [{memberId, memberName, delta, target, base}]
    var names = [];

    if (!participants.length) {
      // 没有分摊人（占位单，或数据残缺）→ 整笔差额都落在垫付人
      deltas.push({ memberId: payer || LOSS_MEMBER_ID, memberName: payName, delta: delta, target: delta, base: 0 });
    } else {
      var oldSum = participants.reduce(function (s, x) { return s + (Number(x.amount) || 0); }, 0);
      var running = 0;
      participants.forEach(function (p, i) {
        var oldShare = Number(p.amount) || 0;
        var newShare = i === participants.length - 1
          ? round2(newAmt - running)                                  // 尾差兜底
          : (oldSum > 0 ? round2(newAmt * (oldShare / oldSum)) : round2(newAmt / participants.length));
        running = round2(running + newShare);
        names.push(p.memberName || p.memberId);
        deltas.push({
          memberId: p.memberId, memberName: p.memberName,
          delta: round2(newShare - oldShare),
          target: newShare, base: oldShare
        });
      });
    }

    // ============ 垫付人那一行 ============
    //
    // 经过穷举验证（见开发记录），这里有个**数学事实**必须先想清楚：
    //
    //   Σadj = Σtarget − Σbase = newAmt − oldAmt = delta
    //
    // 也就是说：**只要总额变了，调整单就不可能零和** —— "零和"与
    // "eff[i] === target[i]" 在总额不变时等价，在总额变化时互斥（已穷举验证）。
    //
    // 因此实现上**不需要区分两类操作**，统一按 target 反解即可：
    //   adj[i] = target[i] − base[i] = Δ[i]（对所有人，含垫付人）
    // 于是 Σadj = delta 自动成立：
    //   · 排除成员时 delta = 0 → 调整单自动零和
    //   · 暂估改价 / 补记时 delta ≠ 0 → 调整单合计恰为 delta
    // 且 eff[i] = base[i] + Δ[i] = target[i] 恒成立。
    //
    // ⚠️ 踩坑记录：曾强行给垫付人加"镜像行"让调整单零和，结果
    //    (a) 等比分摊改价时垫付人应收被算成 2670 却输出 2310（符号/重复计入）
    //    (b) 不等比改价时算出反号
    //    根因是想同时满足两个互斥约束。现由 tests/v3.test.js 的
    //    "Σadj === delta" 与 "eff === target" 双重断言锁死。

    // 按成员聚合（垫付人通常自己也是分摊人，会出现两行同名，必须累加）
    var acc = {};
    var order = [];
    function add(memberId, memberName, amount, flags) {
      if (!memberId) return;
      if (!acc[memberId]) { acc[memberId] = { memberId: memberId, memberName: memberName || memberId, amount: 0 }; order.push(memberId); }
      if (memberName) acc[memberId].memberName = memberName;
      acc[memberId].amount = round2(acc[memberId].amount + amount);
      if (flags) Object.keys(flags).forEach(function (k) { acc[memberId][k] = flags[k]; });
    }

    // 每个人的调整额就是自己的份额变化 Δ[i]（垫付人也一样）。
    // Σadj = ΣΔ = target 合计 − base 合计 = newAmt − oldSum = delta
    //   → delta = 0（纯粹再分配，如排除成员）时调整单自然零和
    //   → delta ≠ 0（金额真的变了）时调整单合计恰为 delta，结算时自动增减总额
    deltas.forEach(function (d) { add(d.memberId, d.memberName, d.delta); });

    var splits = order.map(function (id) {
      var row = acc[id];
      return {
        memberId: row.memberId,
        memberName: row.memberName,
        amount: row.amount,
        isPayerSettle: !!row.isPayerSettle
      };
    });

    // 合计必须等于 delta —— 这是唯一的正确性锚点，**不需要区分 kind**：
    //   Σadj 应 = Σtarget − Σbase = newAmt − oldAmt = delta
    //   ⇒ eff 合计 = base 合计 + delta = newAmt ✓
    // 排除成员时 delta 恰为 0，于是自动零和；改价/补记时 delta≠0，自动记下增量。
    // （曾在此处写 `zeroSum ? 0 : delta` 并默认 zeroSum=true，把正确的 Δ 强行拉平到 0，
    //   导致不等比改价算出反号结果 —— 这个 bug 由 tests/v3.test.js 的恒等断言抓出。）
    var total = round2(splits.reduce(function (s, x) { return s + (Number(x.amount) || 0); }, 0));
    var wantTotal = delta;
    if (Math.abs(total - wantTotal) > 0.004 && splits.length) {
      var maxIdx = 0;
      splits.forEach(function (s, i) {
        if (Math.abs(s.amount) > Math.abs(splits[maxIdx].amount)) maxIdx = i;
      });
      splits[maxIdx].amount = round2(splits[maxIdx].amount + (wantTotal - total));
    }

    return {
      isAdjustment: true,
      adjustsBillId: (oldBill && (oldBill.id || oldBill._id)) || null,
      reason: kind === 'fill' ? 'fill' : 'reestimate',
      kind: kind,
      // 总额没变（纯再分配）时本单零和；改了总额时合计恰为 delta
      zeroSum: Math.abs(delta) < 0.005,
      amount: 0,
      currency: (oldBill && oldBill.currency) || 'CNY',
      rate: 1,
      cnyAmount: 0,
      description: (kind === 'fill' ? '补记金额 · ' : '暂估改价 · ') +
        (oldBill && oldBill.description ? oldBill.description + ' ' : '') +
        '¥' + oldAmt.toFixed(2) + ' → ¥' + newAmt.toFixed(2),
      category: (oldBill && oldBill.category) || 'other',
      source: 'adjust',
      splits: splits,
      delta: delta,              // 本单 splits 合计（= 总额变化量）
      totalDelta: delta,         // 总额变化量：改价/补记真的改了总额
      summary: (delta >= 0 ? '补收' : '退回') + ' ¥' + Math.abs(delta).toFixed(2) +
        (names.length ? '，由 ' + names.join('、') + ' 按原比例' + (delta >= 0 ? '补' : '退') : ''),
      createdAt: opts.ts || new Date().toISOString()
    };
  }

  /**
   * 结算净余额（**含调整单的正确口径**）
   *
   * ============ 为什么必须单独提供这个函数 ============
   * 调整单（多退少补 / 暂估改价）的 amount 是 0，它不是一笔独立消费，
   * 而是"对某笔已有账单的重新分配"。因此结算时必须把所有调整单的 splits
   * **先叠加回原账单**得到 effectiveShares，再用
   *
   *     净余额[人] = Σ(该人实付的人民币金额) − Σ(该人有效份额)
   *
   * 来计算。若把调整单当成独立账单去结算（只累加 payer 的 amount），
   * 垫付人会被少算钱 —— 这是本项目最容易算错的地方，故抽成内核函数统一三端口径。
   *
   * 不变量：Σ净余额 = 0（账恒平）。调用方应断言这一点。
   *
   * @param {Array}  bills   全部账单（含调整单）
   * @param {Array}  members 房间成员 [{id,name}]（可空）
   * @param {Object} [rates] 汇率覆盖
   * @returns {Object} { balances:[{memberId,memberName,amount}], total, balanced, foreign }
   */
  function netBalances(bills, members, rates) {
    var list = settleableBills(bills);
    var adjust = list.filter(function (b) { return b.isAdjustment; });
    var normal = list.filter(function (b) { return !b.isAdjustment; });

    var paid = {};      // 实付
    var share = {};     // 有效份额
    var nameOf = {};

    (members || []).forEach(function (m) { nameOf[m.id] = m.name; });

    function touch(id, name) {
      if (id == null) return;
      if (!(id in paid)) paid[id] = 0;
      if (!(id in share)) share[id] = 0;
      if (name) nameOf[id] = name;
    }

    // 实付：只有真实消费才产生"谁掏了钱"
    normal.forEach(function (b) {
      touch(b.payer, b.payerName);
      if (b.payer != null) paid[b.payer] = round2(paid[b.payer] + billCNY(b, rates));
    });
    // 有效份额累加器。外币账单的 splits 是**原币**金额，必须乘以记账时快照汇率
    // 换成人人民币，否则日元账单会被当人民币计入（曾把账算歪约 12000 倍量级）。
    function addShares(splitList, rate) {
      var r = Number(rate);
      if (!isFinite(r) || r <= 0) r = 1;
      (splitList || []).forEach(function (s) {
        touch(s.memberId, s.memberName);
        if (s.memberId == null) return;
        share[s.memberId] = round2((share[s.memberId] || 0) + (Number(s.amount) || 0) * r);
      });
    }

    normal.forEach(function (b) { addShares(b.splits, b.rate); });

    // 调整单：全部计入有效份额（不依赖 adjustsBillId 是否填写，避免漏算）
    adjust.forEach(function (a) {
      addShares(a.splits, 1);

      // 只有"总额真的变了"的调整单才会改变实付：
      //   暂估改价 3200→3560：垫付人后来又补付 360 → 实付 3560
      //   降价 -400：那 400 是退回来的 → 实付 2800
      //   排除成员：**总额不变**（退款只是在成员间转移），实付不动
      //
      // 判定用调整单自身的"总额变化量"，而不是 delta 字段 ——
      // 排除单的 delta 表示"退款总额"（非零），若拿它当总额变化会把实付算多。
      var netDelta = a.totalDelta != null
        ? Number(a.totalDelta)
        : (a.isAdjustment && a.reason === 'exclude' ? 0 : (Number(a.delta) || 0));
      if (Math.abs(netDelta) < 0.005) return;

      var base = normal.filter(function (b) { return (b.id || b._id) === a.adjustsBillId; })[0];
      if (!base) return;                       // 无归属调整单不动实付
      var payer = base.payer;
      if (payer == null) return;
      var r = Number(base.rate);
      if (!isFinite(r) || r <= 0) r = 1;
      touch(payer, base.payerName);
      paid[payer] = round2(paid[payer] + netDelta * r);
    });

    var ids = Object.keys(paid).concat(Object.keys(share)).filter(function (v, i, arr) {
      return arr.indexOf(v) === i;
    }).filter(function (id) { return id !== LOSS_MEMBER_ID; });

    var balances = ids.map(function (id) {
      return {
        memberId: id,
        memberName: nameOf[id] || id,
        amount: round2((paid[id] || 0) - (share[id] || 0))
      };
    }).sort(function (a, b) { return b.amount - a.amount; });

    var total = round2(balances.reduce(function (s, x) { return s + x.amount; }, 0));
    var foreign = normal.some(function (b) { return b.currency && b.currency !== 'CNY'; });

    return {
      balances: balances,
      total: round2(normal.reduce(function (s, b) { return s + billCNY(b, rates); }, 0)),
      paid: paid,
      shares: share,
      foreign: foreign,
      balanced: Math.abs(total) < 0.05,
      // 若有损耗行，损耗额单独说明（它不属任何成员）
      loss: adjust.length ? null : null
    };
  }

  /**
   * 不变量自检：调整单（isAdjustment）必须自身零和。
   *
   * 为什么单独做成一个函数：调整单如果"不零和"，就会把差额当成一笔新消费
   * 重复计入总额，最终结算净余额之和 ≠ 0。这是最容易犯且最难肉眼发现的错，
   * 所以把它固化成可断言的检查，kernel、服务端与测试都调用它。
   *
   * @returns {Object} { ok, bad:[{id, sum}] }
   */
  function validateAdjustments(bills) {
    var bad = [];
    (bills || []).forEach(function (b) {
      if (!b || !b.isAdjustment) return;
      // 只有"总额未变"（zeroSum 为真）的调整单才应该零和；
      // 改价/补记类调整单合计恰为 delta，不在此校验。
      if (b.zeroSum === false) return;
      var s = round2((b.splits || []).reduce(function (acc, x) { return acc + (Number(x.amount) || 0); }, 0));
      if (Math.abs(s) > 0.01) bad.push({ id: b.id || b._id || '(无 id)', sum: s });
    });
    return { ok: bad.length === 0, bad: bad };
  }

  /**
   * 口头占位：字段不全也能先入账，事后补齐。
   *
   * 状态流转（重要）：
   *   - 字段不全 → status='draft'，needsCompletion=true  → **不参与结算/统计**
   *   - 字段补齐（此时再调本函数）→ status='normal'，needsCompletion=false → 正常参与结算
   * 之所以让补齐后状态变回 normal：占位只是"临时不确定"的标记，
   * 补齐后它就该像普通账单一样算钱；若一直挂 draft 会永远算不进去。
   *
   * @param {Object} partial  { amount?, payer?, description?, currency? }
   * @returns {Object} 占位/普通账单
   */
  function buildPlaceholder(partial) {
    partial = partial || {};
    var missing = [];
    if (!(Number(partial.amount) > 0)) missing.push('amount');
    if (!partial.payer) missing.push('payer');
    var needs = missing.length > 0;
    return {
      status: needs ? 'draft' : 'normal',
      missing: missing,
      canSettle: !needs,
      needsCompletion: needs,
      amount: Number(partial.amount) || 0,
      currency: partial.currency || 'CNY',
      description: partial.description || '（待补：一笔没记清的消费）',
      category: partial.category || 'other',
      payer: partial.payer || null,
      payerName: partial.payerName || '',
      splits: partial.splits || []
    };
  }

  /**
   * 判断账单是否可参与结算：
   * 调整单、重复标记单不单独计（调整单是零和的，计入也不会错，但避免重复展示）
   * 占位单（字段不全）**不计入**结算，否则会把账算歪。
   */
  function isSettleable(bill) {
    if (!bill) return false;
    if (bill.status === 'draft' || bill.status === 'placeholder') return false;
    if (bill.needsCompletion) return false;
    if (bill.voided) return false;
    var amt = Number(bill.amount) || 0;
    // 占位单金额可能为 0；正常账单必须有金额
    if (amt <= 0 && !bill.isAdjustment) return false;
    return true;
  }

  /**
   * 从账单集合中挑出可结算的（结算、统计都应走这个函数）
   */
  function settleableBills(bills) {
    return (bills || []).filter(isSettleable);
  }

  /**
   * 计算某账单的"实际分摊"（含其所有调整单的净效果）
   * 用于 UI 展示"这笔账最后各人实际掏了多少"。
   *
   * @param {Object} bill  原账单
   * @param {Array}  all   全部账单（用于找调整单）
   * @returns {Array} [{memberId, memberName, amount}] amount 为净额
   */
  function effectiveShares(bill, all) {
    var base = (bill && bill.splits) || [];
    var map = {};
    var order = [];
    base.forEach(function (s) {
      if (!map[s.memberId]) { map[s.memberId] = { memberId: s.memberId, memberName: s.memberName, amount: 0 }; order.push(s.memberId); }
      map[s.memberId].amount = round2(map[s.memberId].amount + (Number(s.amount) || 0));
    });
    var id = bill && (bill.id || bill._id);
    (all || []).forEach(function (b) {
      if (!b || !b.isAdjustment || b.adjustsBillId !== id) return;
      (b.splits || []).forEach(function (s) {
        if (!map[s.memberId]) { map[s.memberId] = { memberId: s.memberId, memberName: s.memberName, amount: 0 }; order.push(s.memberId); }
        map[s.memberId].amount = round2(map[s.memberId].amount + (Number(s.amount) || 0));
      });
    });
    return order.map(function (k) { return map[k]; });
  }

  /**
   * 待补清单：哪些账单还没记清
   */
  function pendingBills(bills) {
    return (bills || []).filter(function (b) {
      return b && (b.status === 'draft' || b.needsCompletion || (Number(b.amount) || 0) <= 0 && !b.isAdjustment);
    });
  }

  /**
   * 结算前校验：把所有"不参与结算"的账单列出来提醒用户
   */
  function settlementReadiness(bills) {
    var pending = pendingBills(bills);
    var adjustments = (bills || []).filter(function (b) { return b && b.isAdjustment; });
    return {
      ready: pending.length === 0,
      pendingCount: pending.length,
      pending: pending,
      adjustmentCount: adjustments.length,
      message: pending.length
        ? '还有 ' + pending.length + ' 笔没记清（缺金额或付款人），补齐后账才算得准'
        : '账目齐全，可以结算'
    };
  }

  // ============ 14. 会说话：结清卡片 / 手账 / 礼貌催账（V3） ============

  /**
   * 礼貌催账话术：把"你欠我钱"说成不尴尬的话
   * @param {Object} item { fromName, toName, amount, roomName? }
   * @param {Object} [opts] { style: 'friendly'|'brief'|'playful' }
   */
  function politeReminder(item, opts) {
    opts = opts || {};
    var style = opts.style || 'friendly';
    var from = (item && item.fromName) || '你';
    var to = (item && item.toName) || '对方';
    var amt = '¥' + (Number(item && item.amount) || 0).toFixed(2);
    var room = (item && item.roomName) || '这次旅行';
    var lines = {
      friendly: '嗨 ' + from + '～ ' + room + '的账我对完啦，你这边还有 ' + amt + ' 没结，方便的时候转我就行，不着急 😊',
      brief: room + '结算：' + from + ' → ' + to + ' ' + amt,
      playful: '【' + room + '记账官】提醒：' + from + ' 同学，' + amt + ' 正在呼唤你～ 转账后我们就两清啦 🎉'
    };
    return lines[style] || lines.friendly;
  }

  /**
   * 旅行手账：按天生成一句人话小结（而不是冷冰冰的数字表）
   * @param {Array} bills
   * @param {Object} [opts] { destination, members }
   */
  function travelJournal(bills, opts) {
    opts = opts || {};
    var list = settleableBills(bills);
    var byDay = {};
    list.forEach(function (b) {
      var d = billDayKey(b);
      if (!d) return;
      if (!byDay[d]) byDay[d] = [];
      byDay[d].push(b);
    });
    var days = Object.keys(byDay).sort();
    return days.map(function (d, idx) {
      var dayBills = byDay[d];
      var total = round2(dayBills.reduce(function (s, b) { return s + billCNY(b); }, 0));
      // 当日占比最高的分类
      var cat = {};
      dayBills.forEach(function (b) {
        var c = b.category || 'other';
        cat[c] = round2((cat[c] || 0) + billCNY(b));
      });
      var topCat = Object.keys(cat).sort(function (a, b2) { return cat[b2] - cat[a]; })[0];
      var catName = (CATEGORIES[topCat] && CATEGORIES[topCat].name) || '其他';
      var biggest = dayBills.slice().sort(function (a, b2) { return billCNY(b2) - billCNY(a); })[0];
      return {
        day: d,
        index: idx + 1,
        total: total,
        count: dayBills.length,
        topCategory: topCat,
        text: '第 ' + (idx + 1) + ' 天：' + dayBills.length + ' 笔，共 ¥' + total.toFixed(2) +
          '，主要在「' + catName + '」上花钱' +
          (biggest ? '，最贵一笔是「' + (biggest.description || '消费') + '」¥' + billCNY(biggest).toFixed(2) : '') +
          '。'
      };
    });
  }

  /**
   * 结清卡片数据（可渲染成文本/图片分享）
   * @param {Object} ctx { room, bills, members, settlement? }
   */
  function shareCardData(ctx) {
    ctx = ctx || {};
    var room = ctx.room || {};
    var raw = ctx.bills || [];
    var bills = settleableBills(raw);
    var members = ctx.members || [];
    var total = round2(bills.reduce(function (s, b) { return s + billCNY(b); }, 0));
    var n = members.length || 1;
    var ins = generateInsight({ room: room, bills: raw, members: members });

    // generateInsight 只回 topCategory，这里补一份完整分类占比（结清卡片要展示前 3 名）
    var catMap = {};
    bills.forEach(function (b) {
      var c = b.category || 'other';
      catMap[c] = round2((catMap[c] || 0) + billCNY(b));
    });
    var topCategories = Object.keys(catMap)
      .sort(function (a, b2) { return catMap[b2] - catMap[a]; })
      .map(function (c) {
        return {
          category: c,
          name: (CATEGORIES[c] && CATEGORIES[c].name) || c,
          icon: (CATEGORIES[c] && CATEGORIES[c].icon) || '📦',
          amount: catMap[c],
          percent: total > 0 ? Math.round(catMap[c] / total * 100) : 0
        };
      });

    return {
      title: room.name || '旅行',
      destination: room.destination || '',
      days: ins.days,
      people: n,
      total: total,
      perPerson: round2(total / n),
      billCount: bills.length,
      topCategories: topCategories.slice(0, 3),
      headline: (room.name || '旅行') + ' · ' + ins.days + ' 天 · ' + n + ' 人',
      subtitle: '总计 ¥' + total.toFixed(2) + ' · 人均 ¥' + round2(total / n).toFixed(2),
      footer: 'TravelAA · 旅行 AA 记账'
    };
  }

  /** 结清卡片的纯文本版本（便于复制到微信） */
  function shareCardText(ctx) {
    var d = shareCardData(ctx);
    var lines = [];
    lines.push('✈️ ' + d.headline);
    lines.push('─'.repeat(20));
    lines.push('总消费　¥' + d.total.toFixed(2));
    lines.push('人均　　¥' + d.perPerson.toFixed(2));
    lines.push('账单数　' + d.billCount + ' 笔');
    if (d.topCategories.length) {
      lines.push('主要花在');
      d.topCategories.forEach(function (c) {
        lines.push('　· ' + ((CATEGORIES[c.category] && CATEGORIES[c.category].name) || c.category) + '　¥' + (c.amount || 0).toFixed(2) + '（' + (c.percent || 0) + '%）');
      });
    }
    lines.push('─'.repeat(20));
    lines.push('由 ' + d.footer + ' 生成');
    return lines.join('\n');
  }

  // ============ 导出 ============

  return {
    CATEGORIES: CATEGORIES,
    CNY_RATES: CNY_RATES,
    LOSS_MEMBER_ID: LOSS_MEMBER_ID,
    LOSS_MEMBER_NAME: LOSS_MEMBER_NAME,
    classifyExpense: classifyExpense,
    allocateEvenly: allocateEvenly,
    parseBillText: parseBillText,
    buildSplits: buildSplits,
    generateInsight: generateInsight,
    generateTripReport: generateTripReport,
    parseWithLLM: parseWithLLM,
    // V2 扩展
    buildLLMPrompt: buildLLMPrompt,
    repairJSON: repairJSON,
    mergeParse: mergeParse,
    cnNumToNumber: cnNumToNumber,
    normalizeSpeech: normalizeSpeech,
    getRates: getRates,
    setRates: setRates,
    toCNY: toCNY,
    billCNY: billCNY,
    auditBills: auditBills,
    budgetStatus: budgetStatus,
    dailyStats: dailyStats,
    generateNarrative: generateNarrative,
    // V3 旅行专属记账语义
    LOSS_MEMBER_ID: LOSS_MEMBER_ID,
    LOSS_MEMBER_NAME: LOSS_MEMBER_NAME,
    roundStepOf: roundStepOf,
    smartRound: smartRound,
    applyRoundingLoss: applyRoundingLoss,
    buildSoleSplits: buildSoleSplits,
    isSoleBill: isSoleBill,
    buildAdjustmentForExclusion: buildAdjustmentForExclusion,
    buildAdjustmentForReestimate: buildAdjustmentForReestimate,
    validateAdjustments: validateAdjustments,
    netBalances: netBalances,
    buildPlaceholder: buildPlaceholder,
    isSettleable: isSettleable,
    settleableBills: settleableBills,
    effectiveShares: effectiveShares,
    pendingBills: pendingBills,
    settlementReadiness: settlementReadiness,
    // V3 会说话
    politeReminder: politeReminder,
    travelJournal: travelJournal,
    shareCardData: shareCardData,
    shareCardText: shareCardText
  };
});
