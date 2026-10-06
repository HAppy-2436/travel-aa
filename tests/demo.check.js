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
['ai\\.js', 'ctrip\\.js', 'sync\\.js', 'vision-samples\\.js'].forEach(pat => {
  const m = html.match(new RegExp('src="([^"]*' + pat + ')"'));
  report('引用 ' + pat.replace('\\', ''), !!m, m && m[1]);
  if (m) {
    const target = path.resolve(path.dirname(DEMO), m[1]);
    report('  └ 文件存在', fs.existsSync(target), target.replace(path.join(__dirname, '..') + path.sep, ''));
  }
});

// ============ 3. 关键 DOM 挂载点 ============
const REQUIRED_IDS = ['phonesStage', 'phoneCountLabel', 'engineBadge', 'syncBadge'];
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
  'probeEngine', 'ensureDemoRoom',
  // 真实多窗口同步（刷新不丢 / 多窗口实时）
  'bootSync', 'renderSyncBadge', 'publishSoon', 'applyRemote', 'reseedCounters', 'stampChanged', 'syncState'
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

// ============ 7. 真实多窗口同步接线（防"接了一半"） ============
report('State 带 tombstones（删除防复活）', /State\s*=\s*\{[^}]*tombstones\s*:/.test(html));
report('删除账单时写墓碑', /State\.tombstones\[[^\]]+\]\s*=/.test(html));
report('每次渲染都会发布快照', /function syncAll\(\)\{[\s\S]{0,400}?publishSoon\(\)/.test(html));
report('启动时调用 bootSync', /bootSync\(\)/.test(html) && /function bootSync\s*\(/.test(html));
report('合并后重排自增计数器（防多窗口 id 撞车）', /State\.nextBillId\s*=\s*Math\.max/.test(html));
report('LWW 前给变更实体盖时间戳', /function stampChanged\s*\(/.test(html) && /x\.updatedAt\s*=\s*now/.test(html));
report('远端合并不回环广播（回声放大防护）', /SyncApplyingRemote/.test(html));
report('演示/自检 hash 下不回填旧数据（可复现）', /DEMO_HASH/.test(html));
report('file:// 下可降级（不假定 localStorage 一定可用）', /mode === 'memory'|SyncMode\s*=\s*'memory'/.test(html));
report('★ 同步徽标有实据：探测到对端才宣称"多窗口已同步"',
  /SyncPeerSeen/.test(html) && /function startPresence\s*\(/.test(html) && /new BroadcastChannel\(SyncHub\.ns/.test(html));

// ============ 9. 功能展示的完整性（"做了但演示里看不见"是最大的浪费） ============
report('功能清单 FEATURES 存在且成规模', /var FEATURES = \[/.test(html) &&
  (html.match(/\{ id: '[a-z-]+', name: '/g) || []).length >= 35,
  (html.match(/\{ id: '[a-z-]+', name: '/g) || []).length + ' 项');
report('导览步骤声明 covers（功能 → 步骤可双向校验）', /covers: \[/.test(html) &&
  (html.match(/covers: \[/g) || []).length >= 12, (html.match(/covers: \[/g) || []).length + ' 步声明了覆盖');
report('tourCoverage() 覆盖校验存在并进 #selftest', /function tourCoverage\s*\(/.test(html) && /tourCoverage\(\)/.test(html));
report('导览高亮走 data-feat 语义锚点（不依赖样式类名）', (html.match(/data-feat="/g) || []).length >= 30,
  (html.match(/data-feat="/g) || []).length + ' 个锚点');
report('导览自检要求目标**可见**（防"高亮到空气"）', /isShownDeep/.test(html) && /目标不可见/.test(html));
report('导览期间显示工具条（演示模式默认隐藏，否则前几步高亮到空气）', /body\.present\.touring \.tbar/.test(html));
report('★ 4 台手机都有各自环节的守卫存在', /没有"凑数的人"|没有凑数的人/.test(html) || /4 台手机在导览里都有各自的环节/.test(html));
report('★ 自动演示有"每台手机都动手"的守卫', /seenPhones/.test(html) && /没有"只看不演"的人/.test(html));
report('★ 结算闭环：标记已转账 / 撤销', /function toggleSettled\s*\(/.test(html) && /function settledInfo\s*\(/.test(html));
report('人数只有一个写入口 setPhoneCount', /function setPhoneCount\s*\(/.test(html) && /setPhoneCount\(4\)/.test(html));
report('自动演示保证 4 台手机上场', /setPhoneCount\(4\)/.test(html));
// 第 4 位成员（小王 u4）必须真的参与：导览与自动演示都要有他的环节
const u4InTour = (html.match(/#app-u4 \[data-feat=/g) || []).length;
report('★ 第 4 位成员（小王）在导览里有多处环节', u4InTour >= 3, u4InTour + ' 处（导览）');
report('★ 修掉"越加越长"：导览步骤数 ≤ 18 且每步都声明 covers',
  (html.match(/covers: \[/g) || []).length <= 18 && (html.match(/covers: \[/g) || []).length >= 12,
  (html.match(/covers: \[/g) || []).length + ' 步（同类功能已合并）');
report('★ 不再有"核心/进阶"双机制（合并后多余）', !/tier: 'adv'/.test(html) && !/showAdv/.test(html));
report('★ 第 4 位成员在自动演示里动手（语音/截图/私账/改分摊/结清）', /voice/.test(html) && /visionRecognize\('u4'/.test(html) && /openBillDetail\('u4'/.test(html),
  '语音 + 截图识别 + 多退少补 + 结清闭环');

// ============ 9+. 本轮审计修掉的问题（防回归） ============
report('★ 日期不再裸用 new Date(x).toISOString()（非法值会抛 RangeError 白屏）',
  !/new Date\(o\.date\)\.toISOString/.test(html) && /AI\.toIsoSafe/.test(html));
report('★ 导出 CSV 存在且是纯函数 buildCsv（无头环境可校验）',
  /function buildCsv\s*\(/.test(html) && /function exportCsv\s*\(/.test(html) && /\\uFEFF/.test(html));
report('★ CSV 入口挂了语义锚点', /data-feat="export-csv"/.test(html));
report('★ 导出 CSV 进了功能清单并被导览讲到',
  /id: 'export-csv'/.test(html) && /'export-csv'/.test(html));
report('★ 结算页会告警"账单里有非本房间成员"',
  /data-feat="settle-unknown"/.test(html) && /unknownMembers/.test(html));
report('★ 云函数 addBill 透传 scope/roundedLoss（否则私账被当集体账、抹零丢失）', (function () {
  const f = path.join(__dirname, '..', 'apps', 'cloudfunctions', 'addBill', 'index.js');
  if (!fs.existsSync(f)) return false;
  const src = fs.readFileSync(f, 'utf8');
  return /scope:/.test(src) && /roundedLoss/.test(src);
})());
report('★ 服务端时间戳是带 Z 的 ISO-8601 UTC（CURRENT_TIMESTAMP 会让每日统计漂 8 小时）', (function () {
  const f = path.join(__dirname, '..', 'server', 'database.js');
  if (!fs.existsSync(f)) return false;
  const src = fs.readFileSync(f, 'utf8');
  return !/DEFAULT CURRENT_TIMESTAMP/.test(src) && /strftime\('%Y-%m-%dT%H:%M:%fZ','now'\)/.test(src);
})());

report('★ 导览先滚动再量位置（否则高亮框会停在屏幕外）', (function () {
  const i = html.indexOf('function renderTourStep');
  if (i < 0) return false;
  const seg = html.slice(i, i + 1400);
  const scroll = seg.indexOf('scrollIntoView');
  const rect = seg.indexOf('getBoundingClientRect');
  return scroll > -1 && rect > -1 && scroll < rect;
})());
report('导览控制条不会把「退出」挤成竖排', /\.tour-ctrl \.btn\{flex:1 1 0/.test(html) && !/flex:0 0 56px;/.test(html));

// ============ 10. 共享 AI 引擎浏览器形态冒烟 ============
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
