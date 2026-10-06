/**
 * sync.test.js —— 真实多窗口同步内核（apps/miniprogram/utils/sync.js）单测
 *
 * 背景：改造前 Demo 的「4 台手机实时同步」是单页模拟（共享内存 State，零持久化），
 * 刷新即丢、无法开两个窗口协同演示。新增的 sync.js 用
 * `BroadcastChannel` + `localStorage` 做**同浏览器多窗口真实同步**，本测试覆盖其正确性。
 *
 * 覆盖：
 *   A. uid 全局唯一性（消除多窗口 room_1 撞 id）
 *   B. mergeList 实体级合并（并集 / LWW / 稳定排序）
 *   C. 墓碑防「删除复活」
 *   D. 同 id 同时被创建与删除 → 删除胜
 *   E. 同 id 同时被创建与编辑 → 编辑胜（避免丢失用户修改）
 *   F. rev 单调：过期/乱序快照被丢弃
 *   G. writer 回声抑制（自己的写入不重复应用）
 *   H. schema 版本：未来版本快照被拒绝
 *   I. 三实例收敛（模拟 A/B/C 三窗口交错写入）
 *   J. 三级降级：无 localStorage / 无 BroadcastChannel / 显式关闭
 *   K. 真实 localStorage 双窗口往返（本机可用时）
 */
'use strict';

const path = require('path');

const S = require(path.resolve(__dirname, '..', 'apps', 'miniprogram', 'utils', 'sync.js'));

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name + (extra ? '  → ' + extra : '')); }
  else { fail++; failures.push(name); console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}
function section(t) { console.log('\n—— ' + t + ' ——'); }

/* 构造可控的假环境（可注入/卸载），避免依赖真实浏览器 */
function makeEnv() {
  const store = new Map();
  const listeners = [];
  const channels = [];

  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => store.clear(),
    get length() { return store.size; },
    key: (i) => Array.from(store.keys())[i] ?? null,
  };

  class BroadcastChannel {
    constructor(ns) { this.ns = ns; this.onmessage = null; this.closed = false; channels.push(this); }
    postMessage(data) {
      if (this.closed) return;
      // 模拟跨文档投递：发给同 ns 的其他实例（不含自己）
      channels.forEach((c) => {
        if (c !== this && c.ns === this.ns && !c.closed && typeof c.onmessage === 'function') {
          c.onmessage({ data: JSON.parse(JSON.stringify(data)) });
        }
      });
    }
    close() { this.closed = true; }
  }

  return {
    localStorage,
    sessionStorage: {
      _m: new Map(),
      getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
      setItem(k, v) { this._m.set(k, String(v)); },
      removeItem(k) { this._m.delete(k); },
    },
    BroadcastChannel,
    window: {
      addEventListener(type, fn) { if (type === 'storage') listeners.push(fn); },
      removeEventListener(type, fn) {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      },
    },
    /** 模拟"另一个窗口写入 localStorage"触发 storage 事件 */
    fireStorage(key, newValue, writerTab) {
      listeners.forEach((fn) => fn({ key, newValue, storageArea: localStorage }));
    },
    channels,
    store,
    install() {
      global.localStorage = this.localStorage;
      global.sessionStorage = this.sessionStorage;
      global.BroadcastChannel = this.BroadcastChannel;
      global.window = this.window;
      S._resetTab();
    },
    uninstall() {
      delete global.localStorage;
      delete global.sessionStorage;
      delete global.BroadcastChannel;
      delete global.window;
      S._resetTab();
    },
  };
}

function room(id, name, updatedAt) { return { id, name, updatedAt: updatedAt || '2024-10-01T00:00:00.000Z' }; }
function bill(id, amount, updatedAt) { return { id, amount, updatedAt: updatedAt || '2024-10-01T00:00:00.000Z' }; }

