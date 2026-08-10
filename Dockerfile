FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production \
    DATA_DIR=/app/data

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

RUN mkdir -p /app/data && chown -R node:node /app
USER node

VOLUME ["/app/data"]

CMD ["node", "src/index.js"]
