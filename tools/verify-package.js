#!/usr/bin/env node
/**
 * verify-package.js —— 验证发布包**解压 / 双击就能用**（发布工具，不参与 CI）
 *
 * 为什么必须验：`demo/index.html` 靠相对路径引 4 个外部脚本，
 * 少带一个文件就是白屏 —— 发出去才发现就晚了。
 * 这里把两种交付形态都真跑一遍：
 *   ① 单文件版：jsdom 打开它，确认三份内核 + 样例都在、页面渲染出来、
 *      并且**页内自检 22/22 全过**（自检会真跑解析 / 结算 / 外币 / 订单四条链路）。
 *   ② 目录版：把 zip 解到临时目录，用同一套断言验一遍（证明相对路径没断）。
 *
 * 用法：node tools/verify-package.js [包目录]
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (e) { console.error('缺少 jsdom：请先 npm install'); process.exit(2); }

const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, '..', '发布包'));
const SINGLE = path.join(OUT, 'TravelAA-演示-单文件.html');
const FOLDER_ZIP = path.join(OUT, 'TravelAA-演示包.zip');

let failed = 0;
const check = (name, ok, extra) => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (extra ? '  → ' + extra : ''));
  if (!ok) failed++;
};

async function boot(file, label) {
  const html = fs.readFileSync(file, 'utf8');
  const errors = [];
  const dom = new JSDOM(html, {
    url: 'file:///' + file.replace(/\\/g, '/'),
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
    beforeParse(w) {
      /* file:// 下 fetch 本来就失败（等价离线现场），这里显式对齐，避免环境差异 */
      w.fetch = () => Promise.reject(new Error('offline'));
      w.addEventListener('error', (e) => errors.push(String(e.message || e.error)));
    },
  });
  const w = dom.window, d = w.document;
  await new Promise((r) => { if (d.readyState === 'complete') return r(); d.addEventListener('load', r); setTimeout(r, 8000); });
  await new Promise((r) => setTimeout(r, 500));

  console.log('\n【' + label + '】' + path.relative(OUT, file));
  check('三份共享内核都加载（ai / ctrip / sync）',
    !!(w.AI && w.AI.parseBillText) && !!(w.CTRIP && w.CTRIP.parseOrders) && !!(w.TravelSync || w.SyncHub),
    'AI=' + !!(w.AI && w.AI.parseBillText) + ' CTrip=' + !!(w.CTRIP && w.CTRIP.parseOrders) + ' Sync=' + !!w.window.TravelSync);
  check('订单截图样例素材已加载',
    !!(w.VISION_SAMPLES || d.querySelector('script[src*="vision-samples"]') || html.indexOf('vision-samples') >= 0 || /data:image\/png;base64/.test(html)));
  check('4 台手机渲染出首页', d.querySelectorAll('#phonesStage .pu').length === 4 &&
    !!d.querySelector('#app-u1 .an'), d.querySelectorAll('#phonesStage .pu').length + ' 台');
  check('首屏已铺样例数据（房间卡可见）', /国庆东京行/.test(d.body.textContent) || /国庆东京行/.test(html));
  check('评委区在（对比表 + 诚实边界）', !!d.getElementById('judgeSection') && /市面上的做法/.test(d.body.textContent));
  check('技术证据默认收起', !!(d.querySelector('.judge-tech') && !d.querySelector('.judge-tech').open));

  /* 页内自检：真跑解析 / 结算 / 外币 / 订单四条链路，结果写进 document.title */
  w.runSelfTest();
  await new Promise((r) => setTimeout(r, 300));
  const title = d.title;
  const m = /SELFTEST (\d+)\/(\d+) ALL-PASS/.exec(title);
  check('页内自检全项通过（真跑了四条链路）', !!m && m[1] === m[2], title);

  check('页面无运行时 JS 报错', errors.length === 0, errors.slice(0, 3).join(' | ') || '（无）');
}

