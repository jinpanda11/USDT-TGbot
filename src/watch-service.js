'use strict';

const { fetchAllTransactions, formatUsdt, getCurrentChinaYearMonth } = require('./trongrid');
const { maskAddress, maskUserId } = require('./logger');
const { normalizeApiKey } = require('./utils');

const DIRECTION_LABEL = { in: '到账', out: '转出' };

/**
 * 地址监听轮询服务。
 *
 * 每个监听地址独立保存最近一次交易 id/时间，这样重启后不会对旧交易重复告警。
 * 只有用户配置了个人 API Key 才轮询该用户的监听地址；没有 Key 的监听项会跳过一次。
 */
class WatchService {
  constructor({ storage, bot, config, logger }) {
    this.storage = storage;
    this.bot = bot;
    this.config = config;
    this.logger = logger || console;
    this.timer = null;
    this.running = false;
    this.loops = 0;
  }

  start() {
    if (this.timer) return;
    const intervalMs = Math.max(10000, Number(this.config.watchPollIntervalMs) || 60000);
    this.running = true;
    this.timer = setInterval(() => {
      this.poll().catch((error) => {
        this.logger.warn?.('watch.loop.error', { error: error.message });
      });
    }, intervalMs);
    this.timer.unref?.();
    this.logger.info('watch.started', { intervalMs });

    // 启动后立即跑一次，避免等到第一个定时周期
    this.poll().catch((error) => {
      this.logger.warn?.('watch.initial.error', { error: error.message });
    });
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.logger.info('watch.stopped', {});
  }

  getCheckpoint(userId, key) {
    const user = this.storage.getUser(userId);
    if (!user.watchCheckpoints) return undefined;
    return user.watchCheckpoints[key];
  }

  async setCheckpoint(userId, key, checkpoint) {
    const user = this.storage.getUser(userId);
    if (!user.watchCheckpoints) user.watchCheckpoints = {};
    user.watchCheckpoints[key] = checkpoint;
    await this.storage.save();
  }

  getConfig() {
    return {
      apiBase: this.config.trongridApiBase,
      usdtContract: this.config.usdtContract,
      timeout: this.config.requestTimeoutMs,
      retries: this.config.maxRequestRetries,
      maxPages: this.config.maxPagesPerAddress,
      maxRecords: this.config.maxRecordsPerQuery,
    };
  }

  async queryTransactions(userId, watch, checkpoint) {
    const user = this.storage.getUser(userId);
    const apiKey = normalizeApiKey(user.apiKey);
    if (!apiKey) {
      return { transactions: [], truncated: false };
    }
    const base = this.config.trongridApiBase;
    const address = String(watch.address || '').trim();
    const direction = watch.direction === 'out' ? 'out' : 'in';
    const { year, month } = getCurrentChinaYearMonth();
    const start = Date.UTC(year, month - 1, 1, 0, 0, 0) - 8 * 60 * 60 * 1000;
    const end = Date.UTC(year, month + 0, 1, 0, 0, 0) - 8 * 60 * 60 * 1000;
    const directionParam = direction === 'out' ? 'only_from' : 'only_to';
    const params = new URLSearchParams({
      contract_address: this.config.usdtContract,
      only_confirmed: 'true',
      [directionParam]: 'true',
      limit: '200',
      min_timestamp: String(start),
      max_timestamp: String(end - 1),
    });
    const url = `${base}${encodeURIComponent(address)}/transactions/trc20?${params}`;
    const { transactions, truncated } = await fetchAllTransactions(url, apiKey, {
      timeout: this.config.requestTimeoutMs,
      retries: this.config.maxRequestRetries,
      maxPages: this.config.maxPagesPerAddress,
    });
    const result = transactions
      .filter((tx) => String(tx?.token_info?.address || '').toLowerCase() === String(this.config.usdtContract).toLowerCase())
      .filter((tx) => {
        if (direction === 'in') return String(tx?.to || '') === address;
        return String(tx?.from || '') === address;
      })
      .sort((a, b) => Number(a.block_timestamp) - Number(b.block_timestamp))
      .map((tx) => {
        let amountMicros;
        try {
          amountMicros = BigInt(tx.value);
        } catch {
          return null;
        }
        const timestamp = Number(tx.block_timestamp);
        const id = String(tx.transaction_id || '');
        if (!Number.isFinite(timestamp) || timestamp <= 0 || !id) return null;
        return {
          id,
          amountMicros,
          from: String(tx.from || ''),
          to: String(tx.to || ''),
          timestamp,
          time: new Date(timestamp).toLocaleString('zh-CN', {
            timeZone: 'Asia/Shanghai',
            hour12: false,
          }),
        };
      })
      .filter(Boolean);
    return { transactions: result, truncated };
  }

  async poll() {
    this.loops += 1;
    const users = this.storage.users;
    let watchedCount = 0;
    let sentCount = 0;

    for (const [userIdText, user] of Object.entries(users)) {
      const watched = Array.isArray(user.watchedAddresses) ? user.watchedAddresses : [];
      if (!watched.length) continue;
      const userId = Number.parseFloat(userIdText);
      if (!Number.isFinite(userId)) continue;

      for (const item of watched) {
        watchedCount += 1;
        if (!item) continue;
        const key = `${item.address}|${item.direction}`;
        const checkpoint = this.getCheckpoint(userId, key);
        let result;
        try {
          result = await this.queryTransactions(userId, item, checkpoint);
        } catch (error) {
          this.logger.warn?.('watch.address.error', {
            user: maskUserId(userId),
            address: maskAddress(item.address),
            direction: item.direction,
            error: error.message,
          });
          continue;
        }
        if (!result || !Array.isArray(result.transactions)) continue;
        const txs = checkpoint
          ? result.transactions.filter((tx) => {
              return checkpoint.txId ? tx.id !== checkpoint.txId : tx.timestamp > checkpoint.timestamp;
            })
          : result.transactions;
        for (const tx of txs) {
          if (!this.running) return;
          try {
            await this.bot.telegram.sendMessage(
              userId,
              this.formatWatchMessage(item, tx, user)
            );
            sentCount += 1;
            this.logger.info('watch.sent', {
              user: maskUserId(userId),
              address: maskAddress(item.address),
              direction: item.direction,
              transaction: tx.id,
            });
          } catch (error) {
            this.logger.warn?.('watch.send.failed', {
              user: maskUserId(userId),
              address: maskAddress(item.address),
              direction: item.direction,
              error: error.message,
            });
          }
          if (result.transactions.length && tx.id) {
            await this.setCheckpoint(userId, key, {
              txId: tx.id,
              timestamp: tx.timestamp,
            });
          }
        }
      }
    }

    if (watchedCount > 0) {
      this.logger.info('watch.loop.done', { watched: watchedCount, sent: sentCount, loop: this.loops });
    }
  }

  formatWatchMessage(item, tx, user) {
    const label = item.label || '默认标签';
    const directionText = DIRECTION_LABEL[item.direction] || '交易';
    const amountText = formatUsdt(BigInt(tx.amountMicros));
    const other = item.direction === 'in' ? tx.from : tx.to;
    return [
      `📡 地址监听（${directionText}）`,
      `地址：${item.address}`,
      `标签：${label}`,
      `金额：${amountText} USDT`,
      `${item.direction === 'in' ? '付款方' : '收款方'}：${other || '未知'}`,
      `时间：${tx.time}`,
      `交易：${tx.id}`,
    ].join('\n');
  }
}

module.exports = { WatchService, USDT_DIRECTION_LABEL: DIRECTION_LABEL };