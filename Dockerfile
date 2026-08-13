FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production \
    DATA_DIR=/app/data

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

RUN mkdir -p /app/data

# 健康检查：每30秒检查一次，超时5秒，启动后60秒开始检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${HEALTH_PORT:-3000}/health || exit 1

# 以 root 运行，避免 VPS bind mount 目录权限导致无法写 users.json
# （单机私有 bot 场景可接受；密钥仍只放在 .env / data 中）
VOLUME ["/app/data"]

CMD ["node", "src/index.js"]
