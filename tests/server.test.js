/**
 * server.test.js —— 可选后端（server/app.js）端到端集成测试
 *
 * 为什么需要：三套既有测试只覆盖「算法内核」与「Demo 页面」，**完全不覆盖 server**。
 * 结果是一个致命 bug 长期潜伏：目录重构后 `server/app.js` 里写成
 * `require('../apps/apps/miniprogram/utils/ai')`，后端**根本起不来**，而所有测试依然全绿。
 *
 * 本测试做的事：
 *   1. 把 server/ + apps/ 复制到临时目录（含 node_modules 联接），**不污染仓库真实数据库**
 *   2. 以子进程真实启动 `node app.js`，轮询 /api/health 直到就绪
 *   3. 用 fetch 逐个打真实 HTTP 路由，断言请求/响应与「账恒平」等业务口径
 *   4. 结束时杀掉子进程（含 Windows 进程树），清理临时目录
 *
 * 用法：node tests/server.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 3199);
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  ✅ ' + name + (extra ? '  → ' + extra : ''));
  } else {
    fail++;
    failures.push(name);
    console.log('  ❌ ' + name + (extra ? '  → ' + extra : ''));
  }
}
function section(t) { console.log('\n—— ' + t + ' ——'); }

async function req(method, p, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(BASE + p, opts);
  let data = null;
  try { data = await r.json(); } catch (e) { data = null; }
  return { status: r.status, data };
}

/* ---------- 准备沙箱：复制源码，避开真实 db ---------- */
function prepareSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'travelaa-srv-'));
  fs.cpSync(path.join(ROOT, 'server'), path.join(dir, 'server'), {
    recursive: true,
    filter: (src) => !/[\\/]node_modules([\\/]|$)/.test(src) && !/[\\/]data([\\/]|$)/.test(src),
  });
  fs.cpSync(path.join(ROOT, 'apps'), path.join(dir, 'apps'), {
    recursive: true,
    filter: (src) => !/[\\/]node_modules([\\/]|$)/.test(src),
  });
  // 用联接复用已安装依赖，省去 npm install
  const real = path.join(ROOT, 'server', 'node_modules');
  if (fs.existsSync(real)) {
    fs.symlinkSync(real, path.join(dir, 'server', 'node_modules'), 'junction');
  }
  return dir;
}

