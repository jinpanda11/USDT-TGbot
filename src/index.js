'use strict';

const http = require('http');
const config = require('./config');
const { Storage } = require('./storage');
const { AdService } = require('./ad-service');
const { createBot } = require('./bot');
const { Logger } = require('./logger');

async function main() {
  const logger = new Logger(config.logLevel);
  const storage = new Storage(config.dataDir, { logger });
  const adService = new AdService({
    adsFile: config.adsFile,
    eventsFile: config.adEventsFile,
    logger,
    enabled: config.adsEnabled,
    showRatio: config.adShowRatio,
  });
  const bot = createBot(config, storage, adService);

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

  // 未捕获异常兜底：记录后优雅退出
  process.once('uncaughtException', (error) => {
    logger.error('uncaughtException', {
      error: error.message,
      stack: error.stack,
    });
    stop('uncaughtException').catch(() => process.exit(1));
  });

  process.once('unhandledRejection', (reason) => {
    logger.error('unhandledRejection', {
      reason: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
    stop('unhandledRejection').catch(() => process.exit(1));
  });

  await bot.launch();
  logger.info('bot.launched', {});

  // 设置「M」菜单按钮：命令收进输入框左侧的菜单，/start 或 /menu 才弹出按钮键盘
  try {
    await bot.telegram.setMyCommands([
      { command: 'query', description: '查询本月收入' },
      { command: 'export', description: '导出本月 CSV' },
      { command: 'temp', description: '临时查询某地址' },
      { command: 'menu', description: '打开按钮菜单' },
      { command: 'list', description: '查看地址列表' },
      { command: 'add', description: '添加地址' },
      { command: 'setkey', description: '设置 API Key' },
      { command: 'rate', description: '设置汇率' },
      { command: 'exclude', description: '排除自转开关' },
      { command: 'help', description: '帮助' },
    ]);
    await bot.telegram.setChatMenuButton({ type: 'commands', text: '📋 菜单' });
    logger.info('menu.configured', {});
  } catch (error) {
    logger.warn('menu.setup.failed', { error: error.message });
  }

  console.log('USDT 收入分析 Bot 已启动（long polling）');
}

main().catch((error) => {
  console.error('启动失败', error.message || error);
  process.exit(1);
});
