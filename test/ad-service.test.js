'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AdService } = require('../src/ad-service');

const NOW = Date.UTC(2026, 6, 1); // 2026-07-01

function writeAds(dir, ads) {
  const file = path.join(dir, 'ads.json');
  fs.writeFileSync(file, JSON.stringify({ ads }), 'utf8');
  return file;
}

function writeAdsWithEnabled(dir, enabled, ads) {
  const file = path.join(dir, 'ads.json');
  fs.writeFileSync(file, JSON.stringify({ enabled, ads }), 'utf8');
  return file;
}

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

function makeService(dir, ads, overrides = {}) {
  return new AdService({
    adsFile: writeAds(dir, ads),
    eventsFile: path.join(dir, 'events.jsonl'),
    ...overrides,
  });
}

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usdt-ad-test-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('selectAd：缺失文件返回 undefined，不抛错', () => {
  const service = new AdService({
    adsFile: path.join(dir, 'nope.json'),
    eventsFile: path.join(dir, 'events.jsonl'),
  });
  assert.equal(service.selectAd(NOW), undefined);
});

test('selectAd：过滤非 approved、非结果位、时间窗外、达上限', () => {
  const ads = [
    makeAd({ id: 'draft', status: 'draft' }),
    makeAd({ id: 'broadcast', placement: 'broadcast' }),
    makeAd({ id: 'expired', starts_at: '2020-01-01T00:00:00Z', ends_at: '2021-01-01T00:00:00Z' }),
    makeAd({ id: 'full', impressions: 1000, max_impressions: 1000 }),
    makeAd({ id: 'ok', impressions: 5 }),
  ];
  const service = makeService(dir, ads);
  assert.equal(service.selectAd(NOW).id, 'ok');
});

test('selectAd：轮播按展示占比最低优先', () => {
  const ads = [
    makeAd({ id: 'a', impressions: 800, max_impressions: 1000 }),
    makeAd({ id: 'b', impressions: 100, max_impressions: 1000 }),
  ];
  const service = makeService(dir, ads);
  assert.equal(service.selectAd(NOW).id, 'b');
});

test('selectAd：达到展示上限后不再被选中', () => {
  const service = makeService(dir, [makeAd({ impressions: 1000, max_impressions: 1000 })]);
  assert.equal(service.selectAd(NOW), undefined);
});

test('selectAd：max_impressions=0 表示不限量', () => {
  const service = makeService(dir, [makeAd({ max_impressions: 0 })]);
  assert.ok(service.selectAd(NOW));
});

test('shouldShow：开关与比例', () => {
  assert.equal(new AdService({ enabled: false, showRatio: 1 }).shouldShow(), false);
  assert.equal(new AdService({ enabled: true, showRatio: 0 }).shouldShow(), false);
  assert.equal(new AdService({ enabled: true, showRatio: 1 }).shouldShow(), true);
  // 0.5 比例：1000 次采样应接近一半
  const service = new AdService({ enabled: true, showRatio: 0.5 });
  let shown = 0;
  for (let i = 0; i < 1000; i += 1) {
    if (service.shouldShow()) shown += 1;
  }
  assert.ok(shown > 400 && shown < 600, `采样结果 ${shown} 偏离 0.5`);
});

test('recordImpression：计数递增、持久化并追加事件日志', () => {
  const service = makeService(dir, [makeAd()]);
  service.recordImpression('ad-1', 123);
  service.recordImpression('ad-1', 456);
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'ads.json'), 'utf8'));
  assert.equal(raw.ads[0].impressions, 2);
  const events = fs
    .readFileSync(path.join(dir, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n');
  assert.equal(events.length, 2);
  const first = JSON.parse(events[0]);
  assert.equal(first.eventType, 'impression');
  assert.equal(first.userId, 123);
  assert.equal(first.source, 'query_result');
});

