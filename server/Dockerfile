FROM node:22-alpine

WORKDIR /app

# ============================================================
# ⚠️ 构建上下文必须是**项目根目录**（不是 server/）
#    server/app.js 顶层无条件 require 了跨目录的共享内核：
#      require('../apps/miniprogram/utils/ai')
#      require('../apps/miniprogram/utils/ctrip')
#    因此镜像内必须保持 <root>/server 与 <root>/apps 的**兄弟层级**。
#    构建方式（在项目根目录执行）：
#      docker build -f server/Dockerfile -t travel-aa .
#    或直接用 server/docker-compose.yml（其中 context 已改为 ..）
#    旧的 `build: .` + `COPY . .`（上下文=server/）会让容器启动即
#    MODULE_NOT_FOUND —— 这条已实测复现过。
# ============================================================

# 先装依赖，利用 Docker 缓存
COPY server/package*.json ./
# npm ci 可复现（锁定 lock 文件）；--omit=dev 取代已废弃的 --production
RUN npm ci --omit=dev

# 复制后端源码
COPY server/ ./
# 复制共享算法内核（三端复用同一份 ai.js / ctrip.js / settle.js）
COPY apps/ /apps/

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "app.js"]
