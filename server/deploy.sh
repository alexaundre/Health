#!/bin/bash
# 一键部署脚本 - 在阿里云 Ubuntu 服务器上以 root 运行
# 用法: curl -fsSL https://raw.githubusercontent.com/alexaundre/Health/main/server/deploy.sh | bash
# 或者: git clone 后 sudo bash server/deploy.sh

set -e

REPO_URL="https://github.com/alexaundre/Health.git"
APP_DIR="/opt/health-sync"
WWW_DIR="/var/www/health"
SYNC_DOMAIN="sync.futurus.fit"
APP_DOMAIN="app.futurus.fit"

if [ "$EUID" -ne 0 ]; then
  echo "请用 root 或 sudo 运行"
  exit 1
fi

echo "=== 1. 安装系统依赖 ==="
apt-get update
apt-get install -y curl git build-essential debian-keyring debian-archive-keyring apt-transport-https

echo "=== 2. 安装 Node.js 20 LTS ==="
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node -v

echo "=== 3. 安装 Caddy ==="
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi
caddy version

echo "=== 4. 创建 health 用户 ==="
if ! id health >/dev/null 2>&1; then
  useradd -r -s /bin/false -d "$APP_DIR" health
fi

echo "=== 5. 拉取代码 ==="
if [ -d "$APP_DIR/.git" ]; then
  cd "$APP_DIR" && git pull
else
  rm -rf "$APP_DIR"
  git clone "$REPO_URL" "$APP_DIR"
fi
mkdir -p "$APP_DIR/data" "$WWW_DIR" /var/log/caddy

echo "=== 6. 安装 Node 依赖 ==="
cd "$APP_DIR/server"
npm install --omit=dev

echo "=== 7. 部署前端到 $WWW_DIR ==="
cp "$APP_DIR/index.html" "$WWW_DIR/index.html"

echo "=== 8. 设置文件权限 ==="
chown -R health:health "$APP_DIR"
chown -R caddy:caddy "$WWW_DIR" 2>/dev/null || chown -R www-data:www-data "$WWW_DIR" 2>/dev/null || true

echo "=== 9. 安装 systemd 服务 ==="
cp "$APP_DIR/server/health-sync.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable health-sync
systemctl restart health-sync
sleep 2
systemctl status health-sync --no-pager | head -10

echo "=== 10. 配置 Caddy ==="
cp "$APP_DIR/server/Caddyfile" /etc/caddy/Caddyfile
systemctl restart caddy
sleep 2
systemctl status caddy --no-pager | head -10

echo ""
echo "==========================================="
echo "✓ 部署完成"
echo ""
echo "后端 API: https://$SYNC_DOMAIN"
echo "前端 App: https://$APP_DOMAIN"
echo ""
echo "请确认 DNS 已配置:"
echo "  $SYNC_DOMAIN  A  <服务器公网IP>"
echo "  $APP_DOMAIN   A  <服务器公网IP>"
echo ""
echo "测试: curl https://$SYNC_DOMAIN/api/health"
echo "==========================================="
