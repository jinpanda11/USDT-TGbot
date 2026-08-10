'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { renderText, renderKeyboard, SEPARATOR } = require('../src/ad-renderer');

const ad = {
  id: 'ad-1',
  title: 'XXX 钱包',
  body: '支持 TRON 多地址管理与资产提醒',
  sponsorName: 'XXX 钱包',
  buttonText: '了解详情',
  targetUrl: 'https://example.com/landing',
};

test('renderText：包含分隔线、赞助标签、标题与赞助商', () => {
  const text = renderText(ad);
  assert.ok(text.includes(SEPARATOR));
  assert.ok(text.includes('📢 赞助内容'));
  assert.ok(text.includes('XXX 钱包'));
  assert.ok(text.includes('支持 TRON 多地址管理与资产提醒'));
  assert.ok(text.includes('—— XXX 钱包'));
});

test('renderText：无正文时不产生多余空行', () => {
  const text = renderText({ ...ad, body: '' });
  assert.ok(!text.includes('\n\n\n'));
  assert.ok(!text.includes(SEPARATOR + '\n\n'));
});

test('renderKeyboard：使用 callback_data 且不含 URL 参数', () => {
  const keyboard = renderKeyboard(ad);
  const markup = keyboard.reply_markup;
  assert.equal(markup.inline_keyboard.length, 1);
  const button = markup.inline_keyboard[0][0];
  assert.equal(button.text, '了解详情');
  assert.equal(button.callback_data, 'ad:click:ad-1');
  assert.equal(button.url, undefined);
});

test('renderKeyboard：无落地链接（纯文字广告）不渲染按钮', () => {
  assert.equal(renderKeyboard({ ...ad, targetUrl: '' }), undefined);
  assert.equal(renderKeyboard({ ...ad, targetUrl: undefined }), undefined);
});

test('renderKeyboard：有链接但无按钮文字时用默认文案', () => {
  const keyboard = renderKeyboard({ ...ad, buttonText: '' });
  const button = keyboard.reply_markup.inline_keyboard[0][0];
  assert.equal(button.text, '了解详情');
});

test('renderKeyboard：callback_data 在 Telegram 64 字节限制内', () => {
  const longId = 'x'.repeat(32);
  const keyboard = renderKeyboard({ ...ad, id: longId });
  const data = keyboard.reply_markup.inline_keyboard[0][0].callback_data;
  assert.ok(Buffer.byteLength(data) <= 64);
});
