'use strict';

/** 全局并发信号量：限制同时进行的查询数量 */
class Semaphore {
  constructor(limit) {
    this.limit = Math.max(1, limit);
    this.active = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise((resolve) => this.queue.push(resolve));
    this.active += 1;
  }

  release() {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
}

/** 每用户滑动窗口限流：窗口内最多 maxPerWindow 次 */
class RateLimiter {
  constructor(maxPerWindow, windowMs = 60000) {
    this.maxPerWindow = maxPerWindow;
    this.windowMs = windowMs;
    this.hits = new Map(); // userId -> timestamp[]
  }

  allow(userId) {
    if (this.maxPerWindow <= 0) return true;
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const timestamps = (this.hits.get(userId) || []).filter((t) => t > cutoff);
    if (timestamps.length >= this.maxPerWindow) {
      this.hits.set(userId, timestamps);
      return false;
    }
    timestamps.push(now);
    this.hits.set(userId, timestamps);
    return true;
  }

  reset(userId) {
    this.hits.delete(userId);
  }
}

/** 同参数查询缓存（按插入顺序近似 LRU，超条目数时淘汰最旧） */
class QueryCache {
  constructor(ttlMs, maxEntries = 50) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.map = new Map(); // key -> { createdAt, value }
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (this.ttlMs > 0 && Date.now() - entry.createdAt > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value) {
    if (this.ttlMs <= 0) return;
    if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    this.map.set(key, { createdAt: Date.now(), value });
  }

  clear() {
    this.map.clear();
  }
}

module.exports = { Semaphore, RateLimiter, QueryCache };
