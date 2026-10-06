/**
 * browser.check.js —— Demo 浏览器端验收（无头）
 *
 * 用 jsdom 加载 demo/index.html，真实执行页面脚本、真实派发点击/输入事件，
 * 依次跑 #selftest / #tourtest / #uitest 三个挂钩，读取 document.title 判定。
 *
 * 为什么不用 --headless --dump-dom：本机 Edge/Chrome 的 --dump-dom 在该环境
 * 下始终输出 0 字节，因此改用 jsdom，保证验收可离线、可 CI。
 *
 * 用法：node tests/browser.check.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEMO = path.join(ROOT, 'demo', 'index.html');

let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch (e) {
  console.error('缺少 jsdom，请先执行：npm install jsdom');
  process.exit(2);
}

/* ---------- 逐个 mode 跑一遍 ---------- */
async function runMode(mode, hash, expectKey, waitMs) {
  const html = fs.readFileSync(DEMO, 'utf8');
  const errors = [];

  const dom = new JSDOM(html, {
    url: 'file:///' + DEMO.replace(/\\/g, '/') + hash,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(window) {
      // 离线环境：fetch 一律失败，走本地规则引擎（等价 file:// 现状）
      window.fetch = () => Promise.reject(new Error('offline'));
      window.AbortController = window.AbortController || function () {
        this.signal = {}; this.abort = function () {};
      };
      // jsdom 的 layout 全为 0，给一个最小可用的度量兜底
      window.HTMLElement.prototype.getBoundingClientRect =
        window.HTMLElement.prototype.getBoundingClientRect || function () {
          return { left: 0, right: 375, top: 0, bottom: 0, width: 375, height: 0, x: 0, y: 0 };
        };
      window.addEventListener('error', (e) => errors.push(String(e.message || e.error)));
      window.addEventListener('unhandledrejection', (e) => errors.push('unhandled: ' + String(e.reason)));
    },
  });

  const { window } = dom;
  await new Promise((r) => {
    if (window.document.readyState === 'complete') return r();
    window.addEventListener('load', r);
    setTimeout(r, 8000);
  });
  // 等 #hash 挂钩的 setTimeout(300~400ms) 跑完
  await new Promise((r) => setTimeout(r, waitMs));

  const title = window.document.title || '';
  const panel = window.document.getElementById('testPanel');
  /* ⚠️ 不能按 spans[1] 取结论：`<span>名称 <span>补充</span></span><span class="test-ok">`
     的第二个 span 往往是**补充说明**而不是 PASS/FAIL，会把失败项误判成通过。
     直接按语义类名取。 */
  const rows = panel ? Array.from(panel.querySelectorAll('.test-row')).map((el) => {
    const nameEl = el.querySelector('span');
    const verdictEl = el.querySelector('.test-ok,.test-no');
    return {
      name: nameEl ? nameEl.textContent.trim() : '',
      verdict: verdictEl ? verdictEl.textContent.trim() : '',
    };
  }) : [];
  const fails = rows.filter((r) => r.verdict !== 'PASS');
  const allPass = new RegExp('^' + expectKey + ' \\d+/\\d+ ALL-PASS$').test(title);

  dom.window.close();

  return { mode, title, allPass, total: rows.length, fails, errors };
}

/* ---------- 主流程 ---------- */
(async function main() {
  const modes = [
    ['selftest', '#selftest', 'SELFTEST', 3000],
    ['tourtest', '#tourtest', 'TOURTEST', 3000],
    /* uitest 里含一次完整的 #auto 自动演示（24 个分镜，每镜都有停顿），
       所以等待时间要给够；不够就会在演示跑完前读到中间态。 */
    ['uitest', '#uitest', 'UITEST', 120000],
  ];

  let bad = 0;
  const summary = [];

  for (const [mode, hash, key, wait] of modes) {
    process.stdout.write(`\n—— 浏览器验收 · ${mode} ——\n`);
    let r;
    try {
      r = await runMode(mode, hash, key, wait);
    } catch (e) {
      console.log(`  ❌ 运行异常：${e && e.message}`);
      bad++;
      summary.push({ mode, ok: false, title: 'ERROR ' + (e && e.message) });
      continue;
    }
    console.log(`  document.title = ${r.title || '(空)'}`);
    if (r.total === 0) {
      console.log('  ❌ 未产生任何检查项（页面脚本可能未执行）');
      bad++;
      summary.push({ mode, ok: false, title: r.title });
      continue;
    }
    r.fails.forEach((f) => console.log(`  ❌ ${f.name}`));
    /* 页面运行时报错必须**算失败**，不能只当警告：
       以前只在旁边打一行 ⚠️ 就算过，于是"某个 onclick 抛异常但自检项照样 PASS"
       这种最危险的假绿会被漏掉。 */
    if (r.errors.length) {
      r.errors.slice(0, 5).forEach((e) => console.log(`  ❌ 页面运行时报错：${e}`));
    }
    const ok = r.allPass && r.fails.length === 0 && r.errors.length === 0;
    if (!ok) bad++;
    console.log(`  ${ok ? '✅' : '❌'} ${r.mode}：${r.total - r.fails.length}/${r.total} 通过` +
      (r.errors.length ? ` · 运行时报错 ${r.errors.length} 处` : ''));
    summary.push({ mode, ok, title: r.title });
  }

  console.log('\n========================================');
  if (bad === 0) console.log('浏览器端验收全部通过（selftest / tourtest / uitest）');
  else console.log(`浏览器端验收存在 ${bad} 项未通过`);
  console.log('========================================');
  process.exit(bad === 0 ? 0 : 1);
})();
