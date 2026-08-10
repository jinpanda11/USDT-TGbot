'use strict';

const { Markup } = require('telegraf');

const SEPARATOR = '────────────';

/**
 * 渲染查询结果赞助位文本。
 * 输出：空行 + 分隔线 + 「📢 赞助内容」标签 + 标题/正文 + 赞助商署名。
 * 广告和统计结果之间用分隔线明确隔开，标签固定为“赞助内容”。
 */
function renderText(ad) {
  const lines = [
    '',
    SEPARATOR,
    '📢 赞助内容',
    ad.title,
    ad.body ? ad.body : null,
    `—— ${ad.sponsorName}`,
  ];
  return lines.filter((line) => line !== null && line !== '').join('\n');
}

/**
 * 渲染广告按钮。
 * - 无落地链接（纯文字广告）时不渲染按钮，返回 undefined。
 * - 使用 callback_data（不携带任何敏感参数），点击回调记录点击后再用
 *   answerCbQuery(url) 打开链接。
 */
function renderKeyboard(ad) {
  if (!ad.targetUrl) return undefined;
  const buttonText = ad.buttonText || '了解详情';
  return Markup.inlineKeyboard([[Markup.button.callback(buttonText, `ad:click:${ad.id}`)]]);
}

module.exports = { renderText, renderKeyboard, SEPARATOR };
