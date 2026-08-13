'use strict';

const fs = require('fs');
const path = require('path');
const { isValidTronAddress } = require('./trongrid');

const DEFAULT_USER = {
  apiKey: '',
  addresses: [],
  usdtRate: null,
  excludeSelf: true,
};

class Storage {
  constructor(dataDir, { logger } = {}) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, 'users.json');
    // 兼容：logger 提供 error/warn/info；不传时回退到 console
    this.logger = logger || console;
    this.users = {};
    this.writeQueue = Promise.resolve(); // 写队列：串行化所有 save() 操作
    this.ensureDataDir();
    this.load();
  }

  ensureDataDir() {
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  load() {
    if (!fs.existsSync(this.filePath)) {
      this.users = {};
      this.save();
      return;
    }
    let parsed;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      parsed = JSON.parse(raw || '{}');
    } catch (error) {
      this.logger.error?.('storage.load.corrupt', { path: this.filePath, error: error.message });
      const backupPath = this.backupCorrupt();
      throw new Error(
        `用户数据文件损坏，已备份到 ${backupPath}。请检查文件或从备份恢复后再启动。`
      );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.logger.error?.('storage.load.invalid', { path: this.filePath });
      const backupPath = this.backupCorrupt();
      throw new Error(
        `用户数据文件顶层结构无效，已备份到 ${backupPath}。请检查文件或从备份恢复后再启动。`
      );
    }
    this.users = this.normalizeUsers(parsed);
  }

  /** 损坏文件先复制备份，再允许抛错终止，避免被空数据覆盖 */
  backupCorrupt() {
    const backupPath = `${this.filePath}.corrupt-${Date.now()}.bak`;
    try {
      fs.copyFileSync(this.filePath, backupPath);
    } catch (error) {
      this.logger.error?.('storage.backup.failed', { error: error.message });
      throw new Error('用户数据文件损坏且无法备份，已停止写入。请手动处理 data/users.json。');
    }
    return backupPath;
  }

  /** 逐用户归一化：丢弃非法条目并告警，保证历史数据兼容 */
  normalizeUsers(parsed) {
    const users = {};
    let dropped = 0;
    for (const [key, entry] of Object.entries(parsed)) {
      if (!/^\d+$/.test(key) || !entry || typeof entry !== 'object' || Array.isArray(entry)) {
        dropped += 1;
        continue;
      }
      const normalized = { ...DEFAULT_USER, addresses: [] };
      if (typeof entry.apiKey === 'string') {
        normalized.apiKey = this.normalizeApiKey(entry.apiKey);
      }
      if (typeof entry.usdtRate === 'number' && Number.isFinite(entry.usdtRate) && entry.usdtRate > 0) {
        normalized.usdtRate = entry.usdtRate;
      }
      if (typeof entry.excludeSelf === 'boolean') {
        normalized.excludeSelf = entry.excludeSelf;
      }
      if (Array.isArray(entry.addresses)) {
        for (const item of entry.addresses) {
          if (!item || typeof item !== 'object') {
            dropped += 1;
            continue;
          }
          const address = String(item.address || '').trim();
          if (!isValidTronAddress(address)) {
            dropped += 1;
            continue;
          }
          const label = String(item.label || '默认标签').trim() || '默认标签';
          normalized.addresses.push({ address, label });
        }
      }
      users[key] = normalized;
    }
    if (dropped > 0) {
      this.logger.warn?.('storage.normalize.dropped', { dropped });
    }
    return users;
  }

  save() {
    // 所有写操作排队，防止并发写竞态
    this.writeQueue = this.writeQueue
      .then(() => this._doSave())
      .catch((error) => {
        this.logger.error?.('storage.save.failed', { error: error.message });
        throw error;
      });
    return this.writeQueue;
  }

  _doSave() {
    const serialized = JSON.stringify(this.users, null, 2);
    // 安全阀：不允许把已有数据的文件用空对象覆盖（防误清空）
    if (serialized === '{}' && fs.existsSync(this.filePath)) {
      const existing = fs.readFileSync(this.filePath, 'utf8').trim();
      if (existing && existing !== '{}') {
        throw new Error('检测到用户数据将被清空，已拒绝写入。请人工确认后处理 data/users.json。');
      }
    }
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, serialized, 'utf8');
    try {
      fs.chmodSync(tempPath, 0o600);
    } catch {
      // 平台不支持时忽略
    }
    fs.renameSync(tempPath, this.filePath);
  }

  normalizeApiKey(value) {
    // 反复剥离首尾的 <> 与引号，直到稳定（兼容 <"KEY">、"<KEY>" 等组合）
    let result = String(value ?? '').trim();
    let previous;
    do {
      previous = result;
      result = result.replace(/^<|>$/g, '').replace(/^["']|["']$/g, '');
    } while (result !== previous);
    return result.trim();
  }

  getUser(userId) {
    const key = String(userId);
    if (!this.users[key]) {
      this.users[key] = {
        ...DEFAULT_USER,
        addresses: [],
      };
      this.save();
    }
    const user = this.users[key];
    if (!Array.isArray(user.addresses)) user.addresses = [];
    if (typeof user.excludeSelf !== 'boolean') user.excludeSelf = true;
    if (typeof user.apiKey !== 'string') user.apiKey = '';
    // 兼容历史数据：去掉误存的 <> / 引号
    const cleaned = this.normalizeApiKey(user.apiKey);
    if (cleaned !== user.apiKey) {
      user.apiKey = cleaned;
      this.save();
    }
    return user;
  }

  updateUser(userId, patch) {
    const user = this.getUser(userId);
    Object.assign(user, patch);
    this.save();
    return user;
  }

  addAddress(userId, address, label) {
    const trimmed = String(address || '').trim();
    // 服务端二次校验（防御纵深）
    if (!isValidTronAddress(trimmed)) {
      return { ok: false, reason: 'invalid_address' };
    }
    const user = this.getUser(userId);
    if (user.addresses.some((item) => item.address === trimmed)) {
      return { ok: false, reason: 'exists' };
    }
    user.addresses.push({ address: trimmed, label: label || '默认标签' });
    this.save();
    return { ok: true, user };
  }

  deleteAddress(userId, addressOrIndex) {
    const user = this.getUser(userId);
    const text = String(addressOrIndex).trim();
    let next;

    if (/^\d+$/.test(text)) {
      const index = Number.parseInt(text, 10) - 1;
      if (index < 0 || index >= user.addresses.length) {
        return { ok: false, reason: 'not_found' };
      }
      const removed = user.addresses[index];
      next = user.addresses.filter((_, i) => i !== index);
      user.addresses = next;
      this.save();
      return { ok: true, removed };
    }

    next = user.addresses.filter((item) => item.address !== text);
    if (next.length === user.addresses.length) {
      return { ok: false, reason: 'not_found' };
    }
    const removed = user.addresses.find((item) => item.address === text);
    user.addresses = next;
    this.save();
    return { ok: true, removed };
  }
}

module.exports = { Storage };