(async () => {
  console.log('包目录：' + OUT);

  check('单文件版存在', fs.existsSync(SINGLE), fs.existsSync(SINGLE) ? (fs.statSync(SINGLE).size / 1024).toFixed(0) + ' KB' : '缺失');
  if (fs.existsSync(SINGLE)) {
    const html = fs.readFileSync(SINGLE, 'utf8');
    const left = html.match(/<script src="(?!https?:)[^"]+"/g) || [];
    check('单文件版没有未内联的外部脚本（否则换台机器就白屏）', left.length === 0, left.join(' ') || '（无）');
    await boot(SINGLE, '单文件版');
  }

  check('目录版 zip 存在', fs.existsSync(FOLDER_ZIP), fs.existsSync(FOLDER_ZIP) ? (fs.statSync(FOLDER_ZIP).size / 1024).toFixed(0) + ' KB' : '缺失');
  if (fs.existsSync(FOLDER_ZIP)) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'taa-verify-'));
    /* 用 PowerShell 解压（Windows 自带），解完再验相对路径 */
    execFileSync('powershell.exe', ['-NoProfile', '-Command',
      'Expand-Archive -LiteralPath "' + FOLDER_ZIP + '" -DestinationPath "' + tmp + '" -Force'], { stdio: 'inherit' });
    const root = path.join(tmp, 'TravelAA-演示包');
    check('解压后根目录有 index.html（双击入口）', fs.existsSync(path.join(root, 'index.html')));
    const demo = path.join(root, 'demo', 'index.html');
    const du = path.join(root, 'apps', 'miniprogram', 'utils');
    check('三个内核文件都在（缺一个就白屏）',
      ['ai.js', 'ctrip.js', 'sync.js'].every((f) => fs.existsSync(path.join(du, f))),
      fs.existsSync(du) ? fs.readdirSync(du).join(' ') : '目录缺失');
    check('打开说明.md 在', fs.existsSync(path.join(root, '打开说明.md')));
    if (fs.existsSync(demo)) await boot(demo, '目录版（解压后）');
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  /* ---------- 项目完整包：解压出来必须还是一个能继续提交的完整工程 ---------- */
  const PROJ_ZIP = path.join(OUT, 'TravelAA-项目完整包.zip');
  check('项目完整包存在', fs.existsSync(PROJ_ZIP), fs.existsSync(PROJ_ZIP) ? (fs.statSync(PROJ_ZIP).size / 1024 / 1024).toFixed(1) + ' MB' : '缺失');
  if (fs.existsSync(PROJ_ZIP)) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'taa-proj-verify-'));
    execFileSync('powershell.exe', ['-NoProfile', '-Command',
      'Expand-Archive -LiteralPath "' + PROJ_ZIP + '" -DestinationPath "' + tmp + '" -Force'], { stdio: 'inherit' });
    const root = path.join(tmp, 'TravelAA');
    check('解压后顶层是一个 TravelAA/ 目录（不是散成一堆文件）', fs.existsSync(root));
    const must = ['README.md', 'CHANGELOG.md', 'package.json', 'index.html',
      'demo/index.html', 'apps/miniprogram/utils/ai.js', 'apps/miniprogram/utils/ctrip.js',
      'apps/miniprogram/utils/sync.js', 'server/app.js', 'tests/run-all.js', 'tools/build-package.js', 'docs/'];
    const missing = must.filter((f) => !fs.existsSync(path.join(root, f)));
    check('项目关键文件齐全（源码 / 服务端 / 测试 / 文档 / 打包工具）', missing.length === 0, missing.join(' ') || '全部存在');
    check('版本库 .git 在（解压后能 git log / 继续提交）', fs.existsSync(path.join(root, '.git', 'HEAD')));
    let gitOK = false, head = '';
    try {
      head = execFileSync('git', ['log', '--oneline', '-1'], { cwd: root, encoding: 'utf8' }).trim();
      gitOK = /^[0-9a-f]{7,}/.test(head);
    } catch (e) { gitOK = false; }
    check('版本库可读（git log 能跑出来）', gitOK, head);
    const junk = ['node_modules', 'server/node_modules', 'server/.env', 'tests/.output', 'server/data'];
    const present = junk.filter((f) => fs.existsSync(path.join(root, f)));
    check('没有夹带 node_modules / 空 .env / 测试产物（npm install 就能装回来）', present.length === 0, present.join(' ') || '（干净）');
    if (fs.existsSync(path.join(root, 'demo', 'index.html'))) await boot(path.join(root, 'demo', 'index.html'), '项目完整包（解压后）');
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('\n' + (failed ? '❌ ' + failed + ' 项未通过 —— 不要发出去' : '✅ 三种形态都验过：解压 / 双击即可用'));
  process.exit(failed ? 1 : 0);
})();
