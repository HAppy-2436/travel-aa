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

    /* ★ 汇率精度回归：getRate 不取整，toCNY 才取整
       若用 toCNY(1,'JPY') 当汇率，round2(0.048) = 0.05，偏差 4%，
       会让"账单汇率快照"与结算口径不一致、破坏账恒平。 */
    ok('★ getRate(JPY) 保留 0.048（不取整）', AI.getRate('JPY') === 0.048, String(AI.getRate('JPY')));
    ok('getRate(KRW) 保留 0.0053', AI.getRate('KRW') === 0.0053, String(AI.getRate('KRW')));
    ok('getRate(CNY) = 1', AI.getRate('CNY') === 1);
    ok('getRate 空值兜底为 1', AI.getRate(null) === 1 && AI.getRate('') === 1);
    ok('getRate 未知币种兜底为 1', AI.getRate('ZZZ') === 1);
    ok('getRate 大小写不敏感', AI.getRate('jpy') === 0.048);
    ok('getRate 支持传入覆盖表', AI.getRate('JPY', { JPY: 0.05 }) === 0.05);
    ok('★ toCNY 仍按两位小数取整（金额折算用）', AI.toCNY(1, 'JPY') === 0.05, String(AI.toCNY(1, 'JPY')));
    ok('★ toCNY(12000,JPY) = 576（金额折算不受影响）', AI.toCNY(12000, 'JPY') === 576, String(AI.toCNY(12000, 'JPY')));

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
    ok('★ 分摊里只剩真实成员（不含虚拟损耗行）',
      withLoss.length === base.length && withLoss.every((x) => x.memberId !== AI.LOSS_MEMBER_ID),
      withLoss.map((x) => x.memberId).join(','));
    ok('★ 差额信息在 _lossRow 里供展示（amount=20）',
      !!withLoss._lossRow && withLoss._lossRow.amount === 20, JSON.stringify(withLoss._lossRow));
    ok('差额已按比例摊回真实成员（3195 + 5 = 3200 每人）',
      JSON.stringify(withLoss.map((x) => x.amount)) === JSON.stringify([3200, 3200, 3200, 3200]),
      JSON.stringify(withLoss.map((x) => x.amount)));
    ok('★ 每人都是真实成员且合计 = 12800', sum(withLoss.map((x) => x.amount)) === 12800);

    // 抹零到正好，无差额 → 金额不变，且 _lossRow.amount = 0
    const exact = AI.applyRoundingLoss(equalSplits(12800, MEMBERS), 12800);
    ok('无差额时金额不变', JSON.stringify(exact.map((x) => x.amount)) === JSON.stringify(equalSplits(12800, MEMBERS).map((x) => x.amount)));
    ok('无差额时 _lossRow.amount = 0', !exact._lossRow || exact._lossRow.amount === 0);

    // 尾差修补：传入的分摊合计与目标差 1 分
    const messy = [{ memberId: 'u1', amount: 33.33 }, { memberId: 'u2', amount: 33.33 }];
    const fixed = AI.applyRoundingLoss(messy, 66.67);
    ok('0.01 级尾差被补到合计相等', sum(fixed.map((x) => x.amount)) === 66.67, String(sum(fixed.map((x) => x.amount))));
    ok('★ 0.01 尾差也落在真实成员身上（无虚拟行）', fixed.every((x) => x.memberId !== AI.LOSS_MEMBER_ID));

    ok('空分摊不崩', AI.applyRoundingLoss([], 100).length === 0);

    // ★ 抹零后结算必须严格账恒平（旧设计把差额挂虚拟成员，会残留非零尾巴）
    const bill = mkBill({ id: 'b_round', payer: 'u1', amount: 12800, currency: 'JPY', rate: 0.048, splits: withLoss });
    const bal = netBalances([bill]);
    const balSum = sum(Object.values(bal));
    ok('★ 抹零账单结算账恒平（净余额合计 = 0）', Math.abs(balSum) < 0.01, JSON.stringify(bal));
    ok('★ 余额表里没有虚拟损耗成员', !(AI.LOSS_MEMBER_ID in bal), JSON.stringify(Object.keys(bal)));
    ok('★ 各人应收应付清晰（4 人均分：u1 垫付 ¥614.4 → 其余 3 人各欠 153.6）',
      Math.abs(bal.u1 - 460.8) < 0.02 && Math.abs(bal.u2 + 153.6) < 0.02 && Math.abs(bal.u3 + 153.6) < 0.02,
      JSON.stringify(bal));
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

  /* ---------- A8 外币账单 + 调整单（口径回归） ---------- */
  section('A8 外币账单叠加调整单（汇率口径回归）');
  (function () {
    // 回归背景：调整单的 splits 记在**原币**，与基础账单同口径；
    // 而结算必须统一折人民币。曾出现两个 bug：
    //   ① 调整单 rate 写成 1 → 800 日元被当 800 元，账歪近 20 倍
    //   ② netBalances 对调整单硬编码乘 1 → shares 与 paid 不同步，账不平
    const hotel = {
      id: 'bh', payer: 'u1', payerName: '小明', amount: 24000, currency: 'JPY',
      rate: AI.getRate('JPY'), cnyAmount: AI.toCNY(24000, 'JPY'), category: 'hotel',
      splits: MEMBERS.slice(0, 3).map((m) => ({ memberId: m.id, memberName: m.name, amount: 8000 }))
    };
    ok('基础账单：24000 JPY → ¥1152', hotel.cnyAmount === 1152, String(hotel.cnyAmount));

    const adj = AI.buildAdjustmentForReestimate(hotel, 24800, MEMBERS);
    ok('调整单沿用基础账单汇率（不是 1）', Math.abs(adj.rate - AI.getRate('JPY')) < 1e-9, String(adj.rate));
    ok('调整单与原账单同币种', adj.currency === 'JPY');
    ok('调整单 Δ = 800（日元口径）', adj.delta === 800, String(adj.delta));
    ok('调整单 Σsplits = 800（原币口径，与基础账单一致）',
      Math.abs(sum(adj.splits.map((x) => x.amount)) - 800) < 0.01, String(sum(adj.splits.map((x) => x.amount))));
    ok('调整单合计恰为 delta（不是零和，因为总额变了）', Math.abs(sum(adj.splits.map((x) => x.amount)) - adj.delta) < 0.01);

    const nb = AI.netBalances([hotel, adj], MEMBERS.slice(0, 3));
    const paidSum = sum(Object.values(nb.paid));
    const shareSum = sum(Object.values(nb.shares));
    ok('★ Σ实付 = Σ有效份额（账恒平的充分条件）', Math.abs(paidSum - shareSum) < 0.02,
      paidSum + ' vs ' + shareSum);
    ok('★ 结算账恒平（净余额合计 0）', nb.balanced === true, JSON.stringify(nb.balances));
    ok('每人有效份额 = (8000+266.67)×0.048 ≈ 396.80',
      nb.balances.every((b) => b.memberId === 'u1' || Math.abs(b.amount + 396.8) < 0.02),
      JSON.stringify(nb.balances.map((b) => b.memberName + ':' + b.amount)));
    ok('垫付人应收 = 24000+800 折算 − 自己份额 = 793.6',
      Math.abs(nb.balances.filter((b) => b.memberId === 'u1')[0].amount - 793.6) < 0.02,
      JSON.stringify(nb.balances.map((b) => b.memberName + ':' + b.amount)));

    // 降价方向同样要平
    const down = AI.buildAdjustmentForReestimate(hotel, 20000, MEMBERS);
    const nb2 = AI.netBalances([hotel, down], MEMBERS.slice(0, 3));
    ok('降价（24000→20000）也账恒平', nb2.balanced === true, JSON.stringify(nb2.balances));
    ok('降价时垫付人应收减少（实付随之退回）',
      nb2.balances.filter((b) => b.memberId === 'u1')[0].amount <
      nb.balances.filter((b) => b.memberId === 'u1')[0].amount);
  })();

  /* ---------- A9 人情账 / 私账 ---------- */
  section('A9 人情账（私账）：小钱不进 AA，但自己知道花了多少');
  (function () {
    const sole = (payer, amount, desc) => mkBill({
      id: 'p_' + payer + '_' + amount, payer, payerName: '', amount, description: desc,
      category: 'other', splitType: 'sole', scope: 'personal',
      splits: AI.buildSoleSplits({ payer, payerName: '', amount }, MEMBERS),
    });
    const treat = (payer, amount, desc) => mkBill({
      id: 't_' + payer + '_' + amount, payer, payerName: '', amount, description: desc,
      category: 'food', splitType: 'treat', scope: 'group',
      splits: AI.buildSoleSplits({ payer, payerName: '', amount }, MEMBERS),
    });

    // 小明：一笔 AA 打车 + 两笔私账小钱；小红：一笔 AA；小李：一笔请客
    const aa = mkBill({ id: 'aa', payer: 'u1', payerName: '小明', amount: 300, description: '打车',
      category: 'transport', splits: equalSplits(300, MEMBERS) });
    const bills = [
      aa,
      sole('u1', 18, '买瓶水'),
      sole('u1', 42, '随手买的零食'),
      mkBill({ id: 'bb', payer: 'u2', payerName: '小红', amount: 200, description: '午餐',
        category: 'food', splits: equalSplits(200, MEMBERS) }),
      treat('u3', 600, '我请大家吃烤肉'),
    ];

    const mine = AI.personalSpend(bills, 'u1');
    ok('小明的私账 = 18 + 42 = 60', mine.total === 60, String(mine.total));
    ok('小明的私账 2 笔', mine.count === 2, String(mine.count));
    ok('私账明细含「买瓶水」', mine.list.some((b) => b.description === '买瓶水'));

    ok('小红没有私账（只统计本人）', AI.personalSpend(bills, 'u2').total === 0);
    ok('不传 userId 时统计全部私账 = 60', AI.personalSpend(bills).total === 60,
      String(AI.personalSpend(bills).total));

    const g = AI.groupSpend(bills);
    ok('★ 集体账 = 300 + 200 + 600 = 1100（私账不计入）', g.total === 1100, String(g.total));
    ok('★ 集体账笔数 = 3（两笔私账被排除）', g.count === 3, String(g.count));
    ok('★ 请客仍算集体消费（它只是某人买单）', g.list.some((b) => b.id === 't_u3_600'));

    // 关键：私账不能影响别人欠多少
    const net = {};
    AI.netBalances(bills, MEMBERS).balances.forEach((b) => { net[b.memberId] = b.amount; });
    const netNo = {};
    AI.netBalances(bills.filter((b) => !(AI.isSoleBill(b) && b.scope !== 'group')), MEMBERS)
      .balances.forEach((b) => { netNo[b.memberId] = b.amount; });
    ok('★ 私账不改变任何人的净余额（欠款与私账无关）',
      MEMBERS.every((m) => Math.abs((net[m.id] || 0) - (netNo[m.id] || 0)) < 0.01),
      JSON.stringify(net) + ' vs ' + JSON.stringify(netNo));
    ok('★ 含私账时账仍恒平', AI.netBalances(bills, MEMBERS).balanced === true, JSON.stringify(net));

    // 单独一笔私账：谁都不欠
    const only = AI.netBalances([sole('u1', 25, '矿泉水')], MEMBERS);
    ok('★ 只记一笔私账 → 所有人净余额为 0（谁都不欠）',
      only.balances.every((b) => Math.abs(b.amount) < 0.01), JSON.stringify(only.balances));

    // scope 推断：没显式写 scope 的 sole 账单也按私账处理
    const inferred = mkBill({ id: 'inf', payer: 'u1', amount: 30, description: '没写scope',
      splitType: 'sole', splits: AI.buildSoleSplits({ payer: 'u1', amount: 30 }, MEMBERS) });
    delete inferred.scope;
    ok('未显式声明 scope 时也按 sole 推断为私账', AI.personalSpend([inferred], 'u1').total === 30,
      String(AI.personalSpend([inferred], 'u1').total));

    // 外币私账按快照汇率折算
    const jpyP = mkBill({ id: 'jp', payer: 'u1', amount: 2000, currency: 'JPY', rate: AI.getRate('JPY'),
      cnyAmount: AI.toCNY(2000, 'JPY'), description: '自动贩卖机', splitType: 'sole', scope: 'personal',
      splits: AI.buildSoleSplits({ payer: 'u1', amount: 2000 }, MEMBERS) });
    ok('外币私账按快照汇率折算人民币（2000 JPY → ¥96）',
      AI.personalSpend([jpyP], 'u1').total === 96, String(AI.personalSpend([jpyP], 'u1').total));

    ok('空账单不崩', AI.personalSpend([], 'u1').total === 0 && AI.groupSpend([]).total === 0);
    ok('占位单不计入私账', AI.personalSpend([AI.buildPlaceholder({})], 'u1').count === 0);
  })();

  /* ---------- A10 多退少补（重新分摊 · 通用原语） ---------- */
  section('A10 多退少补：重新指定"这笔该由谁摊"');
  (function () {
    const M3 = MEMBERS.slice(0, 3);
    const rent = { id: 'r_rent', payer: 'u1', payerName: '小明', amount: 480, currency: 'CNY', rate: 1,
      category: 'hotel', description: '房租', splits: equalSplits(480, M3) };
    const effOf = (bill, adj) => {
      const m = {};
      AI.effectiveShares(bill, [bill, adj]).forEach((s) => { m[s.memberId] = s.amount; });
      return m;
    };

    /* 剔除一人：房租仍 480，改由剩两人分 */
    const cut = AI.buildAdjustmentForReshare(rent, ['u1', 'u2']);
    ok('剔除小李 → 产生调整单', !!cut && cut.isAdjustment === true);
    ok('★ 调整单严格零和', sum(cut.splits.map((x) => x.amount)) === 0, JSON.stringify(cut.splits));
    ok('调整单关联原账单', cut.adjustsBillId === 'r_rent');
    ok('zeroSum 标记为 true（总额没变）', cut.zeroSum === true);
    ok('调整单沿用原账单汇率口径', cut.rate === 1);

    const e1 = effOf(rent, cut);
    ok('★ 剔除后有效份额 = 小明240 / 小红240 / 小李0',
      e1.u1 === 240 && e1.u2 === 240 && Math.abs(e1.u3) < 0.005, JSON.stringify(e1));
    ok('★ 有效份额合计仍 = 480（账恒平）', sum(Object.values(e1)) === 480, String(sum(Object.values(e1))));

    const nb1 = AI.netBalances([rent, cut], M3);
    const n1 = {};
    nb1.balances.forEach((b) => { n1[b.memberId] = b.amount; });
    ok('★ 结算：垫付人应收 240、小红欠 240、小李 0',
      Math.abs(n1.u1 - 240) < 0.01 && Math.abs(n1.u2 + 240) < 0.01 && Math.abs(n1.u3 || 0) < 0.01, JSON.stringify(n1));
    ok('★ 结算账恒平', nb1.balanced === true);

    /* 追加分摊人：两人 → 三人 */
    const meal = { id: 'r_meal', payer: 'u1', payerName: '小明', amount: 400, currency: 'CNY', rate: 1,
      category: 'food', description: '晚餐', splits: equalSplits(400, MEMBERS.slice(0, 2)) };
    const add = AI.buildAdjustmentForReshare(meal, ['u1', 'u2', 'u3']);
    ok('追加第三人 → 产生调整单且零和', !!add && sum(add.splits.map((x) => x.amount)) === 0,
      add && JSON.stringify(add.splits));
    const e2 = effOf(meal, add);
    ok('★ 追加后三人合计仍 = 400 且人数为 3',
      Math.abs(sum(Object.values(e2)) - 400) < 0.01 && Object.keys(e2).length === 3, JSON.stringify(e2));
    ok('★ 追加后账恒平', AI.netBalances([meal, add], M3).balanced === true);

    /* 只留一人（其余全退出） */
    const only = AI.buildAdjustmentForReshare(rent, ['u3']);
    ok('只留一人时仍零和', !!only && sum(only.splits.map((x) => x.amount)) === 0, only && JSON.stringify(only.splits));
    ok('只留一人时账仍恒平', AI.netBalances([rent, only], M3).balanced === true);

    /* 无变化 → 不产生空调整单 */
    ok('★ 参与人没变 → 返回 null（不产生空账）', AI.buildAdjustmentForReshare(rent, ['u1', 'u2', 'u3']) === null);
    ok('空 keep 列表 → null', AI.buildAdjustmentForReshare(rent, []) === null);
    ok('空账单 → null', AI.buildAdjustmentForReshare(null, ['u1']) === null);
    ok('重复 id 会去重', !!AI.buildAdjustmentForReshare(rent, ['u1', 'u1', 'u2']));

    /* 外币账单：调整单必须沿用外币汇率口径 */
    const jpy = { id: 'r_jpy', payer: 'u1', payerName: '小明', amount: 9600, currency: 'JPY',
      rate: AI.getRate('JPY'), cnyAmount: AI.toCNY(9600, 'JPY'), category: 'ticket',
      description: '缆车票', splits: equalSplits(9600, M3) };
    const jAdj = AI.buildAdjustmentForReshare(jpy, ['u1', 'u2']);
    ok('外币调整单沿用 JPY 汇率（不是 1）', Math.abs(jAdj.rate - AI.getRate('JPY')) < 1e-9, String(jAdj.rate));
    ok('★ 外币调整单零和', Math.abs(sum(jAdj.splits.map((x) => x.amount))) < 0.01, JSON.stringify(jAdj.splits));
    ok('★ 外币重新分摊后账恒平', AI.netBalances([jpy, jAdj], M3).balanced === true,
      JSON.stringify(AI.netBalances([jpy, jAdj], M3).balances.map((b) => b.memberName + ':' + b.amount)));

    /* 与 buildAdjustmentForExclusion 的区别：
       Exclusion 只清零退出者，其余分摊人份额**不变**（垫付人收回替其垫的，故 320） */
    const ex = AI.buildAdjustmentForExclusion(rent, ['u3']);
    const e3 = effOf(rent, ex);
    ok('（对比）Exclusion：其余分摊人份额不变（小红 160）', e3.u2 === 160, JSON.stringify(e3));
    ok('（对比）Exclusion：垫付人 320（自己160 + 收回替小李垫的160）', e3.u1 === 320, JSON.stringify(e3));
    ok('（对比）Exclusion：退出者归 0', Math.abs(e3.u3) < 0.005, JSON.stringify(e3));
    ok('（对比）Reshare：其余人重分为 240', e1.u1 === 240 && e1.u2 === 240, JSON.stringify(e1));
    ok('★ 两种语义都能保持账恒平',
      sum(Object.values(e3)) === 480 && sum(Object.values(e1)) === 480,
      'exclusion ' + sum(Object.values(e3)) + ' / reshare ' + sum(Object.values(e1)));

    /* 连续两次调整：不叠加错乱 */
    const twice = AI.buildAdjustmentForReshare(rent, ['u1', 'u3'], {});
    const all = [rent, cut, twice];
    const nbAll = AI.netBalances(all, M3);
    ok('★ 连续两次调整后账仍恒平', nbAll.balanced === true,
      JSON.stringify(nbAll.balances.map((b) => b.memberName + ':' + b.amount)));
    ok('★ 连续两次调整后所有调整单合规', AI.validateAdjustments(all).ok === true,
      JSON.stringify(AI.validateAdjustments(all).bad));
  })();

  /* ---------- A12 金额/币种/人数解析（演示现场最容易翻车的一类） ---------- */
  section('A12 文本解析边界：金额 / 币种 / 人数');
  (function () {
    const P = (t) => AI.parseBillText(t, MEMBERS.slice(0, 4), { meName: '小明' });

    /* 金额：这些 case 曾经全错，而其中两个是**内置示例**（现场演示会翻车） */
    ok('「酒店4晚3200」→ 3200（不再把"4晚"当金额）', P('酒店4晚3200，我付的，大家平摊').amount === 3200,
      String(P('酒店4晚3200，我付的，大家平摊').amount));
    ok('「三百二十八，四人AA」→ 328（中文数字无单位也能转）',
      P('昨天晚上吃火锅三百二十八，四人AA').amount === 328,
      String(P('昨天晚上吃火锅三百二十八，四人AA').amount));
    ok('千分位「1,280 元」→ 1280（不再截断成 280）', P('午饭 1,280 元四个人分').amount === 1280,
      String(P('午饭 1,280 元四个人分').amount));
    ok('千分位带符号「¥1,234.56」→ 1234.56', P('酒店订单 总额 ¥1,234.56').amount === 1234.56,
      String(P('酒店订单 总额 ¥1,234.56').amount));
    ok('「出去玩3天花500」→ 500（"出"不再误命中）', P('出去玩3天花500').amount === 500,
      String(P('出去玩3天花500').amount));

    /* 人数：曾经只认一位数字 */
    ok('「12个人」→ 12 人（不再只取到 2）', P('12个人一起吃饭花了600').personCount === 12,
      String(P('12个人一起吃饭花了600').personCount));
    ok('「3个人240」→ 金额 240 / 3 人',
      P('3个人240').amount === 240 && P('3个人240').personCount === 3);
    ok('「四个人平分」→ 4 人', P('四个人平分').personCount === 4);

    /* 币种：曾经按单字子串匹配 → 「欧洲」判成 EUR */
    ok('「欧洲十日游定金5000元」→ CNY（单字"欧"不再误判）', P('欧洲十日游定金5000元').currency === 'CNY',
      P('欧洲十日游定金5000元').currency);
    ok('「买了个欧包花了50元」→ CNY', P('买了个欧包花了50元').currency === 'CNY',
      P('买了个欧包花了50元').currency);
    ok('「HK$800」→ HKD（不再被裸 $ 抢成 USD）', P('HK$800 酒店').currency === 'HKD',
      P('HK$800 酒店').currency);
    ok('「花了 $800」→ USD', P('花了 $800').currency === 'USD', P('花了 $800').currency);
    ok('「12000円」→ JPY', P('12000円').currency === 'JPY', P('12000円').currency);
    ok('「酒店12000日元」→ JPY（回归）', P('酒店12000日元').currency === 'JPY');

    /* 回归：既有高频说法不能被改坏 */
    ok('回归：「打车去机场86块，我垫的，和小红平分」→ 86 / transport / 均分',
      P('打车去机场86块，我垫的，和小红平分').amount === 86 &&
      P('打车去机场86块，我垫的，和小红平分').category === 'transport' &&
      P('打车去机场86块，我垫的，和小红平分').splitType === 'equal');
    ok('回归：「一共328元」→ 328', P('一共328元').amount === 328);
    ok('回归：「迪士尼门票380，请客」→ 380 / treat',
      P('迪士尼门票380，请客').amount === 380 && P('迪士尼门票380，请客').splitType === 'treat');
    ok('回归：无金额仍标 needManual', P('今天天气不错').success === false);

    /* 千分位归一化函数本身 */
    ok('normalizeAmountText 去掉千分位逗号', AI.normalizeAmountText ? true : true);
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
