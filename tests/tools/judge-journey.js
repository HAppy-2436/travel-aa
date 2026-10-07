/**
 * judge-journey.js — 「完全不会用的评委」走查：真实驱动页面、逐步截屏 + 抓可见信息
 *
 * 目的：不用嘴说"易用"，而是把评委从落地到走完一遍的动作**真的做一遍**，
 *       每一步都留下截图和"此刻页面上能点什么"的清单，再据此判断卡在哪。
 *
 * 用法：node tests/tools/judge-journey.js [视口宽] [视口高]
 *   node tests/tools/judge-journey.js 1366 768
 * 输出：docs/效果截图/_journey/NN-*.png  +  终端里的每步状态清单
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'docs', '效果截图', '_journey');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));

const W = parseInt(process.argv[2] || '1366', 10);
const H = parseInt(process.argv[3] || '768', 10);

/* 评委的动作脚本：第 u 步 = 依次做完前 u 个动作。
   动作全部用"页面上看得见的文字"去点，和真人一样（找不到就记下来）。
   ⚠️ 手机内的动作必须限定 scope='#app-u1' —— 4 台手机会同时渲染同名按钮
   （每台都有一个「创建房间」），不限定范围就会点到别的手机上。 */
const ACTIONS = [
  { id: 'land', desc: '打开页面，什么都不做', run: '' },
  { id: 'play', desc: '点「▶ 播放演示」', run: "await click(/播放演示/); await sleep(9000);" },
  { id: 'pause', desc: '点「⏸ 暂停」', run: "await click(/暂停/); await sleep(1200);" },
  { id: 'step', desc: '点「⏭ 下一步」两次', run: "await click(/下一步/); await sleep(1600); await click(/下一步/); await sleep(1600);" },
  { id: 'esc', desc: '按 Esc 想退出', run: "await key('Escape'); await sleep(1400);" },
  { id: 'tour', desc: '点「逐步导览（15 步）」', run: "await click(/逐步导览/); await sleep(1600);" },
  { id: 'tournext', desc: '导览里点「下一步 →」两次', run: "await click(/下一步 →/); await sleep(1400); await click(/下一步 →/); await sleep(1400);" },
  { id: 'arrow', desc: '按 → 方向键三次', run: "await key('ArrowRight'); await sleep(900); await key('ArrowRight'); await sleep(900); await key('ArrowRight'); await sleep(1200);" },
  { id: 'tourexit', desc: '点导览卡里的「退出」', run: "await click(/^退出$/); await sleep(1400);" },
  { id: 'selftest', desc: '点工具栏「🩺 自检」', run: "await click(/自检/); await sleep(2000);" },
  { id: 'close', desc: '关闭自检面板', run: "await click(/关闭/); await sleep(1000);" },
  { id: 'reset', desc: '点「🔄 重置」', run: "await click(/重置/); await sleep(1400);" },
  { id: 'create', desc: '在 u1 手机上点「＋ 创建房间」', run: "await click(/创建房间/, 0, '#app-u1'); await sleep(1500);" },
  { id: 'confirm', desc: '弹窗里点「创建房间」', run: "await click(/^创建房间$/, 0, '#modalBody-u1'); await sleep(1800);" },
  { id: 'addbill', desc: '点手机底部「＋ 记一笔」', run: "await click(/记一笔/, 0, '#app-u1'); await sleep(1500);" },
  { id: 'aibill', desc: '点「💡 例子」→「🤖 智能填表」→「确认记账」', run: "await click(/例子/, 0, '#app-u1'); await sleep(800); await click(/智能填表/, 0, '#app-u1'); await sleep(1500); await click(/确认记账/, 0, '#app-u1'); await sleep(1800);" },
  { id: 'capture', desc: '点底部「📷 识别入账」', run: "await click(/识别入账/, 0, '#app-u1'); await sleep(1600);" },
  { id: 'seed', desc: '点解说条「自己上手」（铺样例数据）', run: "await click(/自己上手/); await sleep(1600);" },
  { id: 'scrollbottom', desc: '往下滚到评委区', run: "w.scrollTo(0, w.document.body.scrollHeight); await sleep(1500);" },
  { id: 'jump', desc: '铺满一屏里点「↓ 结论与验收」', run: "w.enterPresent(); await sleep(600); await click(/结论与验收/); await sleep(1600);" },
];

