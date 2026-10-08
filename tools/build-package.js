#!/usr/bin/env node
/**
 * build-package.js —— 生成"可以直接发出去"的交付包（发布工具，不参与 CI）
 *
 * 为什么需要它：`demo/index.html` 通过相对路径引 4 个外部脚本
 * （共享内核 ai/ctrip/sync + 订单截图样例），**只发一个 html 会白屏**。
 * 这个脚本把交付物做成两种形态，都实测过"解压/双击就能用"：
 *
 *   ① 单文件版 `TravelAA-演示-单文件.html`
 *      把 4 个脚本内联进 html，得到一个自包含文件（≈575 KB）。
 *      双击即开、无需解压、无需联网 —— 发给评委 / 传提交系统最省事。
 *   ② 目录版 `TravelAA-演示包.zip`
 *      保留原始相对路径结构（index.html + demo/ + apps/miniprogram/utils/）。
 *      适合"要看到目录结构"或后续自己改的场合。根 index.html 会自动跳转到 demo。
 *   ③ 源码包 `TravelAA-源码包.zip`
 *      `git archive HEAD` —— 只含**入库过**的文件（自动排除 .git / node_modules /
 *      server/data / .env / *.db），给需要看代码与文档的场合。
 *   ④ 项目完整包 `TravelAA-项目完整包.zip`
 *      入库文件 **+ `.git` 版本库**，解压出来就是一个能 `git log` / 继续提交的完整工程；
 *      顶层带 `TravelAA/` 目录，解压不会散成一堆文件。
 *      （node_modules 不进包：体积 22 MB 且 `npm install` 就能装回来。）
 *
 * 用法：node tools/build-package.js [输出目录]
 *   默认输出到仓库上一级的 `发布包/`（刻意放在仓库外：构建产物不进版本库、不会被 Pages 发布）
 *   `--desktop` 额外把「项目完整包」复制一份到桌面（用户要"压缩到桌面"时用）
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const TO_DESKTOP = args.indexOf('--desktop') >= 0;
const OUT = path.resolve(args.filter((a) => a.indexOf('--') !== 0)[0] || path.join(ROOT, '..', '发布包'));

/* 需要内联/打包的外部脚本（顺序必须与 demo/index.html 里一致：先内核、后样例） */
const DEPS = [
  { tag: '../apps/miniprogram/utils/ai.js', file: 'apps/miniprogram/utils/ai.js' },
  { tag: '../apps/miniprogram/utils/ctrip.js', file: 'apps/miniprogram/utils/ctrip.js' },
  { tag: '../apps/miniprogram/utils/sync.js', file: 'apps/miniprogram/utils/sync.js' },
  { tag: 'assets/vision-samples.js', file: 'demo/assets/vision-samples.js' },
];

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const kb = (n) => (n / 1024).toFixed(0) + ' KB';

/* ---------- ① 单文件版 ---------- */
function buildSingleFile() {
  let html = read('demo/index.html');
  let inlined = 0;
  for (const d of DEPS) {
    const src = read(d.file);
    if (/<\/script/i.test(src)) throw new Error(d.file + ' 里含 </script>，不能内联');
    const tag = new RegExp('<script src="' + d.tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"><\\/script>');
    if (!tag.test(html)) throw new Error('找不到脚本引用：' + d.tag);
    html = html.replace(tag, () => '<script>\n/* ===== ' + d.file + '（已内联，单文件版）===== */\n' + src + '\n</script>');
    inlined++;
  }
  if (inlined !== DEPS.length) throw new Error('内联数量不对：' + inlined);
  /* 单文件版里若还有指向 ../ 的相对脚本引用，说明漏了 */
  const left = html.match(/<script src="(?!https?:)[^"]+"/g) || [];
  if (left.length) throw new Error('还有未内联的外部脚本：' + left.join(' '));
  const out = path.join(OUT, 'TravelAA-演示-单文件.html');
  fs.writeFileSync(out, html);
  return { out, size: fs.statSync(out).size, inlined };
}

/* ---------- ② 目录版 ---------- */
function buildFolder() {
  const dir = path.join(OUT, 'TravelAA-演示包');
  fs.rmSync(dir, { recursive: true, force: true });
  const copy = (rel) => {
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), dst);
  };
  copy('index.html');                       // 根跳转页（相对跳转，子目录也能用）
  copy('demo/index.html');
  fs.readdirSync(path.join(ROOT, 'demo/assets')).forEach((f) => {
    if (fs.statSync(path.join(ROOT, 'demo/assets', f)).isFile()) copy('demo/assets/' + f);
  });
  DEPS.forEach((d) => { if (d.file.indexOf('assets/') !== 0) copy(d.file); });
  fs.writeFileSync(path.join(dir, '打开说明.md'), README_TXT);
  return dir;
}

/* ---------- ③ 源码包 ---------- */
function buildSourceZip() {
  const zip = path.join(OUT, 'TravelAA-源码包.zip');
  fs.rmSync(zip, { force: true });
  /* git archive 只导出**入库过**的文件：.env / node_modules / server/data / *.db / .git 天然排除 */
  execFileSync('git', ['archive', '--format=zip', '-o', zip, 'HEAD'], { cwd: ROOT, stdio: 'inherit' });
  return zip;
}

