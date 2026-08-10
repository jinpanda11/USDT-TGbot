'use strict';

const { Markup } = require('telegraf');
const { renderText } = require('./ad-renderer');
const { isHttpsUrl } = require('./ad-config');
const { maskUserId } = require('./logger');

const CANCEL_KEYBOARD = Markup.keyboard([['❌ 取消']]).resize();
const CONFIRM_KEYBOARD = Markup.keyboard([['✅ 是', '❌ 取消']]).resize();

const STATUS_LABEL = {
  draft: '草稿',
  pending_review: '待审核',
  approved: '投放中',
  paused: '已暂停',
  expired: '已过期',
};

const WIZARD_STEPS = [
  { key: 'title', prompt: '广告标题（≤60 字）：' },
  { key: 'body', prompt: '广告正文（可选，≤500 字，发送「跳过」留空）：' },
  { key: 'sponsorName', prompt: '赞助商名称（≤40 字）：' },
  { key: 'targetUrl', prompt: '落地链接（可选；纯文字广告直接「跳过」，有链接必须 https）：' },
  { key: 'buttonText', prompt: '按钮文字（≤30 字，默认：了解详情；无链接广告无需填，直接「跳过」）：' },
  { key: 'startsAt', prompt: '开始时间（留空=立即；格式如 2026-08-20 或 2026-08-20 10:00）：' },
  { key: 'endsAt', prompt: '结束时间（格式同上，留空=一年后，需晚于开始时间）：' },
  { key: 'maxImpressions', prompt: '展示上限（整数 ≥0，0=不限，默认 0）：' },
  { key: 'placement', prompt: '投放位置：query_result 或 both（默认 query_result）：' },
];

function fmtDate(ms) {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
}

function parseFlexibleDate(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return { ok: true, value: null };
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return { ok: false };
  return { ok: true, value: date.toISOString() };
}

function parsePlacement(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!value || value === 'query_result') return { ok: true, value: 'query_result' };
  if (value === 'both') return { ok: true, value: 'both' };
  return { ok: false };
}

function parseMaxImpressions(text) {
  const value = String(text || '').trim();
  if (!value) return { ok: true, value: 0 };
  const num = Number(value);
  if (!Number.isInteger(num) || num < 0) return { ok: false };
  return { ok: true, value: num };
}

function validateUrl(text) {
  const value = String(text || '').trim();
  if (!value) return { ok: true, value: '' }; // 纯文字广告，无外链
  if (!isHttpsUrl(value)) return { ok: false, error: '链接必须是 https' };
  return { ok: true, value };
}

function buildDraft(data) {
  return {
    title: data.title,
    body: data.body || '',
    sponsorName: data.sponsorName,
    buttonText: data.buttonText,
    targetUrl: data.targetUrl,
    startsAt: data.startsAt || new Date().toISOString(),
    endsAt: data.endsAt || new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
    maxImpressions: data.maxImpressions ?? 0,
    placement: data.placement || 'query_result',
  };
}

function previewDraftText(draft) {
  return [
    renderText({ title: draft.title, body: draft.body, sponsorName: draft.sponsorName }),
    '',
    `链接：${draft.targetUrl || '无（纯文字广告）'}`,
    `时间：${fmtDate(Date.parse(draft.startsAt))} → ${fmtDate(Date.parse(draft.endsAt))}`,
    `展示上限：${draft.maxImpressions === 0 ? '不限' : draft.maxImpressions}`,
    `位置：${draft.placement}`,
  ].join('\n');
}

function adPreviewText(ad) {
  return [
    renderText({ title: ad.title, body: ad.body, sponsorName: ad.sponsorName }),
    '',
    `状态：${STATUS_LABEL[ad.status] || ad.status}`,
    `链接：${ad.targetUrl || '无（纯文字广告）'}`,
    `时间：${fmtDate(ad.startsAt)} → ${fmtDate(ad.endsAt)}`,
    `展示上限：${ad.maxImpressions === 0 ? '不限' : ad.maxImpressions}`,
    `位置：${ad.placement.join('/')}`,
    `曝光：${ad.impressions} / 点击：${ad.clicks}`,
  ].join('\n');
}

