'use strict';

/**
 * 会话管理器 — 管理用户多步会话状态、自动清理过期会话、防内存泄漏
 */
class SessionManager {
  constructor(ttlMs = 1800000, maxSessions = 10000) {
    /** @type {Map<number, { type: string, step?: string, data?: any, createdAt: number }>} */
    this.sessions = new Map();
    this.ttlMs = ttlMs;
    this.maxSessions = maxSessions;
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.cleanup();
    }, 60000);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  cleanup() {
    if (this.ttlMs <= 0) return;
    const now = Date.now();
    // 清理过期会话
    for (const [userId, session] of this.sessions) {
      if (now - session.createdAt > this.ttlMs) {
        this.sessions.delete(userId);
      }
    }
    // 超过上限时，清理最老的会话
    if (this.sessions.size > this.maxSessions) {
      const sorted = Array.from(this.sessions.entries()).sort(
        (a, b) => a[1].createdAt - b[1].createdAt
      );
      const toDelete = sorted.slice(0, this.sessions.size - this.maxSessions);
      for (const [userId] of toDelete) {
        this.sessions.delete(userId);
      }
    }
  }

  get(userId) {
    const session = this.sessions.get(userId);
    if (!session) return undefined;
    if (this.ttlMs > 0 && Date.now() - session.createdAt > this.ttlMs) {
      this.sessions.delete(userId);
      return undefined;
    }
    return session;
  }

  set(userId, session) {
    this.sessions.set(userId, { ...session, createdAt: Date.now() });
  }

  delete(userId) {
    this.sessions.delete(userId);
  }

  clear() {
    this.sessions.clear();
  }
}

module.exports = { SessionManager };
