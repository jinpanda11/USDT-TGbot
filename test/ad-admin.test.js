'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseFlexibleDate,
  parsePlacement,
  parseMaxImpressions,
  validateUrl,
  buildDraft,
  previewDraftText,
  adListText,
} = require('../src/ad-admin');

test('parseFlexibleDate：空=null，合法格式解析，非法格式失败', () => {
  assert.deepEqual(parseFlexibleDate(''), { ok: true, value: null });
  assert.deepEqual(parseFlexibleDate('  '), { ok: true, value: null });
  assert.equal(parseFlexibleDate('2026-08-20').ok, true);
  assert.equal(parseFlexibleDate('2026-08-20 10:00').ok, true);
  assert.equal(parseFlexibleDate('not-a-date').ok, false);
  assert.equal(parseFlexibleDate('2026-13-45').ok, false);
});

test('parsePlacement：默认 query_result，both 合法，其他拒绝', () => {
  assert.deepEqual(parsePlacement(''), { ok: true, value: 'query_result' });
  assert.deepEqual(parsePlacement('query_result'), { ok: true, value: 'query_result' });
  assert.deepEqual(parsePlacement('both'), { ok: true, value: 'both' });
  assert.equal(parsePlacement('broadcast').ok, false);
});

test('parseMaxImpressions：空=0，整数合法，负数/非整数拒绝', () => {
  assert.deepEqual(parseMaxImpressions(''), { ok: true, value: 0 });
  assert.deepEqual(parseMaxImpressions('500'), { ok: true, value: 500 });
  assert.equal(parseMaxImpressions('-1').ok, false);
  assert.equal(parseMaxImpressions('1.5').ok, false);
  assert.equal(parseMaxImpressions('abc').ok, false);
});

test('validateUrl：留空=纯文字广告，有链接只要求 https', () => {
  assert.deepEqual(validateUrl(''), { ok: true, value: '' });
  assert.deepEqual(validateUrl('  '), { ok: true, value: '' });
  assert.equal(validateUrl('https://example.com/x').ok, true);
  assert.equal(validateUrl('https://any-domain.example/x').ok, true);
  assert.equal(validateUrl('http://example.com/x').ok, false);
  assert.equal(validateUrl('not-a-url').ok, false);
});

test('previewDraftText：纯文字广告显示「无（纯文字广告）」', () => {
  const draft = buildDraft({
    title: '频道赞助',
    body: '关注 @MyChannel',
    sponsorName: '@MyChannel',
    buttonText: '',
    targetUrl: '',
  });
  const text = previewDraftText(draft);
  assert.ok(text.includes('无（纯文字广告）'));
  assert.ok(text.includes('@MyChannel'));
});

test('buildDraft：缺省时间补默认值', () => {
  const draft = buildDraft({
    title: 't',
    body: '',
    sponsorName: 's',
    buttonText: 'b',
    targetUrl: 'https://example.com/x',
  });
  assert.ok(draft.startsAt); // 默认立即
  assert.ok(draft.endsAt); // 默认一年后
  assert.equal(draft.maxImpressions, 0);
  assert.equal(draft.placement, 'query_result');
  assert.ok(Date.parse(draft.endsAt) > Date.parse(draft.startsAt));
});

test('previewDraftText：包含链接、时间、上限、位置', () => {
  const draft = buildDraft({
    title: '标题',
    body: '正文',
    sponsorName: '赞助商',
    buttonText: '按钮',
    targetUrl: 'https://example.com/x',
  });
  const text = previewDraftText(draft);
  assert.ok(text.includes('https://example.com/x'));
  assert.ok(text.includes('展示上限：不限'));
  assert.ok(text.includes('位置：query_result'));
  assert.ok(text.includes('📢 赞助内容'));
});

test('adListText：显示总开关状态', () => {
  const on = adListText({ enabled: true, getAllAds: () => [] });
  assert.ok(on.includes('广告总开关：开'));
  const off = adListText({ enabled: false, getAllAds: () => [] });
  assert.ok(off.includes('广告总开关：关'));
});
