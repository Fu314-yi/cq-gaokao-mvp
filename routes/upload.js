'use strict';
const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const XLSX    = require('xlsx');
const crypto  = require('crypto');
const router  = express.Router();

// ═══════════════════════════════════════════════════════════════════
//  内存缓存：上传解析 → 预览 → 确认（两步提交）
// ═══════════════════════════════════════════════════════════════════
const uploadCache = new Map(); // key → { student_id, rows, timestamp }
const CACHE_TTL  = 30 * 60 * 1000; // 30 分钟

// 每 5 分钟清理过期缓存
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of uploadCache) {
    if (now - val.timestamp > CACHE_TTL) uploadCache.delete(key);
  }
}, 5 * 60 * 1000);

// ── multer 存储 ────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: path.join(__dirname, '..', 'uploads'),
  filename: (_req, file, cb) => cb(null, `${Date.now()}_${file.originalname}`)
});
const upload = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    const ok = /\.(xlsx|xls)$/.test(file.originalname.toLowerCase());
    cb(ok ? null : new Error('只允许上传 .xlsx/.xls 文件'), ok);
  },
  limits: { fileSize: 10 * 1024 * 1024 }
});

// ═══════════════════════════════════════════════════════════════════
//  模糊匹配工具函数（保留，用于 school_matched_id 匹配）
// ═══════════════════════════════════════════════════════════════════
function strSimilarity(a, b) {
  if (!a || !b) return 0;
  a = a.toLowerCase().replace(/\s/g, '');
  b = b.toLowerCase().replace(/\s/g, '');
  if (a === b) return 1;
  const setA = new Set(a.split(''));
  let common = 0;
  for (const ch of b) if (setA.has(ch)) common++;
  return common / Math.max(a.length, b.length);
}

function fuzzyMatch(input, nameList, threshold = 0.4) {
  if (!input || !nameList.length) return null;
  let best = null, bestScore = -1;
  for (const item of nameList) {
    const s  = strSimilarity(input, item.name);
    const s2 = strSimilarity(input.replace(/大学$/, '').replace(/学院$/, ''), item.name);
    const score = Math.max(s, s2);
    if (score > bestScore) { bestScore = score; best = item; }
  }
  if (bestScore >= threshold) return { matched: best, score: bestScore };
  return null;
}

// ═══════════════════════════════════════════════════════════════════
//  Excel 解析：严格按用户提供的 40 列格式
// ═══════════════════════════════════════════════════════════════════

/**
 * 保留 COL_ALIASES 仅供模板下载等功能参考，解析逻辑不再使用
 * 实际解析已改为 AOA + colMap 方式
 */
const COL_ALIASES = {
  seq:              ['序号'],
  schoolCode:       ['院校代码'],
  schoolName:       ['院校', '学校名称', '学校'],
  level:            ['层次'],
  region:           ['地区/城市', '地区', '城市'],
  type:             ['类型'],
  nature:           ['性质'],
  ranking:          ['排名'],
  furtherStudyRate: ['升学率'],
  postgradRate:     ['保研率'],
  majorCode:        ['专业代码'],
  majorName:        ['专业', '专业名称'],
  planCount:        ['计划', '招生计划'],
  tuition:          ['学费'],
  academicSystem:   ['学制'],
  selectionReq:     ['选科', '选科要求'],
};

/** 4 个年份 + 每年 6 个字段 */
const YEARS      = [2025, 2024, 2023, 2022];
const YEAR_FIELDS = ['录取人数', '线差', '最低分', '最低位次', '等效位差', '等效分差'];
const YEAR_KEYS   = ['count', 'lineDiff', 'min', 'rank', 'equivRankDiff', 'equivScoreDiff'];

/** getVal 已弃用，保留兼容引用 */
function getVal(row, ...possibleKeys) {
  for (const key of possibleKeys) {
    const trimmed = key.trim();
    if (row[trimmed] !== undefined && row[trimmed] !== null && row[trimmed] !== '') {
      return row[trimmed];
    }
  }
  return undefined;
}

