/**
 * SQLite 数据库层
 * 轻量级，无需安装数据库服务，单文件存储
 * 完美适配 1核1G 服务器
 */
const Database = require('better-sqlite3');
const path = require('path');

// 数据库文件路径
const DB_PATH = path.join(__dirname, 'data', 'travel-aa.db');

// 确保数据目录存在
const fs = require('fs');
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(DB_PATH);

// 开启WAL模式，提升并发性能
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ============ 建表 ============

db.exec(`
  -- 用户表
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    nickname TEXT DEFAULT '',
    avatar TEXT DEFAULT '',
    created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  -- 房间表
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    destination TEXT DEFAULT '',
    room_code TEXT UNIQUE NOT NULL,
    creator_id TEXT NOT NULL,
    start_date TEXT DEFAULT '',
    end_date TEXT DEFAULT '',
    bill_count INTEGER DEFAULT 0,
    total_expense REAL DEFAULT 0,
    created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  -- 房间成员表
  CREATE TABLE IF NOT EXISTS room_members (
    room_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    nickname TEXT DEFAULT '',
    avatar TEXT DEFAULT '',
    joined_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (room_id, user_id),
    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
  );

  -- ⚠️ 时间戳一律用「带 Z 的 ISO-8601 UTC」而不是 CURRENT_TIMESTAMP：
  --    CURRENT_TIMESTAMP 存的是 'YYYY-MM-DD HH:MM:SS'（UTC 但没有 Z），
  --    而 JS 的 new Date('2024-10-04 23:00:00') 会按**本地时间**解析 →
  --    东八区下每天 00:00–08:00 记的账会被算到前一天，「每日消费趋势」整体漂移 8 小时。
  --    用 strftime 输出 ...Z 后，前后端解析口径一致。
  -- 账单表
  CREATE TABLE IF NOT EXISTS bills (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    payer_id TEXT NOT NULL,
    payer_name TEXT DEFAULT '',
    amount REAL NOT NULL,
    description TEXT DEFAULT '',
    category TEXT DEFAULT 'other',
    split_type TEXT DEFAULT 'equal',
    splits TEXT DEFAULT '[]',
    image_url TEXT DEFAULT '',
    created_by TEXT NOT NULL,
    created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
  );

  -- 索引
  CREATE INDEX IF NOT EXISTS idx_rooms_code ON rooms(room_code);
  CREATE INDEX IF NOT EXISTS idx_room_members_user ON room_members(user_id);
  CREATE INDEX IF NOT EXISTS idx_bills_room ON bills(room_id, created_at DESC);
`);

console.log('✅ 数据库初始化完成');

// ============ V2 增量迁移（幂等） ============
// 多币种账单 / 订单来源 / 预算 / 结算记录
const migrations = [
  "ALTER TABLE bills ADD COLUMN currency TEXT DEFAULT 'CNY'",
  "ALTER TABLE bills ADD COLUMN rate REAL DEFAULT 1",
  "ALTER TABLE bills ADD COLUMN cny_amount REAL DEFAULT 0",
  "ALTER TABLE bills ADD COLUMN order_no TEXT DEFAULT ''",
  "ALTER TABLE bills ADD COLUMN source TEXT DEFAULT ''",
  "ALTER TABLE bills ADD COLUMN updated_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
  "ALTER TABLE rooms ADD COLUMN budget REAL DEFAULT 0",
  "ALTER TABLE rooms ADD COLUMN settled_at TEXT DEFAULT ''"
];
migrations.forEach(sql => {
  try { db.exec(sql); } catch (e) { /* 列已存在，忽略 */ }
});

module.exports = db;