/* ---------- ④ 项目完整包（含 .git） ---------- */
function buildProjectZip() {
  const zip = path.join(OUT, 'TravelAA-项目完整包.zip');
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'taa-proj-'));
  fs.rmSync(zip, { force: true });
  /* 用 git archive 取"入库过的文件"（自动排除 node_modules / server/.env / tests/.output 等），
     加 --prefix 让解压出来是 TravelAA/ 一个目录而不是散开的 142 个文件。 */
  execFileSync('git', ['archive', '--format=zip', '--prefix=TravelAA/', '-o',
    path.join(staging, 'src.zip'), 'HEAD'], { cwd: ROOT, stdio: 'inherit' });
  execFileSync('powershell.exe', ['-NoProfile', '-Command',
    'Expand-Archive -LiteralPath "' + path.join(staging, 'src.zip') + '" -DestinationPath "' + staging + '" -Force'],
    { stdio: 'inherit' });
  /* 版本库一起带上：解压后就是一个能 git log / git diff / 继续提交的完整工程 */
  execFileSync('powershell.exe', ['-NoProfile', '-Command',
    'Copy-Item -LiteralPath "' + path.join(ROOT, '.git') + '" -Destination "' + path.join(staging, 'TravelAA', '.git') + '" -Recurse -Force'],
    { stdio: 'inherit' });
  execFileSync('powershell.exe', ['-NoProfile', '-Command',
    'Compress-Archive -Path "' + path.join(staging, 'TravelAA') + '" -DestinationPath "' + zip + '" -CompressionLevel Optimal -Force'],
    { stdio: 'inherit' });
  fs.rmSync(staging, { recursive: true, force: true });
  return zip;
}

const README_TXT = `# TravelAA · 旅行 AA 记账 —— 演示包

携程高校 AI HACKATHON · 队名：爆能器已部署

## 怎么打开

**双击 \`index.html\`** 就行（推荐 Chrome / Edge）。不需要装东西、不需要联网、不需要起服务器。

> 直接双击 \`demo/index.html\` 也可以，但**整个文件夹要一起拷**：
> \`demo/\` 里的页面会去 \`../apps/miniprogram/utils/\` 取三个共享内核脚本，
> 只发一个 html 文件会白屏（这也是为什么另有一份"单文件版"）。

## 进来先点哪

页面中间那条解说栏上就是入口：

| 按钮 | 会看到什么 |
|---|---|
| **▶ 播放演示** | 24 个分镜的完整剧情，约 1 分 30 秒；顶部有进度、可暂停 / 单步 / 调速 / ✕ 退出 |
| **逐步导览（15 步）** | 15 步讲解，自己控制节奏（← → 方向键翻页，Esc 退出） |
| **自己上手** | 先铺一桌样例数据（国庆东京行 · 5 笔账，含外币），然后你直接点手机试 |

四台手机 = 四位同行成员，可以随便点：每台都能自己操作，四台共用同一本账、实时联动。

## 往下滚

手机舞台下面是给评委看的一屏：**和市面上同类做法逐项对比** → 三个不可复制的差异点 →
它替你做的事 → 诚实边界。技术验收证据默认收起，愿意深挖再点开。

## 边界（我们不吹的地方）

- 未连 AI 通道时，**截图识别展示的是内置样例结果**，页面已明确标注，不冒充模型实时输出；
- **携程自动拉单**需要携程开放平台授权，当前是对接点已预留，演示的是同一条数据管线；
- 多窗口同步限于**同一浏览器多标签页**；跨设备需要后端通道，接口已就位；
- 视觉 / 语言模型均为**能力集成**，非自研。

## 文件清单

\`\`\`
index.html                          根跳转页（打开它就会进 demo）
demo/index.html                     演示主页面（唯一交付物）
demo/assets/                        订单截图样例素材
apps/miniprogram/utils/ai.js        AI 记账内核（与小程序、服务端同一份代码）
apps/miniprogram/utils/ctrip.js     携程订单解析内核
apps/miniprogram/utils/sync.js      多窗口同步内核
打开说明.md                          本文件
\`\`\`

页面上的数据只存在你自己浏览器的本地存储里，不上传任何服务器。
`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  console.log('输出目录：' + OUT + '\n');

  const single = buildSingleFile();
  console.log('① 单文件版  ' + path.basename(single.out) + '   ' + kb(single.size) +
    '   （内联 ' + single.inlined + ' 个脚本）');

  const dir = buildFolder();
  console.log('② 目录版    ' + path.basename(dir) + '/   （待压缩）');

  const zip = buildSourceZip();
  console.log('③ 源码包    ' + path.basename(zip) + '   ' + kb(fs.statSync(zip).size) + '  （git archive HEAD）');

  const proj = buildProjectZip();
  console.log('④ 项目完整包 ' + path.basename(proj) + '   ' + kb(fs.statSync(proj).size) + '  （入库文件 + .git，可继续提交）');

  if (TO_DESKTOP) {
    const desktop = path.join(os.homedir(), 'Desktop');
    if (!fs.existsSync(desktop)) throw new Error('找不到桌面目录：' + desktop);
    const dst = path.join(desktop, path.basename(proj));
    fs.copyFileSync(proj, dst);
    console.log('\n📄 已复制到桌面：' + dst + '   ' + kb(fs.statSync(dst).size));
  }
  console.log('\n打包完成。');
})();
