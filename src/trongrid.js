'use strict';

const crypto = require('crypto');
const { maskAddress } = require('./logger');

const USDT_SCALE = 1000000n;
const CHINA_TIME_ZONE = 'Asia/Shanghai';
const CHINA_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;
const CHINA_DATE_TIME_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  timeZone: CHINA_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const TRON_ADDRESS_VERSION = 0x41;
const MAX_RETRY_AFTER_MS = 15000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- TRON 地址校验（Base58Check + 16 进制形式） ----------

function base58Decode(input) {
  if (!input) throw new Error('空输入');
  let value = 0n;
  for (const char of input) {
    const index = BASE58_ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`非法 Base58 字符：${char}`);
    value = value * 58n + BigInt(index);
  }
  const byteLength = Math.ceil(value.toString(16).length / 2) || 1;
  const bytes = Buffer.alloc(byteLength);
  let v = value;
  for (let i = byteLength - 1; i >= 0; i--) {
    bytes[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  // 前导 '1'（值为 0）需要补 0x00
  const leadingZeros = (input.match(/^1+/) || [''])[0].length;
  return Buffer.concat([Buffer.alloc(leadingZeros), bytes]);
}

function sha256Double(data) {
  return crypto
    .createHash('sha256')
    .update(crypto.createHash('sha256').update(data).digest())
    .digest();
}

function isValidTronAddress(address) {
  if (typeof address !== 'string') return false;
  const value = address.trim();
  if (value.length === 0) return false;
  // 16 进制形式：41 + 40 hex（无校验和）
  if (/^41[0-9a-fA-F]{40}$/.test(value)) return true;
  // Base58 形式：T + 33 字符，共 34 位
  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value)) {
    try {
      const decoded = base58Decode(value);
      if (decoded.length !== 25) return false;
      if (decoded[0] !== TRON_ADDRESS_VERSION) return false;
      const payload = decoded.subarray(0, 21);
      const checksum = decoded.subarray(21);
      const hash = sha256Double(payload);
      return (
        hash[0] === checksum[0] &&
        hash[1] === checksum[1] &&
        hash[2] === checksum[2] &&
        hash[3] === checksum[3]
      );
    } catch {
      return false;
    }
  }
  return false;
}

// ---------- 时间与金额 ----------

function getChinaMonthRange(year, month) {
  const start = Date.UTC(year, month - 1, 1) - CHINA_UTC_OFFSET_MS;
  const endExclusive = Date.UTC(year, month, 1) - CHINA_UTC_OFFSET_MS;
  return { start, endExclusive };
}

function getCurrentChinaYearMonth(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: CHINA_TIME_ZONE,
      year: 'numeric',
      month: 'numeric',
    })
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)])
  );
  return { year: parts.year, month: parts.month };
}

/** 今年 1 月 1 日 00:00（北京时间）到指定时刻（默认现在）的查询范围 */
function getYearToDateRange(now = Date.now()) {
  const { year } = getCurrentChinaYearMonth(new Date(now));
  const start = Date.UTC(year, 0, 1) - CHINA_UTC_OFFSET_MS;
  return { year, start, endExclusive: now };
}

function formatUsdt(microUnits) {
  const negative = microUnits < 0n;
  const absolute = negative ? -microUnits : microUnits;
  return `${negative ? '-' : ''}${absolute / USDT_SCALE}.${(absolute % USDT_SCALE)
    .toString()
    .padStart(6, '0')}`;
}

const NO_KEY_HINT =
  '\n提示：您可前往 https://www.trongrid.io/ 注册免费账号，获取免费 API Key 后重试。';

function formatRequestError(error, { noKeyHint = false } = {}) {
  const hint = noKeyHint ? NO_KEY_HINT : '';
  if (error?.status === 401 || error?.status === 403) {
    return (
      (noKeyHint
        ? '访问被拒绝，公共接口可能需要注册。'
        : 'API Key 无效或无权访问（请确认未带 <> 引号，并在 TronGrid 控制台复制完整 Key）') + hint
    );
  }
  if (error?.status === 429) {
    return (
      (noKeyHint ? '当前公共查询接口已限流。' : '请求过于频繁，重试后仍被限流') + hint
    );
  }
  if (error?.status >= 500) return `TronGrid 服务异常（HTTP ${error.status}）`;
  if (error?.code === 'TIMEOUT') return '请求超时，自动重试后仍未成功';
  if (error?.status) return `请求失败（HTTP ${error.status}）`;
  return `网络或接口异常（${error?.message || '未知错误'}）`;
}

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

// ---------- HTTP ----------

