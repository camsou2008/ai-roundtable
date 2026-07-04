# 圆桌 · Multi-AI Discussion Room

一个由你主持、多人多 AI 共同参与的实时聊天室。支持密码认证、邀请码注册、WebSocket 实时消息、AI Agent 拖拽添加，以及 Agent 间交叉讨论。

## 功能

### 🔐 用户系统
- 密码登录 / 邀请码注册
- 管理员可生成邀请链接，一键分享
- 管理员可管理用户、分配角色（管理员 / 成员）、重置密码
- 管理员可分配用户可访问的房间

### 🏠 多房间
- 所有用户均可创建房间
- 管理员看到所有房间，普通用户只能看到分配的房间
- 创建房间时可同时勾选添加 AI Agent

### 🤖 AI Agent
- 添加 Codex / Hermes 等 AI Agent 到房间
- 支持拖拽添加（管理后台）或勾选添加（聊天室）
- 发消息时 `@全体`、`@Codex`、`@Hermes` 触发对应 Agent 回复
- **交叉讨论**：Agent 回复后出现「让他们互相回应」按钮，让 Agent 互相阅读并回应对方观点

### 💬 实时聊天
- WebSocket 实时消息推送
- 在线用户可见
- 消息持久化（SQLite），切换房间不丢失

### 🛠️ 管理后台
- 房间管理（创建 / 删除）
- AI Agent 管理（拖拽添加到房间）
- 用户管理（升降权限、分配房间、重置密码）
- 邀请码管理（生成 / 删除）

## 快速开始

### 前提条件

- Node.js >= 18
- （可选）[Codex CLI](https://github.com/openai/codex) - 通过 npm 安装
- （可选）Hermes Agent - 已随项目环境安装

### 安装与运行

```bash
# 安装依赖
npm install

# 启动服务
npm start
```

浏览器打开 http://127.0.0.1:4173

### 默认管理员

```
用户名：admin
密码：admin123
```

首次登录后请立即修改密码。

## 使用流程

### 1. 管理员初始化

1. 登录 `admin / admin123` → 自动进入管理后台
2. **生成邀请码** → 点「🔑 邀请码」→ 「＋ 生成邀请码」
3. **添加 AI Agent** → 点「🤖 AI Agent 管理」→ 将 Codex / Hermes 拖拽到房间
4. **创建房间** → 点「🏠 房间管理」→ 「＋ 创建房间」

### 2. 邀请用户

把生成的注册链接发给朋友，例如：
```
http://localhost:4173/login?code=ABC1234D
```
对方打开链接，邀请码自动填入，设置密码即可注册。

### 3. 开始讨论

进入聊天室 → 选择房间 → 发消息 `@全体` 或 `@Codex` / `@Hermes` → Agent 自动回复 → 点「让他们互相回应」触发交叉讨论

## 公网访问

使用 ngrok 将本地服务暴露到公网：

```bash
ngrok http 4173
```

免费版首次访问会显示警告页，点「Visit Site」即可。

## 项目结构

```
ai-roundtable/
├── server.mjs           # HTTP + API 路由
├── db.mjs               # SQLite 数据层
├── auth.mjs             # 密码 / Session / 邀请码
├── agent-runner.mjs     # AI Agent CLI 调用
├── ws.mjs               # WebSocket 消息路由
├── public/
│   ├── login.html       # 登录 / 注册页
│   ├── chat.html        # 聊天室主界面
│   ├── admin.html       # 管理后台
│   └── styles.css       # 统一样式
├── test/
│   └── server.test.mjs  # 单元测试
└── package.json
```

## 技术栈

- **后端**：Node.js (原生 http + ESM)
- **数据库**：SQLite (better-sqlite3)
- **实时通信**：WebSocket (ws)
- **前端**：原生 HTML / CSS / JavaScript
- **认证**：Cookie Session + scrypt 密码哈希
- **Agent**：通过 CLI 子进程调用 Codex / Hermes

## 安全边界

- 密码使用 scrypt 加盐哈希存储
- Session 使用随机 UUID，HttpOnly Cookie
- 用户只能看到自己被分配的房间
- 管理员不能删除自己
- Agent 以只读 sandbox 运行
- 本地数据库不提交到仓库（.gitignore）
