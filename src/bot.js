'use strict';

const { Telegraf, Markup } = require('telegraf');
const {
  isValidTronAddress,
  getCurrentChinaYearMonth,
  fetchUsdtCnyRate,
  queryMonthIncome,
  queryYearToDate,
  probeApiKey,
  buildCsv,
  summarizeRecords,
} = require('./trongrid');
const { Logger, maskApiKey, maskUserId } = require('./logger');
const { Semaphore, RateLimiter, QueryCache } = require('./query-gate');
const { renderText, renderKeyboard } = require('./ad-renderer');
const { registerAdAdmin } = require('./ad-admin');
const { BTN, TEXT, MAIN_KEYBOARD, CANCEL_KEYBOARD } = require('./keyboards');
const { WatchService } = require('./watch-service');
const { parsePeriod, validateYearMonth, normalizeApiKey, monthLabel } = require('./utils');
const { SessionManager } = require('./session-manager');

function createBot(config, storage, adService = null, externalWatchService = null) {
  const bot = new Telegraf(config.telegramBotToken);
  const logger = new Logger(config.logLevel);
  const queryingUsers = new Set();
  const querySemaphore = new Semaphore(config.globalQueryConcurrency);
  const rateLimiter = new RateLimiter(config.maxQueriesPerUserPerMin, 60000);
  const queryCache = new QueryCache(config.queryCacheTtlMs, 50);
  const sessionManager = new SessionManager(config.sessionTtlMs, 10000);
  sessionManager.start();

  // 汇率缓存：5分钟TTL，避免并发查询时重复请求 CoinGecko
  let cachedRate = null;
  let rateExpiry = 0;
  const RATE_CACHE_TTL = 300000; // 5分钟

  const resolvedWatchService =
    externalWatchService ||
    new WatchService({
      storage,
      bot,
      config,
      logger,
    });
  bot.watchService = resolvedWatchService;

  const originalStop = bot.stop.bind(bot);
  bot.stop = async (reason) => {
    sessionManager.stop();
    resolvedWatchService.stop();
    await originalStop(reason);
  };

  // ---------- 访问控制 ----------
  bot.use(async (ctx, next) => {
    if (!ctx.from) return next();
    if (config.allowedUserIds.length > 0 && !config.allowedUserIds.includes(ctx.from.id)) {
      logger.info('bot.denied.user', {
        user: maskUserId(ctx.from.id),
        chat: ctx.chat?.type,
      });
      try {
        if (ctx.callbackQuery) await ctx.answerCbQuery('未授权');
        await ctx.reply('该 Bot 未授权给你使用。');
      } catch {
        // ignore
      }
      return;
    }
    return next();
  });

  function resolveApiKey(user) {
    return normalizeApiKey(user.apiKey || config.defaultTronGridApiKey || '');
  }

  function resolveRate(user) {
    if (Number.isFinite(user.usdtRate) && user.usdtRate > 0) return user.usdtRate;
    return config.defaultUsdtCnyRate;
  }

  /** 敏感操作仅限私聊（可配置关闭） */
  function assertPrivateChat(ctx) {
    if (!config.requirePrivateChat) return true;
    if (ctx.chat?.type === 'private') return true;
    ctx.reply('敏感操作仅允许在私聊中使用，请直接私聊本 Bot。', MAIN_KEYBOARD).catch(() => {});
    return false;
  }

  function clearSession(userId) {
    sessionManager.delete(userId);
  }

  function setSession(userId, session) {
    sessionManager.set(userId, session);
  }

  function getSession(userId) {
    return sessionManager.get(userId);
  }

  async function replyMain(ctx, text, extra = {}) {
    return ctx.reply(text, { ...extra, ...MAIN_KEYBOARD });
  }

  function helpText(configHasDefaultKey) {
    return [
      'TRON USDT 链上收入分析',
      '',
      '所有命令已收进输入框左侧的「📋 菜单」按钮。',
      '点 /start 或 /menu，聊天窗口里会弹出快捷按钮，用完自动收起。',
      '',
      '📥 查询本月 — 查当前北京时间月份收入',
      '📅 选择月份 — 点选要查的月份',
      '📄 导出本月 — 导出当前月 CSV',
      '🔍 临时查询 — 查任意地址的月收入（不加进地址管理）',
      '📋 地址管理 — 查看/删除地址',
      '➕ 添加地址 — 按提示添加',
      '⚙️ 设置 — API Key / 汇率 / 排除自转',
      '',
      '高级用户仍可用命令：/query /export /add /list /setkey ...',
      configHasDefaultKey
        ? '服务器已配置默认 TronGrid API Key，也可自己设置。'
        : '未配置 API Key 时使用公共接口（有频率限制）。若查询被限流，可在「设置」里添加从 trongrid.io 注册的免费 Key。',
    ].join('\n');
  }

  function settingsText(user) {
    const apiKey = resolveApiKey(user);
    return [
      '⚙️ 设置',
      '',
      `API Key：${apiKey ? maskApiKey(apiKey) : '未配置'}`,
      `汇率：1 USDT = ${resolveRate(user)} 元${user.usdtRate == null ? '（默认）' : '（个人）'}`,
      `排除自有地址互转：${user.excludeSelf ? '开' : '关'}`,
      '',
      '点下面按钮修改：',
    ].join('\n');
  }

  function settingsKeyboard(user) {
    return Markup.inlineKeyboard([
      [Markup.button.callback('🔑 设置 API Key', 'set:apikey')],
      [
        Markup.button.callback('💱 设置汇率', 'set:rate'),
        Markup.button.callback('🌐 用实时汇率', 'set:rate_live'),
      ],
      [
        Markup.button.callback(
          user.excludeSelf ? '🔁 排除自转：开' : '🔁 排除自转：关',
          'set:exclude_toggle'
        ),
      ],
      [Markup.button.callback('🔄 刷新', 'set:refresh')],
    ]);
  }

  function addressKeyboard(user) {
    if (!user.addresses.length) {
      return Markup.inlineKeyboard([
        [Markup.button.callback('➕ 去添加地址', 'nav:add')],
      ]);
    }
    const rows = user.addresses.map((item, index) => [
      Markup.button.callback(
        `🗑 ${index + 1}. ${item.label}`.slice(0, 60),
        `del:${index + 1}`
      ),
    ]);
    rows.push([Markup.button.callback('➕ 添加地址', 'nav:add')]);
    rows.push([Markup.button.callback('🔄 刷新列表', 'nav:list')]);
    return Markup.inlineKeyboard(rows);
  }

  function addressListText(user) {
    if (!user.addresses.length) {
      return '尚未添加地址。\n点「➕ 添加地址」或下方按钮开始。';
    }
    const lines = user.addresses.map(
      (item, index) => `${index + 1}. ${item.label}\n   ${item.address}`
    );
    return [`📋 地址列表（${user.addresses.length}）`, ...lines, '', '点下面按钮可删除对应地址：'].join(
      '\n'
    );
  }

  function watchDirectionText(direction) {
    if (direction === 'out') return '转出';
    if (direction === 'both') return '全部';
    return '到账';
  }

  function watchKeyboard(user) {
    const rows = [];
    const watched = Array.isArray(user.watchedAddresses) ? user.watchedAddresses : [];
    if (!watched.length) {
      rows.push([Markup.button.callback('📡 添加监听地址', 'watch:add')]);
    } else {
      watched.forEach((item, index) => {
        rows.push([
          Markup.button.callback(
            `🗑 ${index + 1}. ${item.label} · ${watchDirectionText(item.direction)}`.slice(0, 60),
            `wdel:${index + 1}`
          ),
        ]);
      });
      rows.push([Markup.button.callback('📡 添加监听地址', 'watch:add')]);
    }
    rows.push([Markup.button.callback('🔄 刷新', 'watch:refresh')]);
    return Markup.inlineKeyboard(rows);
  }

  function watchListText(user) {
    const watched = Array.isArray(user.watchedAddresses) ? user.watchedAddresses : [];
    if (!watched.length) {
      return '📡 地址监听\n\n尚未添加监听地址。\n监听需要先设置个人 TronGrid API Key，之后可无限制添加地址，到账/转出时会自动通知。';
    }
    const lines = watched.map(
      (item, index) =>
        `${index + 1}. ${item.label} · ${watchDirectionText(item.direction)}\n   ${item.address}`
    );
    return [`📡 地址监听（${watched.length}）`, ...lines, '', '点下面按钮可删除对应监听：'].join('\n');
  }

  function watchAddDirectionKeyboard() {
    return Markup.inlineKeyboard([
      [Markup.button.callback('全部（到账+转出）', 'watch:dir:both')],
      [Markup.button.callback('⬇️ 到账', 'watch:dir:in'), Markup.button.callback('⬆️ 转出', 'watch:dir:out')],
      [Markup.button.callback('❌ 取消', 'nav:close')],
    ]);
  }

  function watchImportKeyboard(user) {
    const addresses = Array.isArray(user.addresses) ? user.addresses : [];
    const rows = [];
    addresses.slice(0, 20).forEach((item, index) => {
      rows.push([
        Markup.button.callback(
          `📥 ${index + 1}. ${item.label}`.slice(0, 60),
          `watch:import:${index + 1}`
        ),
      ]);
    });
    rows.push([Markup.button.callback('⌨️ 手动输入', 'watch:manual')]);
    rows.push([Markup.button.callback('❌ 取消', 'nav:close')]);
    return Markup.inlineKeyboard(rows);
  }

  async function showWatch(ctx) {
    if (!assertPrivateChat(ctx)) return;
    const user = storage.getUser(ctx.from.id);
    await ctx.reply(watchListText(user), {
      ...MAIN_KEYBOARD,
      ...watchKeyboard(user),
    });
  }

  async function startAddWatch(ctx) {
    if (!assertPrivateChat(ctx)) return;
    const user = storage.getUser(ctx.from.id);
    if (!normalizeApiKey(user.apiKey)) {
      setSession(ctx.from.id, { type: 'watch_set_key' });
      await ctx.reply(
        [
          '📡 地址监听需要 TronGrid API Key。',
          '',
          '请发送你的 TronGrid API Key，或直接点「🔑 去设置 API Key」后在「设置」里保存。',
          '',
          '也可以发送 clear 取消。',
        ].join('\n'),
        CANCEL_KEYBOARD
      );
      return;
    }
    const existingAddresses = Array.isArray(user.addresses) ? user.addresses : [];
    if (existingAddresses.length) {
      setSession(ctx.from.id, { type: 'add_watch', step: 'import' });
      const lines = existingAddresses
        .slice(0, 20)
        .map((item, index) => `${index + 1}. ${item.label}\n   ${item.address}`);
      await ctx.reply(
        ['📡 添加监听地址', '', '已发现地址管理里的地址，可选择直接导入：', '', ...lines, '', '也可以「手动输入」其他地址。'].join(
          '\n'
        ),
        {
          ...MAIN_KEYBOARD,
          ...watchImportKeyboard(user),
        }
      );
      return;
    }
    setSession(ctx.from.id, { type: 'add_watch', step: 'address' });
    await ctx.reply(
      [
        '📡 添加监听地址',
        '',
        '请发送 TRON 地址（T 开头，34 位），只监听 USDT。',
        '也可以一行写：地址 标签',
        '例如：',
        'THpMhA9fLPdbPVFkxpGWcXxyEfsxd1bxeJ 钱包1',
        '',
        '点「❌ 取消」可退出。',
      ].join('\n'),
      CANCEL_KEYBOARD
    );
  }

async function saveWatchedAddress(ctx, address, label, direction) {
    const result = storage.addWatchedAddress(ctx.from.id, address, label, direction);
    clearSession(ctx.from.id);
    if (!result.ok) {
      if (result.reason === 'invalid_address') {
        await replyMain(ctx, '监听地址格式不对，已取消。');
      } else {
        await replyMain(ctx, '该监听地址已存在。');
      }
      return;
    }
    const dirText = watchDirectionText(direction);
    await replyMain(ctx, `✅ 已添加监听地址\n${address}\n标签：${label}\n方向：${dirText}\n\n之后到账/转出 USDT 会自动通知。`);
  }

  async function startAddWatchDirection(ctx, address, label) {
    setSession(ctx.from.id, {
      type: 'add_watch',
      step: 'direction',
      data: { address, label },
    });
    await ctx.reply(
      `✅ 地址校验通过：${address}\n标签：${label}\n\n请选择监听方向：`,
      {
        ...MAIN_KEYBOARD,
        ...watchAddDirectionKeyboard(),
      }
    );
  }

  function monthPickerKeyboard(exportMode = false) {
    const { year, month } = getCurrentChinaYearMonth();
    const prefix = exportMode ? 'exm' : 'qm';
    const rows = [
      [Markup.button.callback(`📊 今年总收入（${year} 年至今）`, 'ytd:current')],
    ];
    // 当前年 12 个月
    for (let start = 1; start <= 12; start += 3) {
      rows.push(
        [0, 1, 2].map((offset) => {
          const m = start + offset;
          const label = m === month ? `·${m}月·` : `${m}月`;
          return Markup.button.callback(label, `${prefix}:${year}:${m}`);
        })
      );
    }
    // 快速：上月 / 今年几个近月也可够用；再给上年入口
    const prevYear = year - 1;
    rows.push([
      Markup.button.callback(`${prevYear}年…`, `ypick:${prefix}:${prevYear}`),
      Markup.button.callback('关闭', 'nav:close'),
    ]);
    return Markup.inlineKeyboard(rows);
  }

  function yearMonthPickerKeyboard(prefix, year) {
    const rows = [];
    for (let start = 1; start <= 12; start += 3) {
      rows.push(
        [0, 1, 2].map((offset) => {
          const m = start + offset;
          return Markup.button.callback(`${m}月`, `${prefix}:${year}:${m}`);
        })
      );
    }
    rows.push([Markup.button.callback('« 返回今年', `ypick:${prefix}:current`)]);
    return Markup.inlineKeyboard(rows);
  }

  // 临时查询：选择月份 / 年份
  function tempMonthPickerKeyboard(year) {
    const rows = [];
    for (let start = 1; start <= 12; start += 3) {
      rows.push(
        [0, 1, 2].map((offset) => {
          const m = start + offset;
          return Markup.button.callback(`${m}月`, `tqm:${year}:${m}`);
        })
      );
    }
    rows.push([
      Markup.button.callback(`${year - 1}年…`, `tpick:${year - 1}`),
      Markup.button.callback('关闭', 'nav:close'),
    ]);
    return Markup.inlineKeyboard(rows);
  }

  function tempYearPickerKeyboard(year) {
    const rows = [];
    for (let start = 1; start <= 12; start += 3) {
      rows.push(
        [0, 1, 2].map((offset) => {
          const m = start + offset;
          return Markup.button.callback(`${m}月`, `tqm:${year}:${m}`);
        })
      );
    }
    rows.push([Markup.button.callback('« 返回今年', 'tpick:current')]);
    return Markup.inlineKeyboard(rows);
  }

  async function startTempQuery(ctx) {
    if (!assertPrivateChat(ctx)) return;
    setSession(ctx.from.id, { type: 'temp_query', step: 'address' });
    await ctx.reply(
      [
        '🔍 临时查询',
        '',
        '请输入您要查询的地址（T 开头，34 位）：',
        '查询结果不会加入您的地址管理。',
        '',
        '点「❌ 取消」可退出。',
      ].join('\n'),
      CANCEL_KEYBOARD
    );
  }

  async function showAddresses(ctx) {
    if (!assertPrivateChat(ctx)) return;
    const user = storage.getUser(ctx.from.id);
    await ctx.reply(addressListText(user), {
      ...MAIN_KEYBOARD,
      ...addressKeyboard(user),
    });
  }

  async function showSettings(ctx) {
    if (!assertPrivateChat(ctx)) return;
    const user = storage.getUser(ctx.from.id);
    await ctx.reply(settingsText(user), {
      ...MAIN_KEYBOARD,
      ...settingsKeyboard(user),
    });
  }

  async function startAddAddress(ctx) {
    if (!assertPrivateChat(ctx)) return;
    setSession(ctx.from.id, { type: 'add_address', step: 'address' });
    await ctx.reply(
      [
        '➕ 添加地址',
        '',
        '请发送 TRON 地址（T 开头，34 位）。',
        '也可以一行写：地址 标签',
        '例如：',
        'THpMhA9fLPdbPVFkxpGWcXxyEfsxd1bxeJ 钱包1',
        '',
        '点「❌ 取消」可退出。',
      ].join('\n'),
      CANCEL_KEYBOARD
    );
  }

  async function startSetApiKey(ctx) {
    if (!assertPrivateChat(ctx)) return;
    setSession(ctx.from.id, { type: 'set_apikey' });
    await ctx.reply(
      [
        '🔑 设置 TronGrid API Key',
        '',
        '请直接发送 API Key（不要带 <> 或引号）。',
        '发送 clear 可清除个人 Key。',
        '',
        '点「❌ 取消」可退出。',
      ].join('\n'),
      CANCEL_KEYBOARD
    );
  }

  async function startSetRate(ctx) {
    if (!assertPrivateChat(ctx)) return;
    setSession(ctx.from.id, { type: 'set_rate' });
    await ctx.reply(
      [
        '💱 设置汇率',
        '',
        '请发送数字，例如：7.25',
        '发送 clear 恢复默认。',
        '',
        '点「❌ 取消」可退出。',
      ].join('\n'),
      CANCEL_KEYBOARD
    );
  }

  async function saveApiKey(ctx, raw) {
    if (!assertPrivateChat(ctx)) return;
    if (raw.toLowerCase() === 'clear' || raw.toLowerCase() === 'none') {
      storage.updateUser(ctx.from.id, { apiKey: '' });
      clearSession(ctx.from.id);
      logger.info('user.apikey.cleared', { user: maskUserId(ctx.from.id) });
      await replyMain(
        ctx,
        config.defaultTronGridApiKey
          ? '已清除个人 API Key，将使用服务器默认 Key。'
          : '已清除个人 API Key。'
      );
      return;
    }

    const apiKey = normalizeApiKey(raw);
    if (apiKey.length < 20) {
      await ctx.reply('API Key 看起来太短，请重新完整 /setkey <key>，或点「❌ 取消」。', CANCEL_KEYBOARD);
      return;
    }

    storage.updateUser(ctx.from.id, { apiKey });
    try {
      await ctx.deleteMessage();
    } catch {
      // ignore
    }

    // 复用 TronGrid 客户端配置做连通性探测，不再硬编码 URL
    const probeText = await probeApiKey(apiKey, {
      apiBase: config.trongridApiBase,
      timeout: config.requestTimeoutMs,
    });
    logger.info('user.apikey.saved', { user: maskUserId(ctx.from.id) });

    clearSession(ctx.from.id);
    await replyMain(ctx, `API Key 已保存：${maskApiKey(apiKey)}\n${probeText}`);
  }

  async function runQuery(ctx, { period, exportCsv, tempAddress }) {
    const userId = ctx.from.id;
    if (!assertPrivateChat(ctx)) return;
    if (queryingUsers.has(userId)) {
      await ctx.reply('你有正在进行的查询，请稍候。', MAIN_KEYBOARD);
      return;
    }
    if (!rateLimiter.allow(userId)) {
      await ctx.reply('查询太频繁了，请稍等片刻再试。', MAIN_KEYBOARD);
      return;
    }

    const user = storage.getUser(userId);
    const apiKey = resolveApiKey(user);
    // 未配置 API Key 时使用 TronGrid 公共接口（有限流），出错时提示注册免费 Key
    if (!tempAddress && !user.addresses.length) {
      await ctx.reply('请先添加地址。', {
        ...MAIN_KEYBOARD,
        ...Markup.inlineKeyboard([[Markup.button.callback('➕ 添加地址', 'nav:add')]]),
      });
      return;
    }
    const isYtd = period.type === 'ytd';
    const year = period.year;
    const month = period.month;
    if (!isYtd && !validateYearMonth(year, month)) {
      await ctx.reply('年月无效，请重新选择。', MAIN_KEYBOARD);
      return;
    }

    // 临时查询：只查单个地址，不加进地址管理，也不做排除自转
    const wallets = tempAddress
      ? [{ label: '临时地址', address: tempAddress }]
      : user.addresses.map((item) => ({ ...item }));
    const excludeSelf = tempAddress ? false : user.excludeSelf;

    queryingUsers.add(userId);
    const label = isYtd ? `${year} 年至今` : monthLabel(year, month);
    const status = await ctx.reply(`开始查询 ${label}（0/${wallets.length}）...`, MAIN_KEYBOARD);
    const startedAt = Date.now();
    const periodKey = isYtd ? `ytd:${year}` : `${year}:${month}`;
    const cacheKey = `${userId}|${periodKey}|${excludeSelf}|${exportCsv}|${apiKey}|${tempAddress || ''}`;
    // YTD 的结束时间是“现在”，结果随时变化，不做缓存
    const cached = !exportCsv && !isYtd ? queryCache.get(cacheKey) : undefined;
    const cacheHit = Boolean(cached);

    let progressActive = true;
    let progressChain = Promise.resolve();
    const editStatus = async (text) => {
      try {
        await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, text);
        return true;
      } catch {
        return false;
      }
    };

    try {
      let rate = resolveRate(user);
      let records = cached?.records || [];
      let errors = cached?.errors || [];
      let warnings = cached?.warnings || [];
      let deduped = cached?.deduped || 0;
      let totalMicros = cached?.totalMicros ?? 0n;

      if (!cached) {
        await querySemaphore.acquire();
        try {
          try {
            const now = Date.now();
            if (cachedRate && now < rateExpiry) {
              // 使用缓存的汇率
              if (!Number.isFinite(user.usdtRate) || user.usdtRate <= 0) rate = cachedRate;
            } else {
              // 缓存过期或不存在，重新获取
              const live = await fetchUsdtCnyRate(config.coingeckoRateUrl, {
                timeout: 10000,
                retries: config.maxRequestRetries,
              });
              cachedRate = live;
              rateExpiry = now + RATE_CACHE_TTL;
              if (!Number.isFinite(user.usdtRate) || user.usdtRate <= 0) rate = live;
            }
          } catch (error) {
            logger.warn('rate.fetch.failed', { error: error.message });
          }

          const queryOptions = {
            wallets,
            apiKey,
            excludeSelf,
            usdtContract: config.usdtContract,
            apiBase: config.trongridApiBase,
            concurrency: config.addressConcurrency,
            timeout: config.requestTimeoutMs,
            retries: config.maxRequestRetries,
            maxPages: config.maxPagesPerAddress,
            maxRecords: config.maxRecordsPerQuery,
            totalTimeoutMs: config.queryTotalTimeoutMs,
            onProgress: (completed, total) => {
              progressChain = progressChain
                .then(async () => {
                  if (!progressActive) return;
                  await editStatus(`查询 ${label}：${completed}/${total} 个地址...`);
                })
                .catch(() => {});
            },
            logger,
          };
          const result = isYtd
            ? await queryYearToDate(queryOptions)
            : await queryMonthIncome({ ...queryOptions, year, month });
          ({ records, errors, warnings, deduped, totalMicros } = result);
          if (!exportCsv && !isYtd && records.length <= 1000) {
            queryCache.set(cacheKey, { records, errors, warnings, deduped, totalMicros, rate });
          }
        } finally {
          querySemaphore.release();
        }
      } else {
        rate = cached.rate;
      }

      progressActive = false;
      await progressChain;

      let text = '';
      if (errors.length) text += `${errors.map((item) => `⚠️ ${item}`).join('\n')}\n\n`;
      if (warnings.length) text += `${warnings.map((item) => `⚠️ ${item}`).join('\n')}\n\n`;
      const exportHint = tempAddress
        ? ''
        : isYtd
          ? '可用 /export ytd 导出完整 CSV。'
          : `可用 /export ${year} ${month} 导出完整 CSV。`;
      text += summarizeRecords(records, totalMicros, rate, label, exportHint);
      text += `\n\n汇率：1 USDT = ${Number(rate).toFixed(4)} 元`;
      if (user.excludeSelf) text += '\n已排除自有地址互转';
      if (tempAddress) text += `\n\n📌 查询地址：${tempAddress}`;

      // 查询结果赞助位（阶段 A）：成功/部分成功时追加一条广告
      // 查询结果消息不挂常驻键盘，只在有广告按钮时附带内联按钮
      let replyText = text;
      let replyExtra = {};
      let shownAd = null;
      if (adService && adService.enabled) {
        try {
          if (adService.shouldShow()) {
            const ad = adService.selectAd();
            if (ad) {
              replyText = `${text}\n${renderText(ad)}`;
              const adKeyboard = renderKeyboard(ad);
              if (adKeyboard) replyExtra = adKeyboard;
              shownAd = ad;
            }
          }
        } catch (error) {
          logger.warn('ad.select.failed', { error: error.message });
        }
      }

      await editStatus(`查询完成 ${label}`);
      await ctx.reply(replyText, replyExtra);

      // 消息发送成功后才记录曝光（发送失败不虚增曝光量）
      if (shownAd) {
        adService.recordImpression(shownAd.id, ctx.from.id);
        logger.info('ad.impression', {
          adId: shownAd.id,
          user: maskUserId(ctx.from.id),
          source: 'query_result',
        });
      }

      logger.info('query.completed', {
        user: maskUserId(userId),
        month: label,
        records: records.length,
        deduped,
        failed: errors.length,
        warnings: warnings.length,
        cacheHit,
        durationMs: Date.now() - startedAt,
        exportCsv,
      });

      if (exportCsv && records.length) {
        const { csv, filename } = buildCsv(records, year, isYtd ? 'ytd' : month);
        await ctx.replyWithDocument({
          source: Buffer.from(csv, 'utf8'),
          filename,
        });
      } else if (!exportCsv && !tempAddress && records.length) {
        const exportCallback = isYtd ? `export:y:${year}` : `export:m:${year}:${month}`;
        await ctx.reply('需要完整明细时，可点下方导出：', {
          ...Markup.inlineKeyboard([
            [Markup.button.callback(`📄 导出 ${label} CSV`, exportCallback)],
          ]),
        });
      }
    } catch (error) {
      progressActive = false;
      await progressChain;
      logger.error('query.failed', {
        user: maskUserId(userId),
        month: label,
        error: error.message,
      });
      const failText = `查询失败：${error.message || error}`;
      const edited = await editStatus(failText);
      if (!edited) await ctx.reply(failText, MAIN_KEYBOARD);
    } finally {
      queryingUsers.delete(userId);
    }
  }

  // 广告管理命令（阶段 C 子集）：/ad_new /ad_list /ad_preview /ad_approve /ad_pause /ad_stats
  const adAdmin = adService
    ? registerAdAdmin(bot, {
        config,
        adService,
        logger,
        setSession,
        clearSession,
        replyMain,
        assertPrivateChat,
        mainKeyboard: MAIN_KEYBOARD,
      })
    : null;

  // ---------- 命令（兼容） ----------
  bot.start(async (ctx) => {
    clearSession(ctx.from.id);
    await replyMain(ctx, helpText(Boolean(config.defaultTronGridApiKey)));
  });

  bot.help(async (ctx) => {
    await replyMain(ctx, helpText(Boolean(config.defaultTronGridApiKey)));
  });

  bot.command('watch', async (ctx) => {
    if (!assertPrivateChat(ctx)) return;
    const args = ctx.message.text.trim().split(/\s+/).slice(1).filter(Boolean);
    if (!args.length) {
      await showWatch(ctx);
      return;
    }
    const first = args[0];
    if (first === 'add') {
      await startAddWatch(ctx);
      return;
    }
    if (first === 'del' || first === 'delete') {
      const target = args[1] || '';
      const result = target ? storage.deleteWatchedAddress(ctx.from.id, target) : { ok: false };
      if (!result.ok) {
        await replyMain(ctx, '未找到该监听地址。');
        return;
      }
      await replyMain(ctx, `已删除监听：${result.removed.label}\n${result.removed.address}（${watchDirectionText(result.removed.direction)}）`);
      return;
    }
    await replyMain(ctx, '用法：/watch 查看监听；/watch add 添加监听；/watch del <序号或地址> 删除监听。');
  });

  bot.command('setkey', async (ctx) => {
    const raw = ctx.message.text.trim().split(/\s+/).slice(1).join(' ').trim();
    if (!raw) {
      await startSetApiKey(ctx);
      return;
    }
    await saveApiKey(ctx, raw);
  });

  bot.command('add', async (ctx) => {
    if (!assertPrivateChat(ctx)) return;
    const parts = ctx.message.text.trim().split(/\s+/);
    const address = (parts[1] || '').trim();
    const label = parts.slice(2).join(' ').trim() || '默认标签';
    if (!address) {
      await startAddAddress(ctx);
      return;
    }
    if (!isValidTronAddress(address)) {
      await replyMain(ctx, '无效的 TRON 地址：应为 34 位且以 T 开头。');
      return;
    }
    const result = storage.addAddress(ctx.from.id, address, label);
    if (!result.ok) {
      await replyMain(ctx, result.reason === 'invalid_address' ? '无效的 TRON 地址。' : '该地址已存在。');
      return;
    }
    await replyMain(ctx, `已添加：${label}\n${address}`);
  });

  bot.command('list', async (ctx) => showAddresses(ctx));

  bot.command('del', async (ctx) => {
    if (!assertPrivateChat(ctx)) return;
    const target = (ctx.message.text.trim().split(/\s+/)[1] || '').trim();
    if (!target) {
      await showAddresses(ctx);
      return;
    }
    const result = storage.deleteAddress(ctx.from.id, target);
    if (!result.ok) {
      await replyMain(ctx, '未找到该地址。');
      return;
    }
    await replyMain(ctx, `已删除：${result.removed.label}\n${result.removed.address}`);
  });

  bot.command('rate', async (ctx) => {
    if (!assertPrivateChat(ctx)) return;
    const arg = (ctx.message.text.trim().split(/\s+/)[1] || '').trim().toLowerCase();
    const user = storage.getUser(ctx.from.id);
    if (!arg) {
      await showSettings(ctx);
      return;
    }
    if (arg === 'clear' || arg === 'default') {
      storage.updateUser(ctx.from.id, { usdtRate: null });
      await replyMain(ctx, `已恢复默认汇率：1 USDT = ${config.defaultUsdtCnyRate} 元`);
      return;
    }
    if (arg === 'live') {
      try {
        const live = await fetchUsdtCnyRate(config.coingeckoRateUrl, {
          timeout: 10000,
          retries: config.maxRequestRetries,
        });
        storage.updateUser(ctx.from.id, { usdtRate: Number(live.toFixed(4)) });
        await replyMain(ctx, `已保存实时汇率：1 USDT = ${live.toFixed(4)} 元`);
      } catch (error) {
        await replyMain(ctx, `获取实时汇率失败：${error.message || error}`);
      }
      return;
    }
    const rate = Number.parseFloat(arg);
    if (!Number.isFinite(rate) || rate <= 0) {
      await replyMain(ctx, '请输入有效汇率，例如 7.25');
      return;
    }
    storage.updateUser(ctx.from.id, { usdtRate: rate });
    await replyMain(ctx, `已设置汇率：1 USDT = ${rate} 元`);
  });

  bot.command('exclude', async (ctx) => {
    if (!assertPrivateChat(ctx)) return;
    const arg = (ctx.message.text.trim().split(/\s+/)[1] || '').trim().toLowerCase();
    const user = storage.getUser(ctx.from.id);
    if (!arg) {
      await showSettings(ctx);
      return;
    }
    if (arg !== 'on' && arg !== 'off') {
      await replyMain(ctx, '用法：/exclude on 或 /exclude off');
      return;
    }
    storage.updateUser(ctx.from.id, { excludeSelf: arg === 'on' });
    await replyMain(ctx, `已${arg === 'on' ? '开启' : '关闭'}排除自有地址互转`);
  });

  bot.command('query', async (ctx) => {
    const args = ctx.message.text.trim().split(/\s+/).slice(1);
    const current = getCurrentChinaYearMonth();
    const period = parsePeriod(args, current);
    await runQuery(ctx, { period, exportCsv: false });
  });

  bot.command('export', async (ctx) => {
    const args = ctx.message.text.trim().split(/\s+/).slice(1);
    const current = getCurrentChinaYearMonth();
    const period = parsePeriod(args, current);
    await runQuery(ctx, { period, exportCsv: true });
  });

  bot.command('temp', async (ctx) => {
    if (!assertPrivateChat(ctx)) return;
    const address = (ctx.message.text.trim().split(/\s+/)[1] || '').trim();
    if (!address) {
      await startTempQuery(ctx);
      return;
    }
    if (!isValidTronAddress(address)) {
      await replyMain(ctx, '地址格式错误：应为 34 位且以 T 开头。');
      return;
    }
    setSession(ctx.from.id, { type: 'temp_query', step: 'pick_month', data: { address } });
    const { year } = getCurrentChinaYearMonth();
    await ctx.reply(`✅ 地址校验通过：${address}\n\n请选择要查询的月份：`, tempMonthPickerKeyboard(year));
  });

  bot.command('menu', async (ctx) => {
    clearSession(ctx.from.id);
    await replyMain(ctx, '主菜单已打开，直接点下方按钮即可。');
  });

  bot.command('cancel', async (ctx) => {
    clearSession(ctx.from.id);
    await replyMain(ctx, '已取消。');
  });

  // ---------- 底部按钮 ----------
  bot.hears(BTN.HELP, async (ctx) => {
    clearSession(ctx.from.id);
    await replyMain(ctx, helpText(Boolean(config.defaultTronGridApiKey)));
  });

  bot.hears(BTN.QUERY_MONTH, async (ctx) => {
    clearSession(ctx.from.id);
    const current = getCurrentChinaYearMonth();
    await runQuery(ctx, {
      period: { type: 'month', year: current.year, month: current.month },
      exportCsv: false,
    });
  });

  bot.hears(BTN.EXPORT_MONTH, async (ctx) => {
    clearSession(ctx.from.id);
    const current = getCurrentChinaYearMonth();
    await runQuery(ctx, {
      period: { type: 'month', year: current.year, month: current.month },
      exportCsv: true,
    });
  });

  bot.hears(BTN.PICK_MONTH, async (ctx) => {
    clearSession(ctx.from.id);
    const { year } = getCurrentChinaYearMonth();
    await ctx.reply(`选择要查询的月份（${year} 年）：`, {
      ...MAIN_KEYBOARD,
      ...monthPickerKeyboard(false),
    });
  });

  bot.hears(BTN.ADDRESSES, async (ctx) => {
    clearSession(ctx.from.id);
    await showAddresses(ctx);
  });

  bot.hears(BTN.ADD_ADDR, async (ctx) => {
    await startAddAddress(ctx);
  });

  bot.hears(BTN.TEMP_QUERY, async (ctx) => {
    await startTempQuery(ctx);
  });

  bot.hears(BTN.SETTINGS, async (ctx) => {
    clearSession(ctx.from.id);
    await showSettings(ctx);
  });

  bot.hears(BTN.WATCH, async (ctx) => {
    clearSession(ctx.from.id);
    await showWatch(ctx);
  });

  bot.hears(BTN.CANCEL, async (ctx) => {
    clearSession(ctx.from.id);
    await replyMain(ctx, '已取消，回到主菜单。');
  });

  // ---------- 会话输入（添加地址 / 设置项） ----------
  bot.on('text', async (ctx, next) => {
    const text = (ctx.message.text || '').trim();
    if (text.startsWith('/')) return next();
    if (Object.values(BTN).includes(text)) return next();

    const session = getSession(ctx.from.id);
    if (!session) return next();

    if (session.type === 'ad_new' && adAdmin) {
      return adAdmin.handleWizardText(ctx, session);
    }

    if (session.type === 'temp_query' && session.step === 'address') {
      const address = text.trim();
      if (!isValidTronAddress(address)) {
        await ctx.reply('地址格式错误，请重新输入（T 开头，34 位），或点「❌ 取消」。', CANCEL_KEYBOARD);
        return;
      }
      setSession(ctx.from.id, { type: 'temp_query', step: 'pick_month', data: { address } });
      const { year } = getCurrentChinaYearMonth();
      await ctx.reply(`✅ 地址校验通过：${address}\n\n请选择要查询的月份：`, tempMonthPickerKeyboard(year));
      return;
    }

    if (session.type === 'add_address') {
      if (session.step === 'address') {
        const parts = text.split(/\s+/);
        const address = parts[0];
        const labelFromLine = parts.slice(1).join(' ').trim();
        if (!isValidTronAddress(address)) {
          await ctx.reply('地址格式不对。请发送 T 开头 34 位地址，或点「❌ 取消」。', CANCEL_KEYBOARD);
          return;
        }
        if (labelFromLine) {
          const result = storage.addAddress(ctx.from.id, address, labelFromLine);
          clearSession(ctx.from.id);
          if (!result.ok) {
            await replyMain(ctx, result.reason === 'invalid_address' ? '地址格式不对，已取消。' : '该地址已存在。');
            return;
          }
          await replyMain(ctx, `已添加：${labelFromLine}\n${address}`);
          return;
        }
        setSession(ctx.from.id, {
          type: 'add_address',
          step: 'label',
          data: { address },
        });
        await ctx.reply('请发送这个地址的标签（名称），例如：钱包A\n直接发「默认标签」也可以。', CANCEL_KEYBOARD);
        return;
      }
      if (session.step === 'label') {
        const label = text || '默认标签';
        const result = storage.addAddress(ctx.from.id, session.data.address, label);
        clearSession(ctx.from.id);
        if (!result.ok) {
          await replyMain(ctx, result.reason === 'invalid_address' ? '地址格式不对，已取消。' : '该地址已存在。');
          return;
        }
        await replyMain(ctx, `已添加：${label}\n${session.data.address}`);
        return;
      }
    }

    if (session.type === 'watch_set_key') {
      await saveApiKey(ctx, text);
      return;
    }

    if (session.type === 'add_watch' && session.step === 'address') {
      const parts = text.split(/\s+/);
      const address = parts[0];
      const labelFromLine = parts.slice(1).join(' ').trim() || '默认标签';
      if (!isValidTronAddress(address)) {
        await ctx.reply('地址格式不对（T 开头 34 位），或点「❌ 取消」。', CANCEL_KEYBOARD);
        return;
      }
      await startAddWatchDirection(ctx, address, labelFromLine);
      return;
    }

    if (session.type === 'set_apikey') {
      await saveApiKey(ctx, text);
      return;
    }

    if (session.type === 'set_rate') {
      if (text.toLowerCase() === 'clear' || text.toLowerCase() === 'default') {
        storage.updateUser(ctx.from.id, { usdtRate: null });
        clearSession(ctx.from.id);
        await replyMain(ctx, `已恢复默认汇率：1 USDT = ${config.defaultUsdtCnyRate} 元`);
        return;
      }
      const rate = Number.parseFloat(text);
      if (!Number.isFinite(rate) || rate <= 0) {
        await ctx.reply('请输入有效数字，例如 7.25，或点「❌ 取消」。', CANCEL_KEYBOARD);
        return;
      }
      storage.updateUser(ctx.from.id, { usdtRate: rate });
      clearSession(ctx.from.id);
      await replyMain(ctx, `已设置汇率：1 USDT = ${rate} 元`);
      return;
    }

    return next();
  });

  // ---------- 地址监听 ----------
  bot.action('watch:refresh', async (ctx) => {
    if (!assertPrivateChat(ctx)) return;
    await ctx.answerCbQuery('已刷新');
    const user = storage.getUser(ctx.from.id);
    try {
      await ctx.editMessageText(watchListText(user), watchKeyboard(user));
    } catch {
      await showWatch(ctx);
    }
  });

  bot.action('watch:add', async (ctx) => {
    await ctx.answerCbQuery();
    await startAddWatch(ctx);
  });

  bot.action(/^wdel:(\d+)$/, async (ctx) => {
    if (!assertPrivateChat(ctx)) return;
    const index = ctx.match[1];
    const result = storage.deleteWatchedAddress(ctx.from.id, index);
    if (!result.ok) {
      await ctx.answerCbQuery('未找到该监听');
      return;
    }
    await ctx.answerCbQuery('已删除');
    const user = storage.getUser(ctx.from.id);
    try {
      await ctx.editMessageText(
        `已删除监听：${result.removed.label}\n${result.removed.address}（${watchDirectionText(result.removed.direction)}）\n\n${watchListText(user)}`,
        watchKeyboard(user)
      );
    } catch {
      await showWatch(ctx);
    }
  });

  bot.action('watch:manual', async (ctx) => {
    await ctx.answerCbQuery();
    const session = getSession(ctx.from.id);
    if (session?.type !== 'add_watch' || session.step !== 'import') {
      clearSession(ctx.from.id);
      await ctx.reply('请重新发起添加监听。', MAIN_KEYBOARD);
      return;
    }
    setSession(ctx.from.id, { type: 'add_watch', step: 'address' });
    await ctx.reply(
      [
        '📡 添加监听地址',
        '',
        '请发送 TRON 地址（T 开头，34 位），只监听 USDT。',
        '也可以一行写：地址 标签',
        '',
        '点「❌ 取消」可退出。',
      ].join('\n'),
      CANCEL_KEYBOARD
    );
  });

  bot.action(/^watch:import:(\d+)$/, async (ctx) => {
    if (!assertPrivateChat(ctx)) return;
    const index = Number.parseInt(ctx.match[1], 10) - 1;
    const user = storage.getUser(ctx.from.id);
    const addressItem = Array.isArray(user.addresses) ? user.addresses[index] : undefined;
    const session = getSession(ctx.from.id);
    if (!addressItem || session?.type !== 'add_watch' || session.step !== 'import') {
      clearSession(ctx.from.id);
      await ctx.reply('导入地址已过期或无效，请重新发起。', MAIN_KEYBOARD);
      return;
    }
    setSession(ctx.from.id, {
      type: 'add_watch',
      step: 'direction',
      data: { address: addressItem.address, label: addressItem.label },
    });
    await ctx.reply(
      `✅ 已导入：${addressItem.label}\n${addressItem.address}\n\n请选择监听方向：`,
      {
        ...MAIN_KEYBOARD,
        ...watchAddDirectionKeyboard(),
      }
    );
  });

  bot.action('watch:dir:in', async (ctx) => {
    await ctx.answerCbQuery('开始监听');
    const session = getSession(ctx.from.id);
    if (session?.type !== 'add_watch' || session.step !== 'direction') {
      clearSession(ctx.from.id);
      await ctx.reply('添加监听会话已过期，请重新发起。', MAIN_KEYBOARD);
      return;
    }
    const { address, label } = session.data || {};
    await saveWatchedAddress(ctx, address, label, 'in');
  });

  bot.action('watch:dir:out', async (ctx) => {
    await ctx.answerCbQuery('开始监听');
    const session = getSession(ctx.from.id);
    if (session?.type !== 'add_watch' || session.step !== 'direction') {
      clearSession(ctx.from.id);
      await ctx.reply('添加监听会话已过期，请重新发起。', MAIN_KEYBOARD);
      return;
    }
    const { address, label } = session.data || {};
    await saveWatchedAddress(ctx, address, label, 'out');
  });

  bot.action('watch:dir:both', async (ctx) => {
    await ctx.answerCbQuery('开始监听');
    const session = getSession(ctx.from.id);
    if (session?.type !== 'add_watch' || session.step !== 'direction') {
      clearSession(ctx.from.id);
      await ctx.reply('添加监听会话已过期，请重新发起。', MAIN_KEYBOARD);
      return;
    }
    const { address, label } = session.data || {};
    await saveWatchedAddress(ctx, address, label, 'both');
  });

  // ---------- 内联按钮 ----------
  bot.action('nav:close', async (ctx) => {
    await ctx.answerCbQuery('已关闭');
    try {
      await ctx.editMessageReplyMarkup();
    } catch {
      // ignore
    }
  });

  bot.action('nav:add', async (ctx) => {
    await ctx.answerCbQuery();
    await startAddAddress(ctx);
  });

  bot.action('nav:list', async (ctx) => {
    if (!assertPrivateChat(ctx)) return;
    await ctx.answerCbQuery('已刷新');
    const user = storage.getUser(ctx.from.id);
    try {
      await ctx.editMessageText(addressListText(user), addressKeyboard(user));
    } catch {
      await showAddresses(ctx);
    }
  });

  bot.action(/^del:(\d+)$/, async (ctx) => {
    if (!assertPrivateChat(ctx)) return;
    const index = ctx.match[1];
    const result = storage.deleteAddress(ctx.from.id, index);
    if (!result.ok) {
      await ctx.answerCbQuery('未找到该地址');
      return;
    }
    await ctx.answerCbQuery('已删除');
    const user = storage.getUser(ctx.from.id);
    try {
      await ctx.editMessageText(
        `已删除：${result.removed.label}\n${result.removed.address}\n\n${addressListText(user)}`,
        addressKeyboard(user)
      );
    } catch {
      await showAddresses(ctx);
    }
  });

  bot.action('set:apikey', async (ctx) => {
    await ctx.answerCbQuery();
    await startSetApiKey(ctx);
  });

  bot.action('set:rate', async (ctx) => {
    await ctx.answerCbQuery();
    await startSetRate(ctx);
  });

  bot.action('set:rate_live', async (ctx) => {
    if (!assertPrivateChat(ctx)) return;
    await ctx.answerCbQuery('正在获取...');
    try {
      const live = await fetchUsdtCnyRate(config.coingeckoRateUrl, {
        timeout: 10000,
        retries: config.maxRequestRetries,
      });
      storage.updateUser(ctx.from.id, { usdtRate: Number(live.toFixed(4)) });
      const user = storage.getUser(ctx.from.id);
      try {
        await ctx.editMessageText(settingsText(user), settingsKeyboard(user));
      } catch {
        // ignore
      }
      await ctx.reply(`已保存实时汇率：1 USDT = ${live.toFixed(4)} 元`, MAIN_KEYBOARD);
    } catch (error) {
      await ctx.reply(`获取实时汇率失败：${error.message || error}`, MAIN_KEYBOARD);
    }
  });

  bot.action('set:exclude_toggle', async (ctx) => {
    if (!assertPrivateChat(ctx)) return;
    const user = storage.getUser(ctx.from.id);
    storage.updateUser(ctx.from.id, { excludeSelf: !user.excludeSelf });
    const next = storage.getUser(ctx.from.id);
    await ctx.answerCbQuery(next.excludeSelf ? '已开启排除自转' : '已关闭排除自转');
    try {
      await ctx.editMessageText(settingsText(next), settingsKeyboard(next));
    } catch {
      await showSettings(ctx);
    }
  });

  bot.action('set:refresh', async (ctx) => {
    if (!assertPrivateChat(ctx)) return;
    await ctx.answerCbQuery('已刷新');
    const user = storage.getUser(ctx.from.id);
    try {
      await ctx.editMessageText(settingsText(user), settingsKeyboard(user));
    } catch {
      await showSettings(ctx);
    }
  });

  bot.action(/^ypick:(qm|exm):(current|\d{4})$/, async (ctx) => {
    const prefix = ctx.match[1];
    const yearToken = ctx.match[2];
    const year =
      yearToken === 'current' ? getCurrentChinaYearMonth().year : Number.parseInt(yearToken, 10);
    await ctx.answerCbQuery();
    const exportMode = prefix === 'exm';
    const title =
      yearToken === 'current'
        ? `选择要${exportMode ? '导出' : '查询'}的月份（${year} 年）：`
        : `选择 ${year} 年的月份：`;
    try {
      if (yearToken === 'current') {
        await ctx.editMessageText(title, monthPickerKeyboard(exportMode));
      } else {
        await ctx.editMessageText(title, yearMonthPickerKeyboard(prefix, year));
      }
    } catch {
      await ctx.reply(title, {
        ...MAIN_KEYBOARD,
        ...(yearToken === 'current'
          ? monthPickerKeyboard(exportMode)
          : yearMonthPickerKeyboard(prefix, year)),
      });
    }
  });

  bot.action(/^(qm|exm):(\d{4}):(\d{1,2})$/, async (ctx) => {
    const exportCsv = ctx.match[1] === 'exm';
    const year = Number.parseInt(ctx.match[2], 10);
    const month = Number.parseInt(ctx.match[3], 10);
    await ctx.answerCbQuery(exportCsv ? '开始导出...' : '开始查询...');
    await runQuery(ctx, { period: { type: 'month', year, month }, exportCsv });
  });

  // 今年总收入：当年 1 月 1 日（北京时间）至当前时刻
  bot.action('ytd:current', async (ctx) => {
    const { year } = getCurrentChinaYearMonth();
    await ctx.answerCbQuery('开始查询今年总收入...');
    await runQuery(ctx, { period: { type: 'ytd', year }, exportCsv: false });
  });

  // 临时查询：选择月份 / 年份后查询临时地址
  bot.action(/^tqm:(\d{4}):(\d{1,2})$/, async (ctx) => {
    const year = Number.parseInt(ctx.match[1], 10);
    const month = Number.parseInt(ctx.match[2], 10);
    const session = getSession(ctx.from.id);
    const address =
      session?.type === 'temp_query' && session.step === 'pick_month' ? session.data?.address : undefined;
    await ctx.answerCbQuery('开始查询...');
    if (!address) {
      clearSession(ctx.from.id);
      await ctx.reply('临时查询已过期，请重新发起。', MAIN_KEYBOARD);
      return;
    }
    clearSession(ctx.from.id);
    await runQuery(ctx, {
      period: { type: 'month', year, month },
      exportCsv: false,
      tempAddress: address,
    });
  });

  bot.action(/^tpick:(current|\d{4})$/, async (ctx) => {
    const yearToken = ctx.match[1];
    const year =
      yearToken === 'current' ? getCurrentChinaYearMonth().year : Number.parseInt(yearToken, 10);
    await ctx.answerCbQuery();
    const title = `选择 ${year} 年的月份：`;
    const keyboard = yearToken === 'current' ? tempMonthPickerKeyboard(year) : tempYearPickerKeyboard(year);
    try {
      await ctx.editMessageText(title, keyboard);
    } catch {
      await ctx.reply(title, keyboard);
    }
  });

  bot.action(/^export:(m|y):(\d{4})(?::(\d{1,2}))?$/, async (ctx) => {
    const mode = ctx.match[1];
    const year = Number.parseInt(ctx.match[2], 10);
    const month = ctx.match[3] ? Number.parseInt(ctx.match[3], 10) : undefined;
    await ctx.answerCbQuery('开始导出...');
    await runQuery(ctx, {
      period: mode === 'y' ? { type: 'ytd', year } : { type: 'month', year, month },
      exportCsv: true,
    });
  });

  // ---------- 广告点击 ----------
  bot.action(/^ad:click:(.+)$/, async (ctx) => {
    const adId = ctx.match[1];
    const ad = adService?.getAdById(adId);
    if (!ad) {
      await ctx.answerCbQuery('广告已下线').catch(() => {});
      return;
    }
    if (!ad.targetUrl) {
      await ctx.answerCbQuery('该广告无外链').catch(() => {});
      return;
    }
    // 回调中只带广告 ID，不携带任何敏感参数
    adService.recordClick(ad.id, ctx.from.id);
    logger.info('ad.click', {
      adId: ad.id,
      user: maskUserId(ctx.from.id),
      source: 'query_result',
    });
    try {
      await ctx.answerCbQuery('', { url: ad.targetUrl });
    } catch {
      // ignore
    }
  });

  bot.catch((error, ctx) => {
    logger.error('bot.unhandled', { error: error.message });
    if (ctx?.reply) {
      ctx.reply('处理消息时出错，请稍后重试。', MAIN_KEYBOARD).catch(() => {});
    }
  });

  return bot;
}

module.exports = { createBot };