test('recordClick：点击计数与事件', () => {
  const service = makeService(dir, [makeAd()]);
  service.recordClick('ad-1', 123);
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'ads.json'), 'utf8'));
  assert.equal(raw.ads[0].clicks, 1);
  const events = fs
    .readFileSync(path.join(dir, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n');
  assert.equal(JSON.parse(events[0]).eventType, 'click');
});

test('recordImpression：未知广告 ID 静默忽略', () => {
  const service = makeService(dir, [makeAd()]);
  service.recordImpression('nope', 1);
  service.recordClick('nope', 1);
  assert.equal(fs.existsSync(path.join(dir, 'events.jsonl')), false);
});

test('ads.json 损坏：广告列表为空且不抛错', () => {
  const file = path.join(dir, 'ads.json');
  fs.writeFileSync(file, '{ 坏 JSON', 'utf8');
  const service = new AdService({
    adsFile: file,
    eventsFile: path.join(dir, 'events.jsonl'),
  });
  assert.equal(service.selectAd(NOW), undefined);
});

test('非法广告条目被丢弃，合法广告仍可用', () => {
  const ads = [makeAd({ id: 'bad', target_url: 'http://insecure.example' }), makeAd({ id: 'good' })];
  const service = makeService(dir, ads);
  assert.equal(service.selectAd(NOW).id, 'good');
  assert.equal(service.getAdById('bad'), undefined);
});

test('运营编辑 ads.json 后重新加载（mtime 变化）', () => {
  const service = makeService(dir, [makeAd({ id: 'old' })]);
  assert.equal(service.selectAd(NOW).id, 'old');
  // 模拟运营修改：替换为新广告
  writeAds(dir, [makeAd({ id: 'new' })]);
  assert.equal(service.selectAd(NOW).id, 'new');
});

// ---------- 管理员操作 ----------

test('createAd：合法草稿创建成功并持久化', () => {
  const service = makeService(dir, []);
  const result = service.createAd(
    {
      title: '新广告',
      body: '正文',
      sponsorName: '赞助商',
      buttonText: '去看看',
      targetUrl: 'https://example.com/new',
      startsAt: new Date().toISOString(),
      endsAt: new Date(Date.now() + 86400000).toISOString(),
      maxImpressions: 100,
      placement: 'query_result',
    },
    1
  );
  assert.equal(result.ok, true);
  assert.equal(result.ad.status, 'draft');
  assert.equal(result.ad.id.startsWith('ad-'), true);
  // 草稿不会被 selectAd 选中
  assert.equal(service.selectAd(NOW), undefined);
  // 持久化后重读一致
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'ads.json'), 'utf8'));
  assert.equal(raw.ads[0].id, result.ad.id);
  assert.equal(raw.ads[0].impressions, 0);
});

test('createAd：纯文字广告（无链接）可创建并投放', () => {
  const service = makeService(dir, []);
  const result = service.createAd(
    {
      title: '频道赞助',
      body: '关注 @MyChannel',
      sponsorName: '@MyChannel',
      buttonText: '',
      targetUrl: '',
      startsAt: '2026-01-01T00:00:00Z',
      endsAt: '2027-01-01T00:00:00Z',
      maxImpressions: 0,
      placement: 'query_result',
    },
    1
  );
  assert.equal(result.ok, true);
  assert.equal(result.ad.targetUrl, '');
  assert.equal(result.ad.buttonText, '');
  service.setStatus(result.ad.id, 'approved', 1);
  const selected = service.selectAd(NOW);
  assert.equal(selected.id, result.ad.id);
});

test('createAd：非法内容返回错误且不写入', () => {
  const service = makeService(dir, []);
  const result = service.createAd(
    {
      title: 'x',
      body: '',
      sponsorName: 's',
      buttonText: 'b',
      targetUrl: 'http://insecure.example', // 非 https
      startsAt: new Date().toISOString(),
      endsAt: new Date().toISOString(), // 与 starts 相同 → 非法
      maxImpressions: 0,
      placement: 'query_result',
    },
    1
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'ads.json'), 'utf8'));
  assert.equal(raw.ads.length, 0);
});

