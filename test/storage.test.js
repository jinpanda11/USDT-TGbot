'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Storage } = require('../src/storage');

const WALLET_A = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
const WALLET_B = 'THpMhA9fLPdbPVFkxpGWcXxyEfsxd1bxeJ';

const silentLogger = { error() {}, warn() {}, info() {}, debug() {} };

function makeTempDir(t) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usdt-storage-test-'));
}

test('首次创建：生成空 users.json', async () => {
  const dir = makeTempDir();
  const storage = new Storage(dir, { logger: silentLogger });
  await storage.writeQueue; // 等待初始 save() 完成
  assert.equal(fs.existsSync(path.join(dir, 'users.json')), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'users.json'), 'utf8')), {});
  assert.deepEqual(storage.users, {});
});

test('getUser 创建默认用户并持久化', async () => {
  const dir = makeTempDir();
  const storage = new Storage(dir, { logger: silentLogger });
  const user = storage.getUser(123);
  await storage.writeQueue; // 等待 save() 完成
  assert.equal(user.excludeSelf, true);
  assert.deepEqual(user.addresses, []);
  assert.equal(user.apiKey, '');
  const reloaded = new Storage(dir, { logger: silentLogger });
  assert.equal(reloaded.users['123'].excludeSelf, true);
});

test('addAddress：合法地址成功，重复与非法被拒', () => {
  const dir = makeTempDir();
  const storage = new Storage(dir, { logger: silentLogger });
  assert.equal(storage.addAddress(1, WALLET_A, '钱包A').ok, true);
  assert.equal(storage.addAddress(1, WALLET_A, '钱包A').ok, false);
  assert.equal(storage.addAddress(1, `${WALLET_A.slice(0, -1)}C`, '坏').reason, 'invalid_address');
  assert.equal(storage.addAddress(1, 'not-an-address', '坏').reason, 'invalid_address');
  assert.equal(storage.users['1'].addresses.length, 1);
});

test('updateUser 持久化并可在重载后读取', async () => {
  const dir = makeTempDir();
  const storage = new Storage(dir, { logger: silentLogger });
  storage.updateUser(7, { usdtRate: 7.25, excludeSelf: false, apiKey: 'my-key-123456789012345' });
  await storage.writeQueue; // 等待 save() 完成
  const reloaded = new Storage(dir, { logger: silentLogger });
  assert.equal(reloaded.users['7'].usdtRate, 7.25);
  assert.equal(reloaded.users['7'].excludeSelf, false);
  assert.equal(reloaded.users['7'].apiKey, 'my-key-123456789012345');
});

test('deleteAddress：支持序号与地址删除', () => {
  const dir = makeTempDir();
  const storage = new Storage(dir, { logger: silentLogger });
  storage.addAddress(1, WALLET_A, 'A');
  storage.addAddress(1, WALLET_B, 'B');
  assert.equal(storage.deleteAddress(1, '2').ok, true);
  assert.equal(storage.users['1'].addresses.length, 1);
  assert.equal(storage.deleteAddress(1, WALLET_A).ok, true);
  assert.equal(storage.users['1'].addresses.length, 0);
  assert.equal(storage.deleteAddress(1, '9').ok, false);
});

test('损坏 JSON：备份后抛错终止，不覆盖原文件', () => {
  const dir = makeTempDir();
  const filePath = path.join(dir, 'users.json');
  fs.writeFileSync(filePath, '{"123": {"apiKey": "secret-key-123456789012345"}}', 'utf8');
  fs.writeFileSync(filePath, '{ 这不是合法 JSON', 'utf8');
  assert.throws(() => new Storage(dir, { logger: silentLogger }), /用户数据文件损坏/);
  // 原文件未被覆盖，且生成了 .bak 备份
  assert.match(fs.readFileSync(filePath, 'utf8'), /这不是合法 JSON/);
  const backups = fs.readdirSync(dir).filter((name) => name.includes('.corrupt-') && name.endsWith('.bak'));
  assert.equal(backups.length, 1);
  assert.match(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), /这不是合法 JSON/);
});

test('顶层非对象：备份后抛错', () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'users.json'), '[1,2,3]', 'utf8');
  assert.throws(() => new Storage(dir, { logger: silentLogger }), /顶层结构无效/);
});

test('归一化：未知字段被丢弃、非法地址条目被跳过并告警', () => {
  const dir = makeTempDir();
  fs.writeFileSync(
    path.join(dir, 'users.json'),
    JSON.stringify({
      '123': {
        apiKey: '<key-with-brackets>',
        usdtRate: 'not-a-number',
        excludeSelf: 'yes',
        unknownField: { should: 'be dropped' },
        addresses: [
          { address: WALLET_A, label: '好的' },
          { address: 'bad-address', label: '坏的' },
          null,
        ],
      },
    }),
    'utf8'
  );
  const storage = new Storage(dir, { logger: silentLogger });
  const user = storage.users['123'];
  assert.equal(user.unknownField, undefined);
  assert.equal(user.addresses.length, 1);
  assert.equal(user.addresses[0].label, '好的');
  assert.equal(user.excludeSelf, true); // 非法值回退默认
  assert.equal(user.usdtRate, null); // 非法值回退默认
});

test('归一化：历史数据兼容（缺字段回退默认，API Key 去括号引号）', () => {
  const dir = makeTempDir();
  fs.writeFileSync(
    path.join(dir, 'users.json'),
    JSON.stringify({
      '1': { apiKey: '"<API-KEY-123456789012345678>"', addresses: [{ address: WALLET_B }] },
      '2': 'not-an-object',
    }),
    'utf8'
  );
  const storage = new Storage(dir, { logger: silentLogger });
  assert.equal(storage.users['1'].apiKey, 'API-KEY-123456789012345678');
  assert.equal(storage.users['1'].addresses[0].label, '默认标签');
  assert.equal(storage.users['2'], undefined); // 非法条目被丢弃
});

test('save 安全阀：不允许用空对象覆盖已有数据', async () => {
  const dir = makeTempDir();
  const storage = new Storage(dir, { logger: silentLogger });
  storage.getUser(1);
  await storage.writeQueue; // 等待初始 save() 完成
  await assert.rejects(async () => {
    storage.users = {};
    await storage.save();
  }, /将被清空/);
  // 文件仍保留原数据
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'users.json'), 'utf8'));
  assert.equal(raw['1'].excludeSelf, true);
});

test('文件权限：保存后为 0600（平台支持时）', () => {
  const dir = makeTempDir();
  const storage = new Storage(dir, { logger: silentLogger });
  storage.getUser(1);
  if (process.platform !== 'win32') {
    const mode = fs.statSync(path.join(dir, 'users.json')).mode & 0o777;
    assert.equal(mode, 0o600);
  }
});
