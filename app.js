'use strict';
const express  = require('express');
const path     = require('path');
const session  = require('express-session');
const initDbAsync = require('./db/init');
const { injectUser, requireAuth } = require('./middleware/auth');

async function main() {
  // ── 初始化数据库（异步） ──────────────────────────────────────
  const db = await initDbAsync();

  // ── Express 应用 ──────────────────────────────────────────
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  // 中间件
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  // ── Session 管理 ─────────────────────────────────────────
  app.use(session({
    secret: process.env.SESSION_SECRET || 'cq-gaokao-mvp-secret-2026',
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 24 * 60 * 60 * 1000,   // 24 小时
      httpOnly: true,
    },
  }));

  // 把 db 挂到 req 上供路由使用
  app.use((req, _res, next) => { req.db = db; next(); });

  // 注入当前用户到 req.user / res.locals.user
  app.use(injectUser);

  // ── 公开路由 ─────────────────────────────────────────────
  app.use('/',      require('./routes/index'));   // 首页
  app.use('/',      require('./routes/auth'));    // 登录/注册/验证码/退出
  app.get('/terms',  (req, res) => res.render('terms',  { title: '服务协议' }));
  app.get('/privacy', (req, res) => res.render('privacy', { title: '隐私政策' }));

  // ── 需要登录的路由 ──────────────────────────────────────
  app.use('/student', requireAuth, require('./routes/student'));
  app.use('/upload',  requireAuth, require('./routes/upload'));
  app.use('/report',  requireAuth, require('./routes/report'));

  // ── 管理后台 ─────────────────────────────────────────────
  app.use('/admin',   require('./routes/admin'));   // requireAdmin 在路由内部处理

  // ── 404 & 错误处理 ────────────────────────────────────────
  app.use((_req, res) => res.status(404).render('error', { msg: '页面不存在 (404)' }));
  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).render('error', { msg: err.message || '服务器内部错误' });
  });

  // ── 启动 ──────────────────────────────────────────────────
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`\n🚀  重庆志愿审单系统已启动  →  http://localhost:${PORT}\n`);
  });
}

main().catch(err => {
  console.error('启动失败:', err);
  process.exit(1);
});
