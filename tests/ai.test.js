/**
 * AI 引擎单元测试：node tests/ai.test.js
 */
const AI = require('../apps/miniprogram/utils/ai.js');

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
const OPT = { meName: '小明' };

console.log('\n—— 1. 均分尾差（最大余额法）——');
{
  const s = AI.allocateEvenly(100, 3);
  eq('100元3人分摊合计=100', s.reduce((a, b) => a + b, 0).toFixed(2), '100.00');
  eq('100元3人分摊', s, [33.34, 33.33, 33.33]);
  const s2 = AI.allocateEvenly(0.1, 3);
  eq('0.1元3人分摊合计=0.1', s2.reduce((a, b) => a + b, 0).toFixed(2), '0.10');
  const s3 = AI.allocateEvenly(1, 7);
  eq('1元7人分摊合计=1', s3.reduce((a, b) => a + b, 0).toFixed(2), '1.00');
  const s4 = AI.allocateEvenly(1270.5, 4);
  eq('1270.5元4人分摊合计', s4.reduce((a, b) => a + b, 0).toFixed(2), '1270.50');
  eq('0人分摊', AI.allocateEvenly(10, 0), []);
}

console.log('\n—— 2. 智能分类 ——');
eq('打车→transport', AI.classifyExpense('打车去机场').category, 'transport');
eq('居酒屋→food', AI.classifyExpense('居酒屋聚餐').category, 'food');
eq('民宿→hotel', AI.classifyExpense('西湖边民宿').category, 'hotel');
eq('迪士尼门票→ticket', AI.classifyExpense('迪士尼门票').category, 'ticket');
eq('药妆店扫货→shopping', AI.classifyExpense('药妆店扫货').category, 'shopping');
eq('无关键词→other', AI.classifyExpense('杂项支出xyz').category, 'other');

console.log('\n—— 3. 自然语言记账解析 ——');
{
  const p = AI.parseBillText('打车去机场86块，我垫的，和小红小李平分', MEMBERS, OPT);
  eq('金额86', p.amount, 86);
  eq('分类transport', p.category, 'transport');
  eq('付款人=我(小明)', p.payerName, '小明');
  eq('分摊=均分', p.splitType, 'equal');
  eq('分摊对象=小明+小红+小李', p.splitWith, ['user_1', 'user_2', 'user_3']);
  eq('币种CNY', p.currency, 'CNY');
  ok('置信度>=80', p.confidence >= 80);
  ok('说明含打车', p.description.indexOf('打车') !== -1);
}
{
  const p = AI.parseBillText('昨天晚饭花了328，我先垫的，跟小红小李平分', MEMBERS, OPT);
  eq('金额328', p.amount, 328);
  eq('分类food', p.category, 'food');
  eq('付款人小明', p.payerName, '小明');
  eq('均分3人', p.splitWith.length, 3);
}
{
  const p = AI.parseBillText('小红请客吃居酒屋520', MEMBERS, OPT);
  eq('请客→treat', p.splitType, 'treat');
  eq('付款人小红', p.payerName, '小红');
  eq('金额520', p.amount, 520);
}
{
  const p = AI.parseBillText('¥128.5 银座购物午餐 小明付的', MEMBERS, OPT);
  eq('¥128.5', p.amount, 128.5);
  eq('付款人小明', p.payerName, '小明');
}
{
  const p = AI.parseBillText('迪士尼门票2800，小王付的，四个人AA', MEMBERS, OPT);
  eq('金额2800', p.amount, 2800);
  eq('分类ticket', p.category, 'ticket');
  eq('付款人小王', p.payerName, '小王');
  eq('均分', p.splitType, 'equal');
  eq('四人平分', p.splitWith.length, 4);
}
{
  const p = AI.parseBillText('3个人240的高铁票，我出的', MEMBERS, OPT);
  eq('"3个人240"取金额240', p.amount, 240);
  eq('分类transport', p.category, 'transport');
}
{
  const p = AI.parseBillText('药妆店扫货花了12000日元', MEMBERS, OPT);
  eq('金额12000', p.amount, 12000);
  eq('币种JPY', p.currency, 'JPY');
  ok('折算人民币>0', p.cnyAmount > 0);
}
{
  const p = AI.parseBillText('今天买了些纪念品', MEMBERS, OPT);
  eq('无金额→needManual', p.needManual, true);
  eq('无金额→success=false', p.success, false);
}
{
  const p = AI.parseBillText('实付¥328.00 海底捞火锅 小李付款 全员平分', MEMBERS, OPT);
  eq('实付金额328', p.amount, 328);
  eq('分类food', p.category, 'food');
  eq('付款人小李', p.payerName, '小李');
}

