/**
 * V2 扩展能力单元测试：node tests/v2.test.js
 * 覆盖：语音归一化 / 多币种折算 / 多币种结算 / AI 账单审计 / 预算管理 /
 *       每日消费分析 / LLM 双轨工程化 / 旅行小作文 / 携程订单导入
 */
const AI = require('../apps/miniprogram/utils/ai.js');
const SETTLE = require('../apps/miniprogram/utils/settle.js');
const CTRIP = require('../apps/miniprogram/utils/ctrip.js');

let passed = 0, failed = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; console.log('  ✅ ' + name); }
  else { failed++; console.log('  ❌ ' + name + '\n     期望: ' + e + '\n     实际: ' + a); }
}
function ok(name, cond) { eq(name, !!cond, true); }

const MEMBERS = [
  { id: 'user_1', name: '小明' },
  { id: 'user_2', name: '小红' },
  { id: 'user_3', name: '小李' },
  { id: 'user_4', name: '小王' }
];

async function main() {

  console.log('\n—— 1. 语音/口语文本归一化（会听）——');
  eq('八十六→86', AI.cnNumToNumber('八十六'), 86);
  eq('十二→12', AI.cnNumToNumber('十二'), 12);
  eq('一百五→150（口语省略）', AI.cnNumToNumber('一百五'), 150);
  eq('三百二十八→328', AI.cnNumToNumber('三百二十八'), 328);
  eq('三千二→3200（口语省略）', AI.cnNumToNumber('三千二'), 3200);
  eq('两万五→25000（口语省略）', AI.cnNumToNumber('两万五'), 25000);
  eq('零星串→null', AI.cnNumToNumber('打车'), null);
  ok('归一化含86元', AI.normalizeSpeech('打车去机场八十六块，我垫的').indexOf('86元') !== -1);
  ok('归一化去语音填充词', AI.normalizeSpeech('嗯，那个，晚饭三百二十八元').indexOf('328元') !== -1);
  ok('全角转半角', AI.normalizeSpeech('花了８６元').indexOf('86元') !== -1);
  {
    const p = AI.parseBillText('打车去机场八十六块，我垫的，和小红小李平分', MEMBERS, { meName: '小明' });
    eq('语音句→金额86', p.amount, 86);
    eq('语音句→分类transport', p.category, 'transport');
    eq('语音句→付款人小明', p.payerName, '小明');
    eq('语音句→分摊3人', p.splitWith.length, 3);
  }

  console.log('\n—— 2. 多币种汇率折算（会算账）——');
  eq('JPY折算', AI.toCNY(12000, 'JPY'), 576);
  eq('CNY原样', AI.toCNY(100, 'CNY'), 100);
  eq('未知币种按1', AI.toCNY(100, 'XXX'), 100);
  AI.setRates({ JPY: 0.05 });
  eq('运行时汇率覆盖生效', AI.toCNY(12000, 'JPY'), 600);
  AI.setRates({ JPY: 0.048 });
  eq('汇率恢复', AI.toCNY(12000, 'JPY'), 576);
  eq('传入汇率优先', AI.toCNY(100, 'USD', { USD: 7 }), 700);
  eq('快照cnyAmount优先', AI.billCNY({ amount: 12000, currency: 'JPY', cnyAmount: 576 }), 576);
  eq('rate快照折算', AI.billCNY({ amount: 1000, currency: 'JPY', rate: 0.05 }), 50);
  eq('CNY账单原值', AI.billCNY({ amount: 128.5 }), 128.5);
  {
    const p = AI.parseBillText('药妆店扫货花了12000日元', MEMBERS, { meName: '小明' });
    eq('外币解析带折算', p.cnyAmount, 576);
    eq('外币解析带币种', p.currency, 'JPY');
  }

  console.log('\n—— 3. 多币种贪心结算 ——');
  {
    const members = [MEMBERS[0], MEMBERS[1]];
    const bills = [{
      payer: 'user_1', amount: 1000, currency: 'JPY', rate: 0.05,
      splits: [{ memberId: 'user_1', amount: 500 }, { memberId: 'user_2', amount: 500 }]
    }];
    const s = SETTLE.calculateSettlement(members, bills);
    eq('JPY账单折算总额=50', s.totalExpense, 50);
    eq('垫付人余额+25', s.balances.find(b => b.id === 'user_1').amount, 25);
    eq('分摊人余额-25', s.balances.find(b => b.id === 'user_2').amount, -25);
    eq('转账1笔', s.transfers.length, 1);
    eq('转账金额25', s.transfers[0].amount, 25);
    ok('hasForeign=true', s.hasForeign === true);
    eq('币种清单', s.currencies, ['JPY']);
  }
  {
    const members = [MEMBERS[0], MEMBERS[1]];
    const bills = [
      { payer: 'user_1', amount: 100, splits: [{ memberId: 'user_1', amount: 50 }, { memberId: 'user_2', amount: 50 }] },
      { payer: 'user_1', amount: 1000, currency: 'JPY', rate: 0.05, splits: [{ memberId: 'user_1', amount: 500 }, { memberId: 'user_2', amount: 500 }] }
    ];
    const s = SETTLE.calculateSettlement(members, bills);
    eq('混合币种总额=150', s.totalExpense, 150);
    ok('hasForeign=true', s.hasForeign === true);
    const share = SETTLE.generateShareText({ name: '东京行', memberCount: 2 }, s);
    ok('分享文案含折算提示', share.indexOf('折算人民币') !== -1);
  }

  console.log('\n—— 4. AI 账单审计（会复盘）——');
  {
    const dupBills = [
      { _id: 'b1', amount: 86, description: '打车去机场', category: 'transport', createdAt: '2024-10-01T10:00:00' },
      { _id: 'b2', amount: 86, description: '打车去机场', category: 'transport', createdAt: '2024-10-01T10:05:00' }
    ];
    const r = AI.auditBills(dupBills, MEMBERS);
    eq('检出重复账单', r.issues.filter(x => x.type === 'duplicate').length, 1);
    eq('重复=高严重度', r.issues[0].severity, 'high');
    ok('健康度扣分', r.score < 100);
  }
  {
    const badBills = [
      { _id: 'b1', amount: 100, description: '晚饭', category: 'food', splits: [{ amount: 30 }], createdAt: '2024-10-01T10:00:00' }
    ];
    const r = AI.auditBills(badBills, MEMBERS);
    eq('检出账不平', r.issues.filter(x => x.type === 'unbalanced').length, 1);
  }
  {
    const anomalyBills = [
      { _id: 'b1', amount: 100, description: '打车', category: 'transport', createdAt: '2024-10-01T10:00:00' },
      { _id: 'b2', amount: 100, description: '咖啡', category: 'food', createdAt: '2024-10-02T10:00:00' },
      { _id: 'b3', amount: 5000, description: '代购包包', category: 'shopping', createdAt: '2024-10-03T10:00:00' }
    ];
    const r = AI.auditBills(anomalyBills, MEMBERS);
    eq('检出异常大额', r.issues.filter(x => x.type === 'anomaly').length, 1);
  }
  {
    const r = AI.auditBills([{ _id: 'b1', amount: 500, description: '杂项', category: 'other', createdAt: '2024-10-01T10:00:00' }], MEMBERS);
    eq('检出漏归类', r.issues.filter(x => x.type === 'uncategorized').length, 1);
  }
  {
    const cleanBills = [
      { _id: 'b1', amount: 320, description: '晚餐', category: 'food', splits: [{ amount: 160 }, { amount: 160 }], createdAt: '2024-10-01T10:00:00' },
      { _id: 'b2', amount: 450, description: '打车', category: 'transport', splits: [{ amount: 225 }, { amount: 225 }], createdAt: '2024-10-02T10:00:00' }
    ];
    const r = AI.auditBills(cleanBills, MEMBERS);
    eq('干净账目0问题', r.issues.length, 0);
    eq('健康度100', r.score, 100);
    ok('摘要含审计通过', r.summary.indexOf('审计通过') !== -1);
  }

  console.log('\n—— 5. 预算管理（会算账）——');
  {
    const bills = [
      { amount: 600, createdAt: '2024-10-01T10:00:00' },
      { amount: 400, createdAt: '2024-10-02T10:00:00' }
    ];
    const b = AI.budgetStatus(bills, MEMBERS, 2000, { days: 2, totalDays: 4 });
    eq('已花1000', b.spent, 1000);
    eq('剩余1000', b.remaining, 1000);
    eq('进度50%', b.percent, 50);
    eq('日均500', b.dailyAvg, 500);
    eq('全程预测2000', b.forecast, 2000);
    eq('不超支', b.willExceed, false);
    eq('预警=ok', b.alert, 'ok');
    eq('人均预算500', b.perPersonBudget, 500);
    ok('含建议', b.tips.length > 0);
  }
  {
    const bills = [
      { amount: 1000, createdAt: '2024-10-01T10:00:00' },
      { amount: 800, createdAt: '2024-10-02T10:00:00' }
    ];
    const b = AI.budgetStatus(bills, MEMBERS, 2000, { days: 2, totalDays: 4 });
    eq('预测超支', b.willExceed, true);
    eq('预警=warn', b.alert, 'warn');
    ok('给出安全日均', b.safeDaily > 0 && b.tips.some(t => t.indexOf('控制在') !== -1));
  }
  {
    const bills = [{ amount: 2200, createdAt: '2024-10-01T10:00:00' }];
    const b = AI.budgetStatus(bills, MEMBERS, 2000, { days: 1, totalDays: 3 });
    eq('预算花超→danger', b.alert, 'danger');
    eq('进度110%', b.percent, 110);
  }
  {
    const b = AI.budgetStatus([], MEMBERS, 0, { days: 1, totalDays: 3 });
    ok('未设预算提示', b.tips[0].indexOf('尚未设置') !== -1);
  }
  {
    const bills = [{ amount: 100, createdAt: '2024-10-01T10:00:00' }];
    const b = AI.budgetStatus(bills, MEMBERS, 1000, {
      room: { startDate: '2024-10-01', endDate: '2024-10-07' }, days: 1
    });
    eq('房间日期推算总天数7', b.totalDays, 7);
  }

  console.log('\n—— 6. 每日消费分析（会复盘）——');
  {
    const bills = [
      { amount: 100, category: 'food', createdAt: '2024-10-01T10:00:00' },
      { amount: 100, category: 'transport', createdAt: '2024-10-01T20:00:00' },
      { amount: 200, category: 'food', createdAt: '2024-10-02T10:00:00' },
      { amount: 1000, category: 'hotel', createdAt: '2024-10-03T10:00:00' }
    ];
    const d = AI.dailyStats(bills);
    eq('3个自然日', d.days.length, 3);
    eq('首日2笔200', d.days[0].total, 200);
    eq('最贵一天=10-03', d.maxDay.date, '2024-10-03');
    eq('总额1400', d.total, 1400);
    ok('日均>0', d.dailyAvg > 0);
    ok('分类聚合含hotel', d.byCategory.hotel === 1000);
    ok('趋势向上', d.trend === 'up');
    ok('带星期', d.days[0].weekday.indexOf('周') === 0);
  }

  console.log('\n—— 7. LLM 双轨工程化 ——');
  {
    const prompt = AI.buildLLMPrompt('打车86块', MEMBERS, '小明');
    ok('prompt含few-shot', prompt.indexOf('示例1') !== -1);
    ok('prompt含成员列表', prompt.indexOf('小红') !== -1);
    ok('prompt含输入句', prompt.indexOf('打车86块') !== -1);
  }
  eq('JSON修复：code fence+尾逗号', AI.repairJSON('```json\n{"amount": 66,}\n```'), { amount: 66 });
  eq('JSON修复：中文标点', AI.repairJSON('{"amount"：66，"description"："晚饭"}'), { amount: 66, description: '晚饭' });
  eq('JSON修复：夹带解释文字', AI.repairJSON('好的，解析如下：{"amount": 88} 希望有帮助'), { amount: 88 });
  eq('JSON修复：单引号属性', AI.repairJSON("{'amount': 99, 'description': '午饭'}"), { amount: 99, description: '午饭' });
  eq('JSON修复：无法修复返回null', AI.repairJSON('这根本不是JSON'), null);
  {
    const rule = AI.parseBillText('打车86块', MEMBERS, { meName: '小明' });
    const merged = AI.mergeParse(rule, JSON.stringify({ amount: 86, description: 'LLM说明' }), MEMBERS);
    eq('融合：LLM字段生效', merged.description, 'LLM说明');
    eq('融合：rule字段保留', merged.category, 'transport');
    eq('融合：source=llm', merged.source, 'llm');
    eq('融合：坏JSON→null', AI.mergeParse(rule, '这不是JSON', MEMBERS), null);
  }
  {
    const r = await AI.parseWithLLM('xx', MEMBERS, {
      meName: '小明',
      llmCall: async () => '```json\n{"amount": 66, "category": "food", "description": "LLM解析",}\n```'
    });
    eq('脏JSON也能解析', r.amount, 66);
    eq('source=llm', r.source, 'llm');
    const r2 = await AI.parseWithLLM('打车86块', MEMBERS, {
      llmCall: async () => '抱歉我无法解析'
    });
    eq('LLM胡说→回退规则', r2.source, 'rule');
    eq('回退后金额可用', r2.amount, 86);
    const r3 = await AI.parseWithLLM('xx', MEMBERS, {
      llmCall: async () => JSON.stringify({ amount: 66, splitWith: ['小红'], payerName: '小红' })
    });
    eq('LLM分摊对象映射id', r3.splitWith, ['user_2']);
    eq('LLM付款人映射id', r3.payerId, 'user_2');
  }

  console.log('\n—— 8. 旅行消费小作文 ——');
  {
    const ctx = {
      room: { name: '国庆东京行', destination: '东京', startDate: '2024-10-01', endDate: '2024-10-07' },
      members: MEMBERS,
      bills: [
        { amount: 3200, category: 'hotel', description: '酒店4晚', payerName: '小明', createdAt: '2024-10-01T10:00:00', splits: [{ memberId: 'u1', amount: 3200 }] },
        { amount: 680, category: 'food', description: '晚餐', payerName: '小明', createdAt: '2024-10-02T10:00:00', splits: [{ memberId: 'u1', amount: 680 }] }
      ]
    };
    const n = await AI.generateNarrative(ctx);
    ok('模板小作文含总额', n.indexOf('3880.00') !== -1);
    ok('模板小作文含建议', n.indexOf('建议') !== -1);
    const n2 = await AI.generateNarrative(ctx, { llmCall: async () => '这趟东京行花得值，人均不到一千，下次记得提前订酒店更便宜！' });
    ok('LLM小作文生效', n2.indexOf('东京行') !== -1);
  }

  console.log('\n—— 9. 携程订单导入（会读单）——');
  {
    const o = CTRIP.parseOrderText(CTRIP.CTrip_SAMPLES[0].text);
    eq('识别机票', o.type, 'flight');
    eq('金额6240', o.amount, 6240);
    eq('订单号', o.orderNo, '1034567890');
    eq('出行人4人', o.travelers.length, 4);
    ok('置信度高', o.confidence >= 80);
  }
  {
    const o = CTRIP.parseOrderText(CTRIP.CTrip_SAMPLES[1].text);
    eq('识别酒店', o.type, 'hotel');
    eq('金额3200', o.amount, 3200);
    eq('入住日期', o.date, '2024-10-01');
    ok('标题含酒店名', o.title.indexOf('新宿') !== -1);
  }
  {
    const o = CTRIP.parseOrderText(CTRIP.CTrip_SAMPLES[2].text);
    eq('识别门票', o.type, 'ticket');
    eq('金额2800', o.amount, 2800);
    eq('游玩日期', o.date, '2024-10-04');
    eq('币种CNY', o.currency, 'CNY');
  }
  {
    const o = CTRIP.parseOrderText('随便一段没有金额的文本');
    eq('无金额→needManual', o.needManual, true);
  }
  {
    const bill = CTRIP.orderToBill(CTRIP.parseOrderText(CTRIP.CTrip_SAMPLES[0].text), MEMBERS, { payerId: 'user_1' });
    eq('订单→分类transport', bill.category, 'transport');
    eq('订单→付款人user_1', bill.payer, 'user_1');
    eq('订单→均分4人', bill.splits.length, 4);
    eq('订单→分摊账平', bill.splits.reduce((s, x) => s + x.amount, 0), 6240);
    eq('订单→每人1560', bill.splits[0].amount, 1560);
    ok('订单→来源ctrip', bill.source === 'ctrip');
    eq('订单→快照折算', bill.cnyAmount, 6240);
    ok('订单号留痕', bill.orderNo === '1034567890');
  }
  {
    const combined = CTRIP.CTrip_SAMPLES.map(s => s.text).join('\n\n');
    const bills = CTRIP.importOrders(combined, MEMBERS, { payerId: 'user_1' });
    eq('批量导入3笔', bills.length, 3);
    eq('批量导入金额合计', bills.reduce((s, b) => s + b.amount, 0), 12240);
    ok('分类映射齐全', bills.map(b => b.category).join(',') === 'transport,hotel,ticket');
    const orders = CTRIP.parseOrders(combined);
    eq('批量解析3单', orders.length, 3);
  }

  /* ============================================================
     边界回归（探针找出来的真实问题，逐条钉住）
     ============================================================ */
  console.log('\n—— Z 边界回归：安全日期 / 中文小数 / 千分位 / 口径一致 ——');

  /* Z1. toIsoSafe：非法日期绝不能抛（模型输出/用户输入都可能给这类值） */
  {
    ok('toIsoSafe 存在', typeof AI.toIsoSafe === 'function');
    const bad = ['2024年10月1日', '', null, undefined, '待定', 'abc', {}, NaN];
    let threw = 0;
    bad.forEach((v) => {
      try { AI.toIsoSafe(v); } catch (e) { threw++; }
    });
    ok('★ toIsoSafe 对 8 种非法值都不抛异常', threw === 0, threw + ' 次抛异常');
    ok('toIsoSafe 能认「2024年10月1日」', AI.toIsoSafe('2024年10月1日').slice(0, 10) === '2024-10-01',
      AI.toIsoSafe('2024年10月1日'));
    ok('toIsoSafe 保留合法 ISO', AI.toIsoSafe('2024-10-01T09:00:00.000Z').slice(0, 10) === '2024-10-01');
    /* 原生行为对照：确认这个 helper 确实在解决真实问题 */
    let nativeThrew = false;
    try { new Date('2024年10月1日').toISOString(); } catch (e) { nativeThrew = true; }
    ok('（对照）原生 new Date(中文日期).toISOString() 会抛', nativeThrew);
  }

  /* Z2. 中文小数点：曾经错 24 倍 */
  {
    eq('中文小数「一百二十三点五」', AI.cnNumToNumber('一百二十三点五'), 123.5);
    eq('中文小数「三点五」', AI.cnNumToNumber('三点五'), 3.5);
    const p = AI.parseBillText('一百二十三点五元', MEMBERS, { meName: '小明' });
    eq('★ 「一百二十三点五元」= 123.5（曾错成 5）', p.amount, 123.5);
    eq('「一百二十三块」仍是 123（没被改坏）', AI.parseBillText('一百二十三块', MEMBERS, { meName: '小明' }).amount, 123);
    eq('「三百二十八」仍是 328', AI.parseBillText('三百二十八', MEMBERS, { meName: '小明' }).amount, 328);
    ok('口语「一百五」仍是 150', AI.parseBillText('一百五', MEMBERS, { meName: '小明' }).amount === 150);
    /* 「点」也是量词（3点/8点），别把时间当金额 */
    ok('「下午三点开会花了200」取 200（不是 3）',
      AI.parseBillText('下午三点开会花了200', MEMBERS, { meName: '小明' }).amount === 200);
  }

  /* Z3. 千分位：多点写法不能截成 1.23 */
  {
    eq('「1.234.567」按千分位解析', AI.parseBillText('花了1.234.567元', MEMBERS, { meName: '小明' }).amount, 1234567);
    eq('「12,345.678」仍按逗号千分位', AI.parseBillText('12,345.678', MEMBERS, { meName: '小明' }).amount, 12345.67);
    eq('「¥1,234.56」仍正确', AI.parseBillText('午饭 ¥1,234.56', MEMBERS, { meName: '小明' }).amount, 1234.56);
  }

  /* Z4. 抹零不能把账单抹成 0（否则落库就是 0 元单，还会被结算排除） */
  {
    const r = AI.smartRound(0.4, 'CNY');
    ok('★ smartRound(0.4) 不抹成 0', r.rounded === 0.4 && r.changed === false, JSON.stringify(r));
    ok('smartRound(12780,JPY) 仍抹到 12800', AI.smartRound(12780, 'JPY').rounded === 12800);
    ok('smartRound(0) 不变', AI.smartRound(0, 'CNY').rounded === 0);
  }

  console.log('\n========================================');
  console.log('V2 通过 ' + passed + ' 项，失败 ' + failed + ' 项');
  console.log('========================================');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
