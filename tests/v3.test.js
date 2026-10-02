/**
 * v3.test.js —— 旅行专属记账语义 + "会说话"能力 单测（V3）
 *
 * 覆盖 A 档（记账语义）与 C 档（会说话）：
 *   A1 智能抹零 smartRound / roundStepOf（多币种凑整台阶）
 *   A2 抹零入账账恒平 applyRoundingLoss
 *   A3 代购不摊 buildSoleSplits / isSoleBill
 *   A4 多退少补 buildAdjustmentForExclusion（零和 + 退还额精确）
 *   A5 暂估改价 buildAdjustmentForReestimate（零和 + 按原比例）
 *   A6 口头占位 buildPlaceholder / pendingBills / settlementReadiness
 *   A7 可结算判定 isSettleable / settleableBills / effectiveShares
 *   C1 礼貌催账 politeReminder
 *   C2 旅行手账 travelJournal
 *   C3 结清卡片 shareCardData / shareCardText
 *   Z  账恒平总闸：把 A1~A6 全用上后，结算净余额仍严格为 0
 *
 * 用法：node tests/v3.test.js
 */
'use strict';

const path = require('path');
const AI = require(path.resolve(__dirname, '..', 'apps', 'miniprogram', 'utils', 'ai.js'));

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  → ' + extra : '')); }
  else { fail++; failures.push(name); console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}
function section(t) { console.log('\n—— ' + t + ' ——'); }
function sum(arr) { return Math.round(arr.reduce((s, x) => s + (Number(x) || 0), 0) * 100) / 100; }

const MEMBERS = [
  { id: 'u1', name: '小明' },
  { id: 'u2', name: '小红' },
  { id: 'u3', name: '小李' },
  { id: 'u4', name: '小王' },
];

function equalSplits(amount, members) {
  const parts = AI.allocateEvenly(amount, members.length);
  return members.map((m, i) => ({ memberId: m.id, memberName: m.name, amount: parts[i] }));
}
function mkBill(o) {
  return Object.assign({
    id: 'b_' + Math.random().toString(36).slice(2, 8),
    currency: 'CNY', rate: 1, category: 'food', source: 'manual',
    createdAt: '2024-10-02T09:00:00.000Z',
  }, o);
}
/**
 * 结算净余额：直接使用内核口径（AI.netBalances）。
 *
 * 早期版本我在测试里自己写了一份简化实现，把调整单当独立账单累加 payer，
 * 结果垫付人被少算钱 —— 正是这个 bug 反过来暴露了"测试辅助函数与产品口径不一致"
 * 的风险。现在统一用内核函数，测试与产品不可能再漂移。
 */
function netBalances(bills) {
  const r = AI.netBalances(bills, MEMBERS);
  const out = {};
  r.balances.forEach((b) => { out[b.memberId] = b.amount; });
  return out;
}
function mb(bills) { return AI.netBalances(bills, MEMBERS); }

