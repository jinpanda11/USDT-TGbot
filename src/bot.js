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

function createBot(config, storage) {
  const bot = new Telegraf(config.telegramBotToken);
  const queryingUsers = new Set();

  function resolveApiKey(user) {
    return (user.apiKey || config.defaultTronGridApiKey || '').trim();
  }

  function resolveRate(user) {
    if (Number.isFinite(user.usdtRate) && user.usdtRate > 0) return user.usdtRate;
    return config.defaultUsdtCnyRate;
  }

  bot.start(async (ctx) => {
    await ctx.reply(
      [
        'TRON USDT 链上收入分析机器人',
        '',
        '常用命令：',
        '/setkey <TronGrid API Key>  设置个人 API Key',
        '/add <地址> [标签]          添加收款地址',
        '/list                       查看地址列表',
        '/del <序号或地址>           删除地址',
        '/query [年] [月]            查询该月收入',
        '/export [年] [月]           导出 CSV',
        '/rate [数值]                查看/设置 USDT 汇率',
        '/exclude on|off             是否排除自有地址互转',
        '/help                       帮助',
        '',
        config.defaultTronGridApiKey
          ? '服务器已配置默认 TronGrid API Key，也可 /setkey 使用自己的。'
          : '请先 /setkey 设置 TronGrid API Key。',
      ].join('\n')
    );
  });

  bot.help(async (ctx) => {
    await ctx.reply(
      [
        '使用流程：',
        '1. /setkey 你的TronGridKey',
        '2. /add Txxxxxxxx 钱包A',
        '3. /query 2026 7',
        '4. /export 2026 7',
        '',
        '说明：',
        '- 时间按北京时间整月统计',
        '- 仅统计 USDT(TRC20) 入账',
        '- 明细过多时消息只展示部分，完整数据请导出 CSV',
        '- 建议私聊使用，勿在群里发送 API Key',
      ].join('\n')
    );
  });

  bot.command('setkey', async (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/);
    const apiKey = parts.slice(1).join(' ').trim();
    if (!apiKey) {
      await ctx.reply('用法：/setkey <TronGrid API Key>\n清除个人 Key：/setkey clear');
      return;
    }
    if (apiKey.toLowerCase() === 'clear' || apiKey.toLowerCase() === 'none') {
      storage.updateUser(ctx.from.id, { apiKey: '' });
      await ctx.reply(
        config.defaultTronGridApiKey
          ? '已清除个人 API Key，将使用服务器默认 Key。'
          : '已清除个人 API Key。'
      );
      return;
    }
    storage.updateUser(ctx.from.id, { apiKey });
    try {
      await ctx.deleteMessage();
    } catch {
      // 无私聊删消息权限时忽略
    }
    await ctx.reply('API Key 已保存（建议在私聊中设置）。原消息如未删除请手动删除。');
  });

  bot.command('add', async (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/);
    const address = (parts[1] || '').trim();
    const label = parts.slice(2).join(' ').trim() || '默认标签';
    if (!address) {
      await ctx.reply('用法：/add <TRON地址> [标签]');
      return;
    }
    if (!isValidTronAddress(address)) {
      await ctx.reply('无效的 TRON 地址：应为 34 位且以 T 开头。');
      return;
    }
    const result = storage.addAddress(ctx.from.id, address, label);
    if (!result.ok) {
      await ctx.reply('该地址已存在。');
      return;
    }
    await ctx.reply(`已添加：${label}\n${address}`);
  });

  bot.command('list', async (ctx) => {
    const user = storage.getUser(ctx.from.id);
    if (!user.addresses.length) {
      await ctx.reply('尚未添加地址。使用 /add <地址> [标签]');
      return;
    }
    const lines = user.addresses.map(
      (item, index) => `${index + 1}. ${item.label}\n   ${item.address}`
    );
    const apiKeyStatus = resolveApiKey(user) ? '已配置' : '未配置';
    const rate = resolveRate(user);
    await ctx.reply(
      [
        `地址列表（${user.addresses.length}）`,
        ...lines,
        '',
        `API Key：${apiKeyStatus}`,
        `汇率：1 USDT = ${rate} 元`,
        `排除自转：${user.excludeSelf ? '开' : '关'}`,
      ].join('\n')
    );
  });

  bot.command('del', async (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/);
    const target = (parts[1] || '').trim();
    if (!target) {
      await ctx.reply('用法：/del <序号或地址>\n例如：/del 1  或  /del Txxx...');
      return;
    }
    const result = storage.deleteAddress(ctx.from.id, target);
    if (!result.ok) {
      await ctx.reply('未找到该地址。先用 /list 查看。');
      return;
    }
    await ctx.reply(`已删除：${result.removed.label}\n${result.removed.address}`);
  });

  bot.command('rate', async (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/);
    const user = storage.getUser(ctx.from.id);
    const arg = (parts[1] || '').trim().toLowerCase();

    if (!arg) {
      let liveText = '实时汇率获取中...';
      try {
        const live = await fetchUsdtCnyRate(config.coingeckoRateUrl, {
          timeout: 10000,
          retries: config.maxRequestRetries,
        });
        liveText = `CoinGecko 实时：1 USDT = ${live.toFixed(4)} 元`;
      } catch {
        liveText = 'CoinGecko 实时汇率暂不可用';
      }
      await ctx.reply(
        [
          `当前使用汇率：1 USDT = ${resolveRate(user)} 元`,
          user.usdtRate == null ? '（使用默认/服务器配置）' : '（个人设置）',
          liveText,
          '',
          '设置：/rate 7.25',
          '恢复默认：/rate clear',
          '拉取实时并保存：/rate live',
        ].join('\n')
      );
      return;
    }

    if (arg === 'clear' || arg === 'default') {
      storage.updateUser(ctx.from.id, { usdtRate: null });
      await ctx.reply(`已恢复默认汇率：1 USDT = ${config.defaultUsdtCnyRate} 元`);
      return;
    }

    if (arg === 'live') {
      try {
        const live = await fetchUsdtCnyRate(config.coingeckoRateUrl, {
          timeout: 10000,
          retries: config.maxRequestRetries,
        });
        storage.updateUser(ctx.from.id, { usdtRate: Number(live.toFixed(4)) });
        await ctx.reply(`已保存实时汇率：1 USDT = ${live.toFixed(4)} 元`);
      } catch (error) {
        await ctx.reply(`获取实时汇率失败：${error.message || error}`);
      }
      return;
    }

    const rate = Number.parseFloat(arg);
    if (!Number.isFinite(rate) || rate <= 0) {
      await ctx.reply('请输入有效汇率，例如 /rate 7.25');
      return;
    }
    storage.updateUser(ctx.from.id, { usdtRate: rate });
    await ctx.reply(`已设置汇率：1 USDT = ${rate} 元`);
  });

  bot.command('exclude', async (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/);
    const arg = (parts[1] || '').trim().toLowerCase();
    const user = storage.getUser(ctx.from.id);
    if (!arg) {
      await ctx.reply(
        `当前排除自有地址互转：${user.excludeSelf ? '开' : '关'}\n用法：/exclude on 或 /exclude off`
      );
      return;
    }
    if (arg !== 'on' && arg !== 'off') {
      await ctx.reply('用法：/exclude on 或 /exclude off');
      return;
    }
    storage.updateUser(ctx.from.id, { excludeSelf: arg === 'on' });
    await ctx.reply(`已${arg === 'on' ? '开启' : '关闭'}排除自有地址互转`);
  });

  async function runQuery(ctx, { exportCsv }) {
    const userId = ctx.from.id;
    if (queryingUsers.has(userId)) {
      await ctx.reply('你有正在进行的查询，请稍候。');
      return;
    }

    const user = storage.getUser(userId);
    const apiKey = resolveApiKey(user);
    if (!apiKey) {
      await ctx.reply('请先 /setkey <TronGrid API Key>，或联系管理员配置服务器默认 Key。');
      return;
    }
    if (!user.addresses.length) {
      await ctx.reply('请先 /add 添加地址。');
      return;
    }

    const args = ctx.message.text.trim().split(/\s+/).slice(1);
    const current = getCurrentChinaYearMonth();
    const { year, month } = parseYearMonth(args, current);
    if (!validateYearMonth(year, month)) {
      await ctx.reply('请输入有效年月。例如：/query 2026 7  或  /query 2026-07');
      return;
    }

    queryingUsers.add(userId);
    const status = await ctx.reply(
      `开始查询 ${year}-${String(month).padStart(2, '0')}（0/${user.addresses.length}）...`
    );

    try {
      let rate = resolveRate(user);
      try {
        const live = await fetchUsdtCnyRate(config.coingeckoRateUrl, {
          timeout: 10000,
          retries: config.maxRequestRetries,
        });
        if (!Number.isFinite(user.usdtRate) || user.usdtRate <= 0) {
          rate = live;
        }
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
        onProgress: async (completed, total) => {
          try {
            await ctx.telegram.editMessageText(
              ctx.chat.id,
              status.message_id,
              undefined,
              `查询 ${year}-${String(month).padStart(2, '0')}：${completed}/${total} 个地址...`
            );
          } catch {
            // 忽略频繁编辑失败
          }
        },
      });

      let text = '';
      if (errors.length) {
        text += errors.map((item) => `⚠️ ${item}`).join('\n') + '\n\n';
      }
      text += summarizeRecords(records, totalText, rate, year, month);
      text += `\n\n汇率：1 USDT = ${Number(rate).toFixed(4)} 元`;
      if (user.excludeSelf) text += '\n已排除自有地址互转';

      await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, text);

      if (exportCsv && records.length) {
        const { csv, filename } = buildCsv(records, year, month);
        await ctx.replyWithDocument({
          source: Buffer.from(csv, 'utf8'),
          filename,
        });
      } else if (!exportCsv && records.length) {
        await ctx.reply(
          `导出完整明细：/export ${year} ${month}`,
          Markup.inlineKeyboard([
            Markup.button.callback(
              `导出 ${year}-${String(month).padStart(2, '0')} CSV`,
              `export:${year}:${month}`
            ),
          ])
        );
      }
    } catch (error) {
      console.error(error);
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        status.message_id,
        undefined,
        `查询失败：${error.message || error}`
      );
    } finally {
      queryingUsers.delete(userId);
    }
  }

  bot.command('query', async (ctx) => runQuery(ctx, { exportCsv: false }));
  bot.command('export', async (ctx) => runQuery(ctx, { exportCsv: true }));

  bot.action(/^export:(\d{4}):(\d{1,2})$/, async (ctx) => {
    const year = Number.parseInt(ctx.match[1], 10);
    const month = Number.parseInt(ctx.match[2], 10);
    await ctx.answerCbQuery('开始导出...');
    // 伪造 message.text 以复用 runQuery 参数解析
    ctx.message = { text: `/export ${year} ${month}` };
    await runQuery(ctx, { exportCsv: true });
  });

  bot.catch((error, ctx) => {
    console.error('Bot 错误', error);
    if (ctx?.reply) {
      ctx.reply('处理消息时出错，请稍后重试。').catch(() => {});
    }
  });

  return bot;
}

module.exports = { createBot };
