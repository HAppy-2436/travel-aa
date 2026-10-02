#!/bin/bash
# TravelAA 一键部署脚本
# 使用方法: bash deploy.sh

echo "🚀 TravelAA 部署脚本"
echo "========================"

# 颜色
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# 1. 检查Node.js
echo -e "${YELLOW}[1/5] 检查 Node.js...${NC}"
if ! command -v node &> /dev/null; then
    echo "❌ Node.js 未安装，正在安装..."
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi
echo -e "✅ Node.js $(node -v)"

# 2. 安装依赖
echo -e "${YELLOW}[2/5] 安装依赖...${NC}"
npm install --production
echo -e "✅ 依赖安装完成"

# 3. 创建数据目录
echo -e "${YELLOW}[3/5] 初始化目录...${NC}"
mkdir -p data logs
echo -e "✅ 目录创建完成"

# 4. 安装PM2
echo -e "${YELLOW}[4/5] 配置 PM2...${NC}"
if ! command -v pm2 &> /dev/null; then
    sudo npm install -g pm2
fi
pm2 delete travel-aa 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save
pm2 startup
echo -e "✅ PM2 配置完成"

# 5. 配置防火墙
echo -e "${YELLOW}[5/5] 配置防火墙...${NC}"
sudo ufw allow 3000/tcp 2>/dev/null || true
sudo ufw allow 80/tcp 2>/dev/null || true
sudo ufw allow 443/tcp 2>/dev/null || true

echo ""
echo -e "${GREEN}🎉 部署完成！${NC}"
echo "========================"
echo "📍 API 地址: http://$(curl -s ifconfig.me):3000"
echo "🏥 健康检查: http://$(curl -s ifconfig.me):3000/api/health"
echo "📊 查看日志: pm2 logs travel-aa"
echo "🔄 重启服务: pm2 restart travel-aa"
echo ""
echo "💡 提示：建议配置 Nginx 反代 + SSL 证书"
echo "   配置文件: nginx.conf"
