# 📋 变更记录（CHANGELOG）

> 本项目自**接手 zip 快照**起启用版本管理。基线提交保留了从 `travel-aa.zip` 解出的形态，
> 之后每轮改动独立成 commit，便于 `git diff` 追溯。

## 版本管理约定

- **分支**：`main` 为主干；每轮开发开主题分支（如 `feat/real-sync`），验收全绿后合并
- **提交信息**：`类型(范围): 说明`，类型用 `feat / fix / test / docs / chore / refactor`
- **每轮闸门**：`npm test`（一条命令跑完全部测试）必须全绿才允许提交 / 合并
- **红线**：`.env`、任何 API Key、`node_modules`、`server/data/`、`*.db` 一律不入库（见 `.gitignore`）
- **换行符**：仓库内统一 LF（见 `.gitattributes`），避免 Windows 开发 / Linux 部署产生假 diff

---

## [2.2.0] 第四轮：同步落地 · 无障碍 · 服务端加固 · 工程化

全量验收：**9 套 / 748 项断言全绿**（`node tests/run-all.js`，~72s）。

### 🔗 同步内核接入 Demo（含 3 个静默丢数据 bug 修复）

`utils/sync.js` 此前已写好但未接线。这轮真正接上，并修掉三个实测会让数据丢/复活的坑：

| 坑 | 症状 | 修法 |
|---|---|---|
| `rev` 是**每窗口局部计数器** | 两个窗口都从 0 开始，未收到对方快照就先写的一方发出相同 `rev` → 被 `stale-rev` 丢弃，**那一笔永远同步不过去** | `nextRev()` 取 `max(本地, 共享存储, 墙钟毫秒×1000)+1`；`receive()` 只丢弃**更旧**的 rev（相等放行，交给 LWW 兜底） |
| 原地修改**不更新时间戳** | 房间/账单只有 `createdAt`，加入成员这类修改后合并时两边时间戳相等 → 本地旧副本胜出，对方修改被静默丢掉 | 发布前 `stampChanged()` 按内容指纹 diff，只给**确实变了**的实体盖 `updatedAt`（全量盖会让本地永远赢，同样错）；`applyRemote()` 合并后重新记录指纹 |
| 删除**没有墓碑** | 对方窗口的旧快照一合并，被删的账单就"复活" | `State.tombstones` + `doConfirm`/`resetAll` 留痕 |

另外：`reseedCounters()`（合并后把自增 id 抬到最大编号之上，消除多窗口 `bill_1` 撞车）、
`SyncApplyingRemote` 守卫（远端合并不回环广播）、带演示/自检 hash 时不回填旧数据（保证截图与自检可复现）。
`settle.js` 与 `sync.js` 均为 UMD，Demo 通过 `<script src>` 复用同一份代码。

**同步徽标不虚报**：`new BroadcastChannel()` 在 `file://` 下**能构造成功**，但"能构造"不等于"消息真能跨窗口投递"。
所以徽标不拿构造结果当依据 —— 开局在 `…presence` 频道发一次 hello，**收到对端应答才显示 `🔗 多窗口已同步`**，
否则显示 `💾 已开启本地留存`（刷新不丢是真的，已用探针页在 Edge headless + `file://` 下实测：
`localStorage` 可写，且**跨浏览器进程重启仍读到上一轮写入**）。

### ♿ 无障碍三件套（对比度 / 语义 / 键盘）

- **对比度**：设计令牌按 WCAG 2.1 AA 重算 —— 品牌橙原先无论当底还是当字都只有 2.84:1。
  现在拆成 `--pri`（只当填充）+ `--on-pri`（橙底字 6.25:1）+ `--pri-ink`（白底橙字 6.00:1）；
  灰阶 `--g400/#71717a` 4.88:1、`--g500/#52525b` 7.8:1；语义色绿 6.01、琥珀 5.48、红 4.99、蓝 6.16。
  进度条渐变是纯装饰，保留鲜亮色。
- **语义**：弹层 `role="dialog"` + `aria-modal` + `aria-labelledby`；toast / 演示字幕 / 同步徽标 `role="status" aria-live="polite"`；纯图标按钮补 `aria-label`。
- **键盘**：`Esc` 逐层退出、弹层内 `Tab` 焦点循环、打开自动聚焦/关闭归还焦点；
  页面里 `<div onclick>` 卡片统一补 `tabindex="0" + role="button"` 并支持 Enter/空格；
  人数步进器从 `<i>` 改成真 `<button>`；`:focus-visible` 焦点环。
- ⚠️ **刻意不用原生 `<dialog>`**：会进入 top layer 相对视口居中，弹窗飞出手机壳、破坏"每台手机=一个用户"的隐喻。
- `#uitest` 新增 8 项断言真跑这三件事（逐文本节点算对比度、校验 aria、真实派发 `Esc`/`Tab`/`Enter`）。

### 🛡 服务端写入端校验

`/api/bills` 的 POST/PUT 统一走 `validateBillInput()`：金额 > 0 且 **≤ 2 位小数**、币种必须 3 位字母、
外币汇率合法、分摊成员/付款人必须是本房间成员、**Σsplits 与 amount 严格分位相等**。
`/api/ctrip/import` 每条草稿也过同一道校验，不合格的计入 `skipped[]` 而不是硬塞进库。
实测这些洞**原来全部能写进库并破坏账恒平**。

