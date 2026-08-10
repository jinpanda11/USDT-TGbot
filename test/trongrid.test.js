'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  isValidTronAddress,
  base58Decode,
  getChinaMonthRange,
  formatUsdt,
  formatRequestError,
  fetchJson,
  fetchAllTransactions,
  fetchUsdtCnyRate,
  queryMonthIncome,
  probeApiKey,
  buildCsv,
  summarizeRecords,
} = require('../src/trongrid');

const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const WALLET_A = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
const WALLET_B = 'THpMhA9fLPdbPVFkxpGWcXxyEfsxd1bxeJ';
const API_BASE = 'https://api.trongrid.io/v1/accounts/';

function jsonResponse(body, status = 200, headers = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers)) normalized[key.toLowerCase()] = value;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => normalized[name.toLowerCase()] ?? null },
    json: async () => body,
  };
}

/** 生成一笔 USDT 转入交易（默认收款 WALLET_A，时间在 2026-01 北京时区内） */
function makeTx(overrides = {}) {
  return {
    transaction_id: 'tx-1',
    block_timestamp: Date.UTC(2026, 0, 15, 4), // 2026-01-15 12:00 北京时间
    from: WALLET_B,
    to: WALLET_A,
    value: '1000000',
    token_info: { address: USDT },
    ...overrides,
  };
}

function defaultQueryOptions(overrides = {}) {
  return {
    wallets: [{ label: '钱包A', address: WALLET_A }],
    year: 2026,
    month: 1,
    apiKey: 'test-key',
    excludeSelf: false,
    usdtContract: USDT,
    apiBase: API_BASE,
    concurrency: 2,
    timeout: 5000,
    retries: 0,
    maxPages: 100,
    maxRecords: 100000,
    ...overrides,
  };
}

beforeEach(() => {
  delete globalThis.fetch;
});
afterEach(() => {
  delete globalThis.fetch;
});

// ---------- 地址校验 ----------

test('isValidTronAddress：合法 Base58 地址通过', () => {
  assert.equal(isValidTronAddress(WALLET_A), true);
  assert.equal(isValidTronAddress(WALLET_B), true);
});

test('isValidTronAddress：前后空格被容忍', () => {
  assert.equal(isValidTronAddress(`  ${WALLET_A}  `), true);
});

test('isValidTronAddress：校验和错误失败', () => {
  // 末位字符改动会破坏校验和
  assert.equal(isValidTronAddress(`${WALLET_A.slice(0, -1)}C`), false);
});

test('isValidTronAddress：长度错误失败', () => {
  assert.equal(isValidTronAddress(WALLET_A.slice(0, -1)), false);
  assert.equal(isValidTronAddress(`${WALLET_A}1`), false);
});

test('isValidTronAddress：非法 Base58 字符失败', () => {
  assert.equal(isValidTronAddress(`${WALLET_A.slice(0, -1)}0`), false); // 0
  assert.equal(isValidTronAddress(`${WALLET_A.slice(0, -1)}O`), false); // O
  assert.equal(isValidTronAddress(`${WALLET_A.slice(0, -1)}l`), false); // l
  assert.equal(isValidTronAddress(`${WALLET_A.slice(0, -1)}I`), false); // I
});

test('isValidTronAddress：16 进制形式（41 + 40 hex）通过', () => {
  assert.equal(isValidTronAddress('41E552F6487585C2B58BC2C848BB9E1A6E4D2F8A55'), true);
  assert.equal(isValidTronAddress('41e552f6487585c2b58bc2c848bb9e1a6e4d2f8a55'), true);
  assert.equal(isValidTronAddress('41E552F6487585C2B58BC2C848BB9E1A6E4D2F8A5'), false); // 长度不足
});

test('isValidTronAddress：空值与非字符串失败', () => {
  assert.equal(isValidTronAddress(''), false);
  assert.equal(isValidTronAddress(null), false);
  assert.equal(isValidTronAddress(undefined), false);
  assert.equal(isValidTronAddress(123), false);
});

test('base58Decode：解码结果为 25 字节（1 版本 + 20 地址 + 4 校验和）', () => {
  const decoded = base58Decode(WALLET_A);
  assert.equal(decoded.length, 25);
  assert.equal(decoded[0], 0x41);
});

// ---------- 时间范围 ----------

test('getChinaMonthRange：2026-01 月初/月末为北京时间 00:00', () => {
  const { start, endExclusive } = getChinaMonthRange(2026, 1);
  assert.equal(start, Date.UTC(2025, 11, 31, 16)); // 2026-01-01 00:00 CST
  assert.equal(endExclusive, Date.UTC(2026, 0, 31, 16)); // 2026-02-01 00:00 CST
});

