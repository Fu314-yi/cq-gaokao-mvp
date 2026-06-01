/**
 * db/init.js
 * 使用 sql.js (WebAssembly SQLite)，无需原生编译
 * 提供与 better-sqlite3 相似的同步风格 API wrapper
 */
'use strict';
const path = require('path');
const fs   = require('fs');

const DB_PATH  = path.join(__dirname, 'gaokao.db');
const SQL_PATH = path.join(__dirname, 'init.sql');

let _cachedDb = null;
let _dirty = false;

// ─── 轻量 wrapper：将 sql.js 包装成 better-sqlite3 风格 ───────────
class SqlJsWrapper {
  constructor(sqlDb) {
    this._db  = sqlDb;
    this._path = DB_PATH;
  }

  _persist() {
    try {
      const data = this._db.export();
      fs.writeFileSync(this._path, Buffer.from(data));
    } catch(e) {
      console.error('[DB] 持久化失败:', e.message);
    }
  }

  exec(sql) {
    this._db.run(sql);
    this._persist();
  }

  // 返回 { run, get, all } 对象
  prepare(sql) {
    const self = this;
    return {
      run(...binds) {
        self._db.run(sql, binds.length === 1 && Array.isArray(binds[0]) ? binds[0] : binds);
        const lid = self._db.exec('SELECT last_insert_rowid() as id')[0]?.values[0][0] ?? null;
        self._persist();
        return { lastInsertRowid: lid, changes: 1 };
      },
      get(...binds) {
        const params = binds.length === 1 && Array.isArray(binds[0]) ? binds[0] : binds;
        const stmt = self._db.prepare(sql);
        stmt.bind(params);
        if (!stmt.step()) { stmt.free(); return undefined; }
        const row = stmt.getAsObject();
        stmt.free();
        return row;
      },
      all(...binds) {
        const params = binds.length === 1 && Array.isArray(binds[0]) ? binds[0] : binds;
        const stmt = self._db.prepare(sql);
        stmt.bind(params);
        const rows = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        stmt.free();
        return rows;
      }
    };
  }

  // transaction(fn) → 返回一个函数，调用时在事务内执行 fn(args)
  transaction(fn) {
    const self = this;
    return function(...args) {
      self._db.run('BEGIN');
      try {
        fn(...args);
        self._db.run('COMMIT');
      } catch(e) {
        self._db.run('ROLLBACK');
        throw e;
      }
      self._persist();
    };
  }
}

// ─── 安全保存数据库到磁盘 ─────────────────────────────────────────
function safeSaveDb(rawDb, force) {
  if (!force && !_dirty) {
    console.log('[DB] 数据库无变更，跳过写入');
    return;
  }
  try {
    const data = rawDb.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
    console.log('[DB] 数据库已保存:', DB_PATH);
  } catch(e) {
    console.error('[DB] 数据库保存失败:', e.message);
    // 尝试写到临时文件
    try {
      const tmpPath = DB_PATH + '.tmp';
      const data = rawDb.export();
      fs.writeFileSync(tmpPath, Buffer.from(data));
      console.log('[DB] 已备份到临时文件:', tmpPath);
    } catch(e2) {
      console.error('[DB] 临时文件也写入失败:', e2.message);
    }
  }
}

