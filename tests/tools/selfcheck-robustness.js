/**
 * selfcheck-robustness.js — 自检是否"看状态脸色"（开发者用，不进 CI）
 *
 * 起因：评委走查里点了「🩺 自检」，评委区那面数字墙显示成 `21/22` ——
 *       也就是说自检会在某些页面状态下**失败一项**。对评委来说这是"红字"。
 * 本工具在几种真实状态下各跑一次 runSelfTest，把失败项打出来。
 *
 * 用法：node tests/tools/selfcheck-robustness.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..', '..');
const DEMO = path.join(ROOT, 'demo', 'index.html');
const html = fs.readFileSync(DEMO, 'utf8');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function boot() {
  const errors = [];
  const dom = new JSDOM(html, {
    url: 'file:///' + DEMO.replace(/\\/g, '/'),
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
    beforeParse(w) {
      w.fetch = () => Promise.reject(new Error('offline'));
      w.HTMLElement.prototype.getBoundingClientRect = function () {
        return { left: 100, right: 400, top: 200, bottom: 800, width: 300, height: 600, x: 100, y: 200 };
      };
      w.addEventListener('error', (e) => errors.push(String(e.message || e.error)));
    },
  });
  return { dom, errors };
}
async function ready(dom) {
  const d = dom.window.document;
  await new Promise((r) => { if (d.readyState === 'complete') return r(); d.addEventListener('load', r); setTimeout(r, 8000); });
  await wait(400);
}

/* 复现几种"评委可能停在"的状态，每种都跑一次自检 */
const CASES = [
  { id: 'clean', desc: '刚打开（干净态）', setup: null },
  { id: 'after-tour', desc: '听完导览退出后（u1 停在记一笔）', setup: async (w) => { w.startTour(); await wait(500); w.tourExit(); await wait(400); } },
  { id: 'add-page', desc: 'u1 停在记一笔页（房间已建）', setup: async (w) => { w.ensureDemoRoom(); w.goPhone('u1', 'add'); await wait(200); } },
  { id: 'after-demo', desc: '看过自动演示中途 Esc 后', setup: async (w) => { w.autoDemo(); await wait(3000); w.exitAllModes(); await wait(300); } },
  { id: 'no-room', desc: '重置后（无房间）', setup: async (w) => { w.resetAll(); await wait(200); } },
];

(async () => {
  let bad = 0;
  for (const c of CASES) {
    const { dom } = boot(); const w = dom.window, d = w.document;
    await ready(dom);
    if (c.setup) await c.setup(w);
    w.runSelfTest();
    await wait(150);
    const rows = [].slice.call(d.querySelectorAll('.test-row')).map((el) => ({
      name: el.querySelector('span').textContent.trim(),
      ok: !!el.querySelector('.test-ok'),
    }));
    const failed = rows.filter((r) => !r.ok);
    const score = d.querySelector('.test-hd div:last-child');
    console.log('\n[' + c.id + '] ' + c.desc);
    console.log('  ' + (score ? score.textContent : '?') + (failed.length ? '  ❌' : '  ✅'));
    failed.forEach((f) => console.log('    ❌ ' + f.name));
    if (failed.length) bad++;
  }
  console.log('\n' + (bad ? '❌ ' + bad + ' / ' + CASES.length + ' 种状态下自检会失败' : '✅ 所有状态下自检都是满分'));
  process.exit(0);
})();
