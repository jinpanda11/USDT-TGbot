'use strict';

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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isValidTronAddress(address) {
  return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address);
}

function getChinaMonthRange(year, month) {
  const start = Date.UTC(year, month - 1, 1) - CHINA_UTC_OFFSET_MS;
  const endExclusive = Date.UTC(year, month, 1) - CHINA_UTC_OFFSET_MS;
  return { start, endExclusive };
}

function getCurrentChinaYearMonth() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: CHINA_TIME_ZONE,
      year: 'numeric',
      month: 'numeric',
    })
      .formatToParts(new Date())
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)])
  );
  return { year: parts.year, month: parts.month };
}

function formatUsdt(microUnits) {
  const negative = microUnits < 0n;
  const absolute = negative ? -microUnits : microUnits;
  return `${negative ? '-' : ''}${absolute / USDT_SCALE}.${(absolute % USDT_SCALE)
    .toString()
    .padStart(6, '0')}`;
}

function formatRequestError(error) {
  if (error?.status === 401 || error?.status === 403) {
    return 'API Key 无效或无权访问（请确认未带 <> 引号，并在 TronGrid 控制台复制完整 Key）';
  }
  if (error?.status === 429) return '请求过于频繁，重试后仍被限流';
  if (error?.status >= 500) return `TronGrid 服务异常（HTTP ${error.status}）`;
  if (error?.code === 'TIMEOUT') return '请求超时，自动重试后仍未成功';
  if (error?.status) return `请求失败（HTTP ${error.status}）`;
  return `网络或接口异常（${error?.message || '未知错误'}）`;
}

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

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
      await delay(500 * 2 ** attempt + Math.random() * 250);
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
  while (nextUrl && !seen.has(nextUrl)) {
    seen.add(nextUrl);
    const response = await fetchJson(nextUrl, {
      headers: { 'TRON-PRO-API-KEY': apiKey },
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
  return transactions;
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
  const response = await fetchJson(url, { timeout: options.timeout || 10000, retries: options.retries });
  const rate = Number.parseFloat(response?.tether?.cny);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('Invalid USDT/CNY rate');
  return rate;
}

async function queryMonthIncome({
  wallets,
  year,
  month,
  apiKey,
  excludeSelf,
  usdtContract,
  apiBase,
  concurrency,
  timeout,
  retries,
  onProgress,
}) {
  const ownAddresses = new Set(wallets.map((item) => item.address));
  const { start, endExclusive } = getChinaMonthRange(year, month);
  const records = [];
  const errors = [];
  let completed = 0;

  await mapWithConcurrency(wallets, concurrency, async (wallet) => {
    try {
      const params = new URLSearchParams({
        contract_address: usdtContract,
        only_confirmed: 'true',
        only_to: 'true',
        limit: '200',
        min_timestamp: String(start),
        max_timestamp: String(endExclusive - 1),
      });
      const transactions = await fetchAllTransactions(
        `${apiBase}${encodeURIComponent(wallet.address)}/transactions/trc20?${params}`,
        apiKey,
        { timeout, retries }
      );
      transactions.forEach((transaction) => {
        if (excludeSelf && ownAddresses.has(transaction.from)) return;
        const timestamp = Number(transaction.block_timestamp);
        if (!Number.isFinite(timestamp)) return;
        try {
          const amountMicros = BigInt(transaction.value);
          if (amountMicros < 0n) return;
          records.push({
            label: wallet.label,
            address: wallet.address,
            from: String(transaction.from || ''),
            amountMicros,
            timestamp,
            time: CHINA_DATE_TIME_FORMATTER.format(new Date(timestamp)),
          });
        } catch {
          console.warn('忽略金额格式无效的交易', transaction.transaction_id);
        }
      });
    } catch (error) {
      console.error(error);
      errors.push(`地址 ${wallet.address} 查询失败：${formatRequestError(error)}`);
    } finally {
      completed += 1;
      if (onProgress) onProgress(completed, wallets.length);
    }
  });

  records.sort((a, b) => a.timestamp - b.timestamp);
  const totalMicros = records.reduce((sum, item) => sum + item.amountMicros, 0n);
  return { records, errors, totalMicros, totalText: formatUsdt(totalMicros) };
}

function buildCsv(records, year, month) {
  const rows = [['标签', '收款地址', '付款地址', '金额 (USDT)', '时间']];
  records.forEach((item) => {
    rows.push([item.label, item.address, item.from, formatUsdt(item.amountMicros), item.time]);
  });
  const csv = `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}`;
  const filename = `usdt_income_${year}-${String(month).padStart(2, '0')}.csv`;
  return { csv, filename };
}

function summarizeRecords(records, totalText, rate, year, month) {
  const totalCny = Number(totalText) * rate;
  const monthText = `${year}-${String(month).padStart(2, '0')}`;
  let text = [
    `📊 ${monthText} 收入汇总（北京时间）`,
    `合计：${totalText} USDT`,
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
    text += `\n… 另有 ${records.length - 15} 条未展示，可用 /export ${year} ${month} 导出完整 CSV。`;
  }
  return text;
}

module.exports = {
  isValidTronAddress,
  getCurrentChinaYearMonth,
  formatUsdt,
  formatRequestError,
  fetchUsdtCnyRate,
  queryMonthIncome,
  buildCsv,
  summarizeRecords,
};
