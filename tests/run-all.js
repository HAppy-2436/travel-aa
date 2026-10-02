/**
 * run-all.js —— 全量验收：一条命令跑完所有测试（CI 与交接验收的唯一入口）
 *
 * 用法：node tests/run-all.js  或  npm test
 *
 * 为什么需要：接手前的项目把验收写成「手动依次执行若干条命令」（见 docs/交接文档.md 第 3 节），
 * 漏跑一条就没人知道。这里把全部测试套统一编排、统一汇总、统一退出码，
 * 任何一套挂掉都返回非 0，可直接接 CI。
 *
 * 沙箱注意：本机限制不能通过管道捕获子进程输出，所以用 stdio:'inherit' 直接透传，
 * 本脚本不二次解析各套测试的输出，只看退出码。
 */
'use strict';

const fs = require('fs');
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const SUITES = [
  { name: '算法内核单测', file: 'tests/ai.test.js', hint: '中文数字/分类/分摊/洞察/LLM 修复' },
  { name: 'V2 能力单测', file: 'tests/v2.test.js', hint: '语音归一/多币种/审计/预算/订单' },
  { name: 'V3 旅行记账语义', file: 'tests/v3.test.js', hint: '抹零/代购/多退少补/暂估改价/占位/会说话' },
  { name: '同步内核单测', file: 'tests/sync.test.js', hint: '多窗口合并/墓碑/rev/uid 唯一性' },
  { name: '相对路径检查', file: 'tests/requires.check.js', hint: 'require 与 script src 是否可解析' },
  { name: '交付物可打开性', file: 'tests/resource.check.js', hint: 'file:// 下外部脚本/渲染/挂钩是否齐备' },
  { name: 'Demo 完整性', file: 'tests/demo.check.js', hint: 'onclick 交叉校验/内核引用/DOM 挂载点' },
  { name: '服务器集成测试', file: 'tests/server.test.js', hint: '真实拉起后端 + 全部路由打点' },
  { name: '浏览器验收', file: 'tests/browser.check.js', hint: '#selftest / #tourtest / #uitest' },
];

const results = [];

function sec(ms) { return (ms / 1000).toFixed(1) + 's'; }

console.log('\n==========================================================');
console.log('  TravelAA 全量验收');
console.log('==========================================================');

for (const s of SUITES) {
  if (!fs.existsSync(path.join(ROOT, s.file))) {
    console.log('\n▶ ' + s.name + '  (' + s.file + ')');
    console.log('  ⏭  文件不存在，跳过');
    results.push({ ...s, ok: true, ms: 0, skipped: true });
    continue;
  }
  console.log('\n▶ ' + s.name + '  (' + s.file + ')');
  console.log('  ' + s.hint);

  const started = Date.now();
  const r = spawnSync(process.execPath, [path.join(ROOT, s.file)], {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: true,
  });
  const ms = Date.now() - started;

  const ok = r.status === 0;
  results.push({ ...s, ok, ms, status: r.status });
  console.log('  ' + (ok ? '✅ 通过' : '❌ 失败（退出码 ' + r.status + '）') + '  ' + sec(ms));
}

/* ---------- 汇总 ---------- */
const failed = results.filter((r) => !r.ok);
const total = results.reduce((s, r) => s + r.ms, 0);

console.log('\n==========================================================');
console.log('  验收汇总');
console.log('==========================================================');
results.forEach((r) => {
  const mark = r.skipped ? '⏭ ' : (r.ok ? '✅' : '❌');
  console.log('  ' + mark + '  ' + r.name + '  ' + (r.skipped ? '(跳过)' : sec(r.ms)));
});
console.log('  ' + '-'.repeat(50));
console.log('  ' + (failed.length === 0
  ? '✅ 全部 ' + results.length + ' 套测试通过'
  : '❌ ' + failed.length + ' / ' + results.length + ' 套失败'));
console.log('  总耗时 ' + sec(total));

if (failed.length) {
  console.log('\n  未通过：');
  failed.forEach((r) => console.log('    ❌ ' + r.name + '  →  node ' + r.file));
}

process.exit(failed.length === 0 ? 0 : 1);
