'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Storage } = require('../src/storage');
const { WatchService } = require('../src/watch-service');

const WALLET_A = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
const WALLET_B = 'THpMhA9fLPdbPVFkxpGWcXxyEfsxd1bxeJ';
const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

const silentLogger = { error() {}, warn() {}, info() {}, debug() {} };

function makeTx(overrides = {}) {
  return {
    transaction_id: 'watch-tx-1',
    block_timestamp: Date.UTC(2026, 6, 20, 6),
    from: WALLET_B,
    to: WALLET_A,
    value: '1000000',
    token_info: { address: USDT },
    ...overrides,
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  };
}

beforeEach(() => {
  globalThis.fetch = async () => jsonResponse({ data: [], meta: {} });
});
afterEach(() => {
  delete globalThis.fetch;
});

function makeService(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usdt-watch-test-'));
  const storage = new Storage(dir, { logger: silentLogger });
  return new WatchService({
    storage,
    bot: { telegram: { sendMessage: async () => ({}) } },
    config: {
      trongridApiBase: 'https://api.test/v1/accounts/',
      usdtContract: USDT,
      requestTimeoutMs: 5000,
      maxRequestRetries: 0,
      maxPagesPerAddress: 100,
      maxRecordsPerQuery: 10000,
      watchPollIntervalMs: 100000,
      ...overrides,
    },
    logger: silentLogger,
  });
}

test('queryTransactions：无 API Key 返回空列表', async () => {
  const service = makeService();
  const result = await service.queryTransactions(1, { address: WALLET_A, direction: 'in' });
  assert.deepEqual(result.transactions, []);
});

test('queryTransactions：过滤为监控地址且是 USDT，方向为向外时只保留转出', async () => {
  const service = makeService();
  service.storage.getUser(1).apiKey = 'test-key-123456789012345678901234';
  const txSelf = makeTx({ transaction_id: 'out-1', from: WALLET_A, to: WALLET_B });
  const txOther = makeTx({ transaction_id: 'out-2', from: WALLET_B, to: WALLET_A });
  globalThis.fetch = async () => jsonResponse({ data: [txSelf, txOther, makeTx({ token_info: { address: 'XYZ' } })], meta: {} });
  const result = await service.queryTransactions(1, { address: WALLET_A, direction: 'out' }, undefined);
  assert.equal(result.transactions.length, 1);
  assert.equal(result.transactions[0].id, 'out-1');
});

test('queryTransactions：监控到账只保留收款为该地址的交易', async () => {
  const service = makeService();
  service.storage.getUser(1).apiKey = 'test-key-123456789012345678901234';
  globalThis.fetch = async () =>
    jsonResponse({ data: [makeTx({ to: WALLET_A }), makeTx({ to: WALLET_B })], meta: {} });
  const result = await service.queryTransactions(1, { address: WALLET_A, direction: 'in' }, undefined);
  assert.equal(result.transactions.length, 1);
});

test('queryTransactions：both 同时查询到账和转出并合并', async () => {
  const service = makeService();
  service.storage.getUser(1).apiKey = 'test-key-123456789012345678901234';
  const everUrls = [];
  globalThis.fetch = async (url) => {
    everUrls.push(url);
    const fromA = makeTx({
      transaction_id: 'from-a',
      from: WALLET_A,
      to: WALLET_B,
    });
    const toA = makeTx({ transaction_id: 'to-a', to: WALLET_A });
    if (url.includes('only_from=true')) return jsonResponse({ data: [fromA], meta: {} });
    return jsonResponse({ data: [toA], meta: {} });
  };
  const result = await service.queryTransactions(
    1,
    { address: WALLET_A, direction: 'both' },
    undefined
  );
  assert.equal(result.transactions.length, 2);
  assert.equal(everUrls.filter((url) => url.includes('only_from=true')).length, 1);
  assert.equal(everUrls.filter((url) => url.includes('only_to=true')).length, 1);
});

test('poll：通知新交易，并写 checkpoint 防止重复通知', async () => {
  const service = makeService();
  service.storage.getUser(1).apiKey = 'test-key-123456789012345678901234';
  service.storage.addWatchedAddress(1, WALLET_A, '钱包A', 'in');
  const messages = [];
  service.bot.telegram.sendMessage = async (chatId, text) => {
    messages.push({ chatId, text });
    return {};
  };
  service.running = true;
  globalThis.fetch = async () =>
    jsonResponse({ data: [makeTx({ block_timestamp: Date.now() })], meta: {} });
  await service.poll();
  assert.equal(messages.length, 1);
  assert.match(messages[0].text, /到账/);
  assert.match(messages[0].text, /1\.000000 USDT/);
});