'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');

// 在 require config 前设置必要的环境变量（dotenv 不会覆盖已存在的变量）
process.env.TELEGRAM_BOT_TOKEN = '123456:test-token';
process.env.DATA_DIR = os.tmpdir();

const config = require('../src/config');
const { readInt, readNumber, readBool, readUserIdCsv, required } = config._helpers;

function withEnv(name, value, fn) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

test('config：导出完整配置对象', () => {
  assert.equal(typeof config.telegramBotToken, 'string');
  assert.equal(typeof config.dataDir, 'string');
  assert.ok(Array.isArray(config.allowedUserIds));
  assert.ok(config.defaultUsdtCnyRate > 0);
  assert.equal(typeof config.usdtContract, 'string');
  assert.ok(Number.isInteger(config.addressConcurrency));
  // 广告配置
  assert.equal(config.adsEnabled, false);
  assert.equal(typeof config.adsFile, 'string');
  assert.equal(typeof config.adEventsFile, 'string');
  assert.ok(config.adShowRatio >= 0 && config.adShowRatio <= 1);
});

test('required：缺失时抛错', () => {
  withEnv('TEST_REQUIRED', undefined, () => {
    assert.throws(() => required('TEST_REQUIRED'), /缺少环境变量 TEST_REQUIRED/);
  });
  withEnv('TEST_REQUIRED', '  ', () => {
    assert.throws(() => required('TEST_REQUIRED'), /缺少环境变量 TEST_REQUIRED/);
  });
  withEnv('TEST_REQUIRED', 'value', () => {
    assert.equal(required('TEST_REQUIRED'), 'value');
  });
});

test('readInt：默认值、合法值、越界与非整数', () => {
  withEnv('TEST_INT', undefined, () => {
    assert.equal(readInt('TEST_INT', 3, 1, 20), 3);
  });
  withEnv('TEST_INT', '7', () => {
    assert.equal(readInt('TEST_INT', 3, 1, 20), 7);
  });
  withEnv('TEST_INT', '21', () => {
    assert.throws(() => readInt('TEST_INT', 3, 1, 20), /TEST_INT.*21/);
  });
  withEnv('TEST_INT', '0', () => {
    assert.throws(() => readInt('TEST_INT', 3, 1, 20), /TEST_INT/);
  });
  withEnv('TEST_INT', 'abc', () => {
    assert.throws(() => readInt('TEST_INT', 3, 1, 20), /TEST_INT/);
  });
});

test('readNumber：默认值、合法值、非法值', () => {
  withEnv('TEST_NUM', undefined, () => {
    assert.equal(readNumber('TEST_NUM', 7.2, 0, 1000), 7.2);
  });
  withEnv('TEST_NUM', '7.25', () => {
    assert.equal(readNumber('TEST_NUM', 7.2, 0, 1000), 7.25);
  });
  withEnv('TEST_NUM', '-1', () => {
    assert.throws(() => readNumber('TEST_NUM', 7.2, 0, 1000), /TEST_NUM/);
  });
  withEnv('TEST_NUM', 'NaN', () => {
    assert.throws(() => readNumber('TEST_NUM', 7.2, 0, 1000), /TEST_NUM/);
  });
});

test('readBool：真/假值与非法值', () => {
  withEnv('TEST_BOOL', undefined, () => {
    assert.equal(readBool('TEST_BOOL', true), true);
  });
  withEnv('TEST_BOOL', 'false', () => {
    assert.equal(readBool('TEST_BOOL', true), false);
  });
  withEnv('TEST_BOOL', '1', () => {
    assert.equal(readBool('TEST_BOOL', false), true);
  });
  withEnv('TEST_BOOL', 'off', () => {
    assert.equal(readBool('TEST_BOOL', true), false);
  });
  withEnv('TEST_BOOL', 'x', () => {
    assert.throws(() => readBool('TEST_BOOL', true), /TEST_BOOL/);
  });
});

test('readUserIdCsv：空、合法列表、非法条目', () => {
  withEnv('TEST_IDS', undefined, () => {
    assert.deepEqual(readUserIdCsv('TEST_IDS'), []);
  });
  withEnv('TEST_IDS', ' 123 , 456 ', () => {
    assert.deepEqual(readUserIdCsv('TEST_IDS'), [123, 456]);
  });
  withEnv('TEST_IDS', 'abc', () => {
    assert.throws(() => readUserIdCsv('TEST_IDS'), /TEST_IDS/);
  });
  withEnv('TEST_IDS', '123, 12.5', () => {
    assert.throws(() => readUserIdCsv('TEST_IDS'), /TEST_IDS/);
  });
});
