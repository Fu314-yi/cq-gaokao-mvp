# 重庆高考志愿审单系统 MVP

## 项目说明

这是一个帮助考生审核高考志愿填报方案的本地 Web 系统，基于重庆招考政策开发。

## 技术栈

- **后端**：Node.js + Express
- **数据库**：sql.js（纯 WASM，无需编译）
- **模板引擎**：EJS
- **样式**：TailwindCSS（CDN）

## 目录结构

```
cq-gaokao-mvp/
├── app.js              # 主入口
├── package.json        # 依赖配置
├── db/
│   ├── init.js         # 数据库初始化脚本
│   ├── init.sql        # 建表 SQL
│   └── gaokao.db       # 数据库文件（运行后生成）
├── middleware/
│   └── auth.js         # 认证中间件
├── routes/
│   ├── auth.js         # 登录/注册/退出
│   ├── admin.js        # 管理后台
│   ├── index.js        # 首页
│   ├── report.js       # 审单报告
│   ├── student.js      # 学生管理
│   └── upload.js       # 文件上传
├── views/              # EJS 模板
├── public/             # 静态资源
└── uploads/            # 上传文件存储
```

## 启动方式

### 第一次运行（初始化数据库）

打开 CMD，运行：
```cmd
C:\Users\DELL\.workbuddy\binaries\node\versions\22.12.0\node.exe db/init.js
```

### 启动服务器

```cmd
C:\Users\DELL\.workbuddy\binaries\node\versions\22.12.0\node.exe app.js
```

或者如果系统有全局 node：
```cmd
node app.js
```

看到 `Server running on http://localhost:3000` 即启动成功。

### 安装依赖（首次或 node_modules 丢失时）

```cmd
npm install
```

## 访问地址

| 页面 | 地址 |
|------|------|
| 首页 | http://localhost:3000 |
| 登录 | http://localhost:3000/login |
| 注册 | http://localhost:3000/register |
| 学生列表 | http://localhost:3000/students |
| 志愿上传 | http://localhost:3000/upload |
| 管理后台 | http://localhost:3000/admin |

## 账号信息

| 类型 | 账号 | 密码/验证码 |
|------|------|-------------|
| 管理员 | admin | admin123 |
| 普通用户 | 任意手机号 | 888888（固定验证码） |

## 核心功能

1. **手机号注册/登录**（MVP 固定验证码 888888）
2. **学生信息管理**（分数、位次、民族、体检结论）
3. **志愿草稿上传**（Excel 格式）
4. **智能审单报告**（冲稳保分析、风险标签、SVG 折线图）
5. **管理后台**（用户管理、审核记录统计）

## 注意事项

- `node_modules` 未随项目复制，需要在项目目录执行 `npm install` 安装依赖
- 数据库文件 `gaokao.db` 首次运行会自动创建
- CMD 窗口不能关闭，关闭后服务器停止
