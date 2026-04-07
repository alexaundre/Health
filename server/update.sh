#!/bin/bash
# 更新部署 - 拉取最新代码并重启服务
set -e
cd /opt/health-sync
git pull
cd server
npm install --omit=dev
cp ../index.html /var/www/health/index.html
systemctl restart health-sync
systemctl reload caddy
echo "✓ 更新完成"
systemctl status health-sync --no-pager | head -5
