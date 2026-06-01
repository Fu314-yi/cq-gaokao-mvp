/**
 * routes/auth.js
 * 认证路由：登录、注册、发送验证码、退出
 * 用户登录：/login（手机号+验证码）
 * 管理员登录：/admin/login（账号+密码）— 路由注册在本文件，挂载在 app.js
 */
'use strict';
const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcrypt');

// ── SMS 验证码内存缓存 ──
// phone → { code, expires, cooldown }
const smsCodes = new Map();

// 万能验证码（MVP 开发模式）
const MAGIC_CODE = '888888';

/**
 * 发送验证码（AJAX）
 */
router.post('/send-sms', (req, res) => {
  const { phone } = req.body;
  if (!phone || !/^1\d{10}$/.test(phone)) {
    return res.json({ ok: false, msg: '请输入正确的手机号' });
  }

  // 60 秒冷却
  const existing = smsCodes.get(phone);
  if (existing && Date.now() < existing.cooldown) {
    const remaining = Math.ceil((existing.cooldown - Date.now()) / 1000);
    return res.json({ ok: false, msg: `请${remaining}秒后再试` });
  }

  // 生成 6 位验证码
  const code = String(Math.floor(100000 + Math.random() * 900000));
  smsCodes.set(phone, {
    code,
    expires: Date.now() + 5 * 60 * 1000,   // 5 分钟有效
    cooldown: Date.now() + 60 * 1000,        // 60 秒冷却
  });

  // 打印到控制台（MVP 替代短信发送）
  console.log(`[SMS] ${phone} 验证码: ${code} (万能码: ${MAGIC_CODE})`);

  res.json({ ok: true });
});

// ════════════════════════════════════════════
//  普通用户登录  /login
// ════════════════════════════════════════════

/**
 * GET /login — 用户登录页
 */
router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('auth/login', { title: '登录', error: null, redirect: req.query.redirect || '' });
});

/**
 * POST /login — 用户登录处理（手机号+验证码）
 */
router.post('/login', (req, res) => {
  const { phone, code } = req.body;
  const renderErr = (msg) =>
    res.render('auth/login', { title: '登录', error: msg, redirect: req.body.redirect || '' });

  if (!phone || !/^1\d{10}$/.test(phone)) return renderErr('请输入正确的手机号');
  if (!code) return renderErr('请输入验证码');

  // 查找用户
  const user = req.db.prepare('SELECT * FROM users WHERE phone=? AND is_banned=0').get(phone);
  if (!user) return renderErr('该手机号未注册，请先注册');

  // 验证码校验
  const cached = smsCodes.get(phone);
  const codeValid = code === MAGIC_CODE ||
                    (cached && cached.code === code && Date.now() < cached.expires);
  if (!codeValid) return renderErr('验证码错误或已过期');
  smsCodes.delete(phone);

  // 登录成功
  req.session.userId = user.id;
  const redirectUrl = req.body.redirect || '/';
  res.redirect(redirectUrl);
});

// ════════════════════════════════════════════
//  管理员登录  /admin/login
// ════════════════════════════════════════════

/**
 * GET /admin/login — 管理员登录页
 */
router.get('/admin/login', (req, res) => {
  // 已登录的管理员直接跳后台
  if (req.user && req.user.role === 'admin') return res.redirect('/admin');
  // 普通用户访问此页：先退出 session 再显示管理员登录页
  res.render('auth/admin_login', { title: '管理员登录', error: null, redirect: req.query.redirect || '' });
});

/**
 * POST /admin/login — 管理员登录处理（账号+密码）
 */
router.post('/admin/login', (req, res) => {
  const { phone, password } = req.body;
  const renderErr = (msg) =>
    res.render('auth/admin_login', { title: '管理员登录', error: msg, redirect: req.body.redirect || '' });

  if (!phone) return renderErr('请输入管理员账号');
  if (!password) return renderErr('请输入密码');

  const user = req.db.prepare('SELECT * FROM users WHERE phone=? AND is_banned=0').get(phone);
  if (!user) return renderErr('账号不存在或已被禁用');
  if (user.role !== 'admin') return renderErr('该账号不具备管理员权限');
  if (!user.password_hash) return renderErr('该账号未设置密码，请联系超级管理员');
  if (!bcrypt.compareSync(password, user.password_hash)) return renderErr('密码错误');

  // 登录成功
  req.session.userId = user.id;
  const redirectUrl = req.body.redirect || '/admin';
  res.redirect(redirectUrl);
});

// ════════════════════════════════════════════
//  注册  /register
// ════════════════════════════════════════════

/**
 * GET /register — 注册页
 */
router.get('/register', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('auth/register', { title: '注册', error: null });
});

/**
 * POST /register — 注册处理
 */
router.post('/register', (req, res) => {
  const { phone, code, nickname, grade, region, agreement } = req.body;

  if (!phone || !/^1\d{10}$/.test(phone)) {
    return res.render('auth/register', { title: '注册', error: '请输入正确的手机号' });
  }
  if (!code) {
    return res.render('auth/register', { title: '注册', error: '请输入验证码' });
  }
  if (!grade) {
    return res.render('auth/register', { title: '注册', error: '请选择年级' });
  }
  if (!region) {
    return res.render('auth/register', { title: '注册', error: '请选择地区' });
  }
  if (!agreement) {
    return res.render('auth/register', { title: '注册', error: '请阅读并同意服务协议和隐私政策' });
  }

  // 验证验证码
  const cached = smsCodes.get(phone);
  const codeValid = code === MAGIC_CODE ||
                    (cached && cached.code === code && Date.now() < cached.expires);
  if (!codeValid) {
    return res.render('auth/register', { title: '注册', error: '验证码错误或已过期' });
  }
  smsCodes.delete(phone);

  // 检查手机号是否已注册
  const existing = req.db.prepare('SELECT id FROM users WHERE phone=?').get(phone);
  if (existing) {
    return res.render('auth/register', { title: '注册', error: '该手机号已注册，请直接登录' });
  }

  // 创建用户
  try {
    const result = req.db.prepare(
      `INSERT INTO users(phone, nickname, grade, region, role, agreement_accepted)
       VALUES (?, ?, ?, ?, 'user', 1)`
    ).run(phone, nickname || '', grade, region);

    req.session.userId = result.lastInsertRowid;
    res.redirect('/');
  } catch (e) {
    console.error('注册失败:', e);
    res.render('auth/register', { title: '注册', error: '注册失败，请稍后再试' });
  }
});

// ════════════════════════════════════════════
//  退出登录  /logout
// ════════════════════════════════════════════

/**
 * GET /logout — 退出登录
 */
router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

module.exports = router;
