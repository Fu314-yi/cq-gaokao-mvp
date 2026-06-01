/**
 * routes/admin.js
 * 管理员后台：仪表盘、用户管理、审单浏览、志愿库管理、数据导出
 */
'use strict';
const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const XLSX    = require('xlsx');
const { requireAdmin } = require('../middleware/auth');

// 所有 /admin 路由都要求管理员权限
router.use(requireAdmin);

// multer 存储（用于志愿库上传）
const storage = multer.diskStorage({
  destination: path.join(__dirname, '..', 'uploads'),
  filename: (_req, file, cb) => cb(null, `plans_${Date.now()}_${file.originalname}`)
});
const upload = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    const ok = /\.(xlsx|xls)$/.test(file.originalname.toLowerCase());
    cb(ok ? null : new Error('只允许上传 .xlsx/.xls 文件'), ok);
  },
  limits: { fileSize: 20 * 1024 * 1024 }
});

/**
 * GET /admin — 仪表盘
 */
router.get('/', (req, res) => {
  const db = req.db;

  // 统计卡片
  const totalUsers   = db.prepare('SELECT COUNT(*) as cnt FROM users WHERE role="user"').get().cnt;
  const todayUsers   = db.prepare("SELECT COUNT(*) as cnt FROM users WHERE role='user' AND date(created_at)=date('now','localtime')").get().cnt;
  const totalAudits  = db.prepare('SELECT COUNT(DISTINCT student_id) as cnt FROM submitted_plans').get().cnt;
  const todayAudits  = db.prepare("SELECT COUNT(DISTINCT student_id) as cnt FROM submitted_plans WHERE date(created_at)=date('now','localtime')").get().cnt;

  // 注册趋势（近7天）
  const trend = db.prepare(`
    SELECT date(created_at,'localtime') as day, COUNT(*) as cnt
    FROM users
    WHERE created_at >= datetime('now','-7 days','localtime') AND role='user'
    GROUP BY date(created_at,'localtime')
    ORDER BY day
  `).all();

  // 热门学校 TOP 10
  const popularSchools = db.prepare(`
    SELECT school_name_input as name, COUNT(*) as cnt
    FROM submitted_plans
    WHERE school_name_input IS NOT NULL AND school_name_input != ''
    GROUP BY school_name_input
    ORDER BY cnt DESC
    LIMIT 10
  `).all();

  // 最近注册用户
  const recentUsers = db.prepare(`
    SELECT id, phone, nickname, grade, region, created_at
    FROM users WHERE role='user'
    ORDER BY created_at DESC LIMIT 5
  `).all();

  res.render('admin/dashboard', {
    title: '管理后台',
    stats: { totalUsers, todayUsers, totalAudits, todayAudits },
    trend,
    popularSchools,
    recentUsers,
  });
});

/**
 * GET /admin/plans — 志愿库管理页面
 */
router.get('/plans', (req, res) => {
  const db = req.db;
  const planCount = db.prepare('SELECT COUNT(*) as cnt FROM plans_cq').get().cnt;
  const plans = db.prepare('SELECT * FROM plans_cq ORDER BY school_name, major_name LIMIT 100').all();
  res.render('admin/plans', { title: '志愿库管理', planCount, plans, msg: null });
});

/**
 * POST /admin/plans/import — 导入志愿库
 */
