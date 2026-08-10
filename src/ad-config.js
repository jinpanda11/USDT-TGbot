'use strict';

/** 广告配置读取与校验（阶段 A：查询结果赞助位） */

const AD_STATUSES = new Set(['draft', 'pending_review', 'approved', 'paused', 'expired']);
const AD_PLACEMENTS = new Set(['query_result', 'broadcast', 'both']);
const MAX_ID = 32;
const MAX_TITLE = 60;
const MAX_BODY = 500;
const MAX_SPONSOR = 40;
const MAX_BUTTON = 30;

function normalizePlacement(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === 'string') return [String(value).trim()].filter(Boolean);
  return [];
}

function isHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * 校验单条广告。
 * 返回 { ok, errors, ad }；ad 为归一化后的内部表示（startsAt/endsAt 为毫秒时间戳）。
 * 外链只要求 HTTPS，不限制域名。
 */
function validateAd(raw) {
  const errors = [];
  const id = String(raw?.id || '').trim();
  if (!id) errors.push('缺少 id');
  else if (id.length > MAX_ID) errors.push(`id 超过 ${MAX_ID} 字符`);

  const title = String(raw?.title || '').trim();
  if (!title) errors.push('缺少 title');
  else if (title.length > MAX_TITLE) errors.push(`title 超过 ${MAX_TITLE} 字符`);

  const body = String(raw?.body || '').trim();
  if (body.length > MAX_BODY) errors.push(`body 超过 ${MAX_BODY} 字符`);

  const sponsorName = String(raw?.sponsor_name || '').trim();
  if (!sponsorName) errors.push('缺少 sponsor_name');
  else if (sponsorName.length > MAX_SPONSOR) errors.push(`sponsor_name 超过 ${MAX_SPONSOR} 字符`);

  const buttonText = String(raw?.button_text || '').trim();
  if (buttonText.length > MAX_BUTTON) errors.push(`button_text 超过 ${MAX_BUTTON} 字符`);

  // 外链可选：留空 = 纯文字广告（@用户名写在正文/赞助商栏，Telegram 自动可点）
  const targetUrl = String(raw?.target_url || '').trim();
  if (targetUrl && !isHttpsUrl(targetUrl)) {
    errors.push('target_url 必须是 https 链接');
  }

  if (!AD_STATUSES.has(raw?.status)) errors.push(`status 非法：${raw?.status}`);

  const placement = normalizePlacement(raw?.placement);
  if (placement.length === 0) errors.push('placement 为空');
  else if (!placement.every((item) => AD_PLACEMENTS.has(item))) errors.push('placement 含非法值');

  const startsAt = Date.parse(raw?.starts_at);
  const endsAt = Date.parse(raw?.ends_at);
  if (!Number.isFinite(startsAt)) errors.push('starts_at 无法解析');
  if (!Number.isFinite(endsAt)) errors.push('ends_at 无法解析');
  if (Number.isFinite(startsAt) && Number.isFinite(endsAt) && endsAt <= startsAt) {
    errors.push('ends_at 必须晚于 starts_at');
  }

  let maxImpressions = 0;
  if (raw?.max_impressions != null) {
    maxImpressions = Number(raw.max_impressions);
    if (!Number.isFinite(maxImpressions) || maxImpressions < 0) {
      errors.push('max_impressions 必须是非负整数');
    } else {
      maxImpressions = Math.floor(maxImpressions);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    ad: {
      id,
      title,
      body,
      sponsorName,
      buttonText,
      targetUrl,
      status: raw?.status,
      placement,
      startsAt,
      endsAt,
      maxImpressions,
    },
  };
}

/** 判断广告当前是否投放在查询结果位 */
function isQueryResultPlacement(ad) {
  return ad.placement.includes('query_result') || ad.placement.includes('both');
}

module.exports = { validateAd, isQueryResultPlacement, isHttpsUrl, AD_STATUSES, AD_PLACEMENTS };
