/* 临时：按"交网页"的真实形态验证 ——
   把站点发布成 <root>/travel-aa/（模拟 GitHub Pages 子路径），起静态服务器，
   用真实浏览器打开 http://127.0.0.1:PORT/travel-aa/demo/index.html，
   检查：三个内核脚本 + 样例素材是否都加载、localStorage/BroadcastChannel 是否可用、
   同步徽标显示哪一档、默认几台手机、首屏是否装得下、有没有 404。
   跑完删临时目录。 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SITE = path.join(require('os').tmpdir(), 'travelaa_site_' + Date.now());
const SUB = path.join(SITE, 'travel-aa');
const PORT = 8931;

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}
fs.mkdirSync(SITE, { recursive: true });
for (const rel of ['demo', 'apps', 'index.html']) {
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src)) continue;
  if (fs.statSync(src).isDirectory()) copyDir(src, path.join(SUB, rel));
  else fs.copyFileSync(src, path.join(SUB, rel));
}
console.log('站点已发布到 ' + SUB);

/* 注入一个探针：把关键状态写到页面上 */
const probeTarget = path.join(SUB, 'demo', '_probe.html');
let html = fs.readFileSync(path.join(SUB, 'demo', 'index.html'), 'utf8');
html = html.replace('</body>', `
<script>
setTimeout(function(){
  var de=document.documentElement, vh=window.innerHeight, vw=de.clientWidth;
  var badges={};
  ['engineBadge','syncBadge'].forEach(function(id){var e=document.getElementById(id);badges[id]=e?e.textContent:'(缺)';});
  var stage=document.getElementById('phonesStage'), rows={};
  for(var i=0;i<stage.children.length;i++) rows[Math.round(stage.children[i].getBoundingClientRect().top)]=1;
  var pf=document.querySelector('#phone-u1 .pf');
  var r=pf?pf.getBoundingClientRect():null;
  var ls=false; try{localStorage.setItem('t','1');localStorage.removeItem('t');ls=true;}catch(e){}
  var d=document.createElement('div');
  d.style.cssText='position:fixed;inset:0;z-index:99999;background:#fff;color:#000;font:700 27px/1.4 monospace;padding:26px;white-space:pre-wrap';
  d.textContent=
   'URL 子路径测试  '+location.pathname+'\\n'
   +'内核脚本  AI='+(typeof TravelAI)+' CTrip='+(typeof TravelCTrip)+' Sync='+(typeof TravelSync)+'\\n'
   +'样例素材 VISION_SAMPLES='+(typeof VISION_SAMPLES)+'\\n'
   +'localStorage='+ls+'  BroadcastChannel='+(typeof BroadcastChannel)+'\\n'
   +'同步徽标  '+badges.syncBadge+'   引擎徽标  '+badges.engineBadge+'\\n'
   +'手机 '+stage.children.length+' 台 / '+Object.keys(rows).length+' 行   '+(r?(Math.round(r.width)+'x'+Math.round(r.height)+' 底边 y='+Math.round(r.bottom)+'/'+vh):'?')+'\\n'
   +'视口 '+vw+'x'+vh;
  document.body.appendChild(d);
}, 2000);
</script>
</body>`);
fs.writeFileSync(probeTarget, html);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.map': 'application/json' };
const notFound = [];
const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(SITE, p.replace(/^\/+/, ''));
  if (!f.startsWith(SITE) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    notFound.push(p);
    res.writeHead(404); res.end('404'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
srv.listen(PORT, '127.0.0.1', () => {
  console.log('静态服务器 http://127.0.0.1:' + PORT);
  const shots = [
    ['subpath-demo', '/travel-aa/demo/_probe.html', 1400, 900],
    ['root-redirect', '/travel-aa/', 900, 400],
  ];
  for (const [name, url, w, h] of shots) {
    const out = path.join(ROOT, 'docs', '效果截图', '_host_' + name + '.png');
    spawnSync('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      ['--headless=new', '--disable-gpu', '--no-sandbox', '--user-data-dir=' + path.join(ROOT, 'edgeprof'),
        '--virtual-time-budget=9000', '--window-size=' + w + ',' + h, '--screenshot=' + out,
        'http://127.0.0.1:' + PORT + url],
      { stdio: 'ignore', windowsHide: true });
    console.log(name, fs.existsSync(out) ? 'ok' : 'FAILED');
  }
  console.log('404 请求：', notFound.length ? notFound.join(', ') : '（无）');
  srv.close();
  setTimeout(() => { fs.rmSync(SITE, { recursive: true, force: true }); console.log('临时站点已删除'); }, 500);
});
