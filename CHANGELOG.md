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

## [未发布]

### 🚨 修复：后端完全无法启动（致命）

`server/app.js` 在目录重构（`miniprogram/` → `apps/miniprogram/`）后 require 路径多拼一层，
写成 `../apps/apps/miniprogram/utils/ai`，后端启动即 `MODULE_NOT_FOUND`。

**为什么长期没被发现**：原三套测试只覆盖算法内核与 Demo 页面，**完全没覆盖 server**。

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
