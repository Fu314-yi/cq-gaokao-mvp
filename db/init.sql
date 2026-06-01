-- 重庆高考志愿审单系统 初始化 SQL
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- 学生档案
CREATE TABLE IF NOT EXISTS students (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT    NOT NULL,
  prime           TEXT    NOT NULL,          -- 首选科目: 物理/历史
  elective1       TEXT    NOT NULL,          -- 再选科目1
  elective2       TEXT    NOT NULL,          -- 再选科目2
  total_score     INTEGER NOT NULL,          -- 总分
  rank            INTEGER NOT NULL,          -- 全市位次
  bonus           INTEGER NOT NULL DEFAULT 0,-- 政策加分（分值）
  filing_score    INTEGER,                   -- 投档分（总分+加分，可手动覆盖）
  nation          TEXT    NOT NULL DEFAULT '汉族',
  bonus_tags_json TEXT    NOT NULL DEFAULT '[]', -- 加分标签 JSON数组
  body_flags_json TEXT    NOT NULL DEFAULT '[]', -- 身体受限标签 JSON数组
  height_cm       REAL,                      -- 身高 cm（可选）
  weight_kg       REAL,                      -- 体重 kg（可选）
  vision_l        REAL,                      -- 裸眼视力 左（可选）
  vision_r        REAL,                      -- 裸眼视力 右（可选）
  accepted_tuition_tags TEXT NOT NULL DEFAULT '[]', -- 接受的收费标签 JSON数组 如["中外合作","地方专项"]
  created_at      TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 志愿库：重庆招生计划
CREATE TABLE IF NOT EXISTS plans_cq (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  school_code      TEXT NOT NULL,
  school_name      TEXT NOT NULL,
  major_name       TEXT NOT NULL,
  batch            TEXT NOT NULL,          -- 本科提前批/本科批 等
  min_rank_2025    INTEGER,                -- 2025年最低位次（若已公布）
  min_rank_2024    INTEGER,                -- 2024年最低位次
  selection_req    TEXT,                   -- 选科要求，如"物理必选"
  tuition_tag      TEXT,                   -- 收费标签，如"公办/民办/中外合作"
  body_restrict_tags TEXT NOT NULL DEFAULT '[]', -- 身体限制标签 JSON数组
  source_note      TEXT,                   -- 数据来源备注
  updated_at       TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 已填志愿（学生提交的志愿草稿 —— 含完整解析字段）
CREATE TABLE IF NOT EXISTS submitted_plans (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id       INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  seq              INTEGER NOT NULL,       -- 序号
  school_code      TEXT,                   -- 院校代码
  school_name_input  TEXT,                 -- 院校名称
  major_code       TEXT,                   -- 专业代码
  major_name_input   TEXT,                 -- 专业名称
  level            TEXT,                   -- 层次（本科/专科）
  region           TEXT,                   -- 地区/城市
  type             TEXT,                   -- 类型（综合/理工/师范…）
  nature           TEXT,                   -- 性质（公办/民办）
  ranking          TEXT,                   -- 排名
  further_study_rate TEXT,                 -- 升学率
  postgrad_rate    TEXT,                   -- 保研率
  plan_count       INTEGER,               -- 计划招生数
  tuition          TEXT,                   -- 学费（数字或"待定"）
  academic_system  TEXT,                   -- 学制
  selection_req    TEXT,                   -- 选科要求（如 历史+不限）
  score_2025_json  TEXT,                   -- {count,lineDiff,min,rank,equivRankDiff,equivScoreDiff}
  score_2024_json  TEXT,
  score_2023_json  TEXT,
  score_2022_json  TEXT,
  batch            TEXT,                   -- 批次
  school_matched_id  INTEGER REFERENCES plans_cq(id), -- 匹配到的志愿库ID
  risk_level       TEXT,
  risk_tags_json   TEXT NOT NULL DEFAULT '[]',
  parse_error      INTEGER NOT NULL DEFAULT 0, -- 解析异常标记
  note             TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 用户表（认证系统）
CREATE TABLE IF NOT EXISTS users (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  phone              TEXT    NOT NULL UNIQUE,
  nickname           TEXT,
  grade              TEXT    NOT NULL,       -- 高三/高二/高一/其他
  region             TEXT    NOT NULL,        -- 重庆各区县
  role               TEXT    NOT NULL DEFAULT 'user',  -- user/admin
  agreement_accepted INTEGER NOT NULL DEFAULT 0,
  password_hash      TEXT,                    -- 仅管理员使用 bcrypt hash
  is_banned          INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 简单索引
CREATE INDEX IF NOT EXISTS idx_plans_school ON plans_cq(school_name);
CREATE INDEX IF NOT EXISTS idx_plans_batch  ON plans_cq(batch);
CREATE INDEX IF NOT EXISTS idx_submitted_student ON submitted_plans(student_id);
CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
