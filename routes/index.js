'use strict';
const express = require('express');
const router  = express.Router();

router.get('/', (req, res) => {
  // 首页不再需要统计数字作为展示卡片
  // user 通过 injectUser 中间件已自动注入 res.locals.user
  res.render('index', { total: 0 });
});

module.exports = router;