### 🏗 工程化

- 新增 `.github/workflows/ci.yml`（Node 20/22 跑 `npm test`，失败时上传 `tests/.output/`）
- `run-all.js` 两道**防假绿**闸门：**测试文件缺失算失败**（原来静默跳过）、**每套有通过项数下限**
  （防止断言被掏空后仍退出 0）。子进程输出用文件描述符重定向（非管道）捕获后解析，同时原样透传
- `browser.check.js`：修掉用 `spans[1]` 判结论的误判（补充说明 span 会被当成结论），
  并把**页面运行时报错计为失败**（原来只打一行警告）
- `resource.check.js`：工具条断言从"数 `.cb` 个数"改成按语义角色断言；新增步进器必须是真 `<button>`

### 📚 文档口径一次性对齐

README / 交接文档 / 架构与实现 / 部署与配置 / 效果验收指引 / 上手与演示脚本 / 待办与路线图：
`13/13`→`20/20`、`UITEST 20/20`→`54/54`、`三套`/`7 套`→`9 套`、`runSelfTest(13)`→20、
「单文件双击即开」→「拷整个目录」；补同步层与无障碍的设计说明与踩坑清单；
修掉 `架构与实现.md` 里重复的 `## 五`、断掉的表格、以及"splits 之和等于 cnyAmount"的**错误口径**
（实际是原币口径，照错的写会把外币账单 400 拒掉）。

---

## [2.1.0] 第三轮：后端致命修复 · 测试基建 · 同步内核

### 🚨 修复：后端完全无法启动（致命）

`server/app.js` 在目录重构（`miniprogram/` → `apps/miniprogram/`）后 require 路径多拼一层，
写成 `../apps/apps/miniprogram/utils/ai`，后端启动即 `MODULE_NOT_FOUND`。

**为什么长期没被发现**：原三套测试只覆盖算法内核与 Demo 页面，**完全没覆盖 server**。

> 条目按时间倒序：最新在最上（[2.2.0] → [2.1.0] → [基线]）。

### ✅ 新增：测试基建

| 测试 | 项数 | 作用 |
|---|---|---|
| `tests/requires.check.js` | 29 处引用 | 静态扫描全项目相对路径（`require` / `<script src>` / `<link href>`），把「改目录改漏」钉死 |
| `tests/server.test.js` | 64 项 | 真实子进程拉起 server + 真实 HTTP 打点：24 条路由、账恒平、多币种快照、离线 AI 回退、统计重算 |
| `tests/browser.check.js` | 20+8+29 | 用 **jsdom** 真实加载 `demo/index.html` 并真实派发点击/输入，把 `#selftest`/`#tourtest`/`#uitest` 做成可离线、可 CI 的验收 |
| `tests/sync.test.js` | 52 项 | 多窗口同步内核：uid 唯一性、实体级合并、墓碑防复活、rev 单调、回声抑制、三实例收敛、三级降级 |
| `tests/run-all.js` | 编排 | 一条命令跑完全部测试，统一退出码，可直接接 CI |

> 本机 Edge/Chrome 的 `--dump-dom` 恒返回 0 字节，无法用无头浏览器，故采用 jsdom。

### 🔧 新增：真实多窗口同步内核 `apps/miniprogram/utils/sync.js`

改造前 Demo 的「4 台手机实时同步」是**单页模拟**（共享内存 State，零 `localStorage`、
零 `BroadcastChannel`），刷新即丢、无法开两个窗口协同演示。新增 UMD 同步内核：

- 同浏览器**多窗口 / 多标签页真实同步**（`BroadcastChannel` + `localStorage` 双通道）
- **刷新不丢**、关掉再开数据仍在
- **零依赖、零服务器**，`file://` 双击即开这条红线不变
- **三级降级**：服务端通道 → 同浏览器多窗口 → 单页模拟（与改造前等价）
- **实体级合并**（per-entity merge + LWW）、**墓碑防删除复活**、单调 `rev` 丢弃乱序快照、
  `writer` 回声抑制、**全局唯一 `uid()`**（消除多窗口 `room_1` 撞 id）

**诚实边界**：本模块解决的是**同一浏览器多窗口**的真实同步；跨设备同步需后端通道
（`server/` 已具备 REST 接口），不在本模块范围内。

### 📝 版本管理

- `.gitignore` 补充本地验收临时产物豁免（`/edgeprof/`、`/chrome-prof/`、`/dom*.html`）
- `.gitattributes` 统一换行符（仓库 LF；`.sh`/`Dockerfile` 强制 LF；`.bat`/`.cmd` CRLF）
- `package.json` 增加 `test:*` 分项脚本与 `npm test` 全量入口
- 新增本 `CHANGELOG.md`

---

## [基线] 导入 `travel-aa.zip`

V2 状态的项目完整快照：网页 Demo（`demo/index.html`）、微信小程序与云函数（`apps/`）、
可选后端（`server/`）、三套测试（`tests/`）、文档（`docs/`）。

交接自述：`ai.test.js` 62 项、`v2.test.js` 115 项、Demo 完整性全通过。
接手实测复现：62 / 115 / 全通过，`#selftest` 20/20、`#uitest` 29/29、`#tourtest` 8/8。