function adListKeyboard(adService) {
  const ads = adService.getAllAds();
  const rows = [
    [
      Markup.button.callback(
        adService.enabled ? '🔘 广告总开关：开' : '🔘 广告总开关：关',
        'adadmin:toggle'
      ),
    ],
    ...ads.map((ad) => [
      Markup.button.callback('👁 预览', `adadmin:preview:${ad.id}`),
      Markup.button.callback(
        ad.status === 'approved' ? '⏸ 暂停' : '✅ 审核',
        `adadmin:${ad.status === 'approved' ? 'pause' : 'approve'}:${ad.id}`
      ),
      Markup.button.callback('📊 统计', `adadmin:stats:${ad.id}`),
    ]),
  ];
  return Markup.inlineKeyboard(rows);
}

function adListText(adService) {
  const state = adService.enabled ? '开' : '关';
  const ads = adService.getAllAds();
  if (!ads.length) {
    return `📋 广告列表\n\n🔘 广告总开关：${state}\n\n还没有广告。\n使用 /ad_new 新建第一个。`;
  }
  const lines = ads.map(
    (ad, index) =>
      `${index + 1}. [${STATUS_LABEL[ad.status] || ad.status}] ${ad.title}（${ad.id}）\n` +
      `   曝光 ${ad.impressions} / 点击 ${ad.clicks}`
  );
  return [`📋 广告列表`, `🔘 广告总开关：${state}`, '', ...lines, '', '点下面按钮管理：'].join('\n');
}

/**
 * 注册广告管理命令与回调（阶段 C 子集）。
 * deps: { config, adService, logger, setSession, clearSession, replyMain, assertPrivateChat, mainKeyboard }
 * 返回 { handleWizardText } 供 bot.js 的文本会话分发调用。
 */
