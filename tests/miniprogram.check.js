'use strict';
/**
 * 小程序端静态闸门（多端一致性 + 已知坑回归）
 *
 * 为什么需要：小程序无法在本机真机运行，但**大部分致命问题都是静态可查的** ——
 *   · WXML 表达式里写函数调用（真机不渲染，白屏级）
 *   · 页面缺 onShow（记完账返回看不到新账）
 *   · WXSS 引用未定义变量（整条声明失效）
 *   · 字号越界（排版守卫）
 *   · 口径各写一份（网页说私账、小程序说集体账）
 * 这些都在这里钉住。每条断言都对应一个真实踩过的坑。
 */
const fs = require('fs');
const path = require('path');

const MP = path.resolve(__dirname, '..', 'apps', 'miniprogram');
const CF = path.resolve(__dirname, '..', 'apps', 'cloudfunctions');
let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  → ' + extra : '')); }
  else { fail++; failures.push(name); console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}
function read(p) { return fs.readFileSync(p, 'utf8'); }
/* 去掉注释再判定：注释里为了说明"以前怎么写错的"必然会提到被禁的写法，
   不剥注释就会把自己的说明文字当成违规（踩过）。 */
function stripComments(src, kind) {
  let s = String(src);
  if (kind === 'html') s = s.replace(/<!--[\s\S]*?-->/g, '');
  if (kind === 'css') s = s.replace(/\/\*[\s\S]*?\*\//g, '');
  if (kind === 'js') s = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  return s;
}
function readCode(p, kind) { return stripComments(read(p), kind); }
function list(dir, ext, out) {
  out = out || [];
  if (!fs.existsSync(dir)) return out;
  for (const n of fs.readdirSync(dir)) {
    if (n === 'node_modules') continue;
    const p = path.join(dir, n);
    if (fs.statSync(p).isDirectory()) list(p, ext, out);
    else if (!ext || p.endsWith(ext)) out.push(p);
  }
  return out;
}

console.log('\n—— A. WXML 里不许出现函数调用（真机不渲染）——');
{
  /* WXML 的 {{ }} 只支持表达式，**不支持函数调用**：
     {{item.amount.toFixed(2)}} / {{list.map(...)}} 在真机上直接不渲染（数值空白）。 */
  const wxmls = list(MP, '.wxml');
  const bad = [];
  const callRe = /\{\{[^}]*\.(toFixed|map|filter|join|slice|split|toUpperCase|toLowerCase|padStart|replace|reduce|sort|find)\s*\(/g;
  wxmls.forEach((f) => {
    const src = readCode(f, 'html');
    src.split(/\r?\n/).forEach((line, i) => {
      callRe.lastIndex = 0;
      if (callRe.test(line)) bad.push(path.relative(MP, f) + ':' + (i + 1) + '  ' + line.trim().slice(0, 80));
    });
  });
  ok('WXML 表达式里没有函数调用（8 处 .toFixed 曾让结算页/统计页数值整块空白）', bad.length === 0, bad.slice(0, 4).join(' | '));
  ok('检查确实扫到了 WXML 文件（不是空跑）', wxmls.length >= 6, wxmls.length + ' 个 wxml');
}

console.log('\n—— B. 依赖后续刷新的页面必须有 onShow ——');
{
  /* 演示模式下 db.watch* 是空函数；没有 onShow 就出现"记完账返回看不到新账"。 */
  const need = ['pages/room/room.js', 'pages/settle/settle.js', 'pages/history/history.js', 'pages/index/index.js'];
  const missing = need.filter((p) => !/onShow\s*\(/.test(read(path.join(MP, p))));
  ok('room / settle / history / index 都有 onShow（记账后返回能看到最新数据）', missing.length === 0, missing.join('、'));
}

console.log('\n—— C. WXSS 不许引用未定义的变量 ——');
{
  const app = read(path.join(MP, 'app.wxss'));
  const defined = new Set();
  (app.match(/--[a-z0-9-]+\s*:/g) || []).forEach((m) => defined.add(m.replace(/\s*:$/, '')));
  /* 页面级 wxss 里也可能自己定义 */
  const wxsss = list(MP, '.wxss');
  wxsss.forEach((f) => {
    (read(f).match(/--[a-z0-9-]+\s*:/g) || []).forEach((m) => defined.add(m.replace(/\s*:$/, '')));
  });
  const undef = new Set();
  wxsss.forEach((f) => {
    (read(f).match(/var\((--[a-z0-9-]+)/g) || []).forEach((m) => {
      const name = m.replace('var(', '');
      if (!defined.has(name)) undef.add(name);
    });
  });
  ok('所有 var(--x) 都有定义（history.wxss 的 5 个变量曾全部落空 → 分隔线整条消失）',
    undef.size === 0, [...undef].join('、'));
}

console.log('\n—— D. 排版守卫：字号在 [10px, 48px] 之间 ——');
{
  /* rpx → px：375 逻辑宽下 1rpx = 0.5px。正文上限 36px（72rpx），
     展示级（hero/大数字）允许到 48px（96rpx），下限 10px（20rpx）。 */
  const bad = [];
  list(MP, '.wxss').forEach((f) => {
    const rel = path.relative(MP, f);
    read(f).split(/\r?\n/).forEach((line, i) => {
      const m = /font-size:\s*(\d+(?:\.\d+)?)rpx/g;
      let x;
      while ((x = m.exec(line))) {
        const px = Number(x[1]) * 0.5;
        if (px < 10 || px > 48) bad.push(rel + ':' + (i + 1) + ' ' + x[1] + 'rpx=' + px + 'px');
      }
    });
  });
  ok('字号都在 [10px, 48px] 内（曾出现 18rpx=9px 看不清、100rpx=50px 跳号）', bad.length === 0, bad.slice(0, 4).join(' | '));
}

console.log('\n—— E. 设计一致性：不做圆头像 / 不引外部字体 / 无彩虹分类条 ——');
{
  const wxmlAll = list(MP, '.wxml').map((f) => readCode(f, 'html')).join('\n');
  const wxssAll = list(MP, '.wxss').map((f) => readCode(f, 'css')).join('\n');
  ok('不再用「圆形首字母头像」（{{item.name[0]}}）', !/\{\{\s*item\.name\[0\]\s*\}\}/.test(wxmlAll));
  ok('不再引用真机上不存在的 Space Grotesk（统一走 --font-num 栈）', !/Space Grotesk/.test(wxssAll));
  const rainbow = ['#FF9800', '#2196F3', '#9C27B0', '#4CAF50', '#E91E63'];
  const hit = rainbow.filter((c) => wxssAll.toUpperCase().includes(c));
  ok('分类条不再 6 色彩虹（统一单色，对齐网页端）', hit.length === 0, hit.join('、'));
  ok('导航栏不再是旧橙色（改白底黑字，与网页同一套身份）',
    /"navigationBarBackgroundColor": "#FFFFFF"/.test(read(path.join(MP, 'app.json'))) &&
    /"navigationBarTextStyle": "black"/.test(read(path.join(MP, 'app.json'))));
  const purple = ['#5b3df5', '#5B3DF5'].filter((c) => wxssAll.includes(c));
  ok('紫色 AI 卡片已换成品牌色（11 处硬编码紫色）', purple.length === 0, purple.join('、'));
}

console.log('\n—— F. 三端口径：页面必须调共享内核，不许各写一份 ——');
{
  const settleUtil = read(path.join(MP, 'utils', 'settle.js'));
  ok('结算工具用内核判据 isSettleable / isPersonalBill（不自己写 scope 判断）',
    /isSettleable/.test(settleUtil) && /isPersonalBill/.test(settleUtil) &&
    !/const scope = b\.scope \|\|/.test(settleUtil));
  ok('结算「总消费」走内核 groupSpend（私账不进集体消费）',
    /totalExpense:\s*Math\.round\(groupSpend\(bills\)\.total/.test(settleUtil));
  const history = read(path.join(MP, 'pages', 'history', 'history.js'));
  ok('统计页用 groupExpenseBills（私账/占位单不进统计）', /groupExpenseBills/.test(history));
  const addBill = read(path.join(MP, 'pages', 'add-bill', 'add-bill.js'));
  ok('记账页提交时带 scope（否则私账上云后被当成集体账）', /scope:\s*form\.scope === 'personal'/.test(addBill));
  ok('均分只摊给还在队里的人（AI.activeMemberIds）', /AI\.activeMemberIds/.test(addBill));
  const room = read(path.join(MP, 'pages', 'room', 'room.js'));
  ok('房间页有「有人先走」的开关（toggleMemberLeave → db.setMemberLeave）',
    /toggleMemberLeave/.test(room) && /setMemberLeave/.test(room));
  const dbjs = read(path.join(MP, 'utils', 'db.js'));
  ok('db 层导出 setMemberLeave 且走内核 toggleMemberLeave',
    /setMemberLeave,/.test(dbjs) && /AI\.toggleMemberLeave/.test(dbjs) &&
    /name:\s*'setMemberLeave'/.test(dbjs));
  ok('云函数 setMemberLeave 存在且只改时间戳（不动账单）',
    fs.existsSync(path.join(CF, 'setMemberLeave', 'index.js')) &&
    !/remove\(\)/.test(read(path.join(CF, 'setMemberLeave', 'index.js'))));
}

console.log('\n—— G. 云函数口径（房间统计不能把私账/调整单算进去）——');
{
  const add = read(path.join(CF, 'addBill', 'index.js'));
  ok('addBill：私账与调整单不计入房间统计',
    /countsInGroup = bill\.scope !== 'personal' && !bill\.isAdjustment/.test(add) &&
    /billCount: _\.inc\(countsInGroup \? 1 : 0\)/.test(add));
  ok('addBill：分摊合计按**分严格相等**（容差 0.05 会让库内 Σsplits ≠ amount）',
    /splitCents !== amountCents/.test(add) && !/Math\.abs\(totalSplit - amount\) > 0\.05/.test(add));
  ok('addBill：调整单（amount=0）能落库且带 isAdjustment/adjustsBillId',
    /isAdjustment: true, adjustsBillId/.test(add) && /调整单金额必须为 0/.test(add));
  const del = read(path.join(CF, 'deleteBill', 'index.js'));
  ok('deleteBill：删私账不会把集体消费减出负数，重算也过滤私账/调整单',
    /countsInGroup \? -1 : 0/.test(del) && /const inGroup = rest\.filter/.test(del));
  const create = read(path.join(CF, 'createRoom', 'index.js'));
  ok('createRoom 支持 budget（前端现在也真的传了）',
    /budget: Number\(budget\) \|\| 0/.test(create) &&
    /budget: Number\(form\.budget\) \|\| 0/.test(read(path.join(MP, 'pages', 'index', 'index.js'))));
}

console.log('\n—— H. 页面可达性（写好的页面必须有入口）——');
{
  const appJson = JSON.parse(read(path.join(MP, 'app.json')));
  const pages = appJson.pages || [];
  ['pages/history/history', 'pages/capture/capture'].forEach((p) => {
    ok('app.json 注册了 ' + p, pages.indexOf(p) >= 0, pages.length + ' 页');
  });
  const room = read(path.join(MP, 'pages', 'room', 'room.js'));
  ok('history（统计）有入口（曾完全不可达）', /goToHistory/.test(room) && /pages\/history\/history/.test(room));
  ok('capture（识别入账）有入口', /goToCapture/.test(room) && /pages\/capture\/capture/.test(room));
  const capture = read(path.join(MP, 'pages', 'capture', 'capture.js'));
  ok('票据识别真的调用了 db.recognizeBill（此前是死代码）', /db\.recognizeBill\(/.test(capture));
  ['capture.js', 'capture.wxml', 'capture.wxss', 'capture.json'].forEach((f) => {
    ok('capture 页文件齐全：' + f, fs.existsSync(path.join(MP, 'pages', 'capture', f)));
  });
}

console.log('\n—— I. 结算页分享要真有画布（点「分享结算」不能没反应）——');
{
  const wxml = read(path.join(MP, 'pages', 'settle', 'settle.wxml'));
  const js = read(path.join(MP, 'pages', 'settle', 'settle.js'));
  ok('settle.wxml 里有 <canvas canvas-id="billCanvas">', /canvas-id="billCanvas"/.test(wxml));
  ok('有预览层（生成后能看见、能保存）', /preview-mask/.test(wxml) && /saveImage/.test(wxml));
  ok('转账行带「待转出 / 待收到 / 与我无关」角色',
    /transfer-role/.test(wxml) && /roleText/.test(js) && /待转出/.test(js) && /待收到/.test(js));
}

console.log('\n—— J. 文件编码与占位符 ——');
{
  const all = list(MP).concat(list(CF)).filter((f) => /\.(js|json|wxml|wxss)$/.test(f));
  const bom = all.filter((f) => {
    const b = fs.readFileSync(f);
    return b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF;
  });
  ok('没有文件带 UTF-8 BOM（PowerShell 的 Set-Content 会偷偷加）', bom.length === 0,
    bom.map((f) => path.basename(f)).join('、'));
  const todos = all.filter((f) => /（配图：|TODO|FIXME|占位待补/.test(read(f)));
  ok('源码里没有 TODO / 配图占位这类未完成标记', todos.length === 0,
    todos.map((f) => path.basename(f)).join('、'));
}

console.log('\n========================================');
console.log(`小程序静态闸门：通过 ${pass} 项，失败 ${fail} 项`);
if (fail) failures.forEach((f) => console.log('   ❌ ' + f));
console.log('========================================');
process.exit(fail === 0 ? 0 : 1);
