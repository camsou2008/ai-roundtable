# AI Roundtable

一个由你主持、Codex 与 Hermes 共同参与的本地 AI 圆桌聊天室。

## 功能

- Codex 与 Hermes 首轮独立表达，减少互相迎合
- 支持 `@全体`、`@Codex`、`@Hermes` 点名发言
- 保存并续接两个 Agent 的会话
- 一键进入交叉讨论
- 本地保存房间记录
- 桌面端与移动端响应式界面

## 本地运行

前提：本机已经安装并登录 `codex` 与 `hermes`。

```bash
npm start
```

浏览器打开 <http://127.0.0.1:4173>。

运行测试：

```bash
npm test
```

## GitHub Pages

GitHub Pages 提供静态界面预览。由于 Pages 不能访问你电脑上的 Codex 与 Hermes CLI，真实对话功能必须在本机运行。

## 安全边界

- Agent 默认使用纯讨论提示，不要求读取或修改文件
- Codex 以只读 sandbox 运行
- 不启用 `--yolo` 或跳过审批选项
- 仓库不包含本机认证文件、API Key 或会话数据
