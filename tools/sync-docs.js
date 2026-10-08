'use strict';
/* 文档数字同步：把"几套测试/几项断言"从单一来源（实跑结果）刷进所有文档与页面。
   用法：node tools/sync-docs.js            # 只报告差异
        node tools/sync-docs.js --write     # 写入
   为什么需要：验收数字散落在 README / 交接文档 / 效果验收指引 / 架构与实现 / 待办 / demo 页面里，
   手工改必然漂移（本轮就发现 demo 页面写着 875、实际已经 890）。 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const write = process.argv.includes('--write');

/* 跑一遍 run-all，拿权威数字 */
const out = execFileSync(process.execPath, [path.join(ROOT, 'tests', 'run-all.js')], {
  cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
});
const total = /全部 (\d+) 套测试通过（合计 (\d+) 项断言）/.exec(out);
if (!total) {
  console.error('❌ 没能从 run-all 输出里解析出总数，先让 run-all 全绿再跑本脚本');
  process.exit(1);
}
const suites = Number(total[1]), items = Number(total[2]);
const per = {};
for (const m of out.matchAll(/✅\s+(\S[^\n]*?)\s+\d+\.\d+s\s+·\s+(\d+) 项/g)) per[m[1].trim()] = Number(m[2]);
console.log(`权威数字：${suites} 套 / ${items} 项`);
Object.keys(per).forEach((k) => console.log('   · ' + k + '  ' + per[k]));

const FILES = [
  'README.md', 'CHANGELOG.md', 'docs/交接文档.md', 'docs/效果验收指引.md', 'docs/架构与实现.md',
  'docs/待办与路线图.md', 'docs/上手与演示脚本.md', 'docs/演示健壮性与可用性自查.md',
  'docs/部署与配置.md', 'demo/index.html',
];
/* 旧数字 → 新数字（只替换"套数/项数"这类可判定模式，不碰历史 CHANGELOG 里的旧版本记录） */
const PAIRS = [
  [/9 套 \/ 890 项/g, `${suites} 套 / ${items} 项`],
  [/9 套 \/ 890/g, `${suites} 套 / ${items}`],
  [/合计 890 项断言/g, `合计 ${items} 项断言`],
  [/全部 9 套测试通过（合计 890 项断言）/g, `全部 ${suites} 套测试通过（合计 ${items} 项断言）`],
  [/全部 9 套测试通过/g, `全部 ${suites} 套测试通过`],
  [/10 套 \/ 961/g, `${suites} 套 / ${items}`],
  [/11 套 \/ 962/g, `${suites} 套 / ${items}`],
  [/var SUITE_STATS = \{ suites: \d+, items: \d+ \};/g, `var SUITE_STATS = { suites: ${suites}, items: ${items} };`],
  [/id="jnItems">\d+</g, `id="jnItems">${items}<`],
  [/id="jnSuites">\d+</g, `id="jnSuites">${suites}<`],
  [/\| ✅ \| (\d+) \|/g, '| ✅ | ' + suites + ' |'],
];
let changed = 0;
FILES.forEach((rel) => {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return;
  let s = fs.readFileSync(p, 'utf8');
  const before = s;
  PAIRS.forEach(([re, to]) => { s = s.replace(re, to); });
  if (s !== before) {
    changed++;
    console.log((write ? '✍️  写入 ' : '⚠️  需更新 ') + rel);
    if (write) fs.writeFileSync(p, s);
  }
});
console.log(changed ? '' : '✅ 所有文档与页面的验收数字已经一致');
process.exit(0);