// ─── 异步初始化 ──────────────────────────────────────────────────
async function initDbAsync() {
  if (_cachedDb) return _cachedDb;

  const initSqlJs = require('sql.js');
  const wasmPath  = path.join(
    __dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'
  );

  if (!fs.existsSync(wasmPath)) {
    console.error('[DB] 找不到 sql-wasm.wasm，请确认 node_modules 已正确安装');
    console.error('[DB] 期望路径:', wasmPath);
    throw new Error('缺少 sql-wasm.wasm，请运行: npm install');
  }

  const wasmBinary = fs.readFileSync(wasmPath);
  const SQL = await initSqlJs({ wasmBinary });

  let rawDb;
  let isNew = false;
  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    rawDb = new SQL.Database(buf);
    console.log('[DB] 已加载已有数据库:', DB_PATH);
  } else {
    rawDb = new SQL.Database();
    isNew = true;
    _dirty = true;
    console.log('[DB] 创建新数据库');
  }

  rawDb.run('PRAGMA journal_mode=WAL;');
  rawDb.run('PRAGMA foreign_keys=ON;');

  // 建表
  const sqlInit = fs.readFileSync(SQL_PATH, 'utf8');
  rawDb.run(sqlInit);
  _dirty = true;

  // 字段迁移
  const migrations = [
    // ── students ──
    `ALTER TABLE students ADD COLUMN filing_score    INTEGER`,
    `ALTER TABLE students ADD COLUMN bonus_tags_json TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE students ADD COLUMN body_flags_json TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE students ADD COLUMN height_cm       REAL`,
    `ALTER TABLE students ADD COLUMN weight_kg       REAL`,
    `ALTER TABLE students ADD COLUMN vision_l        REAL`,
    `ALTER TABLE students ADD COLUMN vision_r        REAL`,
    `ALTER TABLE students ADD COLUMN accepted_tuition_tags TEXT NOT NULL DEFAULT '[]'`,
    // ── submitted_plans ──
    `ALTER TABLE submitted_plans ADD COLUMN school_code       TEXT`,
    `ALTER TABLE submitted_plans ADD COLUMN major_code        TEXT`,
    `ALTER TABLE submitted_plans ADD COLUMN level             TEXT`,
    `ALTER TABLE submitted_plans ADD COLUMN region            TEXT`,
    `ALTER TABLE submitted_plans ADD COLUMN type              TEXT`,
    `ALTER TABLE submitted_plans ADD COLUMN nature            TEXT`,
    `ALTER TABLE submitted_plans ADD COLUMN ranking           TEXT`,
    `ALTER TABLE submitted_plans ADD COLUMN further_study_rate TEXT`,
    `ALTER TABLE submitted_plans ADD COLUMN postgrad_rate     TEXT`,
    `ALTER TABLE submitted_plans ADD COLUMN plan_count        INTEGER`,
    `ALTER TABLE submitted_plans ADD COLUMN tuition           TEXT`,
    `ALTER TABLE submitted_plans ADD COLUMN academic_system   TEXT`,
    `ALTER TABLE submitted_plans ADD COLUMN selection_req     TEXT`,
    `ALTER TABLE submitted_plans ADD COLUMN score_2025_json   TEXT`,
    `ALTER TABLE submitted_plans ADD COLUMN score_2024_json   TEXT`,
    `ALTER TABLE submitted_plans ADD COLUMN score_2023_json   TEXT`,
    `ALTER TABLE submitted_plans ADD COLUMN score_2022_json   TEXT`,
    `ALTER TABLE submitted_plans ADD COLUMN parse_error       INTEGER NOT NULL DEFAULT 0`,
  ];
  for (const m of migrations) {
    try { rawDb.run(m); _dirty = true; } catch(_) { /* 列已存在 */ }
  }

  // ── 创建 users 表 ──
  try {
    rawDb.run(`CREATE TABLE IF NOT EXISTS users (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      phone              TEXT    NOT NULL UNIQUE,
      nickname           TEXT,
      grade              TEXT    NOT NULL,
      region             TEXT    NOT NULL,
      role               TEXT    NOT NULL DEFAULT 'user',
      agreement_accepted INTEGER NOT NULL DEFAULT 0,
      password_hash      TEXT,
      is_banned          INTEGER NOT NULL DEFAULT 0,
      created_at         TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
    )`);
    rawDb.run('CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone)');
    _dirty = true;
  } catch(_) {}

  // ── students 表添加 user_id ──
  try {
    rawDb.run('ALTER TABLE students ADD COLUMN user_id INTEGER REFERENCES users(id)');
    rawDb.run('CREATE INDEX IF NOT EXISTS idx_students_user ON students(user_id)');
    _dirty = true;
  } catch(_) {}

  // ── 种子管理员 ──
  const bcrypt = require('bcrypt');
  const adminExists = rawDb.exec("SELECT COUNT(*) as cnt FROM users WHERE phone='admin'");
  const adminCount = Number(adminExists[0]?.values[0][0] ?? 0);
  if (adminCount === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    rawDb.run(`INSERT INTO users(phone, nickname, grade, region, role, password_hash, agreement_accepted)
               VALUES ('admin', '系统管理员', '其他', '重庆市', 'admin', ?, 1)`, [hash]);
    _dirty = true;
    console.log('[DB] 种子管理员已创建: admin / admin123');
  }

  // 只在有变更时才保存
  safeSaveDb(rawDb, isNew);
  console.log('[DB] 数据库初始化完成');

  _cachedDb = new SqlJsWrapper(rawDb);
  return _cachedDb;
}

module.exports = initDbAsync;
module.exports.getCached = () => _cachedDb;

if (require.main === module) {
  initDbAsync()
    .then(() => console.log('完成'))
    .catch(e => { console.error(e); process.exit(1); });
}
