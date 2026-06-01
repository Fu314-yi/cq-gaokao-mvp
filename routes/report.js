'use strict';
const express = require('express');
const router  = express.Router();

/* ═══════════════════════════════════════════════════════════════════
 *  audit(student, rows, planMap) — 纯函数审单引擎
 *
 *  参数:
 *    student  — students 表行对象（需先解析 JSON 字段）
 *    rows     — submitted_plans LEFT JOIN plans_cq 的结果数组
 *    planMap  — { [plans_cq.id]: row } 用于快速查专业详情
 *
 *  返回:
 *    {
 *      items: [{
 *        ...row,
 *        tags: string[],           // 审单标签
 *        zone: 'red'|'yellow'|'green'|'unknown',
 *        rank_ref: number|null,    // 使用的参考位次
 *        rank_ratio: number|null,  // row.rank_ref / student.rank
 *      }],
 *      globals: string[],         // 全局风险标签
 *    }
 * ═══════════════════════════════════════════════════════════════════ */
function audit(student, rows, planMap) {
  const sRank = student.rank;
  const sPrime     = student.prime;                       // 物理 / 历史
  const sElectives = [student.elective1, student.elective2].filter(Boolean);
  const sBodyFlags = Array.isArray(student.body_flags)
    ? student.body_flags : JSON.parse(student.body_flags_json || '[]');
  const sAcceptedTuition = Array.isArray(student.accepted_tuition_tags)
    ? student.accepted_tuition_tags : JSON.parse(student.accepted_tuition_tags || '[]');

  const items = rows.map(row => {
    // 继承上传阶段的风险标签
    const tags = [];
    const uploadTags = JSON.parse(row.risk_tags_json || '[]');
    uploadTags.forEach(t => { if (!tags.includes(t)) tags.push(t); });

    // ── 解析年份录取 JSON ──
    let score2025 = null, score2024 = null;
    try { score2025 = row.score_2025_json ? JSON.parse(row.score_2025_json) : null; } catch(_) {}
    try { score2024 = row.score_2024_json ? JSON.parse(row.score_2024_json) : null; } catch(_) {}

    // ── 判断自含数据是否完整 ──
    const hasSelfRank = (score2025 && score2025.rank) || (score2024 && score2024.rank);
    const hasSelfSelReq = !!(row.selection_req);  // Excel 自带选科要求
    const hasSelfData = hasSelfRank && hasSelfSelReq;

    // ── 1. 院校未匹配 → 区分"数据缺失"和"仅未关联库" ──
    //    关键改进：Excel 自带录取位次+选科+性质时，未匹配 plans_cq 不影响审单
    //    仅当自含数据也缺失时才标 red 级别
    if (!row.school_matched_id || tags.includes('unmatched_school')) {
      // 先移除上传阶段的 unmatched_school 标签
      const idx = tags.indexOf('unmatched_school');
      if (idx >= 0) tags.splice(idx, 1);

      if (hasSelfData) {
        // 自含数据完整，仅未关联志愿库 → 信息标签，不强制标红
        tags.push('no_library_link');
      } else {
        // 无自含数据又没关联库 → 真正的数据缺失
        tags.push('unmatched');
      }
    }

    // major_not_in_plan 降级：如果自含数据完整，仅作信息提示
    if (tags.includes('major_not_in_plan')) {
      if (hasSelfData) {
        const idx = tags.indexOf('major_not_in_plan');
        if (idx >= 0) tags[idx] = 'major_diff_from_library';
      }
      // 无自含数据时保留原标签
    }

    // ── 2. 选科不满足（优先读 submitted_plans 自带，回退到 plans_cq） ──
    //    关键改进：不再要求 school_matched_id 存在，Excel 自带 selection_req 也要检查
    const selReq = row.selection_req || row.lib_selection_req || null;
    if (selReq) {
      if (!checkSelection(sPrime, sElectives, selReq)) {
        if (!tags.includes('selection_mismatch')) tags.push('selection_mismatch');
      }
    }

    // ── 3. 体检受限（仅 plans_cq 有此字段，Excel 无） ──
    //    如果没关联库，无法检查体检，标一个 info 标签提醒
    const bodyTags = row.lib_body_restrict_tags || null;
    if (bodyTags && row.school_matched_id) {
      const restrictTags = JSON.parse(bodyTags || '[]');
      const overlap = restrictTags.filter(t => sBodyFlags.some(bf =>
        normalizeBodyTag(bf) === normalizeBodyTag(t)
      ));
      if (overlap.length > 0) {
        if (!tags.includes('body_risk')) tags.push('body_risk');
      }
    } else if (!row.school_matched_id && sBodyFlags.length > 0) {
      // 未关联库 + 考生有身体受限 → 无法自动检查，仅提醒
      if (!tags.includes('body_check_unavailable')) tags.push('body_check_unavailable');
    }

    // ── 4. 中外合作预警 ──
    //    优先读 Excel 自带 nature 字段，回退到 plans_cq tuition_tag
    //    关键改进：如果 Excel 明确标注"公办"且不含"中外合作"，则不因库的 tuition_tag 标中外合作
    //    （模糊匹配可能把普通专业匹配到了库里的中外合作条目）
    const tuitionTag = row.lib_tuition_tag || '';
    const natureStr  = row.nature || '';

    let isCoop = false;
    if (natureStr.includes('中外合作')) {
      // Excel 自己标注了中外合作 → 一定是
      isCoop = true;
    } else if (natureStr === '公办' || (natureStr.includes('公办') && !natureStr.includes('中外'))) {
      // Excel 明确标注公办 → 信任 Excel，即使库说中外合作也不标
      isCoop = false;
    } else if (tuitionTag.includes('中外合作')) {
      // Excel 没有明确性质，库说中外合作 → 可能是
      isCoop = true;
    }

    if (isCoop && !sAcceptedTuition.includes('中外合作')) {
      if (!tags.includes('maybe_unwanted_coop')) tags.push('maybe_unwanted_coop');
    }

    // ── 5. 位次冲稳保（优先读 score JSON，回退到 plans_cq） ──
    let rank_ref = null;
    if (score2025 && score2025.rank) {
      rank_ref = score2025.rank;
    } else if (score2024 && score2024.rank) {
      rank_ref = score2024.rank;
    } else if (row.lib_min_rank_2025) {
      rank_ref = row.lib_min_rank_2025;
    } else if (row.lib_min_rank_2024) {
      rank_ref = row.lib_min_rank_2024;
    }

    let rank_ratio = null;
    let zone = 'unknown';
    if (rank_ref && sRank) {
      rank_ratio = rank_ref / sRank;
      if (rank_ratio > 1.25) {
        zone = 'green';    // 保：宽裕
      } else if (rank_ratio >= 0.9) {
        zone = 'yellow';   // 稳/冲：边缘
      } else {
        zone = 'red';      // 冲过头：够不到
      }
    }

    // 退档级标签优先：selection_mismatch / body_risk / 真正的数据缺失 → 强制 red
    //    注意：no_library_link / major_diff_from_library / body_check_unavailable 是信息标签，不强制标红
    if (tags.includes('unmatched') || tags.includes('selection_mismatch') || tags.includes('body_risk')) {
      zone = 'red';
    }
    // no_library_link 仅在无位次数据时提升为黄区提醒
    if (tags.includes('no_library_link') && zone === 'unknown') {
      zone = 'yellow';
    }

    return {
      ...row,
      selection_req: selReq,   // 合并后的选科要求
      score2025, score2024,    // 解析后的年份对象
      tags,
      zone,
      rank_ref,
      rank_ratio,
    };
  });

  // ── 全局检查 ──
  const globals = [];

  // 保底不足：最后 5 条如果仍全部在 red 区
  const tail = items.slice(-5);
  if (tail.length >= 3 && tail.every(it => it.zone === 'red')) {
    globals.push('insufficient_safety');
  }

  // 中外合作全局：存在 maybe_unwanted_coop 标签
  if (items.some(it => it.tags.includes('maybe_unwanted_coop'))) {
    globals.push('has_unwanted_coop');
  }

  return { items, globals };
}

