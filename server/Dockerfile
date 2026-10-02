FROM node:18-alpine

WORKDIR /app

# 只复制package文件，利用Docker缓存
COPY package*.json ./
RUN npm install --production

# 复制源代码
COPY . .

# 创建数据目录
RUN mkdir -p /app/data

# 暴露端口
EXPOSE 3000

# 启动命令
CMD ["node", "app.js"]
