'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { Semaphore, RateLimiter, QueryCache } = require('../src/query-gate');

test('Semaphore：限制同时执行数量', async () => {
  const semaphore = new Semaphore(2);
  let active = 0;
  let maxActive = 0;
  const tasks = Array.from({ length: 6 }, async () => {
    await semaphore.acquire();
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    semaphore.release();
  });
  await Promise.all(tasks);
  assert.ok(maxActive <= 2, `最大并发应不超过 2，实际 ${maxActive}`);
});

test('RateLimiter：窗口内超过上限被拒绝', () => {
  const limiter = new RateLimiter(2, 60000);
  assert.equal(limiter.allow(1), true);
  assert.equal(limiter.allow(1), true);
  assert.equal(limiter.allow(1), false);
  // 不同用户互不影响
  assert.equal(limiter.allow(2), true);
  // reset 后恢复
  limiter.reset(1);
  assert.equal(limiter.allow(1), true);
});

test('RateLimiter：maxPerWindow=0 表示不限制', () => {
  const limiter = new RateLimiter(0, 60000);
  for (let i = 0; i < 100; i += 1) {
    assert.equal(limiter.allow(1), true);
  }
});

test('QueryCache：TTL 内命中、过期失效', () => {
  const cache = new QueryCache(100, 10);
  cache.set('k', { value: 1 });
  assert.deepEqual(cache.get('k'), { value: 1 });
  setTimeout(() => {
    assert.equal(cache.get('k'), undefined);
  }, 120);
});

test('QueryCache：ttl=0 时禁用缓存', () => {
  const cache = new QueryCache(0, 10);
  cache.set('k', 1);
  assert.equal(cache.get('k'), undefined);
});

test('QueryCache：超过 maxEntries 淘汰最旧', () => {
  const cache = new QueryCache(60000, 2);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3);
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('b'), 2);
  assert.equal(cache.get('c'), 3);
});
