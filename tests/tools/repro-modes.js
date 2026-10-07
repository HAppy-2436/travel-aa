/**
 * repro-modes.js — 整页模式的状态机复现/回归工具（开发者用，不进 CI）
 *
 * 为什么单独有一个工具：`#uitest` 跑在 jsdom 里，能验"状态对不对"，
 * 但"用户是怎么撞上的"这条路径更适合用一个最小脚本钉住。
 * 这里用 jsdom 真跑 demo/index.html、真派发键盘事件，复现三个真实撞到的坑：
 *   A. 点导览后立刻按 Esc → 遮罩残留、导览卡已关 → 整页被压黑（"直接没了，网页卡住了"）
 *   B. 自动演示跑到一半点导览 → 自动演示是否还在后台推进
 *   C. 导览开着时退出演示 → 遮罩/卡片是否留在常规页面上
 *
 * 用法：node tests/tools/repro-modes.js
 * 期望输出：三条全部 `fixed`（改动前应当能看到 REPRODUCED）。
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
const state = (w, tag) => {
  const d = w.document;
  const dm = (id) => { const el = d.getElementById(id); return el ? w.getComputedStyle(el).display : 'none'; };
  return tag + ' -> body="' + d.body.className + '" mask=' + dm('tourMask') +
    ' card=' + dm('tourCard') + ' presentBar=' + dm('presentBar');
};

(async () => {
  let bad = 0;

  console.log('[A] Tour then Esc immediately (inside the 260ms render window)');
  {
    const { dom } = boot(); const w = dom.window, d = w.document;
    await ready(dom);
    d.querySelector('.tbar button[onclick="startTour()"]').click();
    await wait(60);
    console.log('  ', state(w, 'tour start 60ms'));
    d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(700);
    console.log('  ', state(w, 'after Esc 700ms'));
    const stuck = w.getComputedStyle(d.getElementById('tourMask')).display === 'block' &&
      w.getComputedStyle(d.getElementById('tourCard')).display === 'none';
    console.log('  -> mask stuck with card hidden:', stuck ? 'REPRODUCED' : 'fixed');
    if (stuck) bad++;
  }

  console.log('\n[B] Start auto demo, then start tour (must be mutually exclusive)');
  {
    const { dom } = boot(); const w = dom.window, d = w.document;
    await ready(dom);
    d.querySelector('.tbar button[onclick="autoDemo()"]').click();
    await wait(2500);
    const before = { running: w.autoRunning, page: w.USERS[0]._page };
    d.querySelector('.tbar button[onclick="startTour()"]').click();
    await wait(2500);
    const after = { running: w.autoRunning, page: w.USERS[0]._page };
    console.log('   autoRunning', before.running, '->', after.running, '  u1 page', before.page, '->', after.page);
    const still = after.running === true || after.page !== before.page;
    console.log('   auto demo still advancing during tour:', still ? 'REPRODUCED' : 'fixed');
    console.log('   body.className =', d.body.className);
    if (still) bad++;
  }

  console.log('\n[C] Exit present while the tour is open');
  {
    const { dom } = boot(); const w = dom.window, d = w.document;
    await ready(dom);
    d.querySelector('.tbar button[onclick="startTour()"]').click();
    await wait(500);
    w.exitAllModes();
    await wait(700);
    const c = {
      body: d.body.className,
      mask: w.getComputedStyle(d.getElementById('tourMask')).display,
      card: w.getComputedStyle(d.getElementById('tourCard')).display,
    };
    console.log('   after exitAllModes ->', JSON.stringify(c));
    const residue = c.mask === 'block' || c.card === 'block' || /present|touring/.test(c.body);
    console.log('   residue:', residue ? 'REPRODUCED' : 'fixed');
    if (residue) bad++;
  }

  console.log('\n' + (bad ? '❌ ' + bad + ' 项仍然复现' : '✅ 三个坑都不再复现'));
  process.exit(bad ? 1 : 0);
})();