/* ── 选科匹配 ── */
function checkSelection(prime, electives, req) {
  if (!req || req === '不限') return true;

  const reqLower = req.toLowerCase();

  // ── 首选科目检查 ──
  const hasWuli  = reqLower.includes('物理');
  const hasLishi = reqLower.includes('历史');

  if (hasWuli && hasLishi) {
    // "物理或历史" → 首选科目任一均可，跳过首选检查
  } else if (hasWuli && prime !== '物理') {
    return false;   // 要求物理但考生首选历史
  } else if (hasLishi && prime !== '历史') {
    return false;   // 要求历史但考生首选物理
  }

  // ── 再选科目检查 ──
  // 科目名归一化映射："思想政治" ↔ "政治"，确保双向匹配
  const electiveAliases = {
    '化学': '化学',
    '生物': '生物',
    '政治': '政治',
    '思想政治': '政治',
    '地理': '地理',
  };

  // 将考生再选科目归一化
  const normElectives = electives.map(e => electiveAliases[e] || e);
  // 将要求中的再选科目归一化
  const electiveNames = ['化学', '生物', '政治', '思想政治', '地理'];
  const requiredElectives = electiveNames
    .filter(e => reqLower.includes(e.toLowerCase()))
    .map(e => electiveAliases[e] || e);
  // 去重
  const uniqueRequired = [...new Set(requiredElectives)];

  if (uniqueRequired.length === 0) return true;

  // "或"关系：满足任一即可
  if (reqLower.includes('或')) {
    return uniqueRequired.some(e => normElectives.includes(e));
  }

  // "必选"/"且"/"+"关系：全部需要满足
  if (reqLower.includes('必选') || reqLower.includes('且') || reqLower.includes('+')) {
    return uniqueRequired.every(e => normElectives.includes(e));
  }

  // 默认：如果要求中提到某科目，学生的再选科目需要包含至少一个
  return uniqueRequired.some(e => normElectives.includes(e));
}

