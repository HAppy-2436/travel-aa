/**
 * TravelAA 旅行AA记账 - 独立后端API
 * 
 * 技术栈：Express + SQLite + 腾讯云OCR
 * 资源占用：< 100MB 内存，1核CPU即可运行
 * 部署方式：PM2 / Docker / systemd
 */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const db = require('./database');
// 共享 AI 引擎（与小程序/浏览器 Demo 同一份算法内核，UMD 三端复用）
const AI = require('../apps/miniprogram/utils/ai');
// 携程行程订单导入（同一内核）
const CTRIP = require('../apps/miniprogram/utils/ctrip');

const app = express();
const PORT = process.env.PORT || 3000;

// 简易 .env 加载（零依赖）：server/.env 配置 LLM_API_KEY / LLM_BASE_URL / LLM_MODEL / VISION_MODEL
(function loadEnvFile() {
  try {
    const fs = require('fs');
    const path = require('path');
    const p = path.join(__dirname, '.env');
    if (fs.existsSync(p)) {
      fs.readFileSync(p, 'utf8').split(/\r?\n/).forEach(line => {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (m && !process.env[m[1]]) {
          process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
        }
      });
    }
  } catch (e) { /* ignore */ }
})();

// 环境变量兼容：优先 LLM_API_KEY，未设置时自动读取 DEEPSEEK_API_KEY（密钥不落盘）
// Windows 兜底：进程未继承用户级变量时，从注册表 HKCU\Environment 读取
if (!process.env.LLM_API_KEY && !process.env.DEEPSEEK_API_KEY && process.platform === 'win32') {
  try {
    const { execSync } = require('child_process');
    const out = execSync('reg query HKCU\\Environment /v DEEPSEEK_API_KEY', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const m = out.match(/DEEPSEEK_API_KEY\s+REG_SZ\s+(\S+)/);
    if (m) process.env.DEEPSEEK_API_KEY = m[1];
  } catch (e) { /* 未配置 */ }
}
if (!process.env.LLM_API_KEY && process.env.DEEPSEEK_API_KEY) {
  process.env.LLM_API_KEY = process.env.DEEPSEEK_API_KEY;
}

// ============ 中间件 ============
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// 请求日志
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    if (ms > 100) {
      console.log(`${req.method} ${req.path} ${res.statusCode} ${ms}ms`);
    }
  });
  next();
});

// ============ 工具函数 ============

function genId() {
  return Date.now().toString(36) + crypto.randomBytes(6).toString('hex');
}

function genRoomCode() {
  // 生成6位不重复房间号
  let code;
  do {
    code = String(Math.floor(100000 + Math.random() * 900000));
  } while (db.prepare('SELECT id FROM rooms WHERE room_code = ?').get(code));
  return code;
}

/**
 * 贪心算法：计算最简转账方案
 * V2：多币种账单按记账快照汇率折算人民币（与 apps/miniprogram/utils/settle.js 同一口径）
 */
function calcSettlement(members, bills) {
  const balanceMap = {};
  members.forEach(m => {
    balanceMap[m.user_id] = {
      id: m.user_id,
      name: m.nickname,
      amount: 0
    };
  });

  const currencies = new Set();
  bills.forEach(bill => {
    const splits = typeof bill.splits === 'string' ? JSON.parse(bill.splits || '[]') : (bill.splits || []);
    currencies.add(bill.currency || 'CNY');
    const cny = AI.billCNY({
      amount: bill.amount, currency: bill.currency,
      rate: bill.rate, cnyAmount: bill.cny_amount || null
    });
    const rawAmount = Number(bill.amount) || 0;
    const scale = rawAmount > 0 ? cny / rawAmount : 1;
    if (balanceMap[bill.payer_id]) {
      balanceMap[bill.payer_id].amount += cny;
    }
    splits.forEach(s => {
      if (balanceMap[s.memberId]) {
        balanceMap[s.memberId].amount -= s.amount * scale;
      }
    });
  });

  const balances = Object.values(balanceMap)
    .map(b => ({ ...b, amount: Math.round(b.amount * 100) / 100 }))
    .filter(b => Math.abs(b.amount) > 0.01)
    .sort((a, b) => b.amount - a.amount);

  // 贪心匹配（复制对象再扣减，保留 balances 展示金额）
  const transfers = [];
  const debtors = balances.filter(b => b.amount < -0.01).map(b => ({ ...b }));
  const creditors = balances.filter(b => b.amount > 0.01).map(b => ({ ...b }));

  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amt = Math.min(-debtors[i].amount, creditors[j].amount);
    if (amt > 0.01) {
      transfers.push({
        from: debtors[i].id,
        fromName: debtors[i].name,
        to: creditors[j].id,
        toName: creditors[j].name,
        amount: Math.round(amt * 100) / 100
      });
    }
    debtors[i].amount += amt;
    creditors[j].amount -= amt;
    if (Math.abs(debtors[i].amount) < 0.01) i++;
    if (Math.abs(creditors[j].amount) < 0.01) j++;
  }

  const totalExpense = bills.reduce((s, b) => s + AI.billCNY({
    amount: b.amount, currency: b.currency, rate: b.rate, cnyAmount: b.cny_amount || null
  }), 0);

  return {
    balances,
    transfers,
    totalExpense: Math.round(totalExpense * 100) / 100,
    transferCount: transfers.length,
    currencies: [...currencies],
    hasForeign: [...currencies].some(c => c !== 'CNY')
  };
}

