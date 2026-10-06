/**
 * resource.check.js —— 交付物「双击即开」真实性核查
 *
 * 交接文档声称 Demo 是「单文件、双击即开、离线可用」。但实际上：
 *   1. demo/index.html 通过 <script src> 引用了 3 个外部文件（file:// 下是否可加载？）
 *   2. 还引用了 Google Fonts 的远程样式（离线时字体降级，是否影响观感？）
 *
 * 本检查在 file:// 语义下用 jsdom 真实加载页面，断言：
 *   - 三个外部脚本确实被加载并暴露全局（TravelAI / TravelCTrip / VISION_SAMPLES）
 *   - 页面主渲染函数可执行、手机框渲染出来
 *   - 记录远程字体链接的存在（离线降级提示，不算失败）
 *
 * 用法：node tests/resource.check.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch (e) {
  console.error('缺少 jsdom，请先执行：npm install jsdom');
  process.exit(2);
}

const ROOT = path.resolve(__dirname, '..');
const DEMO = path.join(ROOT, 'demo', 'index.html');

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  → ' + extra : '')); }
  else { fail++; failures.push(name); console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

(async function main() {
  console.log('\n—— 交付物「双击即开」核查（file:// 语义）——');

  const html = fs.readFileSync(DEMO, 'utf8');
  const fileUri = 'file:///' + DEMO.replace(/\\/g, '/');
  const loadErrors = [];

  const dom = new JSDOM(html, {
    url: fileUri,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = () => Promise.reject(new Error('offline'));
      window.addEventListener('error', (e) => loadErrors.push(String(e.message || e.error)), true);
    },
  });

  const { window } = dom;
  await new Promise((r) => {
    if (window.document.readyState === 'complete') return r();
    window.addEventListener('load', r);
    setTimeout(r, 10000);
  });
  await new Promise((r) => setTimeout(r, 1200));

  const d = window.document;

  /* 1. 外部脚本是否真的加载成功 */
  ok('外部脚本 ai.js 暴露 TravelAI 全局', typeof window.TravelAI === 'object' && !!window.TravelAI,
    window.TravelAI ? ('导出 ' + Object.keys(window.TravelAI).length + ' 个方法') : '未加载');
  ok('外部脚本 ctrip.js 暴露 TravelCTrip 全局', typeof window.TravelCTrip === 'object' && !!window.TravelCTrip,
    window.TravelCTrip ? ('导出 ' + Object.keys(window.TravelCTrip).length + ' 个方法') : '未加载');

  const visionKeys = Object.keys(window).filter((k) => /VISION|vision|SAMPLE|sample/i.test(k));
  ok('外部脚本 vision-samples.js 暴露样例数据', visionKeys.length > 0, visionKeys.join(', ') || '未加载');

  ok('页面内 AI 适配层已挂载', !!(window.AI && window.AI.parseBillText));
  ok('页面内携程适配层已挂载', !!(window.CTRIP && window.CTRIP.parseOrders));

  /* 2. 页面渲染 */
  const stage = d.getElementById('phonesStage');
  ok('手机舞台挂载点存在', !!stage);
  ok('手机框已渲染', !!d.querySelector('#phone-u1 .pf'), d.querySelectorAll('#phone-u1 .pf').length + ' 个');
  ok('首页内容已渲染（App 容器）', !!d.querySelector('#app-u1 .an'));
  /* 工具条：新结构为「状态徽标 + 人数步进器 + 操作按钮 + 主行动」
     —— 断言"关键交互都在"，而不是数按钮个数（结构可演进） */
  const tbar = d.querySelector('.tbar');
  ok('工具条存在', !!tbar);
  ok('工具条：引擎状态徽标', !!d.getElementById('engineBadge'));
  ok('工具条：人数步进器（−/＋ 与人数合并为一个控件）',
    !!d.querySelector('.tbar .stepper') && !!d.getElementById('phoneCountLabel'),
    d.querySelector('.stepper b') ? d.querySelector('.stepper b').textContent.trim() : '');
  const acts = Array.from(tbar ? tbar.querySelectorAll('.cb') : []).map((b) => b.textContent.trim());
  ok('工具条：自检入口', acts.some((t) => /自检/.test(t)));
  ok('工具条：导览入口', acts.some((t) => /导览/.test(t)));
  ok('工具条：重置入口', acts.some((t) => /重置/.test(t)));
  ok('工具条：自动演示为唯一主行动（.cb.pr）', !!d.querySelector('.tbar .cb.pr'),
    (d.querySelector('.tbar .cb.pr') || {}).textContent);
  ok('工具条不再是 8 个等重按钮（操作按钮 `.cb` 数量 ≤ 5）', acts.length <= 5, acts.length + ' 个按钮');
  /* 状态徽标不是按钮：引擎/同步状态是"显示"，不该混进操作入口计数 */
  ok('工具条：同步状态徽标（role=status，可被读屏播报）',
    !!d.getElementById('syncBadge') && d.getElementById('syncBadge').getAttribute('role') === 'status',
    (d.getElementById('syncBadge') || {}).textContent);
  ok('工具条：状态徽标不使用 .cb 类（避免与操作按钮混淆）',
    !d.querySelector('.tbar .cb.dot') && !d.getElementById('syncBadge').classList.contains('cb'));
  /* 人数步进器必须是真 <button>：原来的 <i onclick> 键盘到不了 */
  const stepBtns = Array.from(d.querySelectorAll('.tbar .stepper button'));
  ok('★ 人数步进器用真 <button>（键盘可达）', stepBtns.length === 2,
    stepBtns.map((b) => b.getAttribute('aria-label') || b.textContent).join(' / '));

  /* 3. 核心算法在浏览器形态下可用 */
  if (window.AI) {
    const p = window.AI.parseBillText('打车去机场86块，我垫的，和小红小李平分',
      [{ id: 'u1', name: '小明' }, { id: 'u2', name: '小红' }, { id: 'u3', name: '小李' }], { meName: '小明' });
    ok('浏览器内一句话记账可用', p && p.amount === 86, p && ('金额 ' + p.amount + ' · ' + p.category));
    const parts = window.AI.allocateEvenly(100, 3);
    const sum = Math.round(parts.reduce((s, v) => s + v, 0) * 100) / 100;
    ok('浏览器内均分尾差安全', sum === 100, parts.join(' + '));
  }

  /* 4. 远程字体：离线降级提示（不算失败，但必须让使用者知道） */
  const remoteFonts = Array.from(d.querySelectorAll('link[href]'))
    .map((l) => l.getAttribute('href'))
    .filter((h) => /^https?:/.test(h));
  console.log('\n  ℹ️  远程资源（离线时会静默降级，不影响功能）：');
  remoteFonts.forEach((u) => console.log('     · ' + u));
  console.log('     若字体加载失败，界面会回退到系统无衬线字体 —— 排版仍正常，观感略有差异。');

  /* 5. 自检挂钩存在（用户可用 #selftest 自验） */
  ok('提供 #selftest 挂钩', /#selftest/.test(html));
  ok('提供 #uitest 挂钩', /#uitest/.test(html));
  ok('提供 #tourtest 挂钩', /#tourtest/.test(html));
  ok('提供 ?n= 手机台数参数（多人开场）', /\[\?&#\]n=\(\\d\+\)/.test(html));

  dom.window.close();

  console.log('\n========================================');
  console.log(fail === 0 ? '交付物可双击即开（file:// 下资源齐备）' : ('存在 ' + fail + ' 项问题'));
  if (fail) failures.forEach((f) => console.log('  ❌ ' + f));
  console.log('========================================');
  process.exit(fail === 0 ? 0 : 1);
})();