/* ── 体检标签归一化比较 ── */
function normalizeBodyTag(tag) {
  if (!tag) return '';
  // "色弱(01)" → "01", "色盲(02)" → "02"
  const m = tag.match(/\((\d+)\)/);
  if (m) return m[1];
  return tag.trim().toLowerCase();
}


// ═══════════════════════════════════════════════════════════════════
//  路由
// ═══════════════════════════════════════════════════════════════════

// 审单报告列表
router.get('/', (req, res) => {
  const sid = req.query.student_id;
  if (sid) return res.redirect(`/report/${sid}`);

  const students = req.db.prepare(`
    SELECT s.id, s.name, s.total_score, s.rank, s.prime,
           COUNT(sp.id) as plan_count
    FROM students s
    LEFT JOIN submitted_plans sp ON sp.student_id = s.id
    GROUP BY s.id
    ORDER BY s.created_at DESC
  `).all();
  res.render('report_list', { students });
});

// 某学生审单报告
router.get('/:id', (req, res) => {
  const db = req.db;
  const student = db.prepare('SELECT * FROM students WHERE id=?').get(req.params.id);
  if (!student) return res.status(404).render('error', { msg: '学生不存在' });

  // 解析 JSON 字段
  student.body_flags  = JSON.parse(student.body_flags_json  || '[]');
  student.bonus_tags  = JSON.parse(student.bonus_tags_json  || '[]');
  student.accepted_tuition_tags = JSON.parse(student.accepted_tuition_tags || '[]');

  // 取志愿数据（LEFT JOIN plans_cq 取体检受限、收费标签等补充信息）
  const rows = db.prepare(`
    SELECT sp.*,
           pc.school_name  AS lib_school,
           pc.major_name   AS lib_major,
           pc.min_rank_2024 AS lib_min_rank_2024,
           pc.min_rank_2025 AS lib_min_rank_2025,
           pc.selection_req AS lib_selection_req,
           pc.tuition_tag   AS lib_tuition_tag,
           pc.body_restrict_tags AS lib_body_restrict_tags
    FROM submitted_plans sp
    LEFT JOIN plans_cq pc ON sp.school_matched_id = pc.id
    WHERE sp.student_id = ?
    ORDER BY sp.seq
  `).all(student.id);

  // 构建 planMap
  const planMap = {};
  const allPlans = db.prepare('SELECT * FROM plans_cq').all();
  allPlans.forEach(p => { planMap[p.id] = p; });

  // 调用纯函数审单
  const { items, globals } = audit(student, rows, planMap);

  // 分区统计
  const stats = {
    total:   items.length,
    red:     items.filter(it => it.zone === 'red').length,
    yellow:  items.filter(it => it.zone === 'yellow').length,
    green:   items.filter(it => it.zone === 'green').length,
    unknown: items.filter(it => it.zone === 'unknown').length,
  };

  // 建议文本
  const advice = buildAdvice(student, items, globals);

  res.render('report', { student, items, globals, stats, advice });
});


/* ═══════════════════════════════════════════════════════════════════
 *  buildAdvice — 专家级审单建议
 *  基于15年从业经验视角，对每条志愿给出有深度的点评
 * ═══════════════════════════════════════════════════════════════════ */