test('getChinaMonthRange：闰年二月月末 29 日', () => {
  const { endExclusive } = getChinaMonthRange(2024, 2);
  assert.equal(endExclusive, Date.UTC(2024, 1, 29, 16)); // 2024-03-01 00:00 CST
});

// ---------- 金额格式化 ----------

test('formatUsdt：微单位格式化', () => {
  assert.equal(formatUsdt(0n), '0.000000');
  assert.equal(formatUsdt(1000000n), '1.000000');
  assert.equal(formatUsdt(123456789n), '123.456789');
  assert.equal(formatUsdt(-1000000n), '-1.000000');
});

// ---------- fetchJson ----------

test('fetchJson：200 返回 JSON', async () => {
  globalThis.fetch = async () => jsonResponse({ ok: true });
  const result = await fetchJson('https://x.test', { retries: 0 });
  assert.deepEqual(result, { ok: true });
});

test('fetchJson：429 带 Retry-After 时重试并按头部延迟', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return jsonResponse({}, 429, { 'retry-after': '1' });
    return jsonResponse({ ok: 1 }, 200);
  };
  const startedAt = Date.now();
  const result = await fetchJson('https://x.test', { retries: 2 });
  assert.equal(result.ok, 1);
  assert.equal(calls, 2);
  assert.ok(Date.now() - startedAt >= 900, '应等待 Retry-After 后再重试');
});

test('fetchJson：5xx 后重试成功', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return jsonResponse({}, 500);
    return jsonResponse({ ok: 1 }, 200);
  };
  const result = await fetchJson('https://x.test', { retries: 2 });
  assert.equal(result.ok, 1);
  assert.equal(calls, 2);
});

test('fetchJson：retries=0 时 500 直接抛错', async () => {
  globalThis.fetch = async () => jsonResponse({}, 500);
  await assert.rejects(fetchJson('https://x.test', { retries: 0 }), (error) => error.status === 500);
});

test('fetchJson：4xx 不重试直接抛错', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse({}, 403);
  };
  await assert.rejects(fetchJson('https://x.test', { retries: 2 }), (error) => error.status === 403);
  assert.equal(calls, 1);
});

test('fetchJson：超时映射为 TIMEOUT', async () => {
  globalThis.fetch = (url, init) =>
    new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
  await assert.rejects(
    fetchJson('https://x.test', { timeout: 10, retries: 0 }),
    (error) => error.code === 'TIMEOUT'
  );
});

// ---------- fetchAllTransactions ----------

test('fetchAllTransactions：多页收集直到缺失 next', async () => {
  const tx1 = makeTx({ transaction_id: 'a' });
  const tx2 = makeTx({ transaction_id: 'b' });
  const routes = {
    'https://api.test/p1': jsonResponse({ data: [tx1], meta: { links: { next: 'https://api.test/p2' } } }),
    'https://api.test/p2': jsonResponse({ data: [tx2], meta: { links: {} } }),
  };
  globalThis.fetch = async (url) => routes[url] || jsonResponse({ data: [] });
  const { transactions, truncated } = await fetchAllTransactions('https://api.test/p1', 'key', {
    timeout: 5000,
    retries: 0,
  });
  assert.equal(transactions.length, 2);
  assert.equal(truncated, false);
});

test('fetchAllTransactions：空页返回空数组', async () => {
  globalThis.fetch = async () => jsonResponse({ data: [], meta: { links: {} } });
  const { transactions, truncated } = await fetchAllTransactions('https://api.test/p1', 'key', {
    timeout: 5000,
    retries: 0,
  });
  assert.deepEqual(transactions, []);
  assert.equal(truncated, false);
});

test('fetchAllTransactions：重复 next 终止，不会死循环', async () => {
  const tx1 = makeTx({ transaction_id: 'a' });
  const route = jsonResponse({ data: [tx1], meta: { links: { next: 'https://api.test/loop' } } });
  const loop = jsonResponse({ data: [tx1], meta: { links: { next: 'https://api.test/loop' } } });
  globalThis.fetch = async (url) => (url === 'https://api.test/p1' ? route : loop);
  const { transactions, truncated } = await fetchAllTransactions('https://api.test/p1', 'key', {
    timeout: 5000,
    retries: 0,
  });
  assert.equal(transactions.length, 2);
  assert.equal(truncated, false);
});

test('fetchAllTransactions：超过 maxPages 标记 truncated', async () => {
  const tx1 = makeTx({ transaction_id: 'a' });
  // 每页都返回一个新 URL（链式分页无尽头），maxPages 限制翻页数
  let page = 1;
  globalThis.fetch = async () =>
    jsonResponse({ data: [tx1], meta: { links: { next: `https://api.test/page-${++page}` } } });
  const { transactions, truncated } = await fetchAllTransactions('https://api.test/p1', 'key', {
    timeout: 5000,
    retries: 0,
    maxPages: 2,
  });
  assert.equal(transactions.length, 2);
  assert.equal(truncated, true);
});

