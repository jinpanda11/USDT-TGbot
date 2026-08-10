'use strict';

const { Telegraf, Markup } = require('telegraf');
const {
  isValidTronAddress,
  getCurrentChinaYearMonth,
  fetchUsdtCnyRate,
  queryMonthIncome,
  buildCsv,
  summarizeRecords,
} = require('./trongrid');

// 底部常驻按钮文案
const BTN = {
  QUERY_MONTH: '📥 查询本月',
  PICK_MONTH: '📅 选择月份',
  EXPORT_MONTH: '📄 导出本月',
  ADDRESSES: '📋 地址管理',
  ADD_ADDR: '➕ 添加地址',
  SETTINGS: '⚙️ 设置',
  HELP: '❓ 帮助',
  CANCEL: '❌ 取消',
};

const MAIN_KEYBOARD = Markup.keyboard([
  [BTN.QUERY_MONTH, BTN.PICK_MONTH],
  [BTN.EXPORT_MONTH, BTN.ADDRESSES],
  [BTN.ADD_ADDR, BTN.SETTINGS],
  [BTN.HELP],
])
  .resize()
  .persistent();

const CANCEL_KEYBOARD = Markup.keyboard([[BTN.CANCEL]]).resize();

function parseYearMonth(args, fallback) {
  if (!args.length) return { year: fallback.year, month: fallback.month };
  if (args.length === 1) {
    const value = args[0];
    if (/^\d{4}-\d{1,2}$/.test(value)) {
      const [y, m] = value.split('-').map((part) => Number.parseInt(part, 10));
      return { year: y, month: m };
    }
    const month = Number.parseInt(value, 10);
    return { year: fallback.year, month };
  }
  return {
    year: Number.parseInt(args[0], 10),
    month: Number.parseInt(args[1], 10),
  };
}

function validateYearMonth(year, month) {
  return (
    Number.isInteger(year) &&
    year >= 2000 &&
    year <= 2100 &&
    Number.isInteger(month) &&
    month >= 1 &&
    month <= 12
  );
}

