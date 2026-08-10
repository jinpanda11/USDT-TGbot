'use strict';

const config = require('./config');
const { Storage } = require('./storage');
const { createBot } = require('./bot');

async function main() {
  const storage = new Storage(config.dataDir);
  const bot = createBot(config, storage);

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));

  await bot.launch();
  console.log('USDT 收入分析 Bot 已启动（long polling）');
}

main().catch((error) => {
  console.error('启动失败', error);
  process.exit(1);
});
