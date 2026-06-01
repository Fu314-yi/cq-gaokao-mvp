/**
 * middleware/auth.js
 * 认证中间件：requireAuth / requireAdmin / injectUser
 */
'use strict';

/**
 * 注入当前登录用户到 req.user 和 res.locals.user
 * 所有路由都应使用此中间件
 */
function injectUser(req, res, next) {
  if (req.session && req.session.userId) {
    const user = req.db.prepare(
      'SELECT id, phone, nickname, grade, region, role, is_banned FROM users WHERE id=?'
    ).get(req.session.userId);

    if (user && !user.is_banned) {
      req.user = user;
    } else {
      // 用户被封禁或不存在 → 清除 session
      req.session.userId = null;
      req.user = null;
    }
  } else {
    req.user = null;
  }
  res.locals.user = req.user;
  next();
}

/**
 * 要求登录 — 未登录则重定向到用户登录页 /login
 */
function requireAuth(req, res, next) {
  if (!req.user) {
    return res.redirect('/login?redirect=' + encodeURIComponent(req.originalUrl));
  }
  next();
}

/**
 * 要求管理员权限 — 未登录重定向到 /admin/login，非管理员返回 403
 */
function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.redirect('/admin/login?redirect=' + encodeURIComponent(req.originalUrl));
  }
  if (req.user.role !== 'admin') {
    return res.status(403).render('error', { msg: '无管理员权限，请使用管理员账号登录' });
  }
  next();
}

module.exports = { injectUser, requireAuth, requireAdmin };
