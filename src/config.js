'use strict';

require('dotenv').config();

function required(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new Error(`缺少环境变量 ${name}`);
  }
  return String(value).trim();
}

const dataDir = process.env.DATA_DIR || './data';

module.exports = {
  telegramBotToken: required('TELEGRAM_BOT_TOKEN'),
  dataDir,
  defaultTronGridApiKey: (process.env.TRONGRID_API_KEY || '').trim(),
  defaultUsdtCnyRate: Number.parseFloat(process.env.DEFAULT_USDT_CNY_RATE || '7.20') || 7.2,
  addressConcurrency: Number.parseInt(process.env.ADDRESS_CONCURRENCY || '3', 10) || 3,
  requestTimeoutMs: Number.parseInt(process.env.REQUEST_TIMEOUT_MS || '15000', 10) || 15000,
  maxRequestRetries: Number.parseInt(process.env.MAX_REQUEST_RETRIES || '2', 10) || 2,
  usdtContract: process.env.USDT_CONTRACT || 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  trongridApiBase: process.env.TRONGRID_API_BASE || 'https://api.trongrid.io/v1/accounts/',
  coingeckoRateUrl:
    process.env.COINGECKO_RATE_URL ||
    'https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=cny',
};