async function fetchJson(url, { headers = {}, timeout = 15000, retries = 2 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json', ...headers },
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.status = response.status;
        if (response.status === 429) {
          const retryAfter = Number.parseInt(response.headers.get('retry-after') || '', 10);
          if (Number.isFinite(retryAfter)) {
            error.retryAfterMs = Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS);
          }
        }
        throw error;
      }
      return await response.json();
    } catch (error) {
      lastError =
        error.name === 'AbortError'
          ? Object.assign(new Error('请求超时'), { code: 'TIMEOUT' })
          : error;
      const retryable =
        !Number.isInteger(lastError.status) || lastError.status === 429 || lastError.status >= 500;
      if (attempt === retries || !retryable) throw lastError;
      const backoff =
        lastError.status === 429 && lastError.retryAfterMs
          ? lastError.retryAfterMs
          : 500 * 2 ** attempt + Math.random() * 250;
      await delay(backoff);
    } finally {
      clearTimeout(timeoutId);
    }
  }
  throw lastError;
}

async function fetchAllTransactions(url, apiKey, options = {}) {
  const transactions = [];
  let nextUrl = url;
  const seen = new Set();
  const maxPages = options.maxPages ?? 100;
  let pageCount = 0;
  let truncated = false;
  while (nextUrl && !seen.has(nextUrl)) {
    if (pageCount >= maxPages) {
      truncated = true;
      break;
    }
    seen.add(nextUrl);
    pageCount += 1;
    // 未配置 API Key 时不发送请求头（使用公共接口，有限流）
    const headers = apiKey ? { 'TRON-PRO-API-KEY': apiKey } : {};
    const response = await fetchJson(nextUrl, {
      headers,
      timeout: options.timeout,
      retries: options.retries,
    });
    if (response?.success === false) {
      throw new Error(response.error || 'TronGrid 返回查询失败');
    }
    transactions.push(...(response?.data || []));
    const next = response?.meta?.links?.next;
    nextUrl = next ? new URL(next, 'https://api.trongrid.io').href : null;
  }
  return { transactions, truncated };
}

