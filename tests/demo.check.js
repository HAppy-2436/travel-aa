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

// ============ 10. 演示模式的一屏装下（投影仪上最容易翻车的地方） ============
/* 实测事故：4 台手机 = 1334px，1280×720 投影仪放不下 → flex-wrap 把第 4 台折到第二行被切掉；
   而**只加 transform:scale 也没用**，因为折行发生在布局阶段，缩的是"已经折好的两行"。
   下面几条把修法钉住。 */
report('★ 演示模式：舞台禁止折行（否则第 4 台掉到第二行被切）',
  /body\.present \.stage\{[^}]*flex-wrap:nowrap/.test(html));
report('★ 演示模式：舞台 overflow:clip（承接为不折行而溢出的布局）',
  /body\.present \.stage\{[^}]*overflow:clip/.test(html));
report('★ 演示模式：禁止 flex 压缩手机单元（否则内屏比外框宽、两侧被裁）',
  /body\.present \.pu\{flex:0 0 auto\}/.test(html));
report('★ fitPhones() 存在，且在「进演示模式 / 窗口缩放 / 改人数」时都会重量',
  /function fitPhones\s*\(/.test(html) &&
  /function enterPresent\(\)[\s\S]{0,400}?fitPhones\(\)/.test(html) &&
  /addEventListener\('resize', function \(\) \{ fitPhones\(\)/.test(html) &&
  /renderPhones\(\);\s*\n\s*fitPhones\(\)/.test(html));
report('★ fitPhones 先量后缩（顺序反了会缩错）', (function () {
  const i = html.indexOf('function fitPhones');
  if (i < 0) return false;
  const seg = html.slice(i, i + 2400);
  /* 注意要认准**真正的缩放赋值**：函数开头 reset() 里也有一句 `stage.style.transform = ''`
     （那是清空，不是缩放），拿它当基准就会误判。 */
  const measure = seg.indexOf('units[0].getBoundingClientRect()');
  const apply = seg.indexOf("stage.style.transform = 'translateX(");
  return measure > -1 && apply > -1 && measure < apply;
})());
report('★ 纵向按实测分配：手机高度由 --phone-h 决定（网页版不能出现半截手机）',
  /root\.style\.setProperty\('--phone-h'/.test(html) && /height:var\(--phone-h,660px\)/.test(html) &&
  /wrap\.style\.paddingTop = top \+ 'px'/.test(html));
report('★ 演示解说栏只在 present 下显示（不影响常规视图）',
  /\.pshow\{display:none\}/.test(html) && /body\.present \.pshow\{[\s\S]{0,90}?display:block/.test(html));
report('★ 演示模式隐藏人名行，并把"谁在操作"并进字幕条（否则会被解说栏盖住）',
  /body\.present \.pl\{display:none\}/.test(html) && /classList\.contains\('present'\) && owner/.test(html));
report('★ 只有操作中的那台手机被高亮', /function setActing/.test(html) && /classList\.add\('acting'\)/.test(html));

// ============ 10+. 演示的可控性（讲者要能暂停 / 单步 / 调速） ============
report('★ 自动演示支持三种播放状态（run / pause / step）',
  /var autoMode = 'run'/.test(html) && /autoMode === 'pause'/.test(html) && /autoMode === 'step'/.test(html));
report('★ 单步：一个分镜播完就设闸等人点「下一步」',
  /pendingGate/.test(html) && /autoGate/.test(html) &&
  /function autoNext\s*\(/.test(html) && /function releaseAutoGate\s*\(/.test(html));
report('★ 导览：可调自动播放速度（三档循环，定时器按新速度重排）',
  /var TOUR_SPEEDS = \[/.test(html) && /function cycleTourSpeed\s*\(/.test(html) &&
  /setInterval\(tourTick, TOUR_SPEEDS\[tourState\.speed\]\)/.test(html));
report('★ 导览：按钮文案同步更新（不再等 260ms 的定时器）',
  /function updateTourControls\s*\(/.test(html) && /updateTourControls\(\);\s*\n\s*renderTourStep\(\)/.test(html));

// ============ 10++. 网页版外壳（这是提交给评委看的形态） ============
report('★ 网页版：手机高度由 --phone-h 决定，且 renderPhones 后必重量（否则首屏看不到完整手机）',
  /height:var\(--phone-h,660px\)/.test(html) &&
  /renderPhones\(\);\s*\n\s*fitPhones\(\)/.test(html) &&
  /setProperty\('--phone-h'/.test(html));
report('★ 网页版：高度自校正（量真实底边再收/放，不是靠公式凑）',
  /for \(var pass = 0; pass < 4; pass\+\+\)/.test(html) &&
  /getBoundingClientRect\(\)\.bottom - \(vh - 8\)/.test(html) &&
  /PHONE_MIN/.test(html) && /PHONE_MAX/.test(html));
report('★ 网页版：常驻解说条（普通模式也看得到"这一步在做什么"）',
  /<div class="narr" id="narrBar"/.test(html) && /id="shellNarr"/.test(html) &&
  /body\.present \.narr\{display:none\}/.test(html));
report('★ 网页版：解说条与浮动栏共用同一份内容（不出现两套说法）',
  /\['presentStep', 'presentProg', 'presentNarr'\], \['shellStep', 'shellProg', 'shellNarr'\]/.test(html));
report('★ 网页版：品牌行只放产品定位，不再被解说词覆盖',
  /var TAGLINE = /.test(html) && /if\(sub\)sub\.textContent=TAGLINE/.test(html) &&
  !/sub\.textContent = '每个手机 = 一个真实用户/.test(html));
report('★ 网页版：人数只有 setPhoneCount 一个写入口（?n= 也走它）',
  /if \(m\) setPhoneCount\(/.test(html));
report('★ 网页版：手机舞台下方有"给评委看的一屏"（定位 / 五层能力 / 验收证据 / 诚实边界）',
  /id="judgeSection"/.test(html) && /会听/.test(html) && /诚实边界/.test(html) && /jnItems/.test(html));
report('★ 评委面板的验收数字不是写死的：页内自检/交互验收跑完会写入真实结果',
  /var SUITE_STATS = \{ suites: \d+, items: \d+ \}/.test(html) &&
  /id="jnSelf">—</.test(html) && /id="jnUI">—</.test(html) &&
  /setJudgeResult\('self'/.test(html) && /setJudgeResult\('ui'/.test(html) && /fillJudgeStats\(\)/.test(html));
report('★ 网页版：工具条吸顶（滚动时也点得到「自动演示」）',
  /\.tbar\{display:flex;[\s\S]{0,200}?position:sticky;top:0/.test(html));
report('★ 自动演示可调速（三档，作用在每个 sleep 上）',
  /var AUTO_SPEEDS = \[/.test(html) && /function cycleAutoSpeed\s*\(/.test(html) &&
  /ms \* AUTO_SPEEDS\[autoSpeed\]/.test(html));
report('★ 单步「下一步」在闸门注册前被点也不丢（实测点一次没反应）',
  /gateWaived/.test(html) && /if \(gateWaived\) \{ gateWaived = false; return go\(\); \}/.test(html));

// ============ 11. 共享 AI 引擎浏览器形态冒烟 ============
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