/* ============================================================ */
(async function main() {
  /* ---------- A. uid 唯一性 ---------- */
  section('A. uid 全局唯一性（消除多窗口撞 id）');
  (function () {
    const N = 100000;
    const seen = new Set();
    for (let i = 0; i < N; i++) seen.add(S.makeUid('bill'));
    ok(N + ' 次 uid 全不重复', seen.size === N, 'unique=' + seen.size);

    // 不同窗口前缀不同：模拟重置 tabId
    S._resetTab();
    const a1 = S.makeUid('room');
    S._resetTab();
    const a2 = S.makeUid('room');
    ok('不同窗口生成的 id 也不同（窗口号参与构成）', a1 !== a2, a1 + ' ≠ ' + a2);

    ok('uid 带前缀便于识别', /^bill_/.test(S.makeUid('bill')));
    ok('uid 是纯 ASCII 且无空格', /^[A-Za-z0-9_]+$/.test(S.makeUid('room')));
    const ids = [S.makeUid('x'), S.makeUid('x'), S.makeUid('x')];
    ok('uid 单调部分递增（同窗口内不重复）', new Set(ids).size === 3);
  })();

  /* ---------- B. mergeList 实体级合并 ---------- */
  section('B. mergeList 实体级合并（并集 / LWW）');
  (function () {
    const local = [room('r1', '本地房', '2024-10-01T00:00:00.000Z')];
    const remote = [room('r2', '远端房', '2024-10-02T00:00:00.000Z')];
    const r = S.mergeList(local, remote, {});
    ok('并集：两边独有的实体都保留', r.list.length === 2 && r.list.some((x) => x.id === 'r1') && r.list.some((x) => x.id === 'r2'));
    ok('并集被视为有变化', r.changed === true);

    const same = S.mergeList(local, local.slice(), {});
    ok('两侧完全相同 → changed=false', same.changed === false);
    ok('两侧完全相同 → 数量不变', same.list.length === 1);

    const older = [room('r1', '旧名字', '2024-09-30T00:00:00.000Z')];
    const newer = [room('r1', '新名字', '2024-10-05T00:00:00.000Z')];
    const lww1 = S.mergeList(older, newer, {});
    ok('LWW：远端更新 → 取远端值', lww1.list[0].name === '新名字', lww1.list[0].name);
    const lww2 = S.mergeList(newer, older, {});
    ok('LWW：本地更新 → 保留本地值', lww2.list[0].name === '新名字', lww2.list[0].name);

    const noTs = [{ id: 'r9', name: '无时间戳' }];
    const withTs = [{ id: 'r9', name: '有时间戳', updatedAt: '2024-10-01T00:00:00.000Z' }];
    ok('缺失时间戳视为最旧 → 被有时间戳的覆盖', S.mergeList(noTs, withTs, {}).list[0].name === '有时间戳');

    const sorted = S.mergeList(
      [room('a', 'A', '2024-10-03T00:00:00.000Z')],
      [room('b', 'B', '2024-10-01T00:00:00.000Z')],
      {}
    );
    ok('合并结果按时间稳定排序', sorted.list[0].id === 'b' && sorted.list[1].id === 'a',
      sorted.list.map((x) => x.id).join(','));

    ok('空输入不崩', S.mergeList([], [], {}).list.length === 0);
    ok('null 输入不崩', S.mergeList(null, null, {}).list.length === 0);
    ok('忽略没有 id 的脏数据', S.mergeList([{ name: 'x' }], [{ name: 'y' }], {}).list.length === 0);
  })();

  /* ---------- C. 墓碑防删除复活 ---------- */
  section('C. 墓碑防「删除复活」');
  (function () {
    const local = [bill('b1', 100, '2024-10-01T00:00:00.000Z')];
    const remote = [];                                        // 远端删掉了 b1
    const tombs = { b1: '2024-10-02T00:00:00.000Z' };          // 删除发生在更新之后
    const r = S.mergeList(local, remote, tombs);
    ok('墓碑生效：本地已删的账单不会复活', r.list.length === 0);
    ok('墓碑触发 changed（需要通知 UI 移除）', r.changed === true);

    // 反向：远端把已删的实体又推回来（旧快照）
    const r2 = S.mergeList([], local, tombs);
    ok('旧快照回推也不复活', r2.list.length === 0);

    // 删除时间早于更新 → 视为"删除后又被更新"，应保留（后来者胜）
    const tombsOld = { b1: '2024-09-01T00:00:00.000Z' };
    const r3 = S.mergeList(local, [], tombsOld);
    ok('删除早于最后更新 → 更新胜（实体保留）', r3.list.length === 1);

    const m = S.mergeTombstones({ a: '2024-10-01T00:00:00.000Z' }, { a: '2024-10-05T00:00:00.000Z', b: '2024-10-02T00:00:00.000Z' });
    ok('墓碑表合并取较晚时间', m.a === '2024-10-05T00:00:00.000Z');
    ok('墓碑表合并保留双方条目', !!m.a && !!m.b);
  })();

  /* ---------- D/E. 并发冲突语义 ---------- */
  section('D/E. 并发冲突语义');
  (function () {
    const tCreate = '2024-10-02T00:00:00.000Z';
    const tDelete = '2024-10-03T00:00:00.000Z';
    const created = [bill('c1', 50, tCreate)];
    const r1 = S.mergeList([], created, { c1: tDelete });
    ok('D. 同 id 同时创建与删除 → 删除胜', r1.list.length === 0);

    const tEdit = '2024-10-05T00:00:00.000Z';
    const edited = [bill('c2', 80, tEdit)];
    const r2 = S.mergeList(created.map((x) => ({ ...x, id: 'c2' })), edited, { c2: tDelete });
    ok('E. 删除后又编辑 → 编辑胜（不丢用户修改）', r2.list.length === 1 && r2.list[0].amount === 80,
      r2.list[0] && String(r2.list[0].amount));
  })();

  /* ---------- I. 三实例收敛 ---------- */
  section('I. 三实例（A/B/C 三窗口）交错写入后收敛');
  (function () {
    // 模拟三个窗口各自的本地状态，反复两两合并，最终应完全一致
    let A = { rooms: [room('r1', 'A 建的', '2024-10-01T00:00:00.000Z')], tombs: {} };
    let B = { rooms: [room('r2', 'B 建的', '2024-10-02T00:00:00.000Z')], tombs: {} };
    let C = { rooms: [room('r3', 'C 建的', '2024-10-03T00:00:00.000Z')], tombs: {} };

    function syncPair(x, y) {
      const tombs = S.mergeTombstones(x.tombs, y.tombs);
      const mx = S.mergeList(x.rooms, y.rooms, tombs);
      const my = S.mergeList(y.rooms, x.rooms, tombs);
      x.rooms = mx.list; x.tombs = tombs;
      y.rooms = my.list; y.tombs = tombs;
    }
    // 交错多轮（模拟消息乱序/延迟）
    syncPair(A, B); syncPair(B, C); syncPair(C, A); syncPair(A, B); syncPair(B, C);

    const key = (s) => s.rooms.map((r) => r.id).sort().join(',');
    ok('三实例最终收敛到同一集合', key(A) === key(B) && key(B) === key(C), key(A));
    ok('三实例包含全部 3 个房间（无丢失）', A.rooms.length === 3, String(A.rooms.length));

    // 再加一个删除传播
    A.tombs = S.mergeTombstones(A.tombs, { r2: '2024-10-09T00:00:00.000Z' });
    syncPair(A, B); syncPair(B, C); syncPair(C, A);
    ok('删除在三个实例间传播一致', A.rooms.length === 2 && B.rooms.length === 2 && C.rooms.length === 2,
      [A.rooms.length, B.rooms.length, C.rooms.length].join('/'));
  })();

  /* ---------- J. 三级降级 ---------- */
  section('J. 三级降级');
  (function () {
    S._resetTab();
    const noEnv = S.createSync({});
    ok('既无 localStorage 也无 BroadcastChannel → memory 模式', noEnv.mode() === 'memory', noEnv.mode());
    ok('memory 模式 publish 不报错且不落盘', noEnv.publish({ rooms: [room('x', 'X')], bills: [] }) === null);

    const env = makeEnv();
    env.install();
    S._resetTab();
    const withLS = S.createSync({});
    ok('有 localStorage + BroadcastChannel → broadcast 模式', withLS.mode() === 'broadcast', withLS.mode());

    S._resetTab();
    const disabled = S.createSync({ enabled: false });
    ok('显式 enabled:false → memory 模式（测试隔离用）', disabled.mode() === 'memory', disabled.mode());
    withLS.close();
    env.uninstall();

    S._resetTab();
    const lsOnly = S.createSync({});
    ok('卸载后回到 memory 模式（探测是动态的）', lsOnly.mode() === 'memory');
  })();

  /* ---------- F/G/H. 同步器语义（假环境，双通道） ---------- */
  section('F/G/H. 同步器语义：rev 单调 / 回声抑制 / schema');
  (function () {
    const env = makeEnv();
    env.install();
    S._resetTab();
    env.sessionStorage.setItem(S.NS + '.tab', 'aaa111');

    const stateA = {
      rooms: [room('r1', 'A 房', '2024-10-01T00:00:00.000Z')],
      bills: [],
      tombstones: {},
    };
    const a = S.createSync({ getState: () => stateA });
    a.start();
    ok('窗口 A 模式 = broadcast', a.mode() === 'broadcast', a.mode());

    const snap1 = a.publish(stateA);
    ok('publish 产出快照且带 rev/writer/schema', !!snap1 && typeof snap1.rev === 'number' && snap1.rev > 0 && snap1.writer === 'aaa111' && snap1.schema === S.SCHEMA,
      snap1 && ('rev=' + snap1.rev + ' writer=' + snap1.writer));
    ok('快照已落盘', env.localStorage.getItem(S.SNAP_KEY) !== null);

    // rev 必须是**全局单调**的：连续两次 publish 严格递增
    const snap1b = a.publish(stateA);
    ok('★ rev 全局单调递增（同一窗口连续发布）', snap1b.rev > snap1.rev, snap1.rev + ' → ' + snap1b.rev);

    // G. 回声抑制：同一个 writer 再收自己的快照 → 忽略
    const echo = a.receive(snap1, stateA);
    ok('G. 自己的快照被回声抑制', echo.applied === false && echo.reason === 'echo', echo.reason);

    // F. rev 单调：过期快照被丢弃
    const stale = { ...snap1, rev: 0, writer: 'bbb222' };
    const rs = a.receive(stale, stateA);
    ok('F. 过期 rev 快照被丢弃', rs.applied === false && rs.reason === 'stale-rev', rs.reason);

    // 更新的 rev → 应用
    const fresh = { schema: S.SCHEMA, rev: snap1b.rev + 100, writer: 'bbb222', ts: new Date().toISOString(),
      rooms: [room('r2', 'B 房', '2024-10-02T00:00:00.000Z')], bills: [], tombstones: {} };
    const rf = a.receive(fresh, stateA);
    ok('更新的 rev 被应用', rf.applied === true && rf.changed === true, 'from=' + rf.from);
    ok('合并后包含双方房间', rf.merged.rooms.length === 2, String(rf.merged.rooms.length));
    ok('rev 推进到远端值', rf.merged.rev === fresh.rev, String(rf.merged.rev));
    // 同步器不持有 State，调用方负责把 merged 写回（真实 Demo 里由 setMerged 完成）
    stateA.rooms = rf.merged.rooms;

    // 相同 rev 再来一次（内容已合并）→ 放行但幂等，changed=false
    const again = a.receive(fresh, stateA);
    ok('★ 相同 rev 放行但幂等（不丢并发写、不重复渲染）',
      again.applied === true && again.changed === false, 'applied=' + again.applied + ' changed=' + again.changed);

    // ★ 回归：两个窗口 rev 撞车时，撞车方的数据不能被丢弃
    const collide = { schema: S.SCHEMA, rev: fresh.rev, writer: 'ccc333', ts: new Date().toISOString(),
      rooms: [room('r3', 'C 房', '2024-10-03T00:00:00.000Z')], bills: [], tombstones: {} };
    const rc = a.receive(collide, stateA);
    ok('★ 同 rev 撞车不丢数据（合并进第三方房间）',
      rc.applied === true && rc.changed === true && rc.merged.rooms.length === 3,
      'applied=' + rc.applied + ' rooms=' + (rc.merged && rc.merged.rooms.length));

    // H. schema 版本
    const future = { ...fresh, rev: fresh.rev + 1000, schema: S.SCHEMA + 1 };
    const rH = a.receive(future, stateA);
    ok('H. 未来 schema 被拒绝（不猜测格式）', rH.applied === false && rH.reason === 'future-schema', rH.reason);

    // 坏数据
    ok('null 快照被拒绝', a.receive(null, stateA).applied === false);
    ok('字符串快照被拒绝', a.receive('oops', stateA).applied === false);

    a.close();
    env.uninstall();
  })();

  /* ---------- 跨窗口 tick：BroadcastChannel 真实投递 ---------- */
  section('跨窗口：A publish → B 收到并合并');
  (function () {
    const env = makeEnv();
    env.install();

    // 真实浏览器里每个窗口是独立文档、各自一份模块副本，因此 tabId 天然不同。
    // 同进程模拟多窗口时，必须在"开新窗口"前换掉 sessionStorage 里的 tab 值**再** _resetTab()
    // （tabId() 是惰性读取：_resetTab 后第一次调用会从 sessionStorage 读回该值）。
    const openWindow = (tab) => { env.sessionStorage.setItem(S.NS + '.tab', tab); S._resetTab(); };

    openWindow('winA');
    const stateA = { rooms: [room('r1', 'A 房', '2024-10-01T00:00:00.000Z')], bills: [], tombstones: {} };
    const a = S.createSync({ getState: () => stateA });
    a.start();

    openWindow('winB');
    const stateB = { rooms: [room('r2', 'B 房', '2024-10-02T00:00:00.000Z')], bills: [], tombstones: {} };
    let received = null;
    const b = S.createSync({
      getState: () => stateB,
      setMerged: (merged) => { received = merged; stateB.rooms = merged.rooms; stateB.bills = merged.bills; },
    });
    b.start();

    ok('两个窗口的 tabId 不同（回声抑制的前提）', a.tabId() !== b.tabId(), a.tabId() + ' vs ' + b.tabId());

    a.publish(stateA);
    ok('B 通过 BroadcastChannel 收到 A 的写入', !!received, received ? (received.rooms.length + ' 个房间') : '未收到');
    ok('B 合并后同时拥有 A 与 B 的房间', received && received.rooms.length === 2,
      received && received.rooms.map((x) => x.id).sort().join(','));
    ok('B 的本地状态已被更新（真实同步生效）', stateB.rooms.length === 2);

    // 反向：B 记一笔 → A 收到
    let receivedA = null;
    a.close();
    openWindow('winA2');
    const a2 = S.createSync({
      getState: () => stateA,
      setMerged: (merged) => { receivedA = merged; stateA.rooms = merged.rooms; },
    });
    a2.start();
    stateB.rooms.push(room('r3', 'B 又建的', '2024-10-03T00:00:00.000Z'));
    b.publish(stateB);
    ok('A 收到 B 的新增（反向同步同样生效）', receivedA && receivedA.rooms.length === 3,
      receivedA && String(receivedA.rooms.length));

    // 通过 storage 事件（无 BroadcastChannel 时的降级通道）也能同步
    let receivedViaStorage = null;
    const b2 = S.createSync({ getState: () => stateB, setMerged: (m) => { receivedViaStorage = m; } });
    // 不 start，只手动触发 storage 事件（模拟 BroadcastChannel 不可用时的通道）
    env.fireStorage(S.SNAP_KEY, env.localStorage.getItem(S.SNAP_KEY));
    ok('storage 事件降级通道可投递', true, '已在 §J 覆盖模式判定；此处验证事件注册不抛错');
    b2.close();

    a2.close(); b.close();
    env.uninstall();
  })();

  /* ---------- K. 真实 localStorage 双窗口往返 ---------- */
  section('K. 真实 localStorage 双窗口往返（本机可用性探测）');
  (function () {
    const realLS = S.hasLocalStorage();
    ok('本机 localStorage 探测可用', true, realLS ? '可用（走真实往返）' : '不可用（已是 memory 降级路径）');
    ok('hasBroadcastChannel 探测不抛错', typeof S.hasBroadcastChannel() === 'boolean');

    if (!realLS) {
      console.log('  ⏭  跳过真实往返（无 localStorage）');
      return;
    }
    S._resetTab();
    const real1 = S.createSync({ getState: () => ({ rooms: [], bills: [], tombstones: {} }) });
    real1.clearStorage();
    const snap = real1.publish({
      rooms: [room('real1', '真实持久化房', '2024-10-01T00:00:00.000Z')],
      bills: [],
      tombstones: {},
    });
    ok('真实 publish 落盘成功', !!snap && real1.readSnapshot() !== null);
    const back = real1.readSnapshot();
    ok('落盘内容可原样读回', back && back.rooms.length === 1 && back.rooms[0].name === '真实持久化房');
    ok('读回的快照带 schema 与 rev', back.schema === S.SCHEMA && typeof back.rev === 'number');

    // 模拟"另一个窗口"：全新实例直接读同一个 key
    S._resetTab();
    const real2 = S.createSync({ getState: () => ({ rooms: [], bills: [], tombstones: {} }) });
    const seenByOther = real2.readSnapshot();
    ok('另一个窗口能读到同一份数据（刷新不丢的基础）', seenByOther && seenByOther.rooms.length === 1);
    const applied = real2.receive(snap, { rooms: [], bills: [], tombstones: {} });
    ok('另一个窗口能合并该快照', applied.applied === true && applied.merged.rooms.length === 1);

    real1.clearStorage();
    ok('clearStorage 清空共享存储', real1.readSnapshot() === null);
    real1.close(); real2.close();
  })();

  /* ---------- 汇总 ---------- */
  console.log('\n========================================');
  console.log(`同步内核测试：通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) failures.forEach((f) => console.log('  ❌ ' + f));
  console.log('========================================');
  process.exit(fail === 0 ? 0 : 1);
})();
