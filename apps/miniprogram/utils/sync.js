/**
 * sync.js —— 真实多窗口同步内核（UMD，可被浏览器 Demo 与 Node 测试复用）
 *
 * ============================ 为什么需要它 ============================
 * 改造前：Demo 的「4 台手机实时同步」是**单页模拟**——4 台手机共享同一份内存 State，
 * 「同步」只是本地重渲染。全项目零 localStorage、零 BroadcastChannel，
 * 刷新页面数据即全部丢失，也**无法开两个浏览器窗口协同演示**。
 *
 * 改造后（本模块）：
 *   - 同浏览器**多个窗口/标签页真实同步**：窗口 A 记一笔 → 窗口 B 秒级可见；
 *   - **刷新不丢**（localStorage 持久化），关掉再开数据仍在；
 *   - **零依赖、零服务器**，`file://` 双击即开这条红线不变；
 *   - 三级降级：服务端通道 → 同浏览器多窗口通道 → 单页模拟（与改造前逐字节等价）。
 *
 * ============================ 关键设计 ============================
 * 1) 实体级合并（per-entity merge）而非整份覆盖
 *    localStorage 没有 CAS，整份覆盖会丢并发更新。这里按 id 并集合并，
 *    同 id 冲突用 updatedAt 做 LWW（last-write-wins）。
 * 2) 墓碑（tombstone）防「删除复活」
 *    删除必须留痕：否则对方窗口的旧快照一合并，被删的账单就活了。
 * 3) 单调 rev（版本号）
 *    快照带全局 rev，只丢弃**更旧**的 rev（相等放行，见 nextRev 注释）。
 * 4) writer 回声抑制
 *    自己的写入会触发自己的 storage 事件，用 tabId 过滤。
 * 5) 全局唯一 id（uid）
 *    改造前 id 是 `room_` + nextRoomId++，而每个窗口的 nextRoomId 都从 1 开始
 *    → 两个窗口各建一个房间都会得到 `room_1`，合并后互相覆盖。
 *    改为「时间戳 + 随机 + 窗口号」的全局唯一 id。
 *
 * 诚实边界：本模块解决的是**同一浏览器多窗口**的真实同步。
 * 跨设备/跨浏览器同步需要后端通道（server/ 已具备 REST 接口），不在本模块范围内。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TravelSync = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var NS = 'travelaa.v1';
  var SNAP_KEY = NS + '.snapshot';
  var SCHEMA = 1;

  /* ---------- 小工具 ---------- */

  /** 生成全局唯一 id：时间戳(36) + 计数(36) + 随机(36) + 窗口号(36) */
  var _seq = 0;
  var _tabId = null;
  function rand36(len) {
    var s = '';
    while (s.length < len) s += Math.floor(Math.random() * 36).toString(36);
    return s.slice(0, len);
  }
  function makeUid(prefix) {
    _seq = (_seq + 1) % 46656;
    return (prefix || 'id') + '_' +
      Date.now().toString(36) + '_' +
      _seq.toString(36) + '_' +
      rand36(5) + '_' +
      String(tabId()).slice(-3);
  }

  /** 每个窗口一个短 id（存 sessionStorage：同一窗口内刷新不变，新窗口不同） */
  function tabId() {
    if (_tabId) return _tabId;
    _tabId = rand36(6);
    try {
      if (typeof sessionStorage !== 'undefined') {
        var k = NS + '.tab';
        var v = sessionStorage.getItem(k);
        if (v) _tabId = v;
        else sessionStorage.setItem(k, _tabId);
      }
    } catch (e) { /* 无 sessionStorage：用随机值即可 */ }
    return _tabId;
  }
  /** 仅供测试：重置窗口身份 */
  function _resetTab() { _tabId = null; }

  function nowIso() { return new Date().toISOString(); }

  function hasLocalStorage() {
    try {
      if (typeof localStorage === 'undefined' || !localStorage) return false;
      var k = NS + '.probe';
      localStorage.setItem(k, '1');
      localStorage.removeItem(k);
      return true;
    } catch (e) { return false; }
  }
  function hasBroadcastChannel() {
    try { return typeof BroadcastChannel === 'function'; } catch (e) { return false; }
  }

  /* ---------- 合并算法（纯函数，可单测） ---------- */

  function byId(list) {
    var m = {};
    (list || []).forEach(function (x) { if (x && x.id != null) m[x.id] = x; });
    return m;
  }

  /**
   * 计算并集 id
   */
  function unionIds(localList, remoteList) {
    var seen = {};
    var out = [];
    (localList || []).forEach(function (x) { if (x && !seen[x.id]) { seen[x.id] = 1; out.push(x.id); } });
    (remoteList || []).forEach(function (x) { if (x && !seen[x.id]) { seen[x.id] = 1; out.push(x.id); } });
    return out;
  }

  function tsOf(x) {
    if (!x) return 0;
    var v = x.updatedAt || x.createdAt || 0;
    var t = typeof v === 'number' ? v : Date.parse(v);
    return isNaN(t) ? 0 : t;
  }

  /**
   * 实体级合并：按 id 并集，同 id 取 updatedAt 较新者（缺失时间戳视为最旧）。
   *
   * 返回 { list, changed }；changed 表示相对 localList 是否有变化。
   */
  function mergeList(localList, remoteList, tombstones) {
    var L = byId(localList);
    var R = byId(remoteList);
    var ids = unionIds(localList, remoteList);
    var changed = false;
    var list = [];

    ids.forEach(function (id) {
      var tomb = tombstones && Object.prototype.hasOwnProperty.call(tombstones, id);
      if (tomb) {
        // 墓碑：只要删除时间不早于两侧实体的更新时间，就保持删除
        var dAt = tsOf({ updatedAt: tombstones[id] });
        var lAt = tsOf(L[id]);
        var rAt = tsOf(R[id]);
        if (dAt >= lAt && dAt >= rAt) {
          if (L[id]) changed = true;               // 本地还有 → 需要移除
          return;                                   // 保持删除，不放进 list
        }
      }
      var a = L[id];
      var b = R[id];
      if (a && b) {
        if (tsOf(b) > tsOf(a)) { list.push(b); changed = true; }
        else list.push(a);
      } else if (b) { list.push(b); changed = true; }
      else if (a) { list.push(a); }
    });

    // 保持稳定排序（按时间），便于展示与比对
    list.sort(function (x, y) { return tsOf(x) - tsOf(y); });
    return { list: list, changed: changed };
  }

  /**
   * 合并 tombstone 表：同一 id 取较晚时间
   */
  function mergeTombstones(a, b) {
    var out = {};
    [a, b].forEach(function (src) {
      if (!src) return;
      Object.keys(src).forEach(function (k) {
        if (!out[k] || tsOf({ updatedAt: src[k] }) > tsOf({ updatedAt: out[k] })) out[k] = src[k];
      });
    });
    return out;
  }

  /* ---------- 同步内核 ---------- */

  /**
   * 创建同步器
   *
   * @param {Object} opts
   *   opts.enabled  {Boolean} 是否启用同步（测试时可强制关闭，回到单页模拟）
   *   opts.onRemote {Function} 收到远端快照后的回调（用于合并进当前 State 并重渲染）
   *   opts.getState {Function} 返回当前 { rooms, bills, tombstones, rev }
   *   opts.setMerged{Function} 应用合并结果 (merged, meta) => void
   *   opts.onMode   {Function} 同步模式变化回调 (mode) => void
   */
  function createSync(opts) {
    opts = opts || {};
    // 窗口身份在创建时**冻结**。tabId() 背后是一个可被 _resetTab() 重置的可变全局，
    // 若每次调用都重新读取，旧实例会在"另一个窗口"出现后"变成"新窗口
    // → 回声抑制失效、自己的写入被当远端重复应用。冻结后本实例始终用创建时的身份。
    var myTab = tabId();
    var explicitOff = opts.enabled === false;
    var lsOK = hasLocalStorage();
    var bcOK = hasBroadcastChannel();
    var mode = 'memory';           // memory | local | broadcast
    if (!explicitOff && lsOK) mode = 'local';
    if (!explicitOff && lsOK && bcOK) mode = 'broadcast';

    var bc = null;
    var storageHandler = null;
    var closed = false;
    var stats = { sent: 0, recv: 0, merged: 0, ignored: 0 };
    var rev = 0;

    function readSnapshot() {
      if (!lsOK) return null;
      try {
        var raw = localStorage.getItem(SNAP_KEY);
        if (!raw) return null;
        var s = JSON.parse(raw);
        if (!s || typeof s !== 'object') return null;
        if (s.schema != null && s.schema > SCHEMA) return null;   // 未来版本，不猜
        return s;
      } catch (e) { return null; }
    }

    function writeSnapshot(snap) {
      if (!lsOK) return false;
      try { localStorage.setItem(SNAP_KEY, JSON.stringify(snap)); return true; }
      catch (e) { return false; }                                  // 配额满/无痕模式
    }

    /**
     * 取下一个**全局单调**的 rev。
     *
     * 为什么不能简单 `rev += 1`：rev 是每个窗口各自的局部计数器，都从 0 开始。
     * 窗口 A 没收到 B 的快照就先 publish，B 的本地 rev 可能仍是 0，
     * 于是 B 发的 rev=1 与 A 已经推进到的 rev=1 相同 → 被 "stale-rev" 丢弃，
     * **B 那一笔数据永远同步不到 A**（实测：双窗口各记一笔，各自只看到自己那笔）。
     *
     * 修正：以 (墙钟毫秒 × 1000) 为下界，并回读共享存储里的 rev，
     * 三者取最大再 +1，保证跨窗口严格递增；同一毫秒内多次发布也靠 +1 拉开。
     * 极端并发的同一 rev 由 receive() 的「相等也合并」兜底（见下）。
     */
    function nextRev() {
      var stored = readSnapshot();
      var storedRev = stored && typeof stored.rev === 'number' ? stored.rev : 0;
      var next = Math.max(rev, storedRev, Date.now() * 1000) + 1;
      rev = next;
      return next;
    }

    /**
     * 把当前 State 落盘并广播
     * @param {Object} state { rooms, bills, tombstones }
     */
    function publish(state) {
      if (mode === 'memory') return null;
      nextRev();
      var snap = {
        schema: SCHEMA,
        rev: rev,
        writer: myTab,
        ts: nowIso(),
        rooms: (state && state.rooms) || [],
        bills: (state && state.bills) || [],
        tombstones: (state && state.tombstones) || {}
      };
      writeSnapshot(snap);
      if (bc) { try { bc.postMessage(snap); } catch (e) { /* 通道关闭等 */ } }
      stats.sent += 1;
      return snap;
    }

    /**
     * 收到远端快照 → 与本地合并 → 回调
     * 返回 { applied:Boolean, meta:{...} }
     */
    function receive(snap, local) {
      stats.recv += 1;
      if (!snap || typeof snap !== 'object') { stats.ignored += 1; return { applied: false, reason: 'bad-snapshot' }; }
      if (snap.writer === myTab) { stats.ignored += 1; return { applied: false, reason: 'echo' }; }
      if (snap.schema != null && snap.schema > SCHEMA) { stats.ignored += 1; return { applied: false, reason: 'future-schema' }; }
      // 只丢弃**更旧**的 rev。相等必须放行：两个窗口在同一毫秒各写一笔时
      // rev 可能撞车，若把相等也当乱序丢掉，撞车那一方的数据就永久丢失。
      // 放行的代价只是多跑一次合并，而 mergeList 按 updatedAt 做 LWW、幂等，
      // 内容没变化时 changed=false，不会触发多余渲染。
      if (typeof snap.rev === 'number' && snap.rev < rev) { stats.ignored += 1; return { applied: false, reason: 'stale-rev' }; }

      var localRooms = (local && local.rooms) || [];
      var localBills = (local && local.bills) || [];
      var localTombs = (local && local.tombstones) || {};

      var tombs = mergeTombstones(localTombs, snap.tombstones);
      var mr = mergeList(localRooms, snap.rooms, tombs);
      var mb = mergeList(localBills, snap.bills, tombs);

      var changed = mr.changed || mb.changed ||
        Object.keys(tombs).length !== Object.keys(localTombs).length;

      rev = typeof snap.rev === 'number' ? Math.max(rev, snap.rev) : rev;
      var merged = { rooms: mr.list, bills: mb.list, tombstones: tombs, rev: rev };
      if (changed) stats.merged += 1;
      return { applied: true, changed: changed, merged: merged, from: snap.writer };
    }

    function start() {
      if (mode === 'broadcast') {
        try {
          bc = new BroadcastChannel(NS);
          bc.onmessage = function (e) { dispatch(e && e.data); };
        } catch (e) { bc = null; mode = 'local'; }
      }
      if (mode !== 'memory' && typeof window !== 'undefined' && window.addEventListener) {
        storageHandler = function (e) {
          if (!e || e.key !== SNAP_KEY || !e.newValue) return;
          var snap = null;
          try { snap = JSON.parse(e.newValue); } catch (err) { return; }
          dispatch(snap, true);                    // storage 事件本身就是"别人写的"
        };
        window.addEventListener('storage', storageHandler);
      }
      if (opts.onMode) { try { opts.onMode(mode); } catch (e) { /* ignore */ } }
      return mode;
    }

    function dispatch(snap, fromStorage) {
      if (closed) return;
      var local = opts.getState ? opts.getState() : null;
      var r = receive(snap, local);
      if (!r.applied) return;
      if (r.changed && opts.setMerged) opts.setMerged(r.merged, { from: r.from });
    }

    function close() {
      closed = true;
      if (bc) { try { bc.close(); } catch (e) { /* ignore */ } bc = null; }
      if (storageHandler && typeof window !== 'undefined' && window.removeEventListener) {
        window.removeEventListener('storage', storageHandler);
      }
      storageHandler = null;
    }

    /** 清空共享存储（仅测试与"重置全部窗口"使用） */
    function clearStorage() {
      if (lsOK) { try { localStorage.removeItem(SNAP_KEY); } catch (e) { /* ignore */ } }
    }

    return {
      mode: function () { return mode; },
      tabId: function () { return myTab; },
      uid: makeUid,
      publish: publish,
      receive: receive,
      start: start,
      close: close,
      clearStorage: clearStorage,
      readSnapshot: readSnapshot,
      stats: function () { return { mode: mode, rev: rev, sent: stats.sent, recv: stats.recv, merged: stats.merged, ignored: stats.ignored }; },
      setRev: function (n) { rev = n; },
      key: SNAP_KEY,
      ns: NS
    };
  }

  return {
    createSync: createSync,
    // 纯函数导出（便于单测与复用）
    mergeList: mergeList,
    mergeTombstones: mergeTombstones,
    makeUid: makeUid,
    tabId: tabId,
    _resetTab: _resetTab,
    hasLocalStorage: hasLocalStorage,
    hasBroadcastChannel: hasBroadcastChannel,
    NS: NS,
    SNAP_KEY: SNAP_KEY,
    SCHEMA: SCHEMA
  };
}));
