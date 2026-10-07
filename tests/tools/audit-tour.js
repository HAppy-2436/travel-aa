/**
 * audit-tour.js — 导览逐步实测（真实浏览器 + 真实布局；开发者用，不进 CI）
 *
 * 为什么需要它：导览的价值全在"高亮框有没有框住该讲的东西、卡片有没有挡住它"，
 * 这两件事**只有真实布局能算**（jsdom 里所有 rect 都是 0，测不出来）。
 * 本工具起一个临时静态服务器，用 Edge 无头加载一个探针页，
 * 逐步走完 TOUR_STEPS 并把每一步的真实测量结果回传给 Node 打印。
 *
 * 每一步报告：
 *   · 目标是否存在 / 是否可见（沿祖先链查 display，不是只查自身）
 *   · 目标是否完整落在视口内（导览会先 scrollIntoView 再量）
 *   · 高亮遮罩是否包住目标（用 demo 写进去的 style 值判断，避开 0.35s 过渡动画）
 *   · 导览卡片是否压住目标（占满大半屏的目标允许重叠 —— 翻上去也躲不开）
 *
 * 用法：node tests/tools/audit-tour.js [宽] [高]
 *   默认 1440×900；建议同时跑 1366×768 与 1280×720（投影仪常见分辨率）。
 * 依赖：本机装有 Edge（--headless=new）与 jsdom 同级的依赖环境。
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));

const W = process.argv[2] || 1440;
const H = process.argv[3] || 900;

/* 探针页：加载 demo，逐步骤量布局，结果用 fetch 回传给本进程 */
const PROBE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>audit</title>
<style>html,body{margin:0;background:#0b0b10}iframe{border:0;display:block;width:${W}px;height:${H}px}</style>
</head><body><iframe id="f" src="./index.html?cb=${Date.now()}"></iframe><script>
var f = document.getElementById('f');
function px(v){return parseFloat(String(v||'0').replace('px',''))||0;}
function send(p){try{fetch('/__probe?d='+encodeURIComponent(JSON.stringify(p)));}catch(e){}}
f.addEventListener('load', function () {
  var w = f.contentWindow;
  setTimeout(function () {
    if (w.ensureDemoRoom) w.ensureDemoRoom();
    if (w.renderPhones) w.renderPhones();
    var rows = [], i = 0, iv = w.window;
    (function step() {
      if (i >= w.TOUR_STEPS.length) { w.exitAllModes(); send({ vw: iv.innerWidth, vh: iv.innerHeight, rows: rows }); return; }
      var s = w.TOUR_STEPS[i];
      w.startTour({ idx: i });
      setTimeout(function () {
        var el = s.sel ? w.document.querySelector(s.sel) : null;
        var card = w.document.getElementById('tourCard');
        var mask = w.document.getElementById('tourMask');
        var r = el ? el.getBoundingClientRect() : null;
        var c = card ? card.getBoundingClientRect() : null;
        var ms = mask ? [mask.style.left, mask.style.top, mask.style.width, mask.style.height] : null;
        var covers = (r && c) ? !(r.right < c.left || r.left > c.right || r.bottom < c.top || r.top > c.bottom) : null;
        var inside = (r && ms) ? (px(ms[0]) <= r.left + 1 && px(ms[0]) + px(ms[2]) >= r.right - 1 &&
          px(ms[1]) <= r.top + 1 && px(ms[1]) + px(ms[3]) >= r.bottom - 1) : null;
        rows.push({
          i: i + 1, sel: s.sel, title: s.title,
          found: !!el, shown: el ? w.isShownDeep(el) : false,
          inView: r ? (r.top >= 0 && r.bottom <= iv.innerHeight + 1) : false,
          top: r ? Math.round(r.top) : null, bottom: r ? Math.round(r.bottom) : null,
          left: r ? Math.round(r.left) : null, right: r ? Math.round(r.right) : null,
          cardUp: card ? card.classList.contains('up') : null,
          cardTop: c ? Math.round(c.top) : null,
          covers: covers, maskInside: inside
        });
        i++; step();
      }, 520);
    })();
  }, 600);
});
</script></body></html>`;

let resolveResult;
const result = new Promise((r) => { resolveResult = r; });

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/__probe') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok');
    try { resolveResult(JSON.parse(u.searchParams.get('d'))); } catch (e) { /* ignore */ }
    return;
  }
  if (u.pathname === '/__probe.html') {
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

(async () => {
  if (!EDGE) { console.log('⚠️ 本机没有找到 Edge，跳过导览实测'); process.exit(0); }
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const url = 'http://127.0.0.1:' + port + '/__probe.html';
  const p = spawn(EDGE, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--disk-cache-size=1',
    '--window-size=' + W + ',' + H, '--virtual-time-budget=40000', '--screenshot=' + path.join(ROOT, 'docs', '效果截图', '_audit_tour.png'), url], { stdio: 'ignore' });
  const data = await Promise.race([result, new Promise((r) => setTimeout(() => r(null), 90000))]);
  p.kill(); server.close();
  if (!data) { console.log('❌ 没拿到探针数据（Edge 起不来？）'); process.exit(1); }

  console.log('视口 ' + data.vw + '×' + data.vh + ' · ' + data.rows.length + ' 步\n');
  let bad = 0;
  data.rows.forEach((r) => {
    const flags = [];
    if (!r.found) flags.push('目标缺失');
    if (r.found && !r.shown) flags.push('目标不可见');
    if (r.found && !r.inView) flags.push('目标不在视口内(' + r.top + '→' + r.bottom + ')');
    /* 占满大半屏的目标（如 #phonesStage）翻到哪儿都躲不开，允许重叠 */
    if (r.covers && !(r.bottom - r.top > data.vh * 0.6)) flags.push('卡片盖住目标');
    if (r.maskInside === false) flags.push('高亮框没包住目标');
    console.log(String(r.i).padStart(2) + '. ' + (flags.length ? '❌ ' + flags.join(' / ') : '✅') +
      '  ' + String(r.title).slice(0, 26) +
      '   目标 [' + r.left + ',' + r.top + ' → ' + r.right + ',' + r.bottom + ']  cardUp=' + r.cardUp);
    if (flags.length) bad++;
  });
  console.log('\n问题步骤：' + bad + ' / ' + data.rows.length);
  process.exit(bad ? 1 : 0);
})();