function registerAdAdmin(bot, deps) {
  const { config, adService, logger, setSession, clearSession, replyMain, assertPrivateChat, mainKeyboard } = deps;

  async function requireAdmin(ctx) {
    if (!assertPrivateChat(ctx)) return false;
    if (!adService) {
      await ctx.reply('广告服务未启用。');
      return false;
    }
    if (!config.adminUserIds.length || !config.adminUserIds.includes(ctx.from.id)) {
      logger.info('ad.admin.denied', { user: maskUserId(ctx.from.id) });
      await ctx.reply('无权限：该命令仅限管理员使用。');
      return false;
    }
    return true;
  }

  function stepPrompt(ctx, session, step) {
    const def = WIZARD_STEPS.find((item) => item.key === step);
    session.step = step;
    setSession(ctx.from.id, session);
    return ctx.reply(def ? def.prompt : '继续：', CANCEL_KEYBOARD);
  }

  function goConfirm(ctx, session, data) {
    session.step = 'confirm';
    session.data = data;
    setSession(ctx.from.id, session);
    const draft = buildDraft(data);
    return ctx.reply(
      ['确认保存以下广告？', '', previewDraftText(draft), '', '回复「是」保存草稿，或「否」取消。'].join('\n'),
      CONFIRM_KEYBOARD
    );
  }

  function handleWizardText(ctx, session) {
    const data = session.data || {};
    const text = (ctx.message.text || '').trim();
    const invalid = (msg) =>
      ctx.reply(`${msg}\n请重新输入，或点「❌ 取消」。`, CANCEL_KEYBOARD);

    switch (session.step) {
      case 'title': {
        if (!text) return invalid('标题不能为空');
        if (text.length > 60) return invalid('标题不能超过 60 字');
        data.title = text;
        return stepPrompt(ctx, session, 'body');
      }
      case 'body': {
        if (text !== '-' && text.toLowerCase() !== '跳过' && text.length > 500) {
          return invalid('正文不能超过 500 字');
        }
        data.body = text === '-' || text.toLowerCase() === '跳过' ? '' : text;
        return stepPrompt(ctx, session, 'sponsorName');
      }
      case 'sponsorName': {
        if (!text) return invalid('赞助商名称不能为空');
        if (text.length > 40) return invalid('赞助商名称不能超过 40 字');
        data.sponsorName = text;
        return stepPrompt(ctx, session, 'buttonText');
      }
      case 'buttonText': {
        if (text.length > 30) return invalid('按钮文字不能超过 30 字');
        data.buttonText = text; // 留空 = 使用默认「了解详情」
        return stepPrompt(ctx, session, 'startsAt');
      }
      case 'targetUrl': {
        const check = validateUrl(text);
        if (!check.ok) return invalid(check.error);
        data.targetUrl = check.value;
        if (check.value) {
          return stepPrompt(ctx, session, 'buttonText');
        }
        // 纯文字广告：无链接，跳过按钮步骤
        data.buttonText = '';
        return stepPrompt(ctx, session, 'startsAt');
      }
      case 'startsAt': {
        const parsed = parseFlexibleDate(text);
        if (!parsed.ok) return invalid('时间格式无法识别');
        data.startsAt = parsed.value;
        return stepPrompt(ctx, session, 'endsAt');
      }
      case 'endsAt': {
        const parsed = parseFlexibleDate(text);
        if (!parsed.ok) return invalid('时间格式无法识别');
        if (parsed.value && data.startsAt && Date.parse(parsed.value) <= Date.parse(data.startsAt)) {
          return invalid('结束时间必须晚于开始时间');
        }
        data.endsAt = parsed.value;
        return stepPrompt(ctx, session, 'maxImpressions');
      }
      case 'maxImpressions': {
        const parsed = parseMaxImpressions(text);
        if (!parsed.ok) return invalid('请输入 ≥0 的整数');
        data.maxImpressions = parsed.value;
        return stepPrompt(ctx, session, 'placement');
      }
      case 'placement': {
        const parsed = parsePlacement(text);
        if (!parsed.ok) return invalid('仅支持 query_result 或 both');
        data.placement = parsed.value;
        return goConfirm(ctx, session, data);
      }
      case 'confirm': {
        const yes = ['是', 'y', 'yes', '确认'].includes(text.toLowerCase());
        const no = ['否', 'n', 'no', '取消'].includes(text.toLowerCase());
        if (!yes && !no) return invalid('请输入「是」或「否」');
        if (no) {
          clearSession(ctx.from.id);
          return replyMain(ctx, '已取消新建广告。');
        }
        const draft = buildDraft(data);
        const result = adService.createAd(draft, ctx.from.id);
        clearSession(ctx.from.id);
        if (!result.ok) {
          return ctx.reply(`创建失败：\n${result.errors.join('\n')}`, CANCEL_KEYBOARD);
        }
        logger.info('ad.admin.created', { adId: result.ad.id, user: maskUserId(ctx.from.id) });
        return replyMain(
          ctx,
          `✅ 已创建草稿 ${result.ad.id}。\n用 /ad_list 预览审核，或 /ad_approve ${result.ad.id} 直接投放。`
        );
      }
      default: {
        clearSession(ctx.from.id);
        return undefined;
      }
    }
  }

  async function showList(ctx) {
    if (!(await requireAdmin(ctx))) return;
    await ctx.reply(adListText(adService), { ...mainKeyboard, ...adListKeyboard(adService) });
  }

  bot.command('ad_new', async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    setSession(ctx.from.id, { type: 'ad_new', step: 'title', data: {} });
    await ctx.reply(`📝 新建广告（草稿），依次填写：\n\n${WIZARD_STEPS[0].prompt}`, CANCEL_KEYBOARD);
  });

  bot.command('ad_list', async (ctx) => showList(ctx));

  bot.command('ad_preview', async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const id = (ctx.message.text.trim().split(/\s+/)[1] || '').trim();
    const ad = id ? adService.getAdById(id) : undefined;
    if (!ad) {
      await ctx.reply('广告不存在，可用 /ad_list 查看所有广告 ID。', mainKeyboard);
      return;
    }
    await ctx.reply(adPreviewText(ad), mainKeyboard);
  });

  bot.command('ad_approve', async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const id = (ctx.message.text.trim().split(/\s+/)[1] || '').trim();
    const result = id ? adService.setStatus(id, 'approved', ctx.from.id) : { ok: false, errors: ['缺少广告 ID'] };
    if (!result.ok) {
      await ctx.reply(`操作失败：${result.errors.join('、')}`, mainKeyboard);
      return;
    }
    logger.info('ad.admin.approved', { adId: id, user: maskUserId(ctx.from.id) });
    await ctx.reply(`✅ 已审核通过并投放：${result.ad.title}（${result.ad.id}）`, mainKeyboard);
  });

  bot.command('ad_pause', async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const id = (ctx.message.text.trim().split(/\s+/)[1] || '').trim();
    const result = id ? adService.setStatus(id, 'paused', ctx.from.id) : { ok: false, errors: ['缺少广告 ID'] };
    if (!result.ok) {
      await ctx.reply(`操作失败：${result.errors.join('、')}`, mainKeyboard);
      return;
    }
    logger.info('ad.admin.paused', { adId: id, user: maskUserId(ctx.from.id) });
    await ctx.reply(`⏸ 已暂停：${result.ad.title}（${result.ad.id}）`, mainKeyboard);
  });

  bot.command('ad_stats', async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const id = (ctx.message.text.trim().split(/\s+/)[1] || '').trim();
    const stats = id ? adService.getStats(id) : undefined;
    if (!stats) {
      await ctx.reply('广告不存在，可用 /ad_list 查看所有广告 ID。', mainKeyboard);
      return;
    }
    const ctr = stats.impressions > 0 ? `${((stats.clicks / stats.impressions) * 100).toFixed(2)}%` : '-';
    await ctx.reply(
      `📊 统计（${id}）\n曝光：${stats.impressions}\n点击：${stats.clicks}\nCTR：${ctr}`,
      mainKeyboard
    );
  });

  bot.action('adadmin:toggle', async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const next = !adService.enabled;
    adService.setEnabled(next, ctx.from.id);
    logger.info('ad.admin.toggle', { enabled: next, user: maskUserId(ctx.from.id) });
    await ctx.answerCbQuery(next ? '✅ 已开启广告' : '⛔ 已关闭广告');
    await ctx.reply(adListText(adService), { ...mainKeyboard, ...adListKeyboard(adService) });
  });

  bot.action(/^adadmin:(preview|approve|pause|stats):(.+)$/, async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const action = ctx.match[1];
    const id = ctx.match[2];
    const ad = adService.getAdById(id);
    if (!ad) {
      await ctx.answerCbQuery('广告不存在').catch(() => {});
      return;
    }
    await ctx.answerCbQuery();
    if (action === 'preview') {
      await ctx.reply(adPreviewText(ad), mainKeyboard);
    } else if (action === 'approve' || action === 'pause') {
      const next = action === 'approve' ? 'approved' : 'paused';
      const result = adService.setStatus(id, next, ctx.from.id);
      logger.info('ad.admin.action', { action, adId: id, user: maskUserId(ctx.from.id) });
      await ctx.reply(
        result.ok
          ? `${action === 'approve' ? '✅ 已审核通过' : '⏸ 已暂停'}：${result.ad.title}（${result.ad.id}）`
          : `操作失败：${result.errors.join('、')}`,
        mainKeyboard
      );
    } else if (action === 'stats') {
      const stats = adService.getStats(id);
      const ctr = stats.impressions > 0 ? `${((stats.clicks / stats.impressions) * 100).toFixed(2)}%` : '-';
      await ctx.reply(
        `📊 统计（${id}）\n曝光：${stats.impressions}\n点击：${stats.clicks}\nCTR：${ctr}`,
        mainKeyboard
      );
    }
  });

  return { handleWizardText };
}

module.exports = { registerAdAdmin, parseFlexibleDate, parsePlacement, parseMaxImpressions, validateUrl, buildDraft, previewDraftText, adPreviewText, adListText };