test('setStatus：审核/暂停/恢复', () => {
  const service = makeService(dir, [makeAd({ id: 'a' })]);
  // 初始是 approved（makeAd 默认），先暂停
  assert.equal(service.setStatus('a', 'paused', 1).ok, true);
  assert.equal(service.getAdById('a').status, 'paused');
  assert.equal(service.selectAd(NOW), undefined); // 暂停后不再投放
  // 恢复投放
  assert.equal(service.setStatus('a', 'approved', 1).ok, true);
  assert.equal(service.selectAd(NOW).id, 'a');
  // 未知 ID / 非法状态
  assert.equal(service.setStatus('nope', 'approved', 1).ok, false);
  assert.equal(service.setStatus('a', 'weird', 1).ok, false);
});

test('getStats：曝光/点击/CTR，无记录时 CTR 为 0', () => {
  const service = makeService(dir, [makeAd()]);
  assert.equal(service.getStats('ad-1').impressions, 0);
  assert.equal(service.getStats('ad-1').ctr, 0);
  service.recordImpression('ad-1', 1);
  service.recordImpression('ad-1', 2);
  service.recordClick('ad-1', 1);
  const stats = service.getStats('ad-1');
  assert.equal(stats.impressions, 2);
  assert.equal(stats.clicks, 1);
  assert.equal(stats.ctr, 0.5);
  assert.equal(service.getStats('nope'), undefined);
});

test('getAllAds：返回全部广告', () => {
  const service = makeService(dir, [makeAd({ id: 'a' }), makeAd({ id: 'b', status: 'paused' })]);
  const all = service.getAllAds();
  assert.equal(all.length, 2);
  assert.deepEqual(
    all.map((ad) => ad.id).sort(),
    ['a', 'b']
  );
});

// ---------- 总开关（TG 按钮运行时切换） ----------

test('setEnabled：切换开关、立即生效、持久化并写审计事件', () => {
  const service = makeService(dir, [makeAd()]);
  assert.equal(service.enabled, true);
  assert.equal(service.shouldShow(), true);

  service.setEnabled(false, 1);
  assert.equal(service.enabled, false);
  assert.equal(service.shouldShow(), false); // 立即生效

  // 持久化到 ads.json
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'ads.json'), 'utf8'));
  assert.equal(raw.enabled, false);

  // 重载后保持一致（跨重启有效）
  const reloaded = new AdService({
    adsFile: path.join(dir, 'ads.json'),
    eventsFile: path.join(dir, 'events.jsonl'),
  });
  assert.equal(reloaded.enabled, false);

  // 审计事件
  const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n');
  assert.equal(JSON.parse(events[0]).eventType, 'admin_ad_disabled');
});

test('setEnabled：相同状态不重复写', () => {
  const service = makeService(dir, [makeAd()]);
  service.setEnabled(true, 1);
  assert.equal(fs.existsSync(path.join(dir, 'events.jsonl')), false);
});

test('constructor：文件缺失用初始默认；文件显式 enabled 优先于环境默认', () => {
  const missing = new AdService({ adsFile: path.join(dir, 'nope.json'), enabled: false });
  assert.equal(missing.enabled, false);

  writeAdsWithEnabled(dir, false, [makeAd()]);
  const fromFile = new AdService({ adsFile: path.join(dir, 'ads.json'), enabled: true });
  assert.equal(fromFile.enabled, false);
});

test('运营编辑 ads.json 的 enabled 字段会被重新加载', () => {
  const service = makeService(dir, [makeAd()]);
  assert.equal(service.enabled, true);
  writeAdsWithEnabled(dir, false, [makeAd()]);
  service.selectAd(NOW); // 触发 mtime 重载
  assert.equal(service.enabled, false);
});
