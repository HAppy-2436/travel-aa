/**
 * run-all.js —— 全量验收：一条命令跑完所有测试（CI 与交接验收的唯一入口）
 *
 * 用法：node tests/run-all.js  或  npm test
 *
 * 为什么需要：接手前的项目把验收写成「手动依次执行若干条命令」（见 docs/交接文档.md 第 3 节），
 * 漏跑一条就没人知道。这里把全部测试套统一编排、统一汇总、统一退出码，
 * 任何一套挂掉都返回非 0，可直接接 CI。
 *
 * ---------- 两道"假绿"闸门（都是实测踩过的坑）----------
 *  ① 文件缺失必须算**失败**。原来 `!fs.existsSync` → 记 ok:true 跳过，
 *     于是把某个测试文件删掉/改名，`npm test` 依然全绿 —— 最危险的一种假绿。
 *  ② 每套加**项数下限**。原来只看退出码，若某个断言循环被 `if (false)` 掉、
 *     或早退导致只跑了 3 项就退出 0，也会全绿。现在解析输出里的 ✅/❌ 计数，
 *     低于下限即判失败，并把实际项数打出来。
 *
 * ---------- 为什么不用管道捕获子进程输出 ----------
 * 本机沙箱下 Node 的 stdio:'pipe' 会因命名管道受限而失败（EPERM）。
 * 因此把子进程 stdout/stderr 直接**重定向到临时文件描述符**（不是管道），
 * 跑完读回文件：既能原样透传给用户，又能解析计数。
 */
'use strict';

const fs = require('fs');
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'tests', '.output');

/* min = 输出中 ✅ 行数下限（防"整套静默变空/提前退出"）。
   数值取当前实际项数再留一点余量：正常重构不会误报，被掏空一定会报。 */
const SUITES = [
  { name: '算法内核单测', file: 'tests/ai.test.js', min: 55, hint: '中文数字/分类/分摊/洞察/LLM 修复' },
  { name: 'V2 能力单测', file: 'tests/v2.test.js', min: 125, hint: '语音归一/多币种/审计/预算/订单/边界回归' },
  { name: 'V3 旅行记账语义', file: 'tests/v3.test.js', min: 250, hint: '抹零/代购/多退少补/暂估改价/占位/结算口径守卫' },
  { name: '同步内核单测', file: 'tests/sync.test.js', min: 48, hint: '多窗口合并/墓碑/rev/uid 唯一性' },
  { name: '相对路径检查', file: 'tests/requires.check.js', min: 1, hint: 'require 与 script src 是否可解析' },
  { name: '交付物可打开性', file: 'tests/resource.check.js', min: 22, hint: 'file:// 下外部脚本/渲染/挂钩是否齐备' },
  { name: 'Demo 完整性', file: 'tests/demo.check.js', min: 180, hint: 'onclick 交叉校验/内核引用/功能清单/审计回归' },
  { name: '服务器集成测试', file: 'tests/server.test.js', min: 70, hint: '真实拉起后端 + 全部路由打点' },
  {
    name: '浏览器验收', file: 'tests/browser.check.js', min: 3,
    hint: '#selftest / #tourtest / #uitest',
    /* 三个挂钩各自还要过 "N/N ALL-PASS"，并保证项数不被偷偷削减 */
    browser: [['selftest', 22], ['tourtest', 17], ['uitest', 95]],
  },
];

const results = [];

function sec(ms) { return (ms / 1000).toFixed(1) + 's'; }

/** 跑一套并捕获输出（重定向到文件，避免管道） */
function runSuite(s) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const logPath = path.join(OUT_DIR, path.basename(s.file).replace(/\W+/g, '_') + '.log');
  const fd = fs.openSync(logPath, 'w');
  let status = -1;
  try {
    const r = spawnSync(process.execPath, [path.join(ROOT, s.file)], {
      cwd: ROOT,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
    });
    status = r.status === null ? -1 : r.status;
  } finally {
    fs.closeSync(fd);
  }
  let out = '';
  try { out = fs.readFileSync(logPath, 'utf8'); } catch (e) { /* 读不到就当空输出 */ }
  return { status, out };
}

console.log('\n==========================================================');
console.log('  TravelAA 全量验收');
console.log('==========================================================');

for (const s of SUITES) {
  console.log('\n▶ ' + s.name + '  (' + s.file + ')');
  console.log('  ' + s.hint);

  /* ① 文件缺失 = 失败（原来的假绿源头） */
  if (!fs.existsSync(path.join(ROOT, s.file))) {
    console.log('  ❌ 测试文件不存在：' + s.file);
    results.push({ ...s, ok: false, ms: 0, reason: '测试文件缺失' });
    continue;
  }

  const started = Date.now();
  const { status, out } = runSuite(s);
  const ms = Date.now() - started;

  process.stdout.write(out);

  const okMarks = (out.match(/^\s*✅/gm) || []).length;
  const noMarks = (out.match(/^\s*❌/gm) || []).length;

  const problems = [];
  if (status !== 0) problems.push('退出码 ' + status);
  if (noMarks > 0) problems.push('输出里有 ' + noMarks + ' 个 ❌');
  /* ② 项数下限：防止"只跑了几项就退出 0" */
  if (okMarks < s.min) problems.push('通过项 ' + okMarks + ' < 下限 ' + s.min);

  /* ③ 浏览器套件：三个挂钩必须各自 ALL-PASS，且项数达标 */
  if (s.browser) {
    for (const [key, floor] of s.browser) {
      const m = new RegExp(key.toUpperCase() + ' (\\d+)/(\\d+) ALL-PASS', 'i').exec(out);
      if (!m) problems.push(key + ' 未 ALL-PASS');
      else if (Number(m[2]) < floor || Number(m[1]) !== Number(m[2])) {
        problems.push(key + ' 项数 ' + m[1] + '/' + m[2] + '（期望 ≥ ' + floor + ' 且全通过）');
      }
    }
  }

  const ok = problems.length === 0;
  results.push({ ...s, ok, ms, status, okMarks, reason: problems.join('；') });
  console.log('  ' + (ok ? '✅ 通过' : '❌ 失败') + '  ' + sec(ms) +
    '  · 通过 ' + okMarks + ' 项' + (noMarks ? (' · ❌ ' + noMarks + ' 项') : '') +
    (ok ? '' : ('  → ' + problems.join('；'))));
}

/* ---------- 汇总 ---------- */
const failed = results.filter((r) => !r.ok);
const totalMs = results.reduce((s, r) => s + r.ms, 0);
const totalItems = results.reduce((s, r) => s + (r.okMarks || 0), 0);

console.log('\n==========================================================');
console.log('  验收汇总');
console.log('==========================================================');
results.forEach((r) => {
  console.log('  ' + (r.ok ? '✅' : '❌') + '  ' + r.name + '  ' + sec(r.ms) +
    '  · ' + (r.okMarks || 0) + ' 项' + (r.ok ? '' : ('  · ' + r.reason)));
});
console.log('  ' + '-'.repeat(50));
console.log('  ' + (failed.length === 0
  ? '✅ 全部 ' + results.length + ' 套测试通过（合计 ' + totalItems + ' 项断言）'
  : '❌ ' + failed.length + ' / ' + results.length + ' 套失败'));
console.log('  总耗时 ' + sec(totalMs));

if (failed.length) {
  console.log('\n  未通过：');
  failed.forEach((r) => console.log('    ❌ ' + r.name + '  →  node ' + r.file + '   [' + r.reason + ']'));
}

process.exit(failed.length === 0 ? 0 : 1);