console.log('\n—— 4. 分摊明细生成 ——');
{
  const p = AI.parseBillText('晚饭100块，我付的，三个人平分', MEMBERS, OPT);
  const splits = AI.buildSplits(p, MEMBERS);
  eq('100元3人合计=100', splits.reduce((s, x) => s + x.amount, 0).toFixed(2), '100.00');
  eq('参与人数=3', splits.filter(s => s.amount > 0).length, 3);
}
{
  const p = AI.parseBillText('小红请客吃火锅800', MEMBERS, OPT);
  const splits = AI.buildSplits(p, MEMBERS);
  eq('请客：小红全额承担', splits.find(s => s.memberId === 'user_2').amount, 800);
  eq('请客：其他人0', splits.filter(s => s.memberId !== 'user_2').reduce((s, x) => s + x.amount, 0), 0);
}
{
  // 边界：100 元 3 人均分必须账平
  const p = { amount: 100, splitType: 'equal', splitWith: ['user_1', 'user_2', 'user_3'], payerId: 'user_1' };
  const splits = AI.buildSplits(p, MEMBERS);
  eq('尾差修复后账平', splits.reduce((s, x) => s + x.amount, 0).toFixed(2), '100.00');
}

console.log('\n—— 5. AI 消费洞察 & 报告 ——');
{
  const bills = [
    { amount: 3200, category: 'hotel', payerName: '小明', description: '酒店4晚' },
    { amount: 680, category: 'food', payerName: '小明', description: '晚餐' },
    { amount: 2800, category: 'ticket', payerName: '小王', description: '迪士尼门票' },
    { amount: 450, category: 'transport', payerName: '小李', description: '地铁+出租车' }
  ];
  const insight = AI.generateInsight({
    room: { name: '国庆东京行', destination: '东京', startDate: '2024-10-01', endDate: '2024-10-07' },
    bills, members: MEMBERS
  });
  eq('总额7130', insight.total, 7130);
  eq('人均1782.5', insight.perPerson, 1782.5);
  eq('天数7', insight.days, 7);
  eq('TOP分类hotel', insight.topCategory.id, 'hotel');
  ok('建议非空', insight.tips.length > 0);
  ok('摘要含总额', insight.summary.indexOf('7130.00') !== -1);
  const report = AI.generateTripReport(
    { name: '国庆东京行', destination: '东京', startDate: '2024-10-01', endDate: '2024-10-07' }, bills, MEMBERS);
  ok('报告含结算建议', report.indexOf('AI 建议') !== -1);
  ok('报告含人均', report.indexOf('人均') !== -1);
}

console.log('\n—— 6. LLM 双轨回退 ——');
(async () => {
  const r1 = await AI.parseWithLLM('打车86块我付的', MEMBERS, { meName: '小明' });
  eq('无LLM→回退规则引擎', r1.source, 'rule');
  eq('回退结果可用', r1.amount, 86);
  const r2 = await AI.parseWithLLM('xx', MEMBERS, {
    llmCall: async () => JSON.stringify({ amount: 66, category: 'food', description: 'LLM解析' })
  });
  eq('LLM可用→source=llm', r2.source, 'llm');
  eq('LLM结果生效', r2.amount, 66);
  const r3 = await AI.parseWithLLM('打车86块', MEMBERS, {
    llmCall: async () => { throw new Error('network down'); }
  });
  eq('LLM失败→自动回退', r3.source, 'rule');

  console.log('\n========================================');
  console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
  console.log('========================================');
  process.exit(failed > 0 ? 1 : 0);
})();