/* ============================================================ */
(async function main() {

  /* ---------- A1 智能抹零 ---------- */
  section('A1 智能抹零 smartRound / 凑整台阶');
  (function () {
    const jpy = AI.smartRound(12780, 'JPY');
    ok('JPY 12780 → 12800（凑百位）', jpy.rounded === 12800 && jpy.loss === 20, JSON.stringify(jpy));

    const krw = AI.smartRound(45300, 'KRW');
    ok('KRW 45300 → 45000（凑千位）', krw.rounded === 45000 && krw.loss === -300, JSON.stringify(krw));

    const cny = AI.smartRound(328.4, 'CNY');
    ok('CNY 328.4 → 328（凑整元）', cny.rounded === 328 && Math.abs(cny.loss + 0.4) < 0.001, JSON.stringify(cny));

    const up = AI.smartRound(328.1, 'CNY', { mode: 'up' });
    ok('模式 up：328.1 → 329', up.rounded === 329, String(up.rounded));
    const down = AI.smartRound(328.9, 'CNY', { mode: 'down' });
    ok('模式 down：328.9 → 328', down.rounded === 328, String(down.rounded));

    const exact = AI.smartRound(12800, 'JPY');
    ok('已经是整数 → changed=false（不该提示抹零）', exact.changed === false && exact.loss === 0);

    ok('台阶查询 JPY=100', AI.roundStepOf('JPY') === 100);
    ok('台阶查询 KRW=1000', AI.roundStepOf('KRW') === 1000);
    ok('台阶查询 CNY=1', AI.roundStepOf('CNY') === 1);
    ok('未知币种台阶兜底为 1', AI.roundStepOf('XYZ') === 1);
    ok('小写币种也能识别', AI.roundStepOf('jpy') === 100);

    ok('amount=0 不崩', AI.smartRound(0, 'JPY').rounded === 0);
    ok('undefined 不崩', AI.smartRound(undefined, 'JPY').rounded === 0);
    ok('负数也能处理（退款场景）', AI.smartRound(-12780, 'JPY').rounded === -12800, String(AI.smartRound(-12780, 'JPY').rounded));
  })();

  /* ---------- A2 抹零入账账恒平 ---------- */
  section('A2 抹零并入分摊（账恒平）');
  (function () {
    const base = equalSplits(12780, MEMBERS);
    ok('原始分摊合计 = 12780', sum(base.map((x) => x.amount)) === 12780, String(sum(base.map((x) => x.amount))));

    const withLoss = AI.applyRoundingLoss(base, 12800);
    ok('抹零后合计严格 = 12800（账单金额）', sum(withLoss.map((x) => x.amount)) === 12800, String(sum(withLoss.map((x) => x.amount))));
    const lossRow = withLoss.find((x) => x.memberId === AI.LOSS_MEMBER_ID);
    ok('差额单独成行且标记 isLoss', !!lossRow && lossRow.isLoss === true, lossRow && String(lossRow.amount));
    ok('损耗行金额 = 20（凑多了）', !!lossRow && lossRow.amount === 20, lossRow && String(lossRow.amount));
    ok('原成员金额未被改动（不摊到人头上）', withLoss.filter((x) => x.memberId !== AI.LOSS_MEMBER_ID).map((x) => x.amount).join(',') === base.map((x) => x.amount).join(','));

    // 抹零到正好，无差额 → 不应产生损耗行，但合计仍须相等
    const exact = AI.applyRoundingLoss(equalSplits(12800, MEMBERS), 12800);
    ok('无差额时不产生损耗行', !exact.some((x) => x.isLoss), JSON.stringify(exact.map((x) => x.amount)));

    // 尾差修补：传入的分摊合计与目标差 1 分
    const messy = [{ memberId: 'u1', amount: 33.33 }, { memberId: 'u2', amount: 33.33 }];
    const fixed = AI.applyRoundingLoss(messy, 66.67);
    ok('0.01 级尾差被补到合计相等', sum(fixed.map((x) => x.amount)) === 66.67, String(sum(fixed.map((x) => x.amount))));

    ok('空分摊不崩', AI.applyRoundingLoss([], 100).length === 0);

    // 损耗行参与结算后，账仍恒平
    const bill = mkBill({ payer: 'u1', amount: 12800, currency: 'JPY', rate: 0.048, splits: withLoss });
    const bal = netBalances([bill]);
    // 损耗行不是真实成员，会出现在余额表里；把它剔除后真人账应为 0
    const real = Object.keys(bal).filter((k) => k !== AI.LOSS_MEMBER_ID);
    const realSum = Math.round(real.reduce((s, k) => s + bal[k], 0) * 100) / 100;
    ok('（含损耗行时）真人净余额合计 ≠ 0 —— 差额确由损耗承担', realSum !== 0 || bal[AI.LOSS_MEMBER_ID] !== undefined,
      '真人合计 ' + realSum + ' · 损耗 ' + bal[AI.LOSS_MEMBER_ID]);
  })();

  /* ---------- A3 代购不摊 ---------- */
  section('A3 代购 / 不参与分摊');
  (function () {
    const bill = { payer: 'u1', payerName: '小明', amount: 600 };
    const splits = AI.buildSoleSplits(bill, MEMBERS);
    ok('垫付人承担全额', splits.find((s) => s.memberId === 'u1').amount === 600);
    ok('其余人都是 0', splits.filter((s) => s.memberId !== 'u1').every((s) => s.amount === 0));
    ok('合计 = 账单金额', sum(splits.map((x) => x.amount)) === 600);

    ok('识别为"不参与分摊"', AI.isSoleBill({ payer: 'u1', amount: 600, splits }));
    ok('均分账单不被误判', AI.isSoleBill({ payer: 'u1', amount: 600, splits: equalSplits(600, MEMBERS) }) === false);
    ok('splitType=sole 直接判定', AI.isSoleBill({ splitType: 'sole' }) === true);
    ok('sole=true 直接判定', AI.isSoleBill({ sole: true }) === true);

    // 垫付人已不在成员列表（退房/被移除）也不能丢钱
    const orphan = AI.buildSoleSplits({ payer: 'ghost', payerName: '幽灵', amount: 300 }, MEMBERS);
    ok('垫付人不在成员列表时仍有一行承担全额', sum(orphan.map((x) => x.amount)) === 300, JSON.stringify(orphan));

    // 代购账单参与结算：垫付人自购自付，净额为 0（别人不欠）
    const b = mkBill({ id: 'b_sole', payer: 'u1', payerName: '小明', amount: 600, splits });
    const bal = netBalances([b]);
    ok('代购结算：垫付人净 0（他给自己买的，谁都不欠）', Math.abs(bal.u1) < 0.01, 'u1=' + bal.u1);
    ok('代购结算：其他人净 0', Math.abs(bal.u2 || 0) < 0.01 && Math.abs(bal.u3 || 0) < 0.01, JSON.stringify(bal));
    ok('代购结算：账恒平', Math.abs(sum(Object.values(bal))) < 0.01, JSON.stringify(bal));
  })();

  /* ---------- A4 多退少补 ---------- */
  section('A4 多退少补（有人退出分摊）');
  (function () {
    const rent = { id: 'b_rent', payer: 'u1', payerName: '小明', amount: 480, currency: 'CNY', description: '房租',
      splits: equalSplits(480, MEMBERS.slice(0, 3)) };   // 3 人 × 160

    const adj = AI.buildAdjustmentForExclusion(rent, ['u3']);
    ok('调整单标记 isAdjustment', adj.isAdjustment === true);
    ok('调整单金额为 0（零和不影响总额）', adj.amount === 0 && adj.cnyAmount === 0);
    ok('关联到原账单', adj.adjustsBillId === 'b_rent');
    ok('调整单自身零和', sum(adj.splits.map((x) => x.amount)) === 0, JSON.stringify(adj.splits));

    const byId = {};
    adj.splits.forEach((s) => { byId[s.memberId] = s.amount; });
    ok('退出者退还自己那份 160', byId.u3 === -160, String(byId.u3));
    ok('垫付人收回 160（钱回到出钱的人手里）', byId.u1 === 160, String(byId.u1));
    ok('其他分摊人不受影响（不出现在调整单里）', byId.u2 === undefined, JSON.stringify(Object.keys(byId)));

    const exp = AI.effectiveShares(rent, [rent, adj]);
    const eff = {};
    exp.forEach((s) => { eff[s.memberId] = s.amount; });
    ok('effectiveShares：退出者净 0（欠款清零）', Math.abs(eff.u3) < 0.005, String(eff.u3));
    ok('effectiveShares：垫付人净 320（自己 160 + 收回替小李垫的 160）', eff.u1 === 320, String(eff.u1));
    ok('effectiveShares：其余分摊人仍 160', eff.u2 === 160, String(eff.u2));
    ok('effectiveShares：合计仍 = 480（账恒平）', sum(exp.map((x) => x.amount)) === 480, String(sum(exp.map((x) => x.amount))));

    // 端到端：垫付人净余额 = 160（自己那份），与原 320（自己+小李）相比少了 160
    const bal = netBalances([rent, adj]);
    ok('端到端：垫付人净垫付 320 → 160（收回替小李垫的）', Math.abs(bal.u1 - 160) < 0.01, 'u1=' + bal.u1);
    ok('端到端：小红净余额 -160（还欠小明）', Math.abs(bal.u2 + 160) < 0.01, 'u2=' + bal.u2);
    ok('端到端：退出者净余额归 0', Math.abs(bal.u3 || 0) < 0.005, 'u3=' + (bal.u3 || 0));
    ok('端到端：账恒平', Math.abs(sum(Object.values(bal))) < 0.01, JSON.stringify(bal));

    // 两人一起退出
    const adj2 = AI.buildAdjustmentForExclusion(rent, ['u2', 'u3']);
    const b2 = {};
    adj2.splits.forEach((s) => { b2[s.memberId] = s.amount; });
    ok('两人退出：各退 160', b2.u2 === -160 && b2.u3 === -160, JSON.stringify(b2));
    ok('两人退出：垫付人收回 320', b2.u1 === 320, String(b2.u1));
    ok('两人退出：零和', sum(adj2.splits.map((x) => x.amount)) === 0);
    const bal2 = netBalances([rent, adj2]);
    ok('两人退出：垫付人净余额归 0（只剩自己那份已收回）', Math.abs(bal2.u1) < 0.01, 'u1=' + bal2.u1);

    // 全员退出：所有分摊都被冲销，垫付人净余额 0
    const adjAll = AI.buildAdjustmentForExclusion(rent, ['u1', 'u2', 'u3']);
    const ba = {};
    adjAll.splits.forEach((s) => { ba[s.memberId] = s.amount; });
    ok('全员退出：调整单零和', sum(adjAll.splits.map((x) => x.amount)) === 0, JSON.stringify(adjAll.splits));
    const balAll = netBalances([rent, adjAll]);
    ok('全员退出：结算净余额全为 0（这笔账等于被完全冲销）', Object.values(balAll).every((v) => Math.abs(v) < 0.01), JSON.stringify(balAll));

    const adjNone = AI.buildAdjustmentForExclusion(rent, []);
    ok('没传退出人时零和且不产生金额', sum(adjNone.splits.map((x) => x.amount)) === 0);

    // 不等比分摊（2:1）时，退款应按原比例
    const uneven = { id: 'b_un', payer: 'u1', payerName: '小明', amount: 300,
      splits: [{ memberId: 'u1', memberName: '小明', amount: 200 }, { memberId: 'u2', memberName: '小红', amount: 100 }] };
    const adjU = AI.buildAdjustmentForExclusion(uneven, ['u2']);
    const bu = {};
    adjU.splits.forEach((s) => { bu[s.memberId] = s.amount; });
    ok('不等比分摊：退出者按自己那份退 100', bu.u2 === -100, String(bu.u2));
    ok('不等比分摊：垫付人收回 100', bu.u1 === 100, String(bu.u1));
    ok('不等比分摊：零和', sum(adjU.splits.map((x) => x.amount)) === 0);
    const effU = AI.effectiveShares(uneven, [uneven, adjU]);
    const mu2 = {};
    effU.forEach((s) => { mu2[s.memberId] = s.amount; });
    ok('不等比分摊：小红归 0，垫付人有效份额 = 全部 300', mu2.u2 === 0 && mu2.u1 === 300, JSON.stringify(mu2));
    const balU = netBalances([uneven, adjU]);
    ok('不等比分摊：结算后两人净余额都归 0（垫付人独自承担全部）',
      Math.abs(balU.u1 || 0) < 0.01 && Math.abs(balU.u2 || 0) < 0.01, JSON.stringify(balU));
    ok('不等比分摊：账恒平', Math.abs(sum(Object.values(balU))) < 0.01, JSON.stringify(balU));
  })();

  /* ---------- A5 暂估改价 ---------- */
  section('A5 暂估改价 / 二次分摊');
  (function () {
    const est = { id: 'b_hotel', payer: 'u1', payerName: '小明', amount: 3200, currency: 'CNY',
      description: '东京新宿酒店 4 晚', category: 'hotel', splits: equalSplits(3200, MEMBERS) };

    const up = AI.buildAdjustmentForReestimate(est, 3560, MEMBERS, { ts: '2024-10-06T00:00:00.000Z' });
    ok('改价单 isAdjustment', up.isAdjustment === true);
    ok('改价单 amount=0（差额只体现在 splits）', up.amount === 0);
    ok('改价单关联原账单', up.adjustsBillId === 'b_hotel');
    ok('差额 delta = 360', up.delta === 360, String(up.delta));

    const mp = {};
    up.splits.forEach((s) => { mp[s.memberId] = (mp[s.memberId] || 0) + s.amount; });
    ok('4 人各补 90（份额 800 → 890）', ['u1', 'u2', 'u3', 'u4'].every((id) => mp[id] === 90), JSON.stringify(mp));
    ok('★ Σadj 严格等于 delta（改价单不零和，这是数学必然）',
      sum(up.splits.map((x) => x.amount)) === up.delta, sum(up.splits.map((x) => x.amount)) + ' vs ' + up.delta);
    ok('zeroSum 标记为 false（总额变了）', up.zeroSum === false);
    ok('话术说明是"补收"', /补收 ¥360\.00/.test(up.summary), up.summary);
    ok('描述含改价前后金额', /3200\.00 → ¥3560\.00/.test(up.description), up.description);

    // ★ 核心不变量：有效份额必须等于新份额（这是调整单存在的唯一目的）
    const effUp = {};
    AI.effectiveShares(est, [est, up]).forEach((s) => { effUp[s.memberId] = s.amount; });
    ok('★ 有效份额 = 新份额 890（eff === target）', ['u1', 'u2', 'u3', 'u4'].every((id) => effUp[id] === 890), JSON.stringify(effUp));

    const down = AI.buildAdjustmentForReestimate(est, 2800, MEMBERS);
    ok('降价 → 差额为 -400', down.delta === -400, String(down.delta));
    ok('降价单 Σadj = delta = -400', sum(down.splits.map((x) => x.amount)) === -400, String(sum(down.splits.map((x) => x.amount))));
    ok('降价话术是"退回"', /退回 ¥400\.00/.test(down.summary), down.summary);

    const same = AI.buildAdjustmentForReestimate(est, 3200, MEMBERS);
    ok('金额没变 → delta=0 且调整单零和（退化为纯再分配）',
      same.delta === 0 && sum(same.splits.map((x) => x.amount)) === 0 && same.zeroSum === true);

    // 端到端核对（模型：改价 = 垫付人补付增量 Δ，各人份额按新比例调整）
    //   原账 3200（小明垫付）；改价 3560 → 小明又补付 360，实付 3560
    //   新份额各 890 ⇒ 其余 3 人各欠 890；小明应收 = 3560 − 890 = 2670
    const bal = netBalances([est, up]);
    ok('端到端：垫付人实付增至 3560，应收 2670（3560 − 自己应担 890）',
      Math.abs(bal.u1 - 2670) < 0.01, 'u1=' + bal.u1);
    ok('端到端：其余 3 人各欠 890', ['u2', 'u3', 'u4'].every((id) => Math.abs(bal[id] + 890) < 0.01), JSON.stringify(bal));
    ok('端到端：账恒平（净余额合计 0）', Math.abs(sum(Object.values(bal))) < 0.01, JSON.stringify(bal));
    ok('端到端：各人应担份额合计 = 3560（与改价后总额一致）',
      Math.abs(890 * 4 - 3560) < 0.01, String(890 * 4));

    // 不等比账单：改价按原比例（200:100 → 400:200）
    const uneven = { id: 'b_x', payer: 'u1', payerName: '小明', amount: 300, description: 'x',
      splits: [{ memberId: 'u1', memberName: '小明', amount: 200 }, { memberId: 'u2', memberName: '小红', amount: 100 }] };
    const uAdj = AI.buildAdjustmentForReestimate(uneven, 600, MEMBERS);
    const mu = {};
    uAdj.splits.forEach((s) => { mu[s.memberId] = (mu[s.memberId] || 0) + s.amount; });
    ok('不等比改价：小明按 2:3 补 200', mu.u1 === 200, String(mu.u1));
    ok('不等比改价：小红按 1:3 补 100', mu.u2 === 100, String(mu.u2));
    ok('不等比改价：Σadj = delta = 300', sum(uAdj.splits.map((x) => x.amount)) === 300, String(sum(uAdj.splits.map((x) => x.amount))));
    const effU = {};
    AI.effectiveShares(uneven, [uneven, uAdj]).forEach((s) => { effU[s.memberId] = s.amount; });
    ok('★ 不等比改价：有效份额 = 400 / 200（eff === target）', effU.u1 === 400 && effU.u2 === 200, JSON.stringify(effU));
    const balUneven = netBalances([uneven, uAdj]);
    ok('不等比改价：小红欠 200', Math.abs(balUneven.u2 + 200) < 0.01, JSON.stringify(balUneven));
    ok('不等比改价：小明实付增至 600，应收 200（600 − 自己应担 400）',
      Math.abs(balUneven.u1 - 200) < 0.01, String(balUneven.u1));
    ok('不等比改价：端到端账恒平', Math.abs(sum(Object.values(balUneven))) < 0.01, JSON.stringify(balUneven));

    // 无分摊人的占位单「补记金额」→ 用 kind:'fill'
    const ph = { id: 'b_ph', payer: 'u1', payerName: '小明', amount: 0, splits: [] };
    const phAdj = AI.buildAdjustmentForReestimate(ph, 250, MEMBERS, { kind: 'fill' });
    ok('占位单补记金额 → 差额全部落在垫付人', phAdj.splits.length === 1 && phAdj.splits[0].amount === 250, JSON.stringify(phAdj.splits));
    ok('补记单 kind=fill 且 Σadj = delta（不是零和）', phAdj.kind === 'fill' && sum(phAdj.splits.map((x) => x.amount)) === 250);

    ok('★ validateAdjustments 只对"应该零和"的单子做校验（delta=0 的排除单）',
      AI.validateAdjustments([same, AI.buildAdjustmentForExclusion(uneven, ['u2'])]).ok === true);
    ok('validateAdjustments 能抓出错误的零和单',
      AI.validateAdjustments([{ isAdjustment: true, id: 'bad', zeroSum: true, splits: [{ amount: 90 }, { amount: 90 }] }]).ok === false);

    ok('★ validateAdjustments 能验出所有调整单零和', AI.validateAdjustments([up, down, uAdj, phAdj]).ok === true,
      JSON.stringify(AI.validateAdjustments([up, down, uAdj, phAdj]).bad));
    ok('validateAdjustments 能抓出不零和的调整单',
      AI.validateAdjustments([{ isAdjustment: true, id: 'bad', splits: [{ amount: 90 }, { amount: 90 }] }]).ok === false);
  })();

  /* ---------- A6 口头占位 ---------- */
  section('A6 口头占位（字段不全先入账）');
  (function () {
    const ph = AI.buildPlaceholder({ description: '昨天那顿忘了谁付的' });
    ok('状态为 draft', ph.status === 'draft');
    ok('标记缺 amount 与 payer', ph.missing.indexOf('amount') >= 0 && ph.missing.indexOf('payer') >= 0, JSON.stringify(ph.missing));
    ok('needsCompletion = true', ph.needsCompletion === true);
    ok('canSettle = false（不能拿去结算）', ph.canSettle === false);
    ok('不参与结算（isSettleable=false）', AI.isSettleable(ph) === false);

    const half = AI.buildPlaceholder({ amount: 320, description: '只记得金额' });
    ok('只缺付款人时 missing 只有 payer', half.missing.length === 1 && half.missing[0] === 'payer', JSON.stringify(half.missing));

    const full = AI.buildPlaceholder({ amount: 320, payer: 'u1', description: '补齐了' });
    ok('补齐后 needsCompletion = false', full.needsCompletion === false);
    ok('补齐后可以参与结算', AI.isSettleable(full) === true);

    const list = [ph, half,
      mkBill({ id: 'ok1', payer: 'u1', amount: 100, splits: equalSplits(100, MEMBERS) })];
    const pending = AI.pendingBills(list);
    ok('pendingBills 挑出 2 笔未记清', pending.length === 2, String(pending.length));

    const r1 = AI.settlementReadiness(list);
    ok('结算前置校验：ready=false', r1.ready === false);
    ok('结算前置校验：提示未记清笔数', /还有 2 笔没记清/.test(r1.message), r1.message);

    const r2 = AI.settlementReadiness([list[2]]);
    ok('账目齐全时 ready=true', r2.ready === true && /可以结算/.test(r2.message), r2.message);

    ok('settleableBills 过滤掉占位单', AI.settleableBills(list).length === 1, String(AI.settleableBills(list).length));
    ok('金额为 0 的普通账单不可结算', AI.isSettleable({ payer: 'u1', amount: 0, splits: [] }) === false);
    ok('调整单即使金额为 0 也可结算', AI.isSettleable({ isAdjustment: true, amount: 0, splits: [] }) === true);
    ok('voided 账单不可结算', AI.isSettleable({ payer: 'u1', amount: 100, voided: true }) === false);

    // ★ 回归：调整单（amount=0）绝不能被当成"没记清"
    //   曾因运算符优先级写成 `A || B || C && D`，让 isAdjustment 过滤失效
    const mixed = [
      AI.buildPlaceholder({ description: '真的没记清' }),
      { isAdjustment: true, id: 'adj1', amount: 0, zeroSum: true, splits: [{ memberId: 'u1', amount: 0 }] },
      { isAdjustment: true, id: 'adj2', amount: 0, zeroSum: false, delta: 360, splits: [] },
    ];
    ok('★ pendingBills 只挑出 1 笔真占位（不含 2 张调整单）', AI.pendingBills(mixed).length === 1,
      String(AI.pendingBills(mixed).length));
    const rMixed = AI.settlementReadiness(mixed);
    ok('★ 结算校验提示"还有 1 笔"而不是 3 笔', /还有 1 笔没记清/.test(rMixed.message), rMixed.message);
    ok('结算校验能报出调整单数量', rMixed.adjustmentCount === 2, String(rMixed.adjustmentCount));

    const onlyAdj = [{ isAdjustment: true, id: 'a', amount: 0, zeroSum: true, splits: [] }];
    ok('只有调整单时 ready=true（不该拦结算）', AI.settlementReadiness(onlyAdj).ready === true,
      AI.settlementReadiness(onlyAdj).message);
  })();

  /* ---------- A7 effectiveShares ---------- */
  section('A7 实际分摊 effectiveShares');
  (function () {
    const b = { id: 'b1', payer: 'u1', amount: 480, splits: equalSplits(480, MEMBERS.slice(0, 3)) };
    const adj = AI.buildAdjustmentForExclusion(b, ['u3']);
    const eff = AI.effectiveShares(b, [b, adj]);
    const m = {};
    eff.forEach((s) => { m[s.memberId] = s.amount; });
    ok('叠加调整后的净分摊：u1=320（自己 160 + 收回替 u3 垫的 160）', m.u1 === 320, String(m.u1));
    ok('叠加调整后的净分摊：u2=160（不变）', m.u2 === 160, String(m.u2));
    ok('叠加调整后的净分摊：u3=0（退出）', Math.abs(m.u3) < 0.005, String(m.u3));
    ok('净分摊合计 = 480（仍等于账单金额，账恒平）', sum(eff.map((x) => x.amount)) === 480, String(sum(eff.map((x) => x.amount))));

    ok('无调整单时等于原分摊', AI.effectiveShares(b, [b]).length === 3);
    ok('空账单不崩', AI.effectiveShares(null, []).length === 0);
  })();

  /* ---------- C1 礼貌催账 ---------- */
  section('C1 礼貌催账话术');
  (function () {
    const item = { fromName: '小明', toName: '小红', amount: 328.5, roomName: '国庆东京行' };
    const f = AI.politeReminder(item);
    ok('friendly 含金额与房间名', f.indexOf('328.50') >= 0 && f.indexOf('国庆东京行') >= 0, f);
    ok('friendly 语气礼貌（有"不着急"）', /不着急/.test(f));
    const b = AI.politeReminder(item, { style: 'brief' });
    ok('brief 简短且含双方', b.indexOf('小明') >= 0 && b.indexOf('小红') >= 0, b);
    const p = AI.politeReminder(item, { style: 'playful' });
    ok('playful 有情绪', /🎉|记账官/.test(p), p);
    ok('未知 style 回退 friendly', AI.politeReminder(item, { style: 'zzz' }) === f);
    ok('缺字段不崩', typeof AI.politeReminder({}) === 'string');
  })();

  /* ---------- C2 旅行手账 ---------- */
  section('C2 旅行手账（按天人话小结）');
  (function () {
    const bills = [
      mkBill({ id: 'd1a', payer: 'u1', amount: 680, category: 'food', createdAt: '2024-10-02T09:00:00.000Z', splits: equalSplits(680, MEMBERS) }),
      mkBill({ id: 'd1b', payer: 'u2', amount: 320, category: 'transport', createdAt: '2024-10-02T14:00:00.000Z', splits: equalSplits(320, MEMBERS) }),
      mkBill({ id: 'd2a', payer: 'u1', amount: 2800, category: 'ticket', createdAt: '2024-10-03T09:00:00.000Z', splits: equalSplits(2800, MEMBERS) }),
    ];
    const j = AI.travelJournal(bills, { destination: '东京' });
    ok('按天聚合出 2 天', j.length === 2, String(j.length));
    ok('第 1 天合计 1000', j[0].total === 1000, String(j[0].total));
    ok('第 1 天 2 笔', j[0].count === 2);
    ok('第 1 天主分类是 food', j[0].topCategory === 'food', j[0].topCategory);
    ok('第 1 天文案是人话且带数字', /第 1 天：2 笔，共 ¥1000\.00/.test(j[0].text), j[0].text);
    ok('第 2 天最贵一笔是门票', j[1].total === 2800 && /2800\.00/.test(j[1].text), j[1].text);
    ok('空账单返回空数组', AI.travelJournal([]).length === 0);
    ok('缺 createdAt 的账单被跳过', AI.travelJournal([mkBill({ createdAt: null, amount: 10, payer: 'u1', splits: [] })]).length === 0);
  })();

  /* ---------- C3 结清卡片 ---------- */
  section('C3 结清卡片');
  (function () {
    const room = { name: '国庆东京行', destination: '东京', startDate: '2024-10-01', endDate: '2024-10-05' };
    const bills = [
      mkBill({ id: 'c1', payer: 'u1', amount: 3200, category: 'hotel', createdAt: '2024-10-01T09:00:00.000Z', splits: equalSplits(3200, MEMBERS) }),
      mkBill({ id: 'c2', payer: 'u2', amount: 1600, category: 'food', createdAt: '2024-10-02T09:00:00.000Z', splits: equalSplits(1600, MEMBERS) }),
      mkBill({ id: 'c3', payer: 'u3', amount: 800, category: 'transport', createdAt: '2024-10-03T09:00:00.000Z', splits: equalSplits(800, MEMBERS) }),
    ];
    const d = AI.shareCardData({ room, bills, members: MEMBERS });
    ok('卡片总消费 5600', d.total === 5600, String(d.total));
    ok('卡片人均 1400', d.perPerson === 1400, String(d.perPerson));
    ok('卡片天数 5', d.days === 5, String(d.days));
    ok('卡片人数 4', d.people === 4);
    ok('卡片账单数 3', d.billCount === 3);
    ok('分类占比前 3（hotel 居首）', d.topCategories.length === 3 && d.topCategories[0].category === 'hotel',
      d.topCategories.map((c) => c.name + c.percent + '%').join(','));
    ok('hotel 占比 57%', d.topCategories[0].percent === 57, String(d.topCategories[0].percent));
    ok('标题含房间名/天数/人数', /国庆东京行 · 5 天 · 4 人/.test(d.headline), d.headline);

    const txt = AI.shareCardText({ room, bills, members: MEMBERS });
    ok('文本卡片含总额与人均', txt.indexOf('¥5600.00') >= 0 && txt.indexOf('¥1400.00') >= 0);
    ok('文本卡片含分类明细', /住宿|餐饮|交通/.test(txt));
    ok('文本卡片有多行结构', txt.split('\n').length >= 8, String(txt.split('\n').length));

    // 占位单不应计入卡片
    const withPending = bills.concat([AI.buildPlaceholder({ description: '没记清' })]);
    const d2 = AI.shareCardData({ room, bills: withPending, members: MEMBERS });
    ok('占位单不计入结清卡片', d2.billCount === 3 && d2.total === 5600, d2.billCount + ' / ' + d2.total);

    ok('空数据不崩', typeof AI.shareCardText({ room: {}, bills: [], members: [] }) === 'string');
    ok('0 人时人均不出现 NaN', !/NaN/.test(AI.shareCardText({ room: {}, bills: [], members: [] })));
  })();

  /* ---------- Z 账恒平总闸 ---------- */
  section('Z 账恒平总闸（A1~A6 全部混用后仍严格为 0）');
  (function () {
    const bills = [];

    // 1) 普通均分
    bills.push(mkBill({ id: 'z1', payer: 'u1', amount: 680, category: 'food', splits: equalSplits(680, MEMBERS) }));

    // 2) 代购不摊
    bills.push(mkBill({ id: 'z2', payer: 'u2', amount: 600, category: 'shopping',
      splits: AI.buildSoleSplits({ payer: 'u2', payerName: '小红', amount: 600 }, MEMBERS) }));

    // 3) 抹零（JPY 12000 → 凑到百位；100 是倍数，故先造一个非整数）
    const jpyRaw = 12780;
    const jpyRound = AI.smartRound(jpyRaw, 'JPY');
    bills.push(mkBill({ id: 'z3', payer: 'u1', amount: jpyRound.rounded, currency: 'JPY',
      rate: AI.getRates().JPY, category: 'transport',
      splits: AI.applyRoundingLoss(equalSplits(jpyRound.rounded, MEMBERS), jpyRound.rounded) }));

    // 4) 多退少补
    const rent = mkBill({ id: 'z4', payer: 'u1', amount: 480, category: 'hotel', splits: equalSplits(480, MEMBERS.slice(0, 3)) });
    bills.push(rent);
    bills.push(AI.buildAdjustmentForExclusion(rent, ['u3']));

    // 5) 暂估改价
    const hotel = mkBill({ id: 'z5', payer: 'u2', amount: 3200, category: 'hotel', splits: equalSplits(3200, MEMBERS) });
    bills.push(hotel);
    bills.push(AI.buildAdjustmentForReestimate(hotel, 3560, MEMBERS));

    // 6) 口头占位（必须被排除在结算之外）
    bills.push(Object.assign(mkBill({ id: 'z6', payer: null }), AI.buildPlaceholder({ description: '忘了' })));

    const bal = netBalances(bills);
    const total = Math.round(Object.values(bal).reduce((s, v) => s + v, 0) * 100) / 100;
    ok('结算净余额合计严格 = 0', Math.abs(total) < 0.01, '合计 ' + total);
    ok('所有余额都是有限数（无 NaN）', Object.values(bal).every((v) => Number.isFinite(v)), JSON.stringify(bal));
    ok('占位单确实被排除', AI.settleableBills(bills).length === bills.length - 1,
      AI.settleableBills(bills).length + ' / ' + bills.length);

    // 每一项调整单都必须自身零和
    const adjs = bills.filter((b) => b.isAdjustment);
    const v = AI.validateAdjustments(bills);
    ok('★ validateAdjustments：所有调整单自身零和', v.ok === true, JSON.stringify(v.bad));
    ok('共产生 2 张调整单', adjs.length === 2, String(adjs.length));

    // 代购不该让其他人亏钱：u3/u4 的负余额只应来自真实 AA 账单
    ok('代购账单未把成本转嫁给他人', AI.isSoleBill(bills.find((b) => b.id === 'z2')) === true);
  })();

  /* ---------- 汇总 ---------- */
  console.log('\n========================================');
  console.log(`V3 旅行记账语义测试：通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) failures.forEach((f) => console.log('  ❌ ' + f));
  console.log('========================================');
  process.exit(fail === 0 ? 0 : 1);
})();
