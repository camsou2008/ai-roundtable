#!/bin/bash
# 圆桌 · 一键启动
# 启动 Node 服务 + ngrok 公网隧道 + 打开浏览器

cd "$(dirname "$0")"

echo "🌀 启动圆桌服务..."

# 1. 启动 Node 服务（后台）
npm start &
NODE_PID=$!
echo "   Node 服务 PID: $NODE_PID"

# 等待服务就绪
sleep 2

# 2. 启动 ngrok 公网隧道（后台）
ngrok http 4173 --log=stdout &
NGROK_PID=$!
echo "   ngrok PID: $NGROK_PID"

# 等待隧道建立
sleep 3

# 3. 获取公网地址
NGROK_URL=$(curl -s http://127.0.0.1:4040/api/tunnels 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['tunnels'][0]['public_url'])" 2>/dev/null)

echo ""
echo "═══════════════════════════════════════"
echo "   ✅ 圆桌已启动！"
echo "   🌐 本地地址： http://127.0.0.1:4173"
if [ -n "$NGROK_URL" ]; then
  echo "   🌍 公网地址： $NGROK_URL"
fi
echo "   👤 管理员：   admin / admin123"
echo "═══════════════════════════════════════"
echo ""
echo "按 Ctrl+C 停止所有服务"

# 捕获退出信号
trap "echo ''; echo '🛑 正在关闭服务...'; kill $NODE_PID $NGROK_PID 2>/dev/null; echo '已关闭'; exit" SIGINT SIGTERM

# 等待子进程
wait
