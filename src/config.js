'use strict';

const path = require('path');

require('dotenv').config();

function required(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new Error(`缺少环境变量 ${name}`);
  }
  return String(value).trim();
}

function readInt(name, defaultValue, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return defaultValue;
  const value = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`环境变量 ${name} 值无效：${JSON.stringify(String(raw))}（应为 ${min}-${max} 的整数）`);
  }
  return value;
}

function readNumber(name, defaultValue, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return defaultValue;
  const value = Number.parseFloat(String(raw));
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`环境变量 ${name} 值无效：${JSON.stringify(String(raw))}（应为 ${min}-${max} 的数字）`);
  }
  return value;
}

function readBool(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return defaultValue;
  const value = String(raw).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(value)) return true;
  if (['false', '0', 'no', 'off'].includes(value)) return false;
  throw new Error(`环境变量 ${name} 值无效：${JSON.stringify(String(raw))}（应为 true/false）`);
}

/** 逗号分隔的用户 ID 列表；空值返回 []（= 不限制） */
function readUserIdCsv(name) {
  const raw = process.env[name];
  if (!raw || !String(raw).trim()) return [];
  const ids = [];
  for (const part of String(raw).split(',')) {
    const item = part.trim();
    if (!item) continue;
    const id = Number.parseInt(item, 10);
    if (!Number.isInteger(id) || String(id) !== item) {
      throw new Error(`环境变量 ${name} 值无效：${JSON.stringify(item)}（应为数字列表）`);
    }
    ids.push(id);
  }
  return ids;
}

const dataDir = process.env.DATA_DIR || './data';

module.exports = {
  telegramBotToken: required('TELEGRAM_BOT_TOKEN'),
  dataDir,
  defaultTronGridApiKey: (process.env.TRONGRID_API_KEY || '').trim(),
  defaultUsdtCnyRate: readNumber('DEFAULT_USDT_CNY_RATE', 7.2, 0.000001, 100000),
  addressConcurrency: readInt('ADDRESS_CONCURRENCY', 3, 1, 20),
  requestTimeoutMs: readInt('REQUEST_TIMEOUT_MS', 15000, 1000, 120000),
  maxRequestRetries: readInt('MAX_REQUEST_RETRIES', 2, 0, 5),
  usdtContract: process.env.USDT_CONTRACT || 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  trongridApiBase: process.env.TRONGRID_API_BASE || 'https://api.trongrid.io/v1/accounts/',
  coingeckoRateUrl:
    process.env.COINGECKO_RATE_URL ||
    'https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=cny',
  // 访问控制
  allowedUserIds: readUserIdCsv('ALLOWED_TELEGRAM_USER_IDS'),
  requirePrivateChat: readBool('REQUIRE_PRIVATE_CHAT', true),
  // 广告管理员（仅这些 ID 可执行 /ad_* 管理命令）
  adminUserIds: readUserIdCsv('ADMIN_TELEGRAM_USER_IDS'),
  // 查询限流与资源上限
  globalQueryConcurrency: readInt('GLOBAL_QUERY_CONCURRENCY', 2, 1, 20),
  maxQueriesPerUserPerMin: readInt('MAX_QUERIES_PER_USER_PER_MIN', 5, 0, 60),
  queryCacheTtlMs: readInt('QUERY_CACHE_TTL_MS', 60000, 0, 3600000),
  maxPagesPerAddress: readInt('MAX_PAGES_PER_ADDRESS', 100, 1, 1000),
  maxRecordsPerQuery: readInt('MAX_RECORDS_PER_QUERY', 100000, 1000, 500000),
  queryTotalTimeoutMs: readInt('QUERY_TOTAL_TIMEOUT_MS', 300000, 30000, 3600000),
  sessionTtlMs: readInt('SESSION_TTL_MS', 1800000, 60000, 86400000),
  watchPollIntervalMs: readInt('WATCH_POLL_INTERVAL_MS', 60000, 10000, 3600000),
  logLevel: (process.env.LOG_LEVEL || 'info').trim().toLowerCase(),
  healthPort: readInt('HEALTH_PORT', 0, 0, 65535),
  // 广告（阶段 A：查询结果赞助位）
  adsEnabled: readBool('ADS_ENABLED', false),
  adsFile: path.resolve(process.env.ADS_FILE || path.join(dataDir, 'ads.json')),
  adEventsFile: path.resolve(process.env.AD_EVENTS_FILE || path.join(dataDir, 'ad-events.jsonl')),
  adShowRatio: readNumber('AD_SHOW_RATIO', 1, 0, 1),
  // 供测试使用的读取工具
  _helpers: { required, readInt, readNumber, readBool, readUserIdCsv },
};