// ---------- queryMonthIncome ----------

test('queryMonthIncome：正常入账累计与合计', async () => {
  globalThis.fetch = async () =>
    jsonResponse({
      data: [
        makeTx({ transaction_id: 'a', value: '1000000' }),
        makeTx({ transaction_id: 'b', value: '2500000' }),
      ],
      meta: {},
    });
  const result = await queryMonthIncome(defaultQueryOptions());
  assert.equal(result.records.length, 2);
  assert.equal(result.totalText, '3.500000');
  assert.equal(result.deduped, 0);
  assert.deepEqual(result.errors, []);
});

test('queryMonthIncome：同一交易重复出现只计一次', async () => {
  const tx = makeTx({ transaction_id: 'dup', value: '5000000' });
  globalThis.fetch = async () => jsonResponse({ data: [tx, tx, { ...tx }], meta: {} });
  const result = await queryMonthIncome(defaultQueryOptions());
  assert.equal(result.records.length, 1);
  assert.equal(result.deduped, 2);
});

test('queryMonthIncome：排除自有地址互转', async () => {
  globalThis.fetch = async () =>
    jsonResponse({ data: [makeTx({ transaction_id: 'a', from: WALLET_A })], meta: {} });
  const result = await queryMonthIncome(defaultQueryOptions({ excludeSelf: true }));
  assert.equal(result.records.length, 0);
  assert.equal(result.totalText, '0.000000');
});

test('queryMonthIncome：排除自有地址互转关闭时计入', async () => {
  globalThis.fetch = async () =>
    jsonResponse({ data: [makeTx({ transaction_id: 'a', from: WALLET_A })], meta: {} });
  const result = await queryMonthIncome(defaultQueryOptions({ excludeSelf: false }));
  assert.equal(result.records.length, 1);
});

test('queryMonthIncome：非 USDT 合约交易被过滤', async () => {
  globalThis.fetch = async () =>
    jsonResponse({
      data: [
        makeTx({ transaction_id: 'a', token_info: { address: 'TXYZCOIN123456789012345678901234567890' } }),
      ],
      meta: {},
    });
  const result = await queryMonthIncome(defaultQueryOptions());
  assert.equal(result.records.length, 0);
});

test('queryMonthIncome：收款地址不是本次查询地址时被过滤', async () => {
  globalThis.fetch = async () =>
    jsonResponse({ data: [makeTx({ transaction_id: 'a', to: WALLET_B })], meta: {} });
  const result = await queryMonthIncome(defaultQueryOptions());
  assert.equal(result.records.length, 0);
});

test('queryMonthIncome：时间越界交易被过滤', async () => {
  const before = makeTx({ transaction_id: 'a', block_timestamp: Date.UTC(2025, 11, 31, 15) });
  const after = makeTx({ transaction_id: 'b', block_timestamp: Date.UTC(2026, 0, 31, 17) });
  globalThis.fetch = async () => jsonResponse({ data: [before, after], meta: {} });
  const result = await queryMonthIncome(defaultQueryOptions());
  assert.equal(result.records.length, 0);
});

test('queryMonthIncome：负金额被过滤', async () => {
  globalThis.fetch = async () =>
    jsonResponse({ data: [makeTx({ transaction_id: 'a', value: '-5' })], meta: {} });
  const result = await queryMonthIncome(defaultQueryOptions());
  assert.equal(result.records.length, 0);
});

test('queryMonthIncome：非法金额给出警告并忽略', async () => {
  globalThis.fetch = async () =>
    jsonResponse({ data: [makeTx({ transaction_id: 'a', value: 'not-a-number' })], meta: {} });
  const result = await queryMonthIncome(defaultQueryOptions());
  assert.equal(result.records.length, 0);
  assert.ok(result.warnings.some((item) => item.includes('金额格式无效')));
});

test('queryMonthIncome：部分地址失败不影响其他地址', async () => {
  const walletB = { label: '钱包B', address: WALLET_B };
  globalThis.fetch = async (url) => {
    if (url.includes(encodeURIComponent(WALLET_B))) return jsonResponse({}, 500);
    return jsonResponse({ data: [makeTx({ transaction_id: 'a' })], meta: {} });
  };
  const result = await queryMonthIncome(
    defaultQueryOptions({ wallets: [{ label: '钱包A', address: WALLET_A }, walletB] })
  );
  assert.equal(result.records.length, 1);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /查询失败/);
});

