#!/bin/bash
# TravelAA 一键部署脚本（PM2 方式）
#
# ⚠️ 重要：server/app.js 顶层 require 了跨目录的共享算法内核
#       ../apps/miniprogram/utils/ai
#       ../apps/miniprogram/utils/ctrip
#    因此**不能只上传 server/ 目录**，必须保持 apps/ 与 server/ 的兄弟层级。
#
#    正确的上传方式（在项目根目录执行）：
#      tar czf - server apps | ssh root@<服务器IP> "mkdir -p /opt/travel-aa && tar xzf - -C /opt/travel-aa"
#      ssh root@<服务器IP> "cd /opt/travel-aa/server && bash deploy.sh"
#
#    如果只 `scp -r server/ ...`（旧文档的写法），后端启动会直接 MODULE_NOT_FOUND。
#
# 使用方法: 在 <root>/server 目录下执行
#   bash deploy.sh

set -e

echo "🚀 TravelAA 部署脚本"
echo "========================"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# 0. 前置检查：共享内核必须在隔壁（这是最容易踩的坑）
echo -e "${YELLOW}[0/5] 检查共享内核是否存在...${NC}"
if [ ! -f "../apps/miniprogram/utils/ai.js" ] || [ ! -f "../apps/miniprogram/utils/ctrip.js" ]; then
    echo -e "${RED}❌ 找不到 ../apps/miniprogram/utils/{ai,ctrip}.js${NC}"
    echo "   server/app.js 依赖这份跨目录的共享内核，缺了它后端无法启动。"
    echo "   请把整个项目（server/ 与 apps/ 保持兄弟层级）一起上传，而不是只传 server/。"
    exit 1
fi
echo -e "✅ 共享内核就位：../apps/miniprogram/utils/ai.js"

# 1. 检查 Node.js（要求 ≥ 20.19，jsdom 与 better-sqlite3 都不支持 18）
echo -e "${YELLOW}[1/5] 检查 Node.js...${NC}"
NEED_MAJOR=20
if command -v node &> /dev/null; then
    CUR=$(node -v | sed 's/v//' | cut -d. -f1)
    if [ "$CUR" -lt "$NEED_MAJOR" ]; then
        echo -e "${RED}❌ 当前 Node $(node -v) 过低，需要 ≥ ${NEED_MAJOR}（推荐 22 LTS）${NC}"
        echo "   原因：better-sqlite3 12.x 与 jsdom 29.x 都不支持 Node 18。"
        exit 1
    fi
    echo -e "✅ Node.js $(node -v)"
else
    echo "Node.js 未安装，正在安装 Node 22..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
    echo -e "✅ Node.js $(node -v)"
fi

# 2. 安装依赖（npm ci 可复现；--omit=dev 取代已废弃的 --production）
echo -e "${YELLOW}[2/5] 安装依赖...${NC}"
if [ -f package-lock.json ]; then
    npm ci --omit=dev
else
    echo "（无 package-lock.json，退回 npm install）"
    npm install --omit=dev
fi
echo -e "✅ 依赖安装完成"

# 3. 创建运行目录（ecosystem.config.js 的日志路径依赖 logs/）
echo -e "${YELLOW}[3/5] 初始化目录...${NC}"
mkdir -p data logs
echo -e "✅ 目录创建完成（data/ 与 logs/）"

# 4. 配置 PM2
echo -e "${YELLOW}[4/5] 配置 PM2...${NC}"
if ! command -v pm2 &> /dev/null; then
    sudo npm install -g pm2
fi
pm2 delete travel-aa 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save
pm2 startup || true
echo -e "✅ PM2 配置完成"

# 5. 防火墙
echo -e "${YELLOW}[5/5] 配置防火墙...${NC}"
sudo ufw allow 3000/tcp 2>/dev/null || true
sudo ufw allow 80/tcp 2>/dev/null || true
sudo ufw allow 443/tcp 2>/dev/null || true

echo ""
echo -e "${GREEN}🎉 部署完成！${NC}"
echo "========================"
echo "🏥 健康检查: curl http://localhost:3000/api/health"
echo "📊 查看日志: pm2 logs travel-aa"
echo "🔄 重启服务: pm2 restart travel-aa"
echo ""
echo "💡 提示：建议配置 Nginx 反代 + SSL 证书（配置文件：nginx.conf）"