function buildAdvice(student, items, globals) {
  const lines = [];
  const sRank  = student.rank;
  const sPrime = student.prime;
  const sScore = student.total_score;
  const sElec  = [student.elective1, student.elective2].filter(Boolean).join('+');
  const name   = student.name || '考生';

  const redItems    = items.filter(it => it.zone === 'red');
  const yellowItems = items.filter(it => it.zone === 'yellow');
  const greenItems  = items.filter(it => it.zone === 'green');
  const unknownItems = items.filter(it => it.zone === 'unknown');

  // ── 开头概述 ──
  lines.push(`${name}，${sPrime}类，高考总分 ${sScore} 分，全市位次第 ${sRank ? sRank.toLocaleString() : '未知'} 名，再选${sElec ? sElec : '未填'}。`);

  // ── 总体结构诊断 ──
  const total = items.length;
  if (total > 0) {
    const redPct  = Math.round(redItems.length / total * 100);
    const grePct  = Math.round(greenItems.length / total * 100);
    if (redPct > 50) {
      lines.push(`📊 整体结构诊断：本次 ${total} 条志愿中，红色退档级占比高达 ${redPct}%，志愿表整体偏"冲"，存在较高滑档风险。建议大幅调整，增加稳妥院校。`);
    } else if (grePct > 60) {
      lines.push(`📊 整体结构诊断：本次 ${total} 条志愿中，绿色保底区占比 ${grePct}%，整体偏"保"。如果您希望冲击更好的院校，可以适当将前面部分志愿换成位次更接近的学校。`);
    } else {
      lines.push(`📊 整体结构诊断：${total} 条志愿中，红色 ${redItems.length} 条（冲）、黄色 ${yellowItems.length} 条（稳）、绿色 ${greenItems.length} 条（保），整体梯度结构${(yellowItems.length >= 3 && greenItems.length >= 3) ? '合理' : '待优化'}。`);
    }
  }

  // ── 强制退档风险（必须改） ──
  const selMismatchItems = redItems.filter(it => it.tags.includes('selection_mismatch'));
  if (selMismatchItems.length > 0) {
    lines.push(`🔴【必须删除】共 ${selMismatchItems.length} 条专业选科要求与考生不匹配（${sPrime}+${sElec}）：${selMismatchItems.map(it => `第${it.seq}志愿"${it.school_name_input || ''}·${it.major_name_input || ''}"`).slice(0,3).join('、')}${selMismatchItems.length > 3 ? '等' : ''}。这类志愿一旦投档，学校会直接退档，等于浪费一个志愿位。`);
  }

  const bodyRiskItems = redItems.filter(it => it.tags.includes('body_risk'));
  if (bodyRiskItems.length > 0) {
    lines.push(`🔴【体检风险】${bodyRiskItems.length} 条专业与考生身体受限情况存在冲突：${bodyRiskItems.map(it => `第${it.seq}志愿"${it.major_name_input || ''}"`).slice(0,3).join('、')}。请务必对照《普通高等学校招生体检工作指导意见》及各学校招生章程，逐条核实，确认无误再保留。`);
  }

  const unmatchedItems = redItems.filter(it => it.tags.includes('unmatched'));
  if (unmatchedItems.length > 0) {
    lines.push(`🔴【数据缺失】${unmatchedItems.length} 条志愿无任何近年录取数据，无法判断录取概率，相当于蒙着眼填报：${unmatchedItems.map(it => `第${it.seq}志愿"${it.school_name_input || ''}"`).slice(0,3).join('、')}${unmatchedItems.length > 3 ? '等' : ''}。请自行查询这些院校在重庆的历年录取情况，补充后再做判断。`);
  }

  // ── 位次偏高（够不到）的红区志愿 ──
  const rankRedItems = redItems.filter(it =>
    it.rank_ratio !== null &&
    !it.tags.includes('unmatched') &&
    !it.tags.includes('selection_mismatch') &&
    !it.tags.includes('body_risk')
  );
  if (rankRedItems.length > 0) {
    const worst = [...rankRedItems].sort((a,b) => (a.rank_ratio||0)-(b.rank_ratio||0))[0];
    lines.push(`🔴【位次不够】${rankRedItems.length} 条志愿院校最低录取位次比考生位次靠前超过10%，录取概率极低。其中差距最大的是第 ${worst.seq} 志愿"${worst.school_name_input || ''}"（参考位次 ${worst.rank_ref ? worst.rank_ref.toLocaleString() : '—'}，你的位次 ${sRank ? sRank.toLocaleString() : '—'}，位次比仅 ${worst.rank_ratio !== null ? (worst.rank_ratio*100).toFixed(0)+'%' : '—'}）。这些志愿建议替换为位次更接近的院校。`);
  }

  // ── 中外合作预警 ──
  const coopItems = yellowItems.filter(it => it.tags.includes('maybe_unwanted_coop'));
  if (coopItems.length > 0) {
    lines.push(`🟡【中外合作确认】${coopItems.length} 条志愿涉及中外合作办学专业，学费通常在 3~10 万元/年，总计四年花费较高。如家庭经济条件允许且认可该培养模式，则可保留；否则建议替换为同等档次的国内普通专业。涉及院校：${coopItems.map(it => `第${it.seq}志愿"${it.school_name_input || ''}·${it.major_name_input || ''}"`).slice(0,3).join('、')}。`);
  }

  // ── 边缘志愿梯度分析 ──
  const edgeItems = yellowItems.filter(it =>
    it.rank_ratio !== null &&
    !it.tags.includes('maybe_unwanted_coop')
  );
  if (edgeItems.length > 0) {
    lines.push(`🟡【边缘冲刺区】${edgeItems.length} 条志愿处于冲刺区间（位次比90%~125%），能冲上就冲，有一定录取可能但不稳定。建议仔细核查这些学校近三年的录取趋势——如果连续三年位次在考生附近波动，说明确实有机会；如果逐年收紧，则要谨慎。`);
  }

  // ── 保底分析 ──
  if (greenItems.length > 0) {
    if (greenItems.length < 3) {
      lines.push(`🟢【保底不足】绿色安全区只有 ${greenItems.length} 条，数量偏少。志愿填报中"保底"是底线，建议最后 3~5 条选择位次宽裕（比你低 20% 以上）的院校，确保万无一失。`);
    } else {
      lines.push(`🟢【保底情况】有 ${greenItems.length} 条志愿属于安全保底区，这是好的。保底院校虽然可能与期望有落差，但"有学上"是第一目标。`);
    }
  }

  // ── 全局风险：滑档 ──
  if (globals.includes('insufficient_safety')) {
    lines.push(`⚠️【高度警告：滑档风险】最后 5 条志愿全部在红色区间——这是非常危险的信号！一旦前面的冲刺志愿全部落空，您将无学可上，面临"征志愿"或复读。强烈建议立刻将最后 3~5 条替换为确定能录取的兜底院校（公办为主，位次宽裕 20% 以上）。`);
  }

  // ── 数量建议 ──
  if (total > 0 && total < 40) {
    lines.push(`💡 重庆平行志愿最多可填 96 个专业（每批），目前只填了 ${total} 个，还有大量空间。建议将志愿填至 70~80 个，覆盖更多院校，提高录取把握。`);
  } else if (total >= 40) {
    lines.push(`💡 共填报 ${total} 条志愿，数量适中。重庆平行志愿按位次从高到低依次检索，靠后的志愿也有价值，建议尽量填满，利用好每一个志愿位。`);
  }

  // ── 专业梯度提示 ──
  const hasGradientIssue = items.length > 5 && (() => {
    // 检测是否有连续多个志愿位次相近（缺乏梯度）
    const withRank = items.filter(it => it.rank_ref && it.zone !== 'unknown');
    let sameZoneStreak = 0;
    for (let i = 1; i < withRank.length; i++) {
      if (withRank[i].zone === withRank[i-1].zone) {
        sameZoneStreak++;
        if (sameZoneStreak >= 10) return true;
      } else {
        sameZoneStreak = 0;
      }
    }
    return false;
  })();
  if (hasGradientIssue) {
    lines.push(`💡 志愿梯度提示：发现部分志愿区间连续10条以上集中在同一档次（全冲或全保），缺乏"冲稳保"的层次感。建议按"20%冲 + 40%稳 + 40%保"的比例合理分配，每跨越一个档次做好梯度过渡。`);
  }

  // ── 收尾总结 ──
  lines.push(`综合来看，请重点处理：① 红色退档风险条目（必须删或换）；② 确认中外合作意愿；③ 补充保底院校。有任何疑问，建议与招生老师或专业规划师进一步沟通。祝金榜题名！`);

  return lines;
}


module.exports = router;
module.exports.audit = audit;
module.exports.buildAdvice = buildAdvice;
