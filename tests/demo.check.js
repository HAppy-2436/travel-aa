/**
 * demo 页面完整性检查：node tests\demo.check.js
 *
 * 校验目标：demo/index.html（唯一交付物）
 *  - 内联脚本语法可解析（防止现场白屏）
 *  - 共享内核与素材引用可解析
 *  - 关键 DOM 挂载点与函数存在
 *  - 所有 onclick 处理器都有对应函数定义（防止"点了没反应"）
 *  - 共享 AI 引擎可作为浏览器全局加载并正常工作
 */
const fs = require('fs');
const path = require('path');

const DEMO = path.join(__dirname, '..', 'demo', 'index.html');
const html = fs.readFileSync(DEMO, 'utf8');
let failed = 0;
const report = (name, ok, extra) => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (extra ? ' → ' + extra : ''));
  if (!ok) failed++;
};

// ============ 1. 内联脚本语法 ============
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
let inlineCount = 0;
scripts.forEach((m) => {
  const body = m[1];
  if (!body.trim()) return;
  inlineCount++;
  try { new Function(body); report('内联脚本 #' + inlineCount + ' 语法', true); }
  catch (e) { report('内联脚本 #' + inlineCount + ' 语法', false, e.message); }
});
report('存在内联脚本', inlineCount > 0);

// ============ 2. 外部引用可解析 ============
['ai\\.js', 'ctrip\\.js', 'vision-samples\\.js'].forEach(pat => {
  const m = html.match(new RegExp('src="([^"]*' + pat + ')"'));
  report('引用 ' + pat.replace('\\', ''), !!m, m && m[1]);
  if (m) {
    const target = path.resolve(path.dirname(DEMO), m[1]);
    report('  └ 文件存在', fs.existsSync(target), target.replace(path.join(__dirname, '..') + path.sep, ''));
  }
});

// ============ 3. 关键 DOM 挂载点 ============
const REQUIRED_IDS = ['phonesStage', 'phoneCountLabel', 'engineBadge'];
REQUIRED_IDS.forEach(id => report('DOM 挂载点 #' + id, html.includes('id="' + id + '"')));

// ============ 4. 引擎函数 ============
const ENGINE_FNS = [
  // 多机联动引擎
  'renderPhones', 'renderApp', 'renderHome', 'renderRoomDetail', 'renderAddBill',
  'renderCapture', 'renderSettle', 'renderStats', 'addPhone', 'removePhone', 'resetAll', 'autoDemo',
  'calcSettlement', 'doCreateRoom', 'doJoinRoom', 'openCreateModal', 'openJoinModal',
  'submitBill', 'askDeleteBill', 'doConfirm', 'cancelConfirm', 'syncAll', 'showToast',
  'copySettle', 'copyReport', 'phoneGoStats', 'goPhone',
  // 导航闭环（防止"进得去出不来"）
  'phoneGoBack', 'phoneGoHome', 'emBack',
  // AI 记账（会听）
  'aiParseBill', 'aiUseSample', 'startVoiceInput', 'updateAiText', 'aiKeydown', 'selectCurrency',
  // 票据识别 + 携程订单（会看 / 会读单）
  'captureTab', 'renderOrderTab', 'orderParse', 'orderImport', 'orderUseSample', 'orderToggle', 'orderClear',
  'visionRecognize', 'visionImport',
  'ocrSelectType', 'ocrStartScan', 'ocrImport',
  // 多币种与账目处理（会算账 / 会复盘）
  'makeBill', 'billCNY', 'roomTotalCNY', 'genNarrative', 'copyNarrative', 'sourceLabel',
  // 演示保障
  'runSelfTest', 'closeSelfTest', 'showTestPanel', 'runTourTest', 'startTour', 'tourNext', 'tourPrev', 'tourExit', 'toggleTourAuto',
  'runUITest', 'clickByText', 'setInput',
  'probeEngine', 'ensureDemoRoom'
];
ENGINE_FNS.forEach(fn => report('引擎函数 ' + fn, new RegExp('function\\s+' + fn + '\\s*\\(').test(html)));

// ============ 5. onclick 处理器必须有函数定义 ============
const handlers = new Set();
[...html.matchAll(/on(?:click|tap)="(\w+)\(/g)].forEach(m => handlers.add(m[1]));
report('onclick 处理器数量合理', handlers.size > 10, String(handlers.size));
handlers.forEach(fn => {
  report('onclick 处理器 ' + fn + ' 有定义', new RegExp('function\\s+' + fn + '\\s*\\(').test(html));
});

// ============ 6. 结算与分摊正确性（静态存在性） ============
report('账单写入 State.bills', /State\.bills\.push/.test(html));
report('分摊使用共享内核 allocateEvenly', html.includes('allocateEvenly'));
report('多币种折算使用共享内核', /billCNY|toCNY/.test(html));

// ============ 7. 共享 AI 引擎浏览器形态冒烟 ============
const aiSrc = fs.readFileSync(path.join(__dirname, '..', 'apps', 'miniprogram', 'utils', 'ai.js'), 'utf8');
globalThis.self = {};
new Function(aiSrc)();
const browserAI = globalThis.self.TravelAI;
report('AI 引擎可作为浏览器全局加载', !!(browserAI && browserAI.parseBillText && browserAI.generateInsight));
if (browserAI) {
  const parsed = browserAI.parseBillText('打车去机场86块，我垫的，和小红小李平分',
    [{ id: 'u1', name: '小明' }, { id: 'u2', name: '小红' }, { id: 'u3', name: '小李' }], { meName: '小明' });
  report('浏览器形态解析可用', parsed.amount === 86 && parsed.splitWith.length === 3);
}

console.log('\n========================================');
console.log(failed > 0 ? ('失败 ' + failed + ' 项') : 'demo 完整性检查全部通过');
console.log('========================================');
process.exit(failed > 0 ? 1 : 0);
