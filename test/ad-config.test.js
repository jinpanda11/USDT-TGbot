'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateAd, isQueryResultPlacement } = require('../src/ad-config');

function makeAd(overrides = {}) {
  return {
    id: 'ad-1',
    title: 'XXX 钱包',
    body: '支持 TRON 多地址管理与资产提醒',
    sponsor_name: 'XXX 钱包',
    button_text: '了解详情',
    target_url: 'https://example.com/landing',
    status: 'approved',
    placement: 'query_result',
    starts_at: '2026-01-01T00:00:00+08:00',
    ends_at: '2026-12-31T23:59:59+08:00',
    max_impressions: 1000,
    ...overrides,
  };
}

test('validateAd：合法广告通过并归一化', () => {
  const result = validateAd(makeAd());
  assert.equal(result.ok, true);
  assert.deepEqual(result.ad.placement, ['query_result']);
  assert.equal(typeof result.ad.startsAt, 'number');
  assert.equal(result.ad.maxImpressions, 1000);
});

test('validateAd：http 链接被拒绝', () => {
  const result = validateAd(makeAd({ target_url: 'http://example.com/x' }));
  assert.equal(result.ok, false);
});

test('validateAd：任意 https 域名均可（不再限制域名）', () => {
  const result = validateAd(makeAd({ target_url: 'https://any-domain.example/x' }));
  assert.equal(result.ok, true);
});

test('validateAd：纯文字广告（无链接无按钮）通过', () => {
  const result = validateAd(makeAd({ target_url: '', button_text: '' }));
  assert.equal(result.ok, true);
});

test('validateAd：长度限制（id/title/body/sponsor/button）', () => {
  assert.equal(validateAd(makeAd({ id: 'x'.repeat(33) })).ok, false);
  assert.equal(validateAd(makeAd({ title: 'x'.repeat(61) })).ok, false);
  assert.equal(validateAd(makeAd({ body: 'x'.repeat(501) })).ok, false);
  assert.equal(validateAd(makeAd({ sponsor_name: 'x'.repeat(41) })).ok, false);
  assert.equal(validateAd(makeAd({ button_text: 'x'.repeat(31) })).ok, false);
});

test('validateAd：状态与投放位置校验', () => {
  assert.equal(validateAd(makeAd({ status: 'draft' })).ok, true);
  assert.equal(validateAd(makeAd({ status: 'paused' })).ok, true);
  assert.equal(validateAd(makeAd({ status: 'weird' })).ok, false);
  // placement 支持数组与 both
  const list = validateAd(makeAd({ placement: ['query_result', 'broadcast'] }));
  assert.equal(list.ok, true);
  assert.deepEqual(list.ad.placement, ['query_result', 'broadcast']);
  const both = validateAd(makeAd({ placement: 'both' }));
  assert.equal(both.ok, true);
  assert.deepEqual(both.ad.placement, ['both']);
  assert.equal(validateAd(makeAd({ placement: '' })).ok, false);
});

test('validateAd：ends_at 必须晚于 starts_at', () => {
  const result = validateAd(
    makeAd({ starts_at: '2026-12-01T00:00:00+08:00', ends_at: '2026-01-01T00:00:00+08:00' })
  );
  assert.equal(result.ok, false);
});

test('validateAd：max_impressions 负数拒绝，0 表示不限制，非法值拒绝', () => {
  assert.equal(validateAd(makeAd({ max_impressions: -1 })).ok, false);
  assert.equal(validateAd(makeAd({ max_impressions: 0 })).ok, true);
  assert.equal(validateAd(makeAd({ max_impressions: 'abc' })).ok, false);
});

test('isQueryResultPlacement：both 与 query_result 均为结果位', () => {
  assert.equal(isQueryResultPlacement({ placement: ['query_result'] }), true);
  assert.equal(isQueryResultPlacement({ placement: ['both'] }), true);
  assert.equal(isQueryResultPlacement({ placement: ['broadcast'] }), false);
});
