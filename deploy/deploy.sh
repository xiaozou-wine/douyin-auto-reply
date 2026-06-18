#!/bin/bash
# 抖音私信服务 — Linux 一键部署脚本（systemd 版）
# 用法: sudo bash deploy.sh

set -e

APP_DIR="/opt/douyin-auto-reply"
SERVICE_NAME="douyin-auto-reply"
NODE_MIN_VERSION=20

echo "=== 抖音私信服务部署 ==="

# 1. 检查 Node.js
if ! command -v node &>/dev/null; then
  echo "❌ 未检测到 Node.js，先安装 Node.js ${NODE_MIN_VERSION}+"
  echo "   推荐: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash - && sudo apt install -y nodejs"
  exit 1
fi

NODE_VER=$(node -v | grep -oP '\d+' | head -1)
if [ "$NODE_VER" -lt "$NODE_MIN_VERSION" ]; then
  echo "❌ Node.js 版本过低 ($(node -v))，需要 ${NODE_MIN_VERSION}+"
  exit 1
fi
echo "✓ Node.js $(node -v)"

# 2. 创建用户和目录
if ! id -u douyin-auto-reply &>/dev/null; then
  sudo useradd --system --shell /usr/sbin/nologin douyin-auto-reply
  echo "✓ 创建系统用户 douyin-auto-reply"
fi

sudo mkdir -p "$APP_DIR"/{data,logs}
echo "✓ 目录就绪: $APP_DIR"

# 3. 复制文件
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
sudo cp "$SCRIPT_DIR/package.json" "$APP_DIR/"
[ -f "$SCRIPT_DIR/pnpm-lock.yaml" ] && sudo cp "$SCRIPT_DIR/pnpm-lock.yaml" "$APP_DIR/"
sudo cp -r "$SCRIPT_DIR/scripts" "$APP_DIR/"

# .env：不覆盖已有配置
if [ ! -f "$APP_DIR/.env" ]; then
  sudo cp "$SCRIPT_DIR/.env.example" "$APP_DIR/.env"
  echo "⚠  请编辑 $APP_DIR/.env 填入 DOUYIN_COOKIE"
fi
echo "✓ 文件复制完成"

# 4. 安装依赖
cd "$APP_DIR"
if command -v pnpm &>/dev/null; then
  sudo -u douyin-auto-reply pnpm install --prod
else
  sudo -u douyin-auto-reply npm install --omit=dev
fi
echo "✓ 依赖安装完成"

# 5. 安装 systemd 服务
sudo cp "$SCRIPT_DIR/deploy/douyin-auto-reply.service" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
echo "✓ systemd 服务已注册"

# 6. 设置权限
sudo chown -R douyin-auto-reply:douyin-auto-reply "$APP_DIR"
echo "✓ 权限设置完成"

# 7. 启动
sudo systemctl start "$SERVICE_NAME"
echo ""
echo "=== 部署完成 ==="
echo ""
echo "管理命令:"
echo "  sudo systemctl status $SERVICE_NAME    # 查看状态"
echo "  sudo journalctl -u $SERVICE_NAME -f    # 实时日志"
echo "  sudo systemctl restart $SERVICE_NAME   # 重启"
echo "  sudo systemctl stop $SERVICE_NAME      # 停止"