async function waitReady(proc, ms = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (proc.exitCode !== null) return false;
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) return true;
    } catch (e) { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/* ---------- 主流程 ---------- */
(async function main() {
  let sandbox;
  let proc;
  try {
    sandbox = prepareSandbox();
  } catch (e) {
    console.log('❌ 沙箱准备失败：' + e.message);
    process.exit(1);
  }

  const serverDir = path.join(sandbox, 'server');
  proc = spawn(process.execPath, ['app.js'], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(PORT), NPU_FALLBACK: '0', LLM_API_KEY: '' },
    stdio: 'ignore',          // 沙箱限制：不能捕获管道，忽略输出即可
    windowsHide: true,
  });

  const ready = await waitReady(proc);
  if (!ready) {
    console.log('❌ 后端未能启动（端口 ' + PORT + '）。');
    console.log('   最常见原因：server/app.js 的共享内核 require 路径写错，或 better-sqlite3 未编译。');
    try { proc.kill(); } catch (e) { /* ignore */ }
    process.exit(1);
  }

  try {
    /* ===== 1. 健康与引擎 ===== */
    section('1. 健康检查 / AI 引擎状态');
    const h = await req('GET', '/api/health');
    ok('GET /api/health 返回 ok', h.status === 200 && h.data && h.data.status === 'ok', h.status);

    const eng = await req('GET', '/api/ai/engine');
    ok('GET /api/ai/engine 暴露 rule 保底引擎', eng.status === 200 && eng.data.engine && eng.data.engine.rule === true);
    ok('未配 Key 时 cloudLLM=false（离线保底）', eng.data.engine.cloudLLM === false);

    /* ===== 2. 用户 / 房间 ===== */
    section('2. 用户与房间');
    const lg = await req('POST', '/api/login', { userId: 't_u1', nickname: '小明' });
    ok('POST /api/login 注册用户', lg.status === 200 && lg.data.success && lg.data.user.nickname === '小明');

    const cr = await req('POST', '/api/rooms', {
      userId: 't_u1', nickname: '小明', name: '测试东京行', destination: '东京',
      startDate: '2024-10-01', endDate: '2024-10-05',
    });
    ok('POST /api/rooms 创建房间', cr.status === 200 && cr.data.success && !!cr.data.room.id, cr.data.room && cr.data.room.name);
    const roomId = cr.data.room.id;
    const roomCode = cr.data.room.room_code;
    ok('房间号是 6 位数字', /^\d{6}$/.test(String(roomCode)), String(roomCode));
    ok('创建者自动成为成员', cr.data.room.members.length === 1);

    const crBad = await req('POST', '/api/rooms', { userId: 't_u1' });
    ok('缺旅行名 → 400', crBad.status === 400);

    const jn = await req('POST', '/api/rooms/join', { roomCode, userId: 't_u2', nickname: '小红' });
    ok('POST /api/rooms/join 加入房间', jn.status === 200 && jn.data.room.members.length === 2);
    const jnAgain = await req('POST', '/api/rooms/join', { roomCode, userId: 't_u2', nickname: '小红' });
    ok('重复加入不产生重复成员（幂等）', jnAgain.data.room.members.length === 2);
    await req('POST', '/api/rooms/join', { roomCode, userId: 't_u3', nickname: '小李' });

    const jnBad = await req('POST', '/api/rooms/join', { roomCode: '000000', userId: 't_x', nickname: 'x' });
    ok('房间号不存在 → 404', jnBad.status === 404);
    const jnShort = await req('POST', '/api/rooms/join', { roomCode: '12', userId: 't_x', nickname: 'x' });
    ok('房间号非 6 位 → 400', jnShort.status === 400);

    const my = await req('GET', '/api/rooms/my/t_u1');
    ok('GET /api/rooms/my/:userId 列出我的房间', my.data.success && my.data.rooms.length >= 1);

    const rd = await req('GET', '/api/rooms/' + roomId);
    ok('GET /api/rooms/:id 返回房间详情', rd.data.success && rd.data.room.members.length === 3);

    const nf = await req('GET', '/api/rooms/not_exist_id');
    ok('房间不存在 → 404', nf.status === 404);

    /* ===== 3. 账单增删改 + 账恒平 ===== */
    section('3. 账单 CRUD 与分摊校验');
    const b1 = await req('POST', '/api/bills', {
      roomId, payerId: 't_u1', payerName: '小明', amount: 300, description: '晚餐',
      category: 'food', splitType: 'equal', createdBy: 't_u1',
      splits: [{ memberId: 't_u1', amount: 100 }, { memberId: 't_u2', amount: 100 }, { memberId: 't_u3', amount: 100 }],
    });
    ok('POST /api/bills 记账成功', b1.status === 200 && b1.data.success, b1.data.bill && ('¥' + b1.data.bill.amount));
    const billId = b1.data.bill.id;
    ok('CNY 账单 cny_amount = amount', b1.data.bill.cny_amount === 300 && b1.data.bill.rate === 1);

    const bBad = await req('POST', '/api/bills', {
      roomId, payerId: 't_u1', amount: 300, description: '账不平',
      splits: [{ memberId: 't_u1', amount: 100 }],
    });
    ok('分摊合计与金额不符 → 400（账不平被拒）', bBad.status === 400, bBad.data && bBad.data.error);

    const bZero = await req('POST', '/api/bills', { roomId, payerId: 't_u1', amount: 0, splits: [] });
    ok('金额为 0 → 400', bZero.status === 400);
    const bNoPayer = await req('POST', '/api/bills', { roomId, amount: 100, splits: [] });
    ok('缺付款人 → 400', bNoPayer.status === 400);

    // 外币账单：汇率快照
    const bJpy = await req('POST', '/api/bills', {
      roomId, payerId: 't_u2', payerName: '小红', amount: 12000, currency: 'JPY',
      description: '京都交通', category: 'transport', createdBy: 't_u2',
      splits: [
        { memberId: 't_u1', amount: 4000 }, { memberId: 't_u2', amount: 4000 }, { memberId: 't_u3', amount: 4000 },
      ],
    });
    ok('JPY 账单按快照汇率折算 CNY', bJpy.status === 200 && bJpy.data.bill.rate > 0 && bJpy.data.bill.cny_amount > 0,
      'rate=' + (bJpy.data.bill && bJpy.data.bill.rate) + ' cny=' + (bJpy.data.bill && bJpy.data.bill.cny_amount));
    ok('外币账单 rate ≠ 1（确实折算）', bJpy.data.bill.rate !== 1);

    const list = await req('GET', `/api/rooms/${roomId}/bills`);
    ok('GET /api/rooms/:id/bills 返回账单', list.data.success && list.data.bills.length === 2);
    ok('账单 splits 已解析为数组', Array.isArray(list.data.bills[0].splits));

    const up = await req('PUT', '/api/bills/' + billId, {
      amount: 360, description: '晚餐（改）', splits: [
        { memberId: 't_u1', amount: 120 }, { memberId: 't_u2', amount: 120 }, { memberId: 't_u3', amount: 120 },
      ],
    });
    ok('PUT /api/bills/:id 编辑账单', up.status === 200 && up.data.bill.amount === 360);

    const upBad = await req('PUT', '/api/bills/' + billId, {
      amount: 360, splits: [{ memberId: 't_u1', amount: 1 }],
    });
    ok('编辑时账不平 → 400', upBad.status === 400);

    const up404 = await req('PUT', '/api/bills/not_exist', { amount: 10 });
    ok('编辑不存在的账单 → 404', up404.status === 404);

    const del404 = await req('DELETE', '/api/bills/not_exist');
    ok('删除不存在的账单 → 404', del404.status === 404);

    // 房间统计随编辑同步
    const rd2 = await req('GET', '/api/rooms/' + roomId);
    ok('编辑后房间 bill_count 正确', rd2.data.room.bill_count === 2, String(rd2.data.room.bill_count));

    /* ===== 4. 结算：账恒平 ===== */
    section('4. 结算（多币种 / 账恒平 / 最简转账）');
    const st = await req('GET', `/api/rooms/${roomId}/settle`);
    ok('GET /api/rooms/:id/settle 成功', st.status === 200 && st.data.success);
    const bal = st.data.balances || st.data.result && st.data.result.balances || [];
    const balSum = Math.round(bal.reduce((s, b) => s + Number(b.amount || 0), 0) * 100) / 100;
    ok('结算账恒平（净余额合计 = 0）', Math.abs(balSum) < 0.05, '合计 ' + balSum);
    const transfers = st.data.transfers || (st.data.result && st.data.result.transfers) || [];
    ok('给出最简转账方案', Array.isArray(transfers) && transfers.length >= 1, transfers.length + ' 笔');
    const tfSum = Math.round(transfers.reduce((s, t) => s + Number(t.amount || 0), 0) * 100) / 100;
    const debt = Math.round(bal.filter((b) => b.amount < 0).reduce((s, b) => s + Math.abs(b.amount), 0) * 100) / 100;
    ok('转账总额 = 应收总额（不多收不漏收）', Math.abs(tfSum - debt) < 0.05, '转账 ' + tfSum + ' / 应付 ' + debt);

    const stEmpty = await req('GET', '/api/rooms/not_exist/settle');
    ok('不存在房间的结算不崩（返回空方案）', stEmpty.status === 200);

    /* ===== 5. 预算 / 审计 / 每日 / 结清 ===== */
    section('5. 预算 · 审计 · 每日分析 · 结清');
    const bud = await req('POST', `/api/rooms/${roomId}/budget`, { budget: 6000 });
    ok('POST 预算设置成功', bud.status === 200 && bud.data.budget === 6000);
    const budBad = await req('POST', `/api/rooms/${roomId}/budget`, { budget: -1 });
    ok('负预算 → 400', budBad.status === 400);

    const bs = await req('GET', `/api/rooms/${roomId}/budget-status`);
    ok('GET budget-status 返回燃烧率/预测', bs.status === 200 && bs.data.success && bs.data.status, bs.data.status && ('已花 ' + bs.data.status.spent));

    const au = await req('GET', `/api/rooms/${roomId}/audit`);
    ok('GET audit 返回问题清单与健康度', au.status === 200 && au.data.success && au.data.audit && au.data.audit.score > 0,
      au.data.audit && ('健康度 ' + au.data.audit.score + ' 分 · ' + (au.data.audit.issues || []).length + ' 个问题 · 已查 ' + au.data.audit.checked + ' 笔'));
    ok('GET audit 的 checked 覆盖全部账单', au.data.audit.checked === 2, String(au.data.audit.checked));

    const dl = await req('GET', `/api/rooms/${roomId}/daily`);
    ok('GET daily 返回每日聚合', dl.status === 200 && dl.data.success && dl.data.stats);

    const sd = await req('POST', `/api/rooms/${roomId}/settled`);
    ok('POST settled 标记已结清', sd.status === 200 && !!sd.data.settledAt, sd.data.settledAt);

    /* ===== 6. 携程订单导入 ===== */
    section('6. 携程订单导入');
    const ctxt = '【携程】订单确认 机票 订单号 CT12345678 上海浦东-东京成田 往返 金额 ¥6240 出行人 小明 小红';
    const cdraft = await req('POST', '/api/ctrip/import', { text: ctxt, roomId, payerId: 't_u1' });
    ok('订单文本 → 账单草稿（不落库）', cdraft.status === 200 && cdraft.data.success && cdraft.data.bills.length >= 1,
      cdraft.data.bills && cdraft.data.bills.length && ('¥' + cdraft.data.bills[0].amount));

    const before = (await req('GET', `/api/rooms/${roomId}/bills`)).data.bills.length;
    const cimp = await req('POST', '/api/ctrip/import', { text: ctxt, roomId, payerId: 't_u1', create: true });
    const after = (await req('GET', `/api/rooms/${roomId}/bills`)).data.bills.length;
    ok('create=true 时真实落库', cimp.status === 200 && after > before, before + ' → ' + after + ' 笔');
    ok('导入账单 source=ctrip', (await req('GET', `/api/rooms/${roomId}/bills`)).data.bills.some((b) => b.source === 'ctrip'));

    const cnone = await req('POST', '/api/ctrip/import', { text: '无关文本' });
    ok('无金额订单 → 空结果不报错', cnone.status === 200 && cnone.data.bills.length === 0);
    const cnoText = await req('POST', '/api/ctrip/import', {});
    ok('缺订单文本 → 400', cnoText.status === 400);

    /* ===== 7. AI 接口（规则引擎离线路径） ===== */
    section('7. AI 接口（离线规则引擎）');
    const pRule = await req('POST', '/api/ai/parse', {
      text: '打车去机场86块，我垫的，和小红小李平分',
      members: [{ id: 't_u1', name: '小明' }, { id: 't_u2', name: '小红' }, { id: 't_u3', name: '小李' }],
      meName: '小明', mode: 'rule',
    });
    ok('POST /api/ai/parse 返回 {parsed, splits, source}', pRule.status === 200 && pRule.data.success === true && !!pRule.data.parsed,
      pRule.data && ('source ' + pRule.data.source));
    ok('解析出金额 86', pRule.data.parsed && pRule.data.parsed.amount === 86, pRule.data.parsed && ('金额 ' + pRule.data.parsed.amount));
    ok('解析出分类 transport', pRule.data.parsed && pRule.data.parsed.category === 'transport', pRule.data.parsed && pRule.data.parsed.category);
    ok('解析出付款人 = 我(小明)', pRule.data.parsed && pRule.data.parsed.payerId === 't_u1' && pRule.data.parsed.payerName === '小明',
      pRule.data.parsed && (pRule.data.parsed.payerId + ' / ' + pRule.data.parsed.payerName));
    ok('解析出分摊方式 = 均分', pRule.data.parsed && pRule.data.parsed.splitType === 'equal', pRule.data.parsed && pRule.data.parsed.splitType);
    ok('解析出参与分摊 3 人（含垫付人）', pRule.data.parsed && Array.isArray(pRule.data.parsed.splitWith) && pRule.data.parsed.splitWith.length === 3,
      pRule.data.parsed && JSON.stringify(pRule.data.parsed.splitWith));
    ok('解析置信度为高（≥80）', pRule.data.parsed && pRule.data.parsed.confidence >= 80, pRule.data.parsed && String(pRule.data.parsed.confidence));
    ok('分摊明细账恒平（合计 = 86）', pRule.data.splits && Math.abs(pRule.data.splits.reduce((s, x) => s + x.amount, 0) - 86) < 0.005,
      pRule.data.splits && pRule.data.splits.map((x) => x.amount).join(' + '));
    ok('解析结果标注来源（rule/llm）', pRule.data.source === 'rule', pRule.data.source);

    const pLLM = await req('POST', '/api/ai/parse', {
      text: '打车去机场86块', members: [{ id: 't_u1', name: '小明' }], meName: '小明', mode: 'llm',
    });
    ok('无 Key 时 mode=llm 自动回退规则引擎（不报错）', pLLM.status === 200 && pLLM.data.source === 'rule' && pLLM.data.parsed.amount === 86,
      'source ' + pLLM.data.source + ' · 金额 ' + pLLM.data.parsed.amount);

    const pNoText = await req('POST', '/api/ai/parse', {});
    ok('缺文本 → 400', pNoText.status === 400);

    const ins = await req('POST', '/api/ai/insight', {
      bills: [{ amount: 300, cnyAmount: 300, category: 'food', createdAt: '2024-10-01T09:00:00Z' }],
      members: [{ id: 't_u1', name: '小明' }],
    });
    ok('POST /api/ai/insight 返回洞察', ins.status === 200 && ins.data.success !== false);

    const rep = await req('POST', '/api/ai/report', {
      bills: [{ amount: 300, cnyAmount: 300, category: 'food', createdAt: '2024-10-01T09:00:00Z', splits: [{ memberId: 't_u1', amount: 300 }], payerId: 't_u1' }],
      members: [{ id: 't_u1', name: '小明' }],
    });
    ok('POST /api/ai/report 返回报告', rep.status === 200 && rep.data.success !== false);

    const nar = await req('POST', '/api/ai/narrate', {
      bills: [{ amount: 300, cnyAmount: 300, category: 'food', createdAt: '2024-10-01T09:00:00Z' }],
      members: [{ id: 't_u1', name: '小明' }], room: { name: '测试东京行' },
    });
    ok('POST /api/ai/narrate 出小作文（模板保底）', nar.status === 200 && nar.data.success !== false);

    /* ===== 8. 删除账单 + 统计回算 ===== */
    section('8. 删除账单与统计回算');
    const del = await req('DELETE', '/api/bills/' + billId);
    ok('DELETE /api/bills/:id 成功', del.status === 200 && del.data.success);
    const after2 = (await req('GET', `/api/rooms/${roomId}/bills`)).data.bills.length;
    ok('删除后账单数减 1', after2 === after - 1, after + ' → ' + after2);
    const rd3 = await req('GET', '/api/rooms/' + roomId);
    ok('删除后房间 bill_count 已重算', rd3.data.room.bill_count === after2, String(rd3.data.room.bill_count));

    /* ===== 9. 安全：不得把 API Key 泄漏到接口 ===== */
    section('9. 安全边界');
    const engStr = JSON.stringify(eng.data);
    ok('引擎状态不泄漏任何 Key', !/sk-|api[_-]?key/i.test(engStr));
  } catch (e) {
    fail++;
    failures.push('测试执行异常: ' + (e && e.message));
    console.log('\n❌ 测试执行异常：' + (e && e.stack));
  } finally {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } else {
        proc.kill('SIGKILL');
      }
    } catch (e) { /* ignore */ }
    await new Promise((r) => setTimeout(r, 800));
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  console.log('\n========================================');
  console.log(`服务器集成测试：通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) failures.forEach((f) => console.log('  ❌ ' + f));
  console.log('========================================');
  process.exit(fail === 0 ? 0 : 1);
})();