function normalizeApiKey(value) {
  return String(value ?? '')
    .trim()
    .replace(/^<|>$/g, '')
    .replace(/^["']|["']$/g, '')
    .trim();
}

function maskApiKey(apiKey) {
  const key = normalizeApiKey(apiKey);
  if (!key) return '未设置';
  if (key.length <= 8) return `${key.slice(0, 2)}***`;
  return `${key.slice(0, 4)}...${key.slice(-4)}（${key.length} 位）`;
}

function monthLabel(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

function createBot(config, storage) {
  const bot = new Telegraf(config.telegramBotToken);
  const queryingUsers = new Set();
  /** @type {Map<number, { type: string, step?: string, data?: any }>} */
  const sessions = new Map();

  function resolveApiKey(user) {
    return normalizeApiKey(user.apiKey || config.defaultTronGridApiKey || '');
  }

  function resolveRate(user) {
    if (Number.isFinite(user.usdtRate) && user.usdtRate > 0) return user.usdtRate;
    return config.defaultUsdtCnyRate;
  }

  function clearSession(userId) {
    sessions.delete(userId);
  }

  function setSession(userId, session) {
    sessions.set(userId, session);
  }

  async function replyMain(ctx, text, extra = {}) {
    return ctx.reply(text, { ...extra, ...MAIN_KEYBOARD });
  }

  function helpText(configHasDefaultKey) {
    return [
      'TRON USDT 链上收入分析',
      '',
      '直接点下方按钮即可，不用记命令：',
      '📥 查询本月 — 查当前北京时间月份收入',
      '📅 选择月份 — 点选要查的月份',
      '📄 导出本月 — 导出当前月 CSV',
      '📋 地址管理 — 查看/删除地址',
      '➕ 添加地址 — 按提示添加',
      '⚙️ 设置 — API Key / 汇率 / 排除自转',
      '',
      '高级用户仍可用命令：/query /export /add /list /setkey ...',
      configHasDefaultKey
        ? '服务器已配置默认 TronGrid API Key，也可自己设置。'
        : '请先在「设置」里配置 TronGrid API Key。',
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

  function monthPickerKeyboard(exportMode = false) {
    const { year, month } = getCurrentChinaYearMonth();
    const prefix = exportMode ? 'exm' : 'qm';
    const rows = [];
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

  async function showAddresses(ctx) {
    const user = storage.getUser(ctx.from.id);
    await ctx.reply(addressListText(user), {
      ...MAIN_KEYBOARD,
      ...addressKeyboard(user),
    });
  }

  async function showSettings(ctx) {
    const user = storage.getUser(ctx.from.id);
    await ctx.reply(settingsText(user), {
      ...MAIN_KEYBOARD,
      ...settingsKeyboard(user),
    });
  }

  async function startAddAddress(ctx) {
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
    if (raw.toLowerCase() === 'clear' || raw.toLowerCase() === 'none') {
      storage.updateUser(ctx.from.id, { apiKey: '' });
      clearSession(ctx.from.id);
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
      await ctx.reply('API Key 看起来太短，请重新发送完整 Key，或点「❌ 取消」。', CANCEL_KEYBOARD);
      return;
    }

    storage.updateUser(ctx.from.id, { apiKey });
    try {
      await ctx.deleteMessage();
    } catch {
      // ignore
    }

    let probeText = '';
    try {
      const probeUrl =
        'https://api.trongrid.io/v1/accounts/T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb/transactions/trc20?limit=1';
      const response = await fetch(probeUrl, {
        headers: { Accept: 'application/json', 'TRON-PRO-API-KEY': apiKey },
      });
      if (response.ok) probeText = '连通性检测：通过';
      else if (response.status === 401 || response.status === 403) {
        probeText = '连通性检测：失败（401/403）。请核对 Key。';
      } else {
        probeText = `连通性检测：HTTP ${response.status}（可再试查询）`;
      }
    } catch (error) {
      probeText = `连通性检测：网络异常（${error.message || error}）`;
    }

    clearSession(ctx.from.id);
    await replyMain(ctx, `API Key 已保存：${maskApiKey(apiKey)}\n${probeText}`);
  }

  async function runQuery(ctx, { year, month, exportCsv }) {
    const userId = ctx.from.id;
    if (queryingUsers.has(userId)) {
      await ctx.reply('你有正在进行的查询，请稍候。', MAIN_KEYBOARD);
      return;
    }

    const user = storage.getUser(userId);
    const apiKey = resolveApiKey(user);
    if (!apiKey) {
      await ctx.reply('请先在「⚙️ 设置」里配置 TronGrid API Key。', {
        ...MAIN_KEYBOARD,
        ...Markup.inlineKeyboard([[Markup.button.callback('🔑 去设置 API Key', 'set:apikey')]]),
      });
      return;
    }
    if (!user.addresses.length) {
      await ctx.reply('请先添加地址。', {
        ...MAIN_KEYBOARD,
        ...Markup.inlineKeyboard([[Markup.button.callback('➕ 添加地址', 'nav:add')]]),
      });
      return;
    }
    if (!validateYearMonth(year, month)) {
      await ctx.reply('年月无效，请重新选择。', MAIN_KEYBOARD);
      return;
    }

    queryingUsers.add(userId);
    const label = monthLabel(year, month);
    const status = await ctx.reply(`开始查询 ${label}（0/${user.addresses.length}）...`, MAIN_KEYBOARD);

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
      try {
        const live = await fetchUsdtCnyRate(config.coingeckoRateUrl, {
          timeout: 10000,
          retries: config.maxRequestRetries,
        });
        if (!Number.isFinite(user.usdtRate) || user.usdtRate <= 0) rate = live;
      } catch (error) {
        console.warn('实时汇率不可用，使用已配置汇率', error);
      }

      const { records, errors, totalText } = await queryMonthIncome({
        wallets: user.addresses.map((item) => ({ ...item })),
        year,
        month,
        apiKey,
        excludeSelf: user.excludeSelf,
        usdtContract: config.usdtContract,
        apiBase: config.trongridApiBase,
        concurrency: config.addressConcurrency,
        timeout: config.requestTimeoutMs,
        retries: config.maxRequestRetries,
        onProgress: (completed, total) => {
          progressChain = progressChain
            .then(async () => {
              if (!progressActive) return;
              await editStatus(`查询 ${label}：${completed}/${total} 个地址...`);
            })
            .catch(() => {});
        },
      });

      progressActive = false;
      await progressChain;

      let text = '';
      if (errors.length) text += `${errors.map((item) => `⚠️ ${item}`).join('\n')}\n\n`;
      text += summarizeRecords(records, totalText, rate, year, month);
      text += `\n\n汇率：1 USDT = ${Number(rate).toFixed(4)} 元`;
      if (user.excludeSelf) text += '\n已排除自有地址互转';

      await editStatus(`查询完成 ${label}`);
      await ctx.reply(text, MAIN_KEYBOARD);

      if (exportCsv && records.length) {
        const { csv, filename } = buildCsv(records, year, month);
        await ctx.replyWithDocument({
          source: Buffer.from(csv, 'utf8'),
          filename,
        });
      } else if (!exportCsv && records.length) {
        await ctx.reply('需要完整明细时，可点下方导出：', {
          ...MAIN_KEYBOARD,
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback(`📄 导出 ${label} CSV`, `export:${year}:${month}`),
            ],
          ]),
        });
      }
    } catch (error) {
      progressActive = false;
      await progressChain;
      console.error(error);
      const failText = `查询失败：${error.message || error}`;
      const edited = await editStatus(failText);
      if (!edited) await ctx.reply(failText, MAIN_KEYBOARD);
    } finally {
      queryingUsers.delete(userId);
    }
  }

  // ---------- 命令（兼容） ----------
  bot.start(async (ctx) => {
    clearSession(ctx.from.id);
    await replyMain(ctx, helpText(Boolean(config.defaultTronGridApiKey)));
  });

  bot.help(async (ctx) => {
    await replyMain(ctx, helpText(Boolean(config.defaultTronGridApiKey)));
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
      await replyMain(ctx, '该地址已存在。');
      return;
    }
    await replyMain(ctx, `已添加：${label}\n${address}`);
  });

  bot.command('list', async (ctx) => showAddresses(ctx));

  bot.command('del', async (ctx) => {
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
    const { year, month } = parseYearMonth(args, current);
    await runQuery(ctx, { year, month, exportCsv: false });
  });

  bot.command('export', async (ctx) => {
    const args = ctx.message.text.trim().split(/\s+/).slice(1);
    const current = getCurrentChinaYearMonth();
    const { year, month } = parseYearMonth(args, current);
    await runQuery(ctx, { year, month, exportCsv: true });
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
    await runQuery(ctx, { year: current.year, month: current.month, exportCsv: false });
  });

  bot.hears(BTN.EXPORT_MONTH, async (ctx) => {
    clearSession(ctx.from.id);
    const current = getCurrentChinaYearMonth();
    await runQuery(ctx, { year: current.year, month: current.month, exportCsv: true });
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

  bot.hears(BTN.SETTINGS, async (ctx) => {
    clearSession(ctx.from.id);
    await showSettings(ctx);
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

    const session = sessions.get(ctx.from.id);
    if (!session) return next();

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
            await replyMain(ctx, '该地址已存在。');
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
          await replyMain(ctx, '该地址已存在。');
          return;
        }
        await replyMain(ctx, `已添加：${label}\n${session.data.address}`);
        return;
      }
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
    await ctx.answerCbQuery('已刷新');
    const user = storage.getUser(ctx.from.id);
    try {
      await ctx.editMessageText(addressListText(user), addressKeyboard(user));
    } catch {
      await showAddresses(ctx);
    }
  });

  bot.action(/^del:(\d+)$/, async (ctx) => {
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
    await runQuery(ctx, { year, month, exportCsv });
  });

  bot.action(/^export:(\d{4}):(\d{1,2})$/, async (ctx) => {
    const year = Number.parseInt(ctx.match[1], 10);
    const month = Number.parseInt(ctx.match[2], 10);
    await ctx.answerCbQuery('开始导出...');
    await runQuery(ctx, { year, month, exportCsv: true });
  });

  bot.catch((error, ctx) => {
    console.error('Bot 错误', error);
    if (ctx?.reply) {
      ctx.reply('处理消息时出错，请稍后重试。', MAIN_KEYBOARD).catch(() => {});
    }
  });

  return bot;
}

module.exports = { createBot };