// ============ API 路由 ============

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    name: 'TravelAA API',
    version: '1.0.0',
    uptime: process.uptime()
  });
});

// ---- 用户 ----

// 注册/登录
app.post('/api/login', (req, res) => {
  try {
    const { userId, nickname, avatar } = req.body;
    const id = userId || genId();

    db.prepare(`
      INSERT INTO users (id, nickname, avatar) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET nickname = ?, avatar = ?
    `).run(id, nickname || '', avatar || '', nickname || '', avatar || '');

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    res.json({ success: true, user });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ---- 房间 ----

// 创建房间
app.post('/api/rooms', (req, res) => {
  try {
    const { userId, nickname, avatar, name, destination, startDate, endDate } = req.body;

    if (!userId) return res.status(400).json({ success: false, error: '缺少用户ID' });
    if (!name) return res.status(400).json({ success: false, error: '请输入旅行名称' });

    const roomId = genId();
    const roomCode = genRoomCode();

    // 创建房间
    db.prepare(`
      INSERT INTO rooms (id, name, destination, room_code, creator_id, start_date, end_date)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(roomId, name, destination || '', roomCode, userId, startDate || '', endDate || '');

    // 添加创建者为成员
    db.prepare(`
      INSERT INTO room_members (room_id, user_id, nickname, avatar) VALUES (?, ?, ?, ?)
    `).run(roomId, userId, nickname || '房主', avatar || '');

    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
    const members = db.prepare('SELECT * FROM room_members WHERE room_id = ?').all(roomId);

    res.json({ success: true, room: { ...room, members } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 加入房间
app.post('/api/rooms/join', (req, res) => {
  try {
    const { roomCode, userId, nickname, avatar } = req.body;

    if (!roomCode || roomCode.length !== 6) {
      return res.status(400).json({ success: false, error: '请输入6位房间号' });
    }

    // 查找房间
    const room = db.prepare('SELECT * FROM rooms WHERE room_code = ?').get(roomCode);
    if (!room) {
      return res.status(404).json({ success: false, error: '房间不存在' });
    }

    // 检查是否已在房间
    const existing = db.prepare(
      'SELECT * FROM room_members WHERE room_id = ? AND user_id = ?'
    ).get(room.id, userId);

    if (existing) {
      const members = db.prepare('SELECT * FROM room_members WHERE room_id = ?').all(room.id);
      return res.json({ success: true, room: { ...room, members }, message: '已在房间中' });
    }

    // 检查人数上限
    const count = db.prepare(
      'SELECT COUNT(*) as cnt FROM room_members WHERE room_id = ?'
    ).get(room.id);
    if (count.cnt >= 20) {
      return res.status(400).json({ success: false, error: '房间人数已达上限' });
    }

    // 加入房间
    db.prepare(`
      INSERT INTO room_members (room_id, user_id, nickname, avatar) VALUES (?, ?, ?, ?)
    `).run(room.id, userId, nickname || '新成员', avatar || '');

    const members = db.prepare('SELECT * FROM room_members WHERE room_id = ?').all(room.id);
    res.json({ success: true, room: { ...room, members } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 获取我的房间列表
app.get('/api/rooms/my/:userId', (req, res) => {
  try {
    const { userId } = req.params;
    const rooms = db.prepare(`
      SELECT r.*, 
        (SELECT COUNT(*) FROM room_members WHERE room_id = r.id) as member_count
      FROM rooms r
      JOIN room_members rm ON r.id = rm.room_id
      WHERE rm.user_id = ?
      ORDER BY r.updated_at DESC
      LIMIT 20
    `).all(userId);

    // 为每个房间添加成员列表
    const result = rooms.map(room => {
      const members = db.prepare('SELECT * FROM room_members WHERE room_id = ?').all(room.id);
      return { ...room, members };
    });

    res.json({ success: true, rooms: result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 获取房间详情
app.get('/api/rooms/:roomId', (req, res) => {
  try {
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.roomId);
    if (!room) return res.status(404).json({ success: false, error: '房间不存在' });

    const members = db.prepare('SELECT * FROM room_members WHERE room_id = ?').all(room.id);
    res.json({ success: true, room: { ...room, members } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ---- 账单 ----

// 获取房间账单
app.get('/api/rooms/:roomId/bills', (req, res) => {
  try {
    const bills = db.prepare(`
      SELECT * FROM bills WHERE room_id = ? ORDER BY created_at DESC LIMIT 100
    `).all(req.params.roomId);

    // 解析splits
    const result = bills.map(b => ({ ...b, splits: JSON.parse(b.splits || '[]') }));
    res.json({ success: true, bills: result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 添加账单
app.post('/api/bills', (req, res) => {
  try {
    const { roomId, payerId, payerName, amount, description, category, splitType, splits, imageUrl, createdBy,
      currency, rate, orderNo, source } = req.body;

    // 校验
    if (!roomId || !amount || amount <= 0) {
      return res.status(400).json({ success: false, error: '金额必须大于0' });
    }
    if (!payerId) {
      return res.status(400).json({ success: false, error: '请选择付款人' });
    }

    // 校验分摊金额
    const totalSplit = (splits || []).reduce((s, x) => s + (x.amount || 0), 0);
    if (Math.abs(totalSplit - amount) > 0.05) {
      return res.status(400).json({ 
        success: false, 
        error: `分摊金额(${totalSplit.toFixed(2)})与账单金额(${amount})不符` 
      });
    }

    const billId = genId();
    const finalAmount = Math.round(amount * 100) / 100;
    // 多币种：记账时快照汇率与折算额（结算按快照折算，不漂移）
    const cur = (currency || 'CNY').toUpperCase();
    const finalRate = cur === 'CNY' ? 1 : (Number(rate) || AI.getRates()[cur] || 1);
    const cnyAmount = Math.round(finalAmount * finalRate * 100) / 100;

    db.prepare(`
      INSERT INTO bills (id, room_id, payer_id, payer_name, amount, description, category, split_type, splits, image_url, created_by, currency, rate, cny_amount, order_no, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      billId, roomId, payerId, payerName || '', finalAmount,
      description || '', category || 'other', splitType || 'equal',
      JSON.stringify(splits || []), imageUrl || '', createdBy || payerId,
      cur, finalRate, cnyAmount, orderNo || '', source || ''
    );

    // 更新房间统计（按人民币折算额）
    db.prepare(`
      UPDATE rooms SET bill_count = bill_count + 1, total_expense = total_expense + ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(cnyAmount, roomId);

    const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(billId);
    res.json({ success: true, bill: { ...bill, splits: JSON.parse(bill.splits) } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 编辑账单（V2：产品闭环 —— 记错账可改）
app.put('/api/bills/:billId', (req, res) => {
  try {
    const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(req.params.billId);
    if (!bill) return res.status(404).json({ success: false, error: '账单不存在' });

    const { amount, description, category, payerId, payerName, splitType, splits, currency, rate } = req.body;
    const finalAmount = amount != null ? Math.round(Number(amount) * 100) / 100 : bill.amount;

    if (finalAmount <= 0) return res.status(400).json({ success: false, error: '金额必须大于0' });

    const finalSplits = splits || JSON.parse(bill.splits || '[]');
    const totalSplit = finalSplits.reduce((s, x) => s + (x.amount || 0), 0);
    if (Math.abs(totalSplit - finalAmount) > 0.05) {
      return res.status(400).json({
        success: false,
        error: `分摊金额(${totalSplit.toFixed(2)})与账单金额(${finalAmount})不符`
      });
    }

    const cur = (currency || bill.currency || 'CNY').toUpperCase();
    const finalRate = cur === 'CNY' ? 1 : (Number(rate) || bill.rate || AI.getRates()[cur] || 1);
    const cnyAmount = Math.round(finalAmount * finalRate * 100) / 100;

    db.prepare(`
      UPDATE bills SET amount = ?, description = ?, category = ?, payer_id = ?, payer_name = ?,
        split_type = ?, splits = ?, currency = ?, rate = ?, cny_amount = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      finalAmount, description != null ? description : bill.description,
      category || bill.category, payerId || bill.payer_id, payerName != null ? payerName : bill.payer_name,
      splitType || bill.split_type, JSON.stringify(finalSplits), cur, finalRate, cnyAmount, bill.id
    );

    // 重算房间总账（避免增量漂移）
    recomputeRoomStats(bill.room_id);

    const updated = db.prepare('SELECT * FROM bills WHERE id = ?').get(bill.id);
    res.json({ success: true, bill: { ...updated, splits: JSON.parse(updated.splits) } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * 重算房间统计（编辑/删除/导入后调用，保证账面一致）
 */
function recomputeRoomStats(roomId) {
  const row = db.prepare(`
    SELECT COUNT(*) as cnt, COALESCE(SUM(cny_amount), 0) as total FROM bills WHERE room_id = ?
  `).get(roomId);
  db.prepare(`
    UPDATE rooms SET bill_count = ?, total_expense = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(row.cnt, row.total, roomId);
}

// 删除账单
app.delete('/api/bills/:billId', (req, res) => {
  try {
    const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(req.params.billId);
    if (!bill) return res.status(404).json({ success: false, error: '账单不存在' });

    db.prepare('DELETE FROM bills WHERE id = ?').run(bill.id);
    recomputeRoomStats(bill.room_id);

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ---- 房间预算（V2）----

// 设置/更新旅行预算
app.post('/api/rooms/:roomId/budget', (req, res) => {
  try {
    const { budget } = req.body;
    const value = Number(budget) || 0;
    if (value < 0) return res.status(400).json({ success: false, error: '预算不能为负' });

    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.roomId);
    if (!room) return res.status(404).json({ success: false, error: '房间不存在' });

    db.prepare('UPDATE rooms SET budget = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(value, room.id);
    res.json({ success: true, budget: value });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 预算状态（燃烧率/超支预测/安全日均/预警）
app.get('/api/rooms/:roomId/budget-status', (req, res) => {
  try {
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.roomId);
    if (!room) return res.status(404).json({ success: false, error: '房间不存在' });

    const members = db.prepare('SELECT * FROM room_members WHERE room_id = ?').all(room.id);
    const bills = db.prepare('SELECT * FROM bills WHERE room_id = ?').all(room.id).map(toBillDTO);

    const status = AI.budgetStatus(bills, members, room.budget || 0, {
      room: { startDate: room.start_date, endDate: room.end_date }
    });
    res.json({ success: true, status });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// AI 账单审计（重复/账不平/异常大额/漏归类）
app.get('/api/rooms/:roomId/audit', (req, res) => {
  try {
    const bills = db.prepare('SELECT * FROM bills WHERE room_id = ?').all(req.params.roomId).map(toBillDTO);
    const members = db.prepare('SELECT * FROM room_members WHERE room_id = ?').all(req.params.roomId);
    const audit = AI.auditBills(bills, members);
    res.json({ success: true, audit });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 每日消费分析
app.get('/api/rooms/:roomId/daily', (req, res) => {
  try {
    const bills = db.prepare('SELECT * FROM bills WHERE room_id = ?').all(req.params.roomId).map(toBillDTO);
    res.json({ success: true, stats: AI.dailyStats(bills) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * DB 行 → AI 引擎账单 DTO（splits 解析 + 字段名对齐）
 */
function toBillDTO(b) {
  return {
    ...b,
    splits: typeof b.splits === 'string' ? JSON.parse(b.splits || '[]') : (b.splits || []),
    cnyAmount: b.cny_amount || null,
    createdAt: b.created_at
  };
}

// 标记已结清（结算闭环）
app.post('/api/rooms/:roomId/settled', (req, res) => {
  try {
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.roomId);
    if (!room) return res.status(404).json({ success: false, error: '房间不存在' });

    db.prepare("UPDATE rooms SET settled_at = datetime('now'), updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(room.id);
    res.json({ success: true, settledAt: db.prepare('SELECT settled_at FROM rooms WHERE id = ?').get(room.id).settled_at });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ---- 携程行程订单导入（V2：赛道契合）----

/**
 * 订单文本 → 账单草稿；create=true 时直接落库
 */
app.post('/api/ctrip/import', (req, res) => {
  try {
    const { text, roomId, payerId, create, splitWith } = req.body;
    if (!text) return res.status(400).json({ success: false, error: '缺少订单文本' });

    let members = [];
    if (roomId) {
      members = db.prepare('SELECT * FROM room_members WHERE room_id = ?').all(roomId)
        .map(m => ({ id: m.user_id, name: m.nickname }));
    }
    // ⚠️ 必须把汇率表传进去：ctrip.js 在缺 rates 时会把外币汇率兜底成 1，
    //    导致「24000 日元」被当成「24000 元人民币」落库（虚增约 20 倍），
    //    房间总额 / 结算 / 审计全部错。实测：不传 rates → cnyAmount=24000；
    //    传 rates → cnyAmount=1152（正确）。
    const drafts = CTRIP.importOrders(text, members, { payerId, splitWith, rates: AI.getRates() });

    if (!drafts.length) {
      return res.json({ success: true, bills: [], message: '未识别到有效订单（需含金额）' });
    }

    if (!create || !roomId) {
      return res.json({ success: true, bills: drafts, message: `识别到 ${drafts.length} 笔订单，确认后入账` });
    }

    // 直接入账
    const insert = db.prepare(`
      INSERT INTO bills (id, room_id, payer_id, payer_name, amount, description, category, split_type, splits, image_url, created_by, currency, rate, cny_amount, order_no, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const created = [];
    drafts.forEach(d => {
      const billId = genId();
      insert.run(
        billId, roomId, d.payer, d.payerName, d.amount, d.description, d.category, d.splitType,
        JSON.stringify(d.splits), '', d.payer, d.currency, d.rate, d.cnyAmount, d.orderNo, 'ctrip'
      );
      created.push({ id: billId, ...d });
    });
    recomputeRoomStats(roomId);

    res.json({ success: true, bills: created, message: `已导入 ${created.length} 笔订单` });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ---- 结算 ----

app.get('/api/rooms/:roomId/settle', (req, res) => {
  try {
    const members = db.prepare(`
      SELECT * FROM room_members WHERE room_id = ?
    `).all(req.params.roomId);

    const bills = db.prepare(`
      SELECT * FROM bills WHERE room_id = ?
    `).all(req.params.roomId);

    const settlement = calcSettlement(members, bills.map(b => ({
      ...b,
      splits: typeof b.splits === 'string' ? JSON.parse(b.splits || '[]') : (b.splits || [])
    })));

    res.json({ success: true, ...settlement });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ---- AI 能力（与小程序/浏览器 Demo 共享同一引擎）----

/**
 * OpenAI 兼容 chat/completions 调用（云端 LLM 与端侧 NPU 通用）
 */
const FLM_URL = (process.env.FLM_URL || 'http://127.0.0.1:52625').replace(/\/$/, '');
const FLM_BASE = `${FLM_URL}/v1`;
const FLM_MODEL = process.env.FLM_MODEL || 'qwen3.5:9b';
// 云端视觉模型（需支持图片输入的 OpenAI 兼容接口，如 gpt-4o / qwen-vl-plus / glm-4v-plus）
const CLOUD_BASE = (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const CLOUD_MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';
const VISION_MODEL = process.env.VISION_MODEL || CLOUD_MODEL;

async function chatCompletion({ base, key, model, messages, timeoutMs = 30000 }) {
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages, temperature: 0 }),
      signal: controller.signal
    });
    if (!resp.ok) throw new Error('LLM HTTP ' + resp.status);
    const data = await resp.json();
    // FastFlowLM 偶发以 200 + {error} 返回执行失败，转为异常触发重试
    if (data && data.error) {
      throw new Error(typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
    }
    return data.choices?.[0]?.message?.content || null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * LLM 适配器（三层回退，演示永不失败）：
 * 1) 云端 LLM（配置 LLM_API_KEY 时）→ 2) 端侧 NPU 大模型（可选，NPU_FALLBACK=0 关闭）→ 3) 返回 null 由规则引擎兜底
 */
async function callLLM(prompt) {
  const messages = [
    { role: 'system', content: '你是旅行AA记账的解析助手，只输出JSON，不要解释。' },
    { role: 'user', content: prompt }
  ];

  // 1) 云端 LLM
  const key = process.env.LLM_API_KEY || '';
  if (key) {
    try {
      const out = await chatCompletion({ base: CLOUD_BASE, key, model: CLOUD_MODEL, messages });
      if (out) return out;
    } catch (e) {
      console.log('[ai] 云端 LLM 失败，尝试端侧回退：' + e.message);
    }
  }

  // 2) 端侧 NPU 大模型（本地 FastFlowLM，可选回退）
  if (process.env.NPU_FALLBACK !== '0') {
    try {
      const out = await chatCompletion({ base: FLM_BASE, key: '', model: FLM_MODEL, messages, timeoutMs: 45000 });
      if (out) return out;
    } catch (e) {
      console.log('[ai] 端侧 NPU 不可用，回退规则引擎：' + e.message);
    }
  }

  // 3) 双轨回退
  return null;
}

/**
 * 视觉大模型适配器（订单截图 → 结构化）：
 * 1) 云端视觉模型（支持图片输入的 OpenAI 兼容接口）→ 2) 端侧 NPU 视觉（可选回退）→ 3) null
 * 返回 { text, engine, model } 或 null
 */
async function callVisionLLM(dataUri, prompt) {
  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: dataUri } }
    ]
  }];

  // 1) 云端视觉大模型
  const key = process.env.LLM_API_KEY || '';
  if (key) {
    try {
      const out = await chatCompletion({ base: CLOUD_BASE, key, model: VISION_MODEL, messages, timeoutMs: 90000 });
      if (out) return { text: out, engine: 'cloud-vision', model: VISION_MODEL };
    } catch (e) {
      console.log('[ai/vision] 云端视觉失败，尝试端侧回退：' + e.message);
    }
  }

  // 2) 端侧 NPU 视觉（可选）
  if (process.env.NPU_FALLBACK !== '0') {
    try {
      const out = await chatCompletion({ base: FLM_BASE, key: '', model: FLM_MODEL, messages, timeoutMs: 90000 });
      if (out) return { text: out, engine: 'npu-vision', model: FLM_MODEL };
    } catch (e) {
      console.log('[ai/vision] 端侧视觉失败：' + e.message);
    }
  }

  return null;
}

/**
 * AI 引擎状态（demo 用：显示当前真实生效的解析引擎）
 */
app.get('/api/ai/engine', async (req, res) => {
  const out = {
    rule: true,
    cloudLLM: !!process.env.LLM_API_KEY,
    cloudModel: process.env.LLM_API_KEY ? VISION_MODEL : '',
    npu: false,
    npuEnabled: process.env.NPU_FALLBACK !== '0',
    npuModel: FLM_MODEL
  };
  if (out.npuEnabled) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 800);
      const r = await fetch(`${FLM_URL}/v1/models`, { signal: controller.signal });
      clearTimeout(t);
      out.npu = r.ok;
    } catch (e) { /* 未启动 */ }
  }
  res.json({ success: true, engine: out });
});

/**
 * 真·多模态识图：订单截图 → 结构化订单
 * 云端视觉大模型优先（配置 LLM_API_KEY + 支持图片输入的模型），可选端侧 NPU 回退
 * body: { image: base64 或 data URI, hint?: string }
 * 正式产品链路：携程App订单截图/邮件转发 → 本管线 → 账单；授权后经携程开放平台自动拉单（对接点预留）
 */
app.post('/api/ai/vision', async (req, res) => {
  try {
    const { image, hint } = req.body || {};
    if (!image) return res.status(400).json({ success: false, error: '缺少图片' });

    const dataUri = String(image).startsWith('data:') ? image : `data:image/png;base64,${image}`;
    const prompt = `这是一张旅行类订单截图（携程等App的订单详情/确认页）。${hint ? '附加提示：' + hint : ''}
只输出一个 JSON 对象，不要任何解释或 markdown，键名必须与下面完全一致：
{"orderNo":"","orderType":"","title":"","amount":0,"currency":"","date":"","travelers":[]}
取值规则：
- orderNo：订单号
- orderType：flight|hotel|train|ticket|car 之一
- title：产品全名（航班航司+航班号 / 酒店名+房型 / 车次 / 景点名）
- amount：实付款数字（不带逗号）
- currency：币种，如 CNY
- date：入住或出发日期，必须是 "YYYY-MM-DD" 格式字符串，禁止 null、禁止对象或数组
- travelers：出行人/入住人姓名字符串数组（如 ["小明"]），禁止对象
不确定的字段用空字符串或空数组，禁止 null。
输出示例（严格模仿此格式）：
{"orderNo":"H9876543210","orderType":"hotel","title":"东京新宿格拉斯丽酒店 高级大床房","amount":3200,"currency":"CNY","date":"2024-10-01","travelers":["小明"]}`;

    // 自动重试保证演示可靠（云端/端侧偶发瞬态失败均可自愈）
    let content = null;
    let engine = 'none';
    let model = '';
    for (let attempt = 0; attempt < 3 && !content; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 1500));
      try {
        const r = await callVisionLLM(dataUri, prompt);
        if (r) {
          content = r.text;
          engine = r.engine;
          model = r.model;
        }
      } catch (e) {
        console.log('[ai/vision] 第 ' + (attempt + 1) + ' 次识图失败：' + e.message);
      }
    }

    if (!content) {
      return res.status(503).json({
        success: false,
        error: '视觉服务未就绪：在 server/.env 配置 LLM_API_KEY（支持图片输入的模型），或运行 npu -b 启用端侧回退'
      });
    }

    const obj = AI.repairJSON(content);
    if (!obj || obj.amount == null) {
      return res.json({ success: true, order: null, raw: content, engine, model });
    }

    const order = normalizeVisionOrder(obj);
    // 兜底：模型没给日期时，从原始输出文本提取首个 YYYY-MM-DD
    if (!order.date) {
      const m = String(content).match(/\d{4}-\d{2}-\d{2}/);
      if (m) order.date = m[0];
    }

    res.json({ success: true, order, engine, model });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * 视觉模型输出归一化：date 可能是数组/带时间字符串，类型与标题可能缺失 → 启发式补全
 */
function normalizeVisionOrder(obj) {
  // date：统一提取 YYYY-MM-DD
  let date = '';
  const rawDate = obj.date;
  const pickDate = (cand) => {
    const m = String(cand || '').match(/\d{4}-\d{2}-\d{2}/);
    return m ? m[0] : '';
  };
  if (typeof rawDate === 'string') date = pickDate(rawDate);
  else if (Array.isArray(rawDate)) {
    for (const it of rawDate) {
      date = pickDate(it && (it.start_date_time || it.end_date_time || it.date || it.check_in_date));
      if (date) break;
    }
  } else if (rawDate && typeof rawDate === 'object') {
    date = pickDate(rawDate.start_date_time || rawDate.end_date_time || rawDate.date);
  }

  let title = String(obj.title || '').trim();

  // 类型：缺失时按标题推断
  let orderType = ['flight', 'hotel', 'train', 'ticket', 'car'].includes(obj.orderType) ? obj.orderType : '';
  if (!orderType) {
    if (/酒店|hotel|住宿|民宿/i.test(title)) orderType = 'hotel';
    else if (/航空|航班|机票|[A-Z]{2}\d{3,4}/.test(title)) orderType = 'flight';
    else if (/铁路|火车|高铁|动车|车次/i.test(title)) orderType = 'train';
    else if (/门票|乐园|景区|演出|博物馆/i.test(title)) orderType = 'ticket';
    else orderType = 'other';
  }
  if (!title) {
    title = { flight: '机票订单', hotel: '酒店订单', train: '火车票订单', ticket: '门票订单', car: '租车订单' }[orderType] || '识别订单';
  }

  // 出行人：字符串或对象数组均可
  const travelers = [];
  const rawT = obj.travelers;
  if (Array.isArray(rawT)) {
    rawT.forEach(t => {
      if (typeof t === 'string' && t.trim()) travelers.push(t.trim());
      else if (t && typeof t === 'object') {
        const name = t.name || t.travelerName || t.guestName || '';
        if (name) travelers.push(String(name));
      }
    });
  } else if (typeof rawT === 'string' && rawT.trim()) {
    travelers.push(rawT.trim());
  }

  return {
    orderNo: String(obj.orderNo || ''),
    orderType,
    title,
    amount: Number(obj.amount) || 0,
    currency: String(obj.currency || '').toUpperCase() || 'CNY',
    date,
    travelers
  };
}

/**
 * 一句话 → 结构化账单（自然语言记账）
 * mode=rule（默认，毫秒级离线）/ mode=llm（云端 LLM 或端侧 NPU，失败自动回退）
 */
app.post('/api/ai/parse', async (req, res) => {
  try {
    const { text, members, meName, mode } = req.body;
    if (!text) return res.status(400).json({ success: false, error: '缺少文本' });

    const list = Array.isArray(members) && members.length ? members : [];

    if (mode === 'llm') {
      const parsed = await AI.parseWithLLM(text, list, { meName, llmCall: callLLM });
      const splits = list.length ? AI.buildSplits(parsed, list) : [];
      return res.json({ success: true, parsed, splits, source: parsed.source });
    }

    const parsed = AI.parseBillText(text, list, { meName });
    const splits = list.length ? AI.buildSplits(parsed, list) : [];

    res.json({ success: true, parsed, splits, source: 'rule' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * AI 消费洞察
 */
app.post('/api/ai/insight', (req, res) => {
  try {
    const { room, bills, members } = req.body;
    if (!Array.isArray(bills)) return res.status(400).json({ success: false, error: '缺少账单数据' });
    const insight = AI.generateInsight({ room: room || {}, bills, members: members || [] });
    res.json({ success: true, insight });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * AI 旅行消费报告（分享文案）
 */
app.post('/api/ai/report', (req, res) => {
  try {
    const { room, bills, members } = req.body;
    if (!Array.isArray(bills)) return res.status(400).json({ success: false, error: '缺少账单数据' });
    const report = AI.generateTripReport(room || {}, bills, members || []);
    res.json({ success: true, report });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * AI 旅行消费小作文（useLLM=true 且配置密钥时走大模型，否则模板保底）
 */
app.post('/api/ai/narrate', async (req, res) => {
  try {
    const { room, bills, members, useLLM } = req.body;
    if (!Array.isArray(bills)) return res.status(400).json({ success: false, error: '缺少账单数据' });
    const narrative = await AI.generateNarrative(
      { room: room || {}, bills, members: members || [] },
      useLLM ? { llmCall: callLLM } : {}
    );
    res.json({ success: true, narrative });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ---- OCR识别 ----

const multer = require('multer');
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB限制
});

app.post('/api/ocr', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: '请上传图片' });
    }

    const imageBase64 = req.file.buffer.toString('base64');

    // 尝试腾讯云OCR
    const tencentSecretId = process.env.TENCENT_SECRET_ID || '';
    const tencentSecretKey = process.env.TENCENT_SECRET_KEY || '';

    let texts = [];

    if (tencentSecretId && tencentSecretKey) {
      try {
        texts = await callTencentOCR(imageBase64);
      } catch (e) {
        console.log('腾讯云OCR失败:', e.message);
      }
    }

    // 规则解析（分类使用共享 AI 引擎，比纯关键词更稳）
    const rawText = texts.join('\n');
    const aiCategory = texts.length > 0 ? AI.classifyExpense(rawText).category : 'other';
    const result = {
      success: true,
      amount: extractAmount(texts),
      merchant: extractMerchant(texts),
      time: extractTime(texts),
      category: aiCategory !== 'other' ? aiCategory : guessCategory(texts),
      imageType: detectImageType(texts),
      confidence: texts.length > 0 ? 85 : 0,
      rawText: rawText.substring(0, 500),
      needManual: texts.length === 0
    };

    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============ OCR解析规则 ============

function extractAmount(texts) {
  const full = texts.join('\n');
  const patterns = [
    /(?:实付|应付|支付|付款|消费|合计|总计|总额|共计|金额)[\s:：]*[¥￥]?([0-9]+\.?[0-9]{0,2})/i,
    /[¥￥]([0-9]+\.[0-9]{2})/,
    /([0-9]+\.[0-9]{2})\s*元/,
    /(?:^|\s)([0-9]{1,7}\.[0-9]{2})(?:\s|$)/m
  ];
  for (const p of patterns) {
    const m = full.match(p);
    if (m) {
      const v = parseFloat(m[1]);
      if (v > 0 && v < 1000000) return Math.round(v * 100) / 100;
    }
  }
  return null;
}

function extractMerchant(texts) {
  const full = texts.join('\n');
  const patterns = [
    /(?:商户|收款方|商家|店铺|商家名称|付款给)[\s:：]*([^\n]{2,30})/i,
    /(?:向|给)([^\n]{2,20})(?:付款|支付)/
  ];
  for (const p of patterns) {
    const m = full.match(p);
    if (m) {
      const name = m[1].trim().replace(/[\s·]+$/, '').substring(0, 25);
      if (name.length >= 2) return name;
    }
  }
  return '';
}

function extractTime(texts) {
  const full = texts.join('\n');
  const patterns = [
    /(\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?)/,
    /(\d{4}年\d{1,2}月\d{1,2}日\s*\d{1,2}:\d{2})/,
    /(\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2})/
  ];
  for (const p of patterns) {
    const m = full.match(p);
    if (m) return m[1];
  }
  return '';
}

function detectImageType(texts) {
  const full = texts.join(' ');
  if (full.includes('支付宝') || full.includes('ALIPAY')) return 'alipay';
  if (full.includes('微信') || full.includes('WeChat') || full.includes('财付通')) return 'wechat';
  return 'unknown';
}

function guessCategory(texts) {
  const full = texts.join(' ').toLowerCase();
  const map = {
    food: ['餐厅','饭店','美食','咖啡','奶茶','火锅','外卖','美团','餐','食'],
    transport: ['打车','滴滴','出租','地铁','高铁','飞机','机票','出行','加油'],
    hotel: ['酒店','宾馆','民宿','住宿','携程','旅馆'],
    ticket: ['门票','景区','公园','博物馆','电影','演出'],
    shopping: ['超市','商场','购物','淘宝','京东','商店','便利店']
  };
  for (const [cat, kws] of Object.entries(map)) {
    if (kws.some(kw => full.includes(kw))) return cat;
  }
  return 'other';
}

/**
 * 腾讯云OCR（通用印刷体识别）
 * 需要环境变量 TENCENT_SECRET_ID / TENCENT_SECRET_KEY，
 * 且安装可选依赖：npm i tencentcloud-sdk-nodejs-ocr
 * 未配置时返回空数组，由调用方回退"手动输入模式"——演示永不失败。
 */
async function callTencentOCR(imageBase64) {
  let OcrClient;
  try {
    OcrClient = require('tencentcloud-sdk-nodejs-ocr').ocr.v20181119.Client;
  } catch (e) {
    console.log('未安装 tencentcloud-sdk-nodejs-ocr，OCR 使用手动输入回退。安装：npm i tencentcloud-sdk-nodejs-ocr');
    return [];
  }

  const client = new OcrClient({
    credential: {
      secretId: process.env.TENCENT_SECRET_ID || '',
      secretKey: process.env.TENCENT_SECRET_KEY || ''
    },
    region: process.env.TENCENT_OCR_REGION || 'ap-guangzhou',
    profile: { httpProfile: { endpoint: 'ocr.tencentcloudapi.com' } }
  });

  const result = await client.GeneralBasicOCR({ ImageBase64: imageBase64 });
  return (result.TextDetections || []).map(d => d.DetectedText);
}

// ============ 启动 ============
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════╗
║   TravelAA API Server               ║
║   Port: ${PORT}                           ║
║   Memory: ~80MB                     ║
║   Ready! ✅                          ║
╚══════════════════════════════════════╝
  `);
});

module.exports = app;