test('queryMonthIncome：超过 maxRecords 时告警并截断', async () => {
  globalThis.fetch = async () =>
    jsonResponse({
      data: [
        makeTx({ transaction_id: 'a', value: '1' }),
        makeTx({ transaction_id: 'b', value: '1' }),
        makeTx({ transaction_id: 'c', value: '1' }),
      ],
      meta: {},
    });
  const result = await queryMonthIncome(defaultQueryOptions({ maxRecords: 2 }));
  assert.equal(result.records.length, 2);
  assert.ok(result.warnings.some((item) => item.includes('最大记录数')));
});

test('queryMonthIncome：超时后剩余地址跳过并告警', async () => {
  globalThis.fetch = async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return jsonResponse({ data: [], meta: {} });
  };
  const result = await queryMonthIncome(
    defaultQueryOptions({
      wallets: [
        { label: '钱包A', address: WALLET_A },
        { label: '钱包B', address: WALLET_B },
      ],
      concurrency: 1,
      totalTimeoutMs: 5,
    })
  );
  assert.ok(result.warnings.some((item) => item.includes('未查询')));
});

test('queryMonthIncome：记录按时间排序', async () => {
  globalThis.fetch = async () =>
    jsonResponse({
      data: [
        makeTx({ transaction_id: 'a', block_timestamp: Date.UTC(2026, 0, 20, 4) }),
        makeTx({ transaction_id: 'b', block_timestamp: Date.UTC(2026, 0, 10, 4) }),
      ],
      meta: {},
    });
  const result = await queryMonthIncome(defaultQueryOptions());
  assert.equal(result.records[0].transaction_id, undefined); // 记录不存 transaction_id
  assert.ok(result.records[0].timestamp < result.records[1].timestamp);
});

// ---------- 汇率与汇总 ----------

test('fetchUsdtCnyRate：解析 CoinGecko 响应', async () => {
  globalThis.fetch = async () => jsonResponse({ tether: { cny: 7.25 } });
  const rate = await fetchUsdtCnyRate('https://rate.test', { retries: 0 });
  assert.equal(rate, 7.25);
});

test('fetchUsdtCnyRate：非法汇率抛错', async () => {
  globalThis.fetch = async () => jsonResponse({ tether: { cny: 'abc' } });
  await assert.rejects(fetchUsdtCnyRate('https://rate.test', { retries: 0 }));
});

test('summarizeRecords：超大金额不产生精度损失', () => {
  const records = [
    {
      label: '钱包A',
      address: WALLET_A,
      from: WALLET_B,
      amountMicros: 12345678901234567890n, // 约 1.2e13 USDT
      timestamp: Date.UTC(2026, 0, 15, 4),
      time: '2026-01-15 12:00:00',
    },
  ];
  const totalMicros = 12345678901234567890n;
  const text = summarizeRecords(records, totalMicros, 7.25, 2026, 1);
  assert.match(text, /12345678901234\.567890 USDT/);
  assert.match(text, /约合：¥/);
  assert.match(text, /笔数：1/);
});

test('summarizeRecords：无记录时提示未找到', () => {
  const text = summarizeRecords([], 0n, 7.25, 2026, 1);
  assert.match(text, /未找到 USDT 入账记录/);
});

// ---------- CSV ----------

test('buildCsv：包含 BOM、表头、引号转义与文件名', () => {
  const records = [
    {
      label: '钱包,一',
      address: WALLET_A,
      from: WALLET_B,
      amountMicros: 1000000n,
      time: '2026-01-15 12:00:00',
    },
  ];
  const { csv, filename } = buildCsv(records, 2026, 1);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('"标签","收款地址","付款地址","金额 (USDT)","时间"'));
  assert.ok(csv.includes('"钱包,一"'));
  assert.equal(filename, 'usdt_income_2026-01.csv');
});

// ---------- 探测 ----------

test('probeApiKey：200 返回通过', async () => {
  globalThis.fetch = async () => jsonResponse({}, 200);
  const text = await probeApiKey('test-key', { apiBase: API_BASE });
  assert.match(text, /通过/);
});

test('probeApiKey：403 提示核对 Key', async () => {
  globalThis.fetch = async () => jsonResponse({}, 403);
  const text = await probeApiKey('test-key', { apiBase: API_BASE });
  assert.match(text, /401\/403/);
});

test('probeApiKey：网络异常友好提示', async () => {
  globalThis.fetch = async () => {
    throw new Error('ECONNREFUSED');
  };
  const text = await probeApiKey('test-key', { apiBase: API_BASE });
  assert.match(text, /网络异常/);
});

// ---------- 错误格式化 ----------

test('formatRequestError：常见状态映射', () => {
  assert.match(formatRequestError({ status: 401 }), /API Key/);
  assert.match(formatRequestError({ status: 429 }), /限流/);
  assert.match(formatRequestError({ status: 500 }), /服务异常/);
  assert.match(formatRequestError({ code: 'TIMEOUT' }), /超时/);
  assert.match(formatRequestError({}), /网络或接口异常/);
});
