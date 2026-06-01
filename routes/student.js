'use strict';
const express = require('express');
const router  = express.Router();

/* ── 工具函数 ── */
function toInt(v, def = null) {
  const n = parseInt(v);
  return isNaN(n) ? def : n;
}
function toFloat(v) {
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}
function toArr(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

// ─── 学生档案列表 ────────────────────────────────────────────────
router.get('/', (req, res) => {
  let list;
  if (req.user.role === 'admin') {
    // 管理员可看所有学生
    list = req.db.prepare('SELECT * FROM students ORDER BY created_at DESC').all();
  } else {
    // 普通用户只看自己的
    list = req.db.prepare('SELECT * FROM students WHERE user_id=? ORDER BY created_at DESC').all(req.user.id);
  }
  res.render('student_list', { list });
});

// ─── 新建表单 ───────────────────────────────────────────────────
router.get('/new', (_req, res) => {
  res.render('student_form', { student: null, errors: [] });
});

// ─── 新建提交 ───────────────────────────────────────────────────
router.post('/new', (req, res) => {
  const {
    name, prime, elective1, elective2,
    total_score, rank, bonus, filing_score,
    nation,
    height_cm, weight_kg, vision_l, vision_r,
  } = req.body;

  const bonus_tags = toArr(req.body.bonus_tags);
  const body_flags = toArr(req.body.body_flags);
  const accepted_tuition_tags = toArr(req.body.accepted_tuition_tags);

  const errors = [];
  if (!name?.trim())   errors.push('姓名不能为空');
  if (!prime)          errors.push('请选择首选科目（物理 / 历史）');
  if (!elective1 || !elective2) errors.push('请恰好勾选 2 门再选科目');
  if (elective1 && elective2 && elective1 === elective2) errors.push('两门再选科目不能相同');
  if (!total_score)    errors.push('请填写高考总分');
  if (!rank)           errors.push('请填写全市位次');

  if (errors.length) {
    return res.render('student_form', { student: req.body, errors });
  }

  const totalScoreInt = toInt(total_score, 0);
  const bonusInt      = toInt(bonus, 0);
  // 投档分：优先用前端传来的值（手动覆盖），否则自动算
  const filingScoreInt = filing_score !== '' && filing_score != null
    ? toInt(filing_score, totalScoreInt + bonusInt)
    : totalScoreInt + bonusInt;

  const stmt = req.db.prepare(`
    INSERT INTO students(
      name, prime, elective1, elective2,
      total_score, rank, bonus, filing_score,
      nation,
      bonus_tags_json, body_flags_json, accepted_tuition_tags,
      height_cm, weight_kg, vision_l, vision_r
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  const result = stmt.run(
    name.trim(), prime, elective1, elective2,
    totalScoreInt, toInt(rank, 1), bonusInt, filingScoreInt,
    nation || '汉族',
    JSON.stringify(bonus_tags), JSON.stringify(body_flags),
    JSON.stringify(accepted_tuition_tags),
    toFloat(height_cm), toFloat(weight_kg),
    toFloat(vision_l),  toFloat(vision_r)
  );

  // 关联当前用户
  req.db.prepare('UPDATE students SET user_id=? WHERE id=?').run(req.user.id, result.lastInsertRowid);

  // 提交后跳到上传页，携带 student_id
  res.redirect(`/upload?student_id=${result.lastInsertRowid}`);
});

// ─── 编辑表单 ───────────────────────────────────────────────────
router.get('/:id/edit', (req, res) => {
  const student = req.db.prepare('SELECT * FROM students WHERE id=?').get(req.params.id);
  if (!student) return res.status(404).render('error', { msg: '学生不存在' });
  res.render('student_form', { student, errors: [] });
});

// ─── 编辑提交 ───────────────────────────────────────────────────
router.post('/:id/edit', (req, res) => {
  const sid = req.params.id;
  const student = req.db.prepare('SELECT id FROM students WHERE id=?').get(sid);
  if (!student) return res.status(404).render('error', { msg: '学生不存在' });

  const {
    name, prime, elective1, elective2,
    total_score, rank, bonus, filing_score,
    nation,
    height_cm, weight_kg, vision_l, vision_r,
  } = req.body;

  const bonus_tags = toArr(req.body.bonus_tags);
  const body_flags = toArr(req.body.body_flags);
  const accepted_tuition_tags = toArr(req.body.accepted_tuition_tags);

  const errors = [];
  if (!name?.trim())   errors.push('姓名不能为空');
  if (!prime)          errors.push('请选择首选科目');
  if (!elective1 || !elective2) errors.push('请恰好勾选 2 门再选科目');
  if (!total_score)    errors.push('请填写总分');
  if (!rank)           errors.push('请填写全市位次');

  if (errors.length) {
    return res.render('student_form', { student: { ...req.body, id: sid }, errors });
  }

  const totalScoreInt  = toInt(total_score, 0);
  const bonusInt       = toInt(bonus, 0);
  const filingScoreInt = filing_score !== '' && filing_score != null
    ? toInt(filing_score, totalScoreInt + bonusInt)
    : totalScoreInt + bonusInt;

  req.db.prepare(`
    UPDATE students SET
      name=?, prime=?, elective1=?, elective2=?,
      total_score=?, rank=?, bonus=?, filing_score=?,
      nation=?,
      bonus_tags_json=?, body_flags_json=?, accepted_tuition_tags=?,
      height_cm=?, weight_kg=?, vision_l=?, vision_r=?
    WHERE id=?
  `).run(
    name.trim(), prime, elective1, elective2,
    totalScoreInt, toInt(rank, 1), bonusInt, filingScoreInt,
    nation || '汉族',
    JSON.stringify(bonus_tags), JSON.stringify(body_flags),
    JSON.stringify(accepted_tuition_tags),
    toFloat(height_cm), toFloat(weight_kg),
    toFloat(vision_l),  toFloat(vision_r),
    sid
  );

  res.redirect(`/student/${sid}`);
});

// ─── 添加志愿草稿 ───────────────────────────────────────────────
router.post('/:id/plan', (req, res) => {
  const { seq, batch, school_name_input, major_name_input, risk_level } = req.body;
  const sid = req.params.id;
  const student = req.db.prepare('SELECT id FROM students WHERE id=?').get(sid);
  if (!student) return res.status(404).render('error', { msg: '学生不存在' });

  req.db.prepare(`
    INSERT INTO submitted_plans(student_id,seq,batch,school_name_input,major_name_input,risk_level)
    VALUES(?,?,?,?,?,?)
  `).run(sid, parseInt(seq) || 1, batch || '本科批',
    school_name_input || '', major_name_input || '', risk_level || '');

  res.redirect(`/student/${sid}`);
});

// ─── 学生详情 ───────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const student = req.db.prepare('SELECT * FROM students WHERE id=?').get(req.params.id);
  if (!student) return res.status(404).render('error', { msg: '学生不存在' });

  // 解析 JSON 字段
  student.body_flags  = JSON.parse(student.body_flags_json  || '[]');
  student.bonus_tags  = JSON.parse(student.bonus_tags_json  || '[]');
  student.accepted_tuition_tags = JSON.parse(student.accepted_tuition_tags || '[]');

  const plans = req.db.prepare(
    'SELECT * FROM submitted_plans WHERE student_id=? ORDER BY seq'
  ).all(student.id);

  res.render('student_detail', { student, plans });
});

module.exports = router;