/** 转 number，失败返回 undefined；支持"低4053"→-4053, "-4053"→-4053 */
function toNum(val) {
  if (val === undefined || val === null || val === '') return undefined;
  let s = String(val).trim();
  // "低4053" → "-4053"
  if (s.startsWith('低') || s.startsWith('↓')) s = '-' + s.slice(1);
  if (s.startsWith('高') || s.startsWith('↑') || s.startsWith('↑')) s = s.slice(1);
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/** 安全转 string，去除换行和多余空格 */
function toStr(val) {
  if (val === undefined || val === null) return '';
  return String(val).replace(/[\r\n]+/g, ' ').trim();
}

/** 清洗院校名：取第一行（换行前的核心名称），去除括号外多余空格 */
function cleanSchoolName(raw) {
  if (!raw) return '';
  // "保定学院\n(本科)\n(公办)(办学地点：河北保定)" → "保定学院"
  const firstLine = String(raw).split(/[\r\n]/)[0].trim();
  return firstLine;
}

/** 清洗专业名：去尾部换行和空格 */
function cleanMajorName(raw) {
  if (!raw) return '';
  return String(raw).replace(/[\r\n]+/g, ' ').replace(/\s+$/g, '').trim();
}

/** 清洗排名：提取数字，"易度排名：563" → "563" */
function cleanRanking(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  // 提取最后一段数字
  const m = s.match(/(\d[\d,]*)/);
  return m ? m[1].replace(/,/g, '') : s;
}

/** 清洗百分比： "10.5%" → "10.5%"（保持原样，或去掉%变数字） */
function cleanPercent(raw) {
  if (!raw) return '';
  return String(raw).trim();
}

/**
 * 解析一行 Excel 原始数据（AOA 格式） → 结构化对象
 * @param {Array} dataRow   AOA 格式的数据行（数组，按列顺序）
 * @param {Object} colMap   列名 → 列索引映射
 * @param {number} index    行序号（用于空序号兜底和错误提示）
 * @returns {Object} 解析后的志愿行
 */
function parseExcelRow(dataRow, colMap, index) {
  const errors = [];

  // ── 安全按列索引取值 ──
  function colVal(colName) {
    const idx = colMap[colName];
    if (idx === undefined || idx === null) return undefined;
    const v = dataRow[idx];
    return (v !== undefined && v !== null && v !== '') ? v : undefined;
  }

  // ── 提取基础字段 ──
  const rawSchoolName = colVal('院校') || colVal('学校名称') || '';
  const rawMajorName  = colVal('专业') || colVal('专业名称') || '';
  const rawRanking    = colVal('排名') || '';
  const rawNature     = colVal('性质') || '';

  const result = {
    _index:          index,
    seq:             toNum(colVal('序号')) || (index + 1),
    schoolCode:      toStr(colVal('院校代码')),
    schoolName:      cleanSchoolName(rawSchoolName),
    level:           toStr(colVal('层次')),
    region:          toStr(colVal('地区/城市') || colVal('地区') || colVal('城市')),
    type:            toStr(colVal('类型')),
    nature:          toStr(rawNature),
    ranking:         cleanRanking(rawRanking),
    furtherStudyRate:cleanPercent(colVal('升学率')),
    postgradRate:    cleanPercent(colVal('保研率')),
    majorCode:       toStr(colVal('专业代码')),
    majorName:       cleanMajorName(rawMajorName),
    planCount:       toNum(colVal('计划') || colVal('招生计划')),
    tuition:         toStr(colVal('学费')),
    academicSystem:  toNum(colVal('学制')),
    selectionReq:    toStr(colVal('选科') || colVal('选科要求')),
    // 保留原始院校名（含附加信息），供详情展示
    _rawSchoolName:  toStr(rawSchoolName),
    _rawMajorName:   toStr(rawMajorName),
  };

  // ── 提取 4 年录取数据 ──
  for (const year of YEARS) {
    const scoreData = {};
    for (let i = 0; i < YEAR_FIELDS.length; i++) {
      const fieldLabel = YEAR_FIELDS[i];
      // 尝试多种列名：精确匹配、带年份前缀、带"历史/物理"后缀
      let val = colVal(`${year}${fieldLabel}`);       // "2025最低位次"
      if (val === undefined) {
        val = colVal(`${fieldLabel}${year}`);          // "最低位次2025"（罕见）
      }
      // 也尝试带科类后缀，如 "2025历史最低位次"、"2024物理最低位次"
      if (val === undefined) {
        for (const suffix of ['历史', '物理', '(历史)', '(物理)']) {
          val = colVal(`${year}${suffix}${fieldLabel}`);
          if (val !== undefined) break;
        }
      }
      scoreData[YEAR_KEYS[i]] = toNum(val);
    }
    // 只有至少一个字段有值才挂上去
    if (Object.values(scoreData).some(v => v !== undefined)) {
      result[`score${year}`] = scoreData;
    }
  }

  // ── 必填校验 ──
  if (!result.schoolName) errors.push('院校名称为空');
  if (!result.majorName)  errors.push('专业名称为空');

  // ── 判断整行是否有解析异常 ──
  result.parseError  = errors.length > 0;
  result.parseErrors = errors;

  return result;
}

/**
 * 批量解析 Excel 文件 → 志愿行数组
 *
 * 核心改动：自动检测表头行
 * 真实用户的 Excel 可能前 1~2 行是标题/年份分组头，
 * 真正的列头在后面的某行。本函数通过扫描行内容，
 * 找到包含"序号"+"院校"的行作为表头行。
 *
 * @param {string} filePath  上传的 xlsx 临时文件路径
 * @returns {{ rows: Object[], warnings: string[] }}
 */
function parseExcelFile(filePath) {
  const wb   = XLSX.readFile(filePath);
  const ws   = wb.Sheets[wb.SheetNames[0]];

  // ── 用 AOA（数组的数组）读取，不自动推断表头 ──
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  const rows     = [];
  const warnings = [];

  if (aoa.length === 0) {
    warnings.push('Excel 文件无数据行');
    return { rows, warnings };
  }

  // ── step 1: 自动检测表头行 ──
  // 寻找同时包含"序号"和"院校"的行（允许模糊匹配）
  let headerRowIdx = -1;
  let headerRow    = null;

  for (let i = 0; i < Math.min(aoa.length, 10); i++) {
    const cells = aoa[i].map(c => String(c).trim());
    const hasSeq   = cells.some(c => c === '序号');
    const hasSchool = cells.some(c => c === '院校' || c === '学校名称');
    if (hasSeq && hasSchool) {
      headerRowIdx = i;
      headerRow    = cells;
      break;
    }
  }

  // 兜底：如果没找到同时含"序号"+"院校"的行，放宽到只含"院校"
  if (headerRowIdx === -1) {
    for (let i = 0; i < Math.min(aoa.length, 10); i++) {
      const cells = aoa[i].map(c => String(c).trim());
      if (cells.some(c => c === '院校' || c === '学校名称')) {
        headerRowIdx = i;
        headerRow    = cells;
        warnings.push('未找到标准表头行（缺少"序号"列），使用含"院校"的行作为表头');
        break;
      }
    }
  }

  // 最终兜底：如果还是没找到，用第一行作为表头（兼容旧格式）
  if (headerRowIdx === -1) {
    headerRowIdx = 0;
    headerRow    = aoa[0].map(c => String(c).trim());
    warnings.push('未找到含"序号"+"院校"的表头行，默认使用第一行作为表头');
  }

  console.log(`[parseExcelFile] 检测到表头行: Row ${headerRowIdx}, 列: ${headerRow.slice(0, 20).join(' | ')}`);

  // ── step 2: 构建列名 → 列索引映射 ──
  const colMap = {};
  for (let col = 0; col < headerRow.length; col++) {
    const raw = headerRow[col].trim();
    if (!raw) continue;

    // 去掉列名中可能的科类后缀如 "2025历史录取人数" → 拆成 "2025录取人数"
    // 先存原始列名
    colMap[raw] = col;

    // 也存去掉空格的版本
    const noSpace = raw.replace(/\s+/g, '');
    if (noSpace !== raw) colMap[noSpace] = col;
  }

  // 特殊处理：年份列名可能有科类后缀
  // 实际表头如 "录取人数" "线差" "最低分" "最低位次" "等效位差" "等效分差"
  // 但 year group header 行（如 Row 1）标注了 "2025历史"、"2024历史" 等
  // sheetjs 对合并单元格的处理：子单元格可能为空
  // 我们需要从 group header 行+列头行组合推断完整列名

  // 读取 group header 行（表头的上一行）
  const groupHeaderRow = headerRowIdx > 0
    ? aoa[headerRowIdx - 1].map(c => String(c).trim())
    : [];

  // 为年份列补充带年份前缀的映射
  for (const year of YEARS) {
    for (let i = 0; i < YEAR_FIELDS.length; i++) {
      const fieldLabel = YEAR_FIELDS[i];
      // 已有精确映射 "2025最低位次" → 跳过
      if (colMap[`${year}${fieldLabel}`] !== undefined) continue;

      // 找到 "最低位次" 等基础列名所在的列索引
      const baseColIdx = colMap[fieldLabel];
      if (baseColIdx === undefined) continue;

      // 同一个基础列名会出现 4 次（4个年份），我们需要区分
      // 策略：从 group header 行读取对应列的年份标签
    }
  }

  // 更可靠的策略：根据列位置直接推断年份列
  // 40列格式：16个基础列 + 4年×6列 = 40列
  // 基础列占 col 0~15，然后 2025 占 16~21，2024 占 22~27，2023 占 28~33，2022 占 34~39
  // 但有些文件基础列可能不完全（缺少某些列），所以需要根据实际表头动态推断

  // 动态推断年份列：找到第一个年份字段的起始列，然后按每组6列推算
  let yearColStart = -1;
  const baseColNames = ['序号', '院校代码', '院校', '层次', '地区/城市', '地区', '城市',
                         '类型', '性质', '排名', '升学率', '保研率', '专业代码',
                         '专业', '专业名称', '计划', '招生计划', '学费', '学制', '选科', '选科要求'];

  // 找到最后一个基础列的索引
  let lastBaseColIdx = -1;
  for (const name of baseColNames) {
    if (colMap[name] !== undefined && colMap[name] > lastBaseColIdx) {
      lastBaseColIdx = colMap[name];
    }
  }

  // 年份列从 lastBaseColIdx + 1 开始
  if (lastBaseColIdx >= 0) {
    yearColStart = lastBaseColIdx + 1;
  }

  // 补充年份列映射（基于位置推断）
  if (yearColStart >= 0 && yearColStart < headerRow.length) {
    for (const year of YEARS) {
      const yearOffset = (year - 2025) * 6; // 2025→0, 2024→6, 2023→12, 2022→18
      // 但这个 offset 方向取决于年份排列顺序（从近到远还是从远到近）
      // 检测方式：看 group header 行对应位置的文本
      for (let i = 0; i < YEAR_FIELDS.length; i++) {
        const colIdx = yearColStart + yearOffset + i;
        if (colIdx >= headerRow.length) continue;

        // 存储映射
        colMap[`${year}${YEAR_FIELDS[i]}`] = colIdx;
      }
    }

    // 用 group header 行来校验/修正年份分配
    // group header 行中，"2025历史" 覆盖 col 16~21, "2024历史" 覆盖 22~27 等
    if (groupHeaderRow.length > 0) {
      const yearGroupMap = {}; // col → year
      let currentYear = null;
      for (let c = 0; c < groupHeaderRow.length; c++) {
        const g = groupHeaderRow[c];
        if (g) {
          // 提取年份 "2025历史" → 2025, "2024(招生计划)" → 2024
          const ym = g.match(/(\d{4})/);
          if (ym) currentYear = parseInt(ym[1]);
        }
        if (currentYear) yearGroupMap[c] = currentYear;
      }

      // 根据实际 group header 修正年份列映射
      for (let c = yearColStart; c < headerRow.length; c++) {
        const actualYear = yearGroupMap[c];
        if (!actualYear) continue;
        const baseName = headerRow[c]; // "录取人数" "最低位次" 等
        if (!baseName) continue;
        colMap[`${actualYear}${baseName.trim()}`] = c;
      }
    }
  }

  console.log(`[parseExcelFile] 列映射完成, 共 ${Object.keys(colMap).length} 个映射, 年份列起始: ${yearColStart}`);

  // ── step 3: 逐行解析数据 ──
  for (let i = headerRowIdx + 1; i < aoa.length; i++) {
    const dataRow = aoa[i];

    // 跳过完全空行
    const hasContent = dataRow.some(v => v !== '' && v !== null && v !== undefined);
    if (!hasContent) continue;

    const parsed = parseExcelRow(dataRow, colMap, rows.length);
    rows.push(parsed);
  }

  // ── step 4: 校验表头完整性 ──
  const requiredHeaders = ['院校', '专业'];
  const missingHeaders  = requiredHeaders.filter(h => colMap[h] === undefined);
  if (missingHeaders.length > 0) {
    warnings.push(`表头缺少关键列：${missingHeaders.join('、')}，部分字段可能无法解析`);
  }

  console.log(`[parseExcelFile] 解析完成: ${rows.length} 条志愿, ${rows.filter(r=>r.parseError).length} 条有异常`);

  return { rows, warnings };
}

// ═══════════════════════════════════════════════════════════════════
//  路由
// ═══════════════════════════════════════════════════════════════════

// ── GET /upload — 上传页面 ─────────────────────────────────────
router.get('/', (req, res) => {
  const student_id = req.query.student_id || '';
  let student = null;
  if (student_id) {
    student = req.db.prepare('SELECT id,name FROM students WHERE id=?').get(student_id);
  }
  res.render('upload', { student, error: null });
});

// ── POST /upload — 上传 xlsx → 解析 → 预览 ───────────────────
router.post('/', upload.single('file'), (req, res) => {
  const student_id = req.body.student_id || req.query.student_id || '';
  const db = req.db;

  // 验证学生
  let student = null;
  if (student_id) {
    student = db.prepare('SELECT * FROM students WHERE id=?').get(student_id);
  }
  if (!student) {
    try { if (req.file) fs.unlinkSync(req.file.path); } catch(_) {}
    return res.render('upload', {
      student: null,
      error: '缺少有效的学生ID，请从学生详情页进入上传流程'
    });
  }

  if (!req.file) {
    return res.render('upload', { student, error: '请选择 xlsx 文件' });
  }

  try {
    // ── 解析 Excel ──
    const { rows, warnings } = parseExcelFile(req.file.path);

    // 清理临时文件
    try { fs.unlinkSync(req.file.path); } catch(_) {}

    if (rows.length === 0) {
      return res.render('upload', {
        student,
        error: 'Excel 文件中未找到有效数据行。' + (warnings.length ? warnings.join('；') : '')
      });
    }

    // ── 写入缓存 ──
    const cacheKey = crypto.randomUUID();
    uploadCache.set(cacheKey, {
      student_id: student.id,
      rows,
      timestamp: Date.now()
    });

    // ── 渲染预览页 ──
    return res.render('upload_preview', {
      student,
      cacheKey,
      rows,
      warnings,
      error: null
    });

  } catch (e) {
    console.error('[upload] 解析出错:', e);
    try { if (req.file) fs.unlinkSync(req.file.path); } catch(_) {}
    return res.render('upload', {
      student,
      error: `解析失败：${e.message}`
    });
  }
});

// ── POST /upload/confirm — 确认导入 → 写入 DB ─────────────────
router.post('/confirm', (req, res) => {
  const db       = req.db;
  const cacheKey = req.body.cacheKey || '';
  const checked  = req.body.checked; // 可能是 string 或 string[]

  // 从缓存取数据
  const cached = uploadCache.get(cacheKey);
  if (!cached) {
    return res.render('upload', {
      student: null,
      error: '预览数据已过期，请重新上传文件'
    });
  }

  uploadCache.delete(cacheKey); // 用完即删

  const student = db.prepare('SELECT * FROM students WHERE id=?').get(cached.student_id);
  if (!student) {
    return res.render('upload', {
      student: null,
      error: '学生不存在'
    });
  }

  // ── 确定勾选的行索引 ──
  let checkedIndices = [];
  if (Array.isArray(checked)) {
    checkedIndices = checked.map(i => parseInt(i)).filter(n => !isNaN(n));
  } else if (checked !== undefined && checked !== '') {
    const n = parseInt(checked);
    if (!isNaN(n)) checkedIndices = [n];
  }

  // 如果没有勾选任何行，提示
  if (checkedIndices.length === 0) {
    return res.render('upload', {
      student,
      error: '请至少勾选一条志愿再确认导入'
    });
  }

  // ── 加载 plans_cq 匹配池 ──
  const allPlans = db.prepare('SELECT id, school_name, major_name FROM plans_cq').all();
  const schoolMap = new Map();
  for (const p of allPlans) {
    if (!schoolMap.has(p.school_name)) schoolMap.set(p.school_name, []);
    schoolMap.get(p.school_name).push(p);
  }
  const schoolList = Array.from(schoolMap.keys()).map(name => ({ name }));

  // ── 清除该学生旧的 submitted_plans ──
  db.prepare('DELETE FROM submitted_plans WHERE student_id=?').run(student.id);

  // ── 逐行写入 ──
  let inserted = 0;
  let errorRows = 0;

  for (const idx of checkedIndices) {
    const r = cached.rows[idx];
    if (!r) continue;

    // ── 模糊匹配 plans_cq ──
    let school_matched_id = null;
    const risk_tags = [];

    if (allPlans.length === 0) {
      risk_tags.push('no_library');
    } else if (r.schoolName) {
      const schoolMatch = fuzzyMatch(r.schoolName, schoolList, 0.45);
      if (!schoolMatch) {
        risk_tags.push('unmatched_school');
      } else {
        const matchedSchoolName = schoolMatch.matched.name;
        const matchedRows = schoolMap.get(matchedSchoolName) || [];

        if (r.majorName) {
          const majorList = matchedRows.map(p => ({ name: p.major_name, id: p.id }));
          const majorMatch = fuzzyMatch(r.majorName, majorList, 0.4);
          if (majorMatch) {
            school_matched_id = majorMatch.matched.id;
          } else {
            school_matched_id = matchedRows[0]?.id || null;
            risk_tags.push('major_not_in_plan');
          }
        } else {
          school_matched_id = matchedRows[0]?.id || null;
        }
      }
    }

    // ── 构造 JSON 字段 ──
    const score2025 = r.score2025 ? JSON.stringify(r.score2025) : null;
    const score2024 = r.score2024 ? JSON.stringify(r.score2024) : null;
    const score2023 = r.score2023 ? JSON.stringify(r.score2023) : null;
    const score2022 = r.score2022 ? JSON.stringify(r.score2022) : null;

    // ── 写入 DB ──
    try {
      db.prepare(`
        INSERT INTO submitted_plans(
          student_id, seq,
          school_code, school_name_input, major_code, major_name_input,
          level, region, type, nature, ranking, further_study_rate, postgrad_rate,
          plan_count, tuition, academic_system, selection_req,
          score_2025_json, score_2024_json, score_2023_json, score_2022_json,
          batch, school_matched_id, risk_level, risk_tags_json, parse_error, note
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        student.id, r.seq,
        r.schoolCode  || null,
        r.schoolName,
        r.majorCode   || null,
        r.majorName,
        r.level       || null,
        r.region      || null,
        r.type        || null,
        r.nature      || null,
        r.ranking     || null,
        r.furtherStudyRate || null,
        r.postgradRate     || null,
        r.planCount   || null,
        r.tuition     || null,
        r.academicSystem  || null,
        r.selectionReq || null,
        score2025, score2024, score2023, score2022,
        '本科批',        // batch
        school_matched_id,
        'normal',        // risk_level (后面审单会重算)
        JSON.stringify(risk_tags),
        r.parseError ? 1 : 0,
        r.parseErrors.length ? `解析异常: ${r.parseErrors.join('；')}` : null
      );
      inserted++;
      if (r.parseError) errorRows++;
    } catch (e) {
      console.error(`[upload/confirm] 写入第 ${r.seq} 行失败:`, e.message);
    }
  }

  console.log(`[upload/confirm] 学生${student.name}: 导入 ${inserted} 条（其中 ${errorRows} 条有解析异常）`);

  // 跳转审单报告
  return res.redirect(`/report/${student.id}`);
});

// ── GET /upload/template-plans — 下载志愿库模板 ────────────────
router.get('/template-plans', (_req, res) => {
  const wb = XLSX.utils.book_new();
  const headers = [
    ['学校代码','学校名称','专业名称','批次','2024最低位次','2025最低位次','选科要求','收费标签','身体限制标签','数据来源']
  ];
  const ws = XLSX.utils.aoa_to_sheet(headers);
  ws['!cols'] = [10,20,20,10,14,14,16,10,16,16].map(w=>({wch:w}));
  XLSX.utils.book_append_sheet(wb, ws, '志愿库导入');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.set({
    'Content-Disposition': 'attachment; filename="plans_template.xlsx"',
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  });
  res.send(buf);
});

// ── POST /upload/plans — 导入志愿库（plans_cq）────────────────
router.post('/plans', upload.single('file'), (req, res) => {
  const db = req.db;
  if (!req.file) return res.redirect('/upload?error=no_file');

  try {
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

    // 返回 JSON 供前端展示
    return res.json({ ok: true, total: rows.length, inserted, skipped });
  } catch (e) {
    try { fs.unlinkSync(req.file.path); } catch(_) {}
    console.error(e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
module.exports.parseExcelRow   = parseExcelRow;
module.exports.parseExcelFile  = parseExcelFile;