async function mapWithConcurrency(items, limit, worker) {
  let nextIndex = 0;
  async function run() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

async function fetchUsdtCnyRate(url, options = {}) {
  const response = await fetchJson(url, {
    timeout: options.timeout || 10000,
    retries: options.retries,
  });
  const rate = Number.parseFloat(response?.tether?.cny);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('Invalid USDT/CNY rate');
  return rate;
}

async function queryIncomeRange({
  wallets,
  apiKey,
  excludeSelf,
  usdtContract,
  apiBase,
  concurrency,
  timeout,
  retries,
  maxPages = 100,
  maxRecords = 100000,
  totalTimeoutMs = 0,
  onProgress,
  logger,
  start,
  endExclusive,
}) {
  const ownAddresses = new Set(wallets.map((item) => item.address));
  const contractLower = String(usdtContract).toLowerCase();
  const records = [];
  const errors = [];
  const warnings = [];
  const seenKeys = new Set();
  let deduped = 0;
  let skipped = 0;
  let completed = 0;
  let recordLimitReached = false;
  const deadline = totalTimeoutMs > 0 ? Date.now() + totalTimeoutMs : 0;

  await mapWithConcurrency(wallets, concurrency, async (wallet) => {
    if (recordLimitReached || (deadline > 0 && Date.now() > deadline)) {
      skipped += 1;
      completed += 1;
      if (onProgress) onProgress(completed, wallets.length);
      return;
    }
    try {
      const params = new URLSearchParams({
        contract_address: usdtContract,
        only_confirmed: 'true',
        only_to: 'true',
        limit: '200',
        min_timestamp: String(start),
        max_timestamp: String(endExclusive - 1),
      });
      const { transactions, truncated } = await fetchAllTransactions(
        `${apiBase}${encodeURIComponent(wallet.address)}/transactions/trc20?${params}`,
        apiKey,
        { timeout, retries, maxPages }
      );
      if (truncated) {
        warnings.push(`地址 ${maskAddress(wallet.address)} 页数超过 ${maxPages}，结果可能不完整`);
      }
      transactions.forEach((transaction) => {
        if (recordLimitReached) return;
        // 校验合约地址
        const tokenAddress = String(transaction?.token_info?.address || '').toLowerCase();
        if (tokenAddress !== contractLower) return;
        // 校验收款地址（only_to 之外的防御性校验）
        if (String(transaction?.to || '') !== wallet.address) return;
        // 校验时间范围
        const timestamp = Number(transaction?.block_timestamp);
        if (!Number.isFinite(timestamp) || timestamp < start || timestamp >= endExclusive) return;
        // 校验金额格式
        let amountMicros;
        try {
          amountMicros = BigInt(transaction.value);
        } catch {
          warnings.push(
            `地址 ${maskAddress(wallet.address)} 有条交易金额格式无效（${transaction.transaction_id || '未知 id'}），已忽略`
          );
          return;
        }
        if (amountMicros < 0n) return;
        // 排除自有地址互转
        if (excludeSelf && ownAddresses.has(String(transaction?.from || ''))) return;
        // 按 交易ID + 收款地址 + 金额 去重
        const dedupKey = `${transaction.transaction_id}|${transaction.to}|${transaction.value}`;
        if (seenKeys.has(dedupKey)) {
          deduped += 1;
          return;
        }
        seenKeys.add(dedupKey);
        if (maxRecords > 0 && records.length >= maxRecords) {
          recordLimitReached = true;
          return;
        }
        records.push({
          label: wallet.label,
          address: wallet.address,
          from: String(transaction?.from || ''),
          amountMicros,
          timestamp,
          time: CHINA_DATE_TIME_FORMATTER.format(new Date(timestamp)),
        });
      });
    } catch (error) {
      if (logger) {
        logger.warn('query.address.failed', {
          address: maskAddress(wallet.address),
          status: error.status,
          code: error.code,
          error: error.message,
        });
      }
      errors.push(
        `地址 ${maskAddress(wallet.address)} 查询失败：${formatRequestError(error, { noKeyHint: !apiKey })}`
      );
    } finally {
      completed += 1;
      if (onProgress) onProgress(completed, wallets.length);
    }
  });

  if (skipped > 0) {
    warnings.push(`有 ${skipped} 个地址因超时或记录数上限未查询，结果可能不完整`);
  }
  if (recordLimitReached) {
    warnings.push(`已达最大记录数 ${maxRecords}，结果可能不完整`);
  }
  records.sort((a, b) => a.timestamp - b.timestamp);
  const totalMicros = records.reduce((sum, item) => sum + item.amountMicros, 0n);
  return {
    records,
    errors,
    warnings,
    deduped,
    totalMicros,
    totalText: formatUsdt(totalMicros),
  };
}

/** 按月份查询（北京时间某月 1 日 00:00 至下月 1 日 00:00） */
async function queryMonthIncome(options) {
  const { start, endExclusive } = getChinaMonthRange(options.year, options.month);
  return queryIncomeRange({ ...options, start, endExclusive });
}

/** 今年至今：当年 1 月 1 日 00:00（北京时间）到当前时刻，跨年自动从新一年 1 月 1 日起算 */
async function queryYearToDate(options) {
  const { start, endExclusive } = getYearToDateRange();
  return queryIncomeRange({ ...options, start, endExclusive });
}

// ---------- 展示 ----------

function buildCsv(records, year, month, suffix) {
  const rows = [['标签', '收款地址', '付款地址', '金额 (USDT)', '时间']];
  records.forEach((item) => {
    rows.push([item.label, item.address, item.from, formatUsdt(item.amountMicros), item.time]);
  });
  const csv = `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}`;
  const part = suffix !== undefined ? suffix : String(month).padStart(2, '0');
  const filename = `usdt_income_${year}-${part}.csv`;
  return { csv, filename };
}

function summarizeRecords(records, totalMicros, rate, title, exportHint = '') {
  const totalCny = (Number(totalMicros) / 1e6) * rate;
  let text = [
    `📊 ${title} 收入汇总（北京时间）`,
    `合计：${formatUsdt(totalMicros)} USDT`,
    `约合：¥${totalCny.toFixed(2)}`,
    `笔数：${records.length}`,
  ].join('\n');

  if (!records.length) {
    text += '\n\n未找到 USDT 入账记录。';
    return text;
  }

  const preview = records.slice(0, 15);
  text += '\n\n明细预览（最多 15 条）：\n';
  preview.forEach((item, index) => {
    text += `${index + 1}. ${item.time} | ${formatUsdt(item.amountMicros)} USDT | ${item.from.slice(0, 6)}… → ${item.label}\n`;
  });
  if (records.length > 15) {
    text += `\n… 另有 ${records.length - 15} 条未展示。`;
    if (exportHint) text += ` ${exportHint}`;
  }
  return text;
}

// ---------- API Key 连通性探测（复用统一配置，不再硬编码 URL） ----------

async function probeApiKey(apiKey, { apiBase, timeout = 15000 } = {}) {
  const base = String(apiBase || 'https://api.trongrid.io/v1/accounts/').replace(/\/+$/, '') + '/';
  const probeUrl = `${base}T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb/transactions/trc20?limit=1`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(probeUrl, {
      headers: { Accept: 'application/json', 'TRON-PRO-API-KEY': apiKey },
      signal: controller.signal,
    });
    if (response.ok) return '连通性检测：通过';
    if (response.status === 401 || response.status === 403) {
      return '连通性检测：失败（401/403）。请核对 Key。';
    }
    return `连通性检测：HTTP ${response.status}（可再试查询）`;
  } catch (error) {
    return `连通性检测：网络异常（${error.message || error}）`;
  } finally {
    clearTimeout(timeoutId);
  }
}

module.exports = {
  isValidTronAddress,
  base58Decode,
  getChinaMonthRange,
  getYearToDateRange,
  getCurrentChinaYearMonth,
  formatUsdt,
  formatRequestError,
  fetchJson,
  fetchAllTransactions,
  fetchUsdtCnyRate,
  queryIncomeRange,
  queryMonthIncome,
  queryYearToDate,
  probeApiKey,
  buildCsv,
  summarizeRecords,
};
