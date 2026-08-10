'use strict';

const http = require('http');
const config = require('./config');
const { Storage } = require('./storage');
const { createBot } = require('./bot');
const { Logger } = require('./logger');

async function main() {
  const logger = new Logger(config.logLevel);
  const storage = new Storage(config.dataDir, { logger });
  const bot = createBot(config, storage);

  // 可选健康检查端口（HEALTH_PORT=0 时不启动）
  let healthServer;
  if (config.healthPort > 0) {
    healthServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    });
    await new Promise((resolve, reject) => {
      healthServer.once('error', reject);
      healthServer.listen(config.healthPort, () => resolve());
    });
    logger.info('health.server.start', { port: config.healthPort });
  }

  let stopping = false;
  async function stop(reason) {
    if (stopping) return;
    stopping = true;
    logger.info('shutdown.start', { reason });
    const forceExit = setTimeout(() => {
      logger.error('shutdown.timeout', {});
      process.exit(1);
    }, 10000);
    forceExit.unref();
    try {
      if (healthServer) {
        await new Promise((resolve) => healthServer.close(resolve));
      }
      await bot.stop(reason);
      logger.info('shutdown.done', {});
      process.exit(0);
    } catch (error) {
      logger.error('shutdown.error', { error: error.message });
      process.exit(1);
    }
  }

  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));

  await bot.launch();
  logger.info('bot.launched', {});
  console.log('USDT 收入分析 Bot 已启动（long polling）');
}

main().catch((error) => {
  console.error('启动失败', error.message || error);
  process.exit(1);
});