router.post('/plans/import', upload.single('file'), (req, res) => {
  const db = req.db;
  if (!req.file) return res.json({ ok: false, error: '请选择文件' });

  try {
    const clearBefore = req.body.clear_before === '1';
    if (clearBefore) {
      db.prepare('DELETE FROM plans_cq').run();
      console.log('[admin/plans] 已清空旧志愿库数据');
    }

    const wb   = XLSX.readFile(req.file.path);
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

    let inserted = 0, skipped = 0;
    for (const r of rows) {
      const school_name = String(r['学校名称'] || '').trim();
      const major_name  = String(r['专业名称'] || '').trim();
      if (!school_name || !major_name) { skipped++; continue; }
      db.prepare(`
        INSERT INTO plans_cq(school_code,school_name,major_name,batch,min_rank_2024,min_rank_2025,
                             selection_req,tuition_tag,body_restrict_tags,source_note)
        VALUES(?,?,?,?,?,?,?,?,?,?)
      `).run(
        String(r['学校代码'] || '').trim(),
        school_name, major_name,
        String(r['批次'] || '本科批').trim(),
        parseInt(r['2024最低位次']) || null,
        parseInt(r['2025最低位次']) || null,
        String(r['选科要求'] || '').trim(),
        String(r['收费标签'] || '').trim(),
        JSON.stringify(String(r['身体限制标签'] || '').split(/[,，]/).map(s=>s.trim()).filter(Boolean)),
        String(r['数据来源'] || '').trim()
      );
      inserted++;
    }
    try { fs.unlinkSync(req.file.path); } catch(_) {}

    return res.json({ ok: true, total: rows.length, inserted, skipped });
  } catch (e) {
    try { fs.unlinkSync(req.file.path); } catch(_) {}
    console.error(e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * POST /admin/plans/clear — 清空志愿库
 */
router.post('/plans/clear', (req, res) => {
  const db = req.db;
  db.prepare('DELETE FROM plans_cq').run();
  res.redirect('/admin/plans');
});

/**
 * GET /admin/users — 用户管理
 */
router.get('/users', (req, res) => {
  const db = req.db;
  const keyword = req.query.q || '';

  let users;
  if (keyword) {
    users = db.prepare(`
      SELECT id, phone, nickname, grade, region, role, is_banned, created_at
      FROM users
      WHERE phone LIKE ? OR nickname LIKE ?
      ORDER BY created_at DESC
    `).all(`%${keyword}%`, `%${keyword}%`);
  } else {
    users = db.prepare(`
      SELECT id, phone, nickname, grade, region, role, is_banned, created_at
      FROM users
      ORDER BY created_at DESC
    `).all();
  }

  res.render('admin/users', { title: '用户管理', users, keyword });
});

/**
 * POST /admin/users/:id/toggle-ban — 封禁/解封
 */
router.post('/users/:id/toggle-ban', (req, res) => {
  const db = req.db;
  const user = db.prepare('SELECT id, is_banned FROM users WHERE id=?').get(req.params.id);
  if (!user) return res.redirect('/admin/users');

  const newStatus = user.is_banned ? 0 : 1;
  db.prepare('UPDATE users SET is_banned=? WHERE id=?').run(newStatus, req.params.id);
  res.redirect('/admin/users');
});

/**
 * POST /admin/users/:id/delete — 删除用户
 */
router.post('/users/:id/delete', (req, res) => {
  const db = req.db;
  const userId = req.params.id;
  // 不允许删除自己
  if (parseInt(userId) === req.user.id) return res.redirect('/admin/users');
  db.prepare('DELETE FROM users WHERE id=? AND role!=?').run(userId, 'admin');
  res.redirect('/admin/users');
});

/**
 * GET /admin/audits — 审单记录浏览
 */
router.get('/audits', (req, res) => {
  const db = req.db;
  const keyword = req.query.q || '';

  let records;
  if (keyword) {
    records = db.prepare(`
      SELECT sp.student_id, s.name as student_name, s.rank as student_rank,
             COUNT(sp.id) as plan_count,
             MAX(sp.created_at) as latest_time
      FROM submitted_plans sp
      JOIN students s ON sp.student_id = s.id
      WHERE s.name LIKE ?
      GROUP BY sp.student_id
      ORDER BY latest_time DESC
    `).all(`%${keyword}%`);
  } else {
    records = db.prepare(`
      SELECT sp.student_id, s.name as student_name, s.rank as student_rank,
             COUNT(sp.id) as plan_count,
             MAX(sp.created_at) as latest_time
      FROM submitted_plans sp
      JOIN students s ON sp.student_id = s.id
      GROUP BY sp.student_id
      ORDER BY latest_time DESC
      LIMIT 50
    `).all();
  }

  res.render('admin/audits', { title: '审单记录', records, keyword });
});

/**
 * GET /admin/export — CSV 导出
 */
router.get('/export', (req, res) => {
  const db = req.db;
  const rows = db.prepare(`
    SELECT sp.seq, sp.school_name_input, sp.major_name_input, sp.selection_req,
           sp.nature, sp.batch, s.name as student_name, s.rank as student_rank,
           sp.risk_tags_json, sp.created_at
    FROM submitted_plans sp
    JOIN students s ON sp.student_id = s.id
    ORDER BY sp.student_id, sp.seq
  `).all();

  // CSV 输出
  const BOM = '\uFEFF';
  const headers = ['序号','学生姓名','位次','院校名称','专业名称','选科要求','性质','批次','风险标签','创建时间'];
  let csv = BOM + headers.join(',') + '\n';
  for (const r of rows) {
    const tags = JSON.parse(r.risk_tags_json || '[]').join('|');
    const line = [
      r.seq, r.student_name, r.student_rank,
      `"${(r.school_name_input||'').replace(/"/g,'""')}"`,
      `"${(r.major_name_input||'').replace(/"/g,'""')}"`,
      `"${(r.selection_req||'').replace(/"/g,'""')}"`,
      r.nature||'', r.batch||'', `"${tags}"`, r.created_at
    ].join(',');
    csv += line + '\n';
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename=audit_export.csv');
  res.send(csv);
});

module.exports = router;