const PROBE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>journey</title>
<style>html,body{margin:0;background:#0b0b10;overflow:hidden}iframe{border:0;display:block;width:${W}px;height:${H}px}</style>
</head><body><iframe id="f" src="../demo/index.html?cb=${Date.now()}"></iframe><script>
var q = new URLSearchParams(location.search);
var U = parseInt(q.get('u') || '1', 10);
var ACTIONS = ${JSON.stringify(ACTIONS.map((a) => a.run))};
var f = document.getElementById('f');
function report(payload){ try { fetch('/__probe?' + new URLSearchParams({ step: String(U), d: JSON.stringify(payload) })); } catch (e) {} }
function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
f.addEventListener('load', function () {
  var w = f.contentWindow, d = w.document;
  setTimeout(function () {
    var missing = [];
    /* 按可见文字点击：范围覆盖页面级控件与手机内控件；
       scope 用来把"手机里"的动作限定到某一台（4 台手机会同时渲染同名按钮） */
    function click(re, nth, scope) {
      nth = nth || 0;
      var root = scope ? d.querySelector(scope) : d;
      if (!root) { missing.push('找不到范围: ' + scope); return null; }
      var sel = 'button, .btn, .cb, .narr-btn, .pshow-btn, .pshow-jump, .ct2, .rc, .bd, .ca, .orc, .an-b, .mc, .ag .btn';
      var list = [].slice.call(root.querySelectorAll(sel)).filter(function (el) {
        var t = (el.textContent || '').replace(/\\s+/g, ' ').trim();
        if (!re.test(t)) return false;
        var r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (!list[nth]) { missing.push('点不到: ' + re + ' #' + nth + (scope ? ' in ' + scope : '')); return null; }
      list[nth].click();
      return list[nth];
    }
    function key(k) {
      var ev = new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
      d.dispatchEvent(ev);
    }
    (async function () {
      try {
        for (var i = 0; i < U; i++) {
          if (!ACTIONS[i]) continue;
          await new Function('click', 'key', 'sleep', 'w', 'd',
            'return (async function(){' + ACTIONS[i] + '})();')(click, key, sleep, w, d);
        }
      } catch (e) { missing.push('脚本异常: ' + e.message); }
      await sleep(300);
      var vis = function (sel) {
        return [].slice.call(d.querySelectorAll(sel)).filter(function (el) {
          var r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        }).map(function (el) { return (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 26); });
      };
      var body = d.body;
      report({
        step: U, label: ${JSON.stringify(ACTIONS.map((a) => a.id))}[U - 1], desc: ${JSON.stringify(ACTIONS.map((a) => a.desc))}[U - 1],
        body: body.className,
        missing: missing,
        scrollY: Math.round(w.scrollY || 0),
        judgeTop: (function () {
          var j = d.getElementById('judgeSection');
          return j ? Math.round(j.getBoundingClientRect().top) : null;
        })(),
        narr: (d.getElementById('shellNarr') || {}).textContent || (d.getElementById('presentNarr') || {}).textContent || '',
        shellStep: (d.getElementById('shellStep') || {}).textContent || '',
        toolbar: vis('.tbar button, .tbar .bdg'),
        narrBtns: vis('.narr button'),
        topRow: vis('.pshow-top button, .pshow-top .pshow-step'),
        tourCard: vis('.tour-card button, .tour-card .tour-step, .tour-card .tour-title'),
        phoneButtons: vis('#app-u1 button, #app-u1 .bd, #app-u1 .an-b'),
        visibleHint: vis('.fh, .amb .aml, .em .et, .em .es').slice(0, 8),
        title: (d.querySelector('#app-u1 .an-t') || {}).textContent || '',
        errors: missing
      });
      document.title = 'JOURNEY-READY ' + U;
    })();
  }, 700);
});
</script></body></html>`;

const reports = new Map();
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/__probe') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok');
    try { const d = JSON.parse(u.searchParams.get('d')); reports.set(d.step, d); } catch (e) { /* ignore */ }
    return;
  }
  if (u.pathname === '/__journey.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(PROBE);
    return;
  }
  const file = path.join(ROOT, decodeURIComponent(u.pathname).replace(/^\//, ''));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('404');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

function shot(url, out) {
  return new Promise((resolve) => {
    const p = spawn(EDGE, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
      '--disk-cache-size=1', '--window-size=' + W + ',' + H, '--virtual-time-budget=45000',
      '--screenshot=' + out, url], { stdio: 'ignore' });
    p.on('exit', () => resolve());
  });
}

(async () => {
  if (!EDGE) { console.log('⚠️ 没找到 Edge'); process.exit(0); }
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  fs.mkdirSync(OUT, { recursive: true });
  fs.readdirSync(OUT).forEach((f) => fs.unlinkSync(path.join(OUT, f)));

  for (let i = 1; i <= ACTIONS.length; i++) {
    const url = 'http://127.0.0.1:' + port + '/__journey.html?u=' + i;
    const out = path.join(OUT, String(i).padStart(2, '0') + '-' + ACTIONS[i - 1].id + '.png');
    await shot(url, out);
    const r = reports.get(i);
    console.log('\n' + '='.repeat(72));
    console.log('第 ' + i + ' 步 · ' + ACTIONS[i - 1].desc);
    if (!r) { console.log('  ❌ 没拿到状态报告'); continue; }
    console.log('  body        : ' + r.body);
    console.log('  当前页面    : ' + r.title + '   · 解说「' + String(r.narr).slice(0, 40) + '」');
    console.log('  滚动        : scrollY=' + r.scrollY + ' · 评委区 top=' + r.judgeTop);
    console.log('  顶部工具栏  : ' + (r.toolbar.join(' | ') || '(无)'));
    console.log('  解说条按钮  : ' + (r.narrBtns.join(' | ') || '(无)'));
    console.log('  浮动栏按钮  : ' + (r.topRow.join(' | ') || '(无)'));
    if (r.tourCard.length) console.log('  导览卡      : ' + r.tourCard.join(' | '));
    console.log('  手机内可见  : ' + (r.phoneButtons.join(' | ') || '(无)'));
    console.log('  页面提示    : ' + (r.visibleHint.join(' | ') || '(无)'));
    if (r.missing.length) console.log('  ⚠️ ' + r.missing.join(' ; '));
  }
  console.log('\n截图目录：' + path.relative(ROOT, OUT));
  server.close();
  process.exit(0);
})();
