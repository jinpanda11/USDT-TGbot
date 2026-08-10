'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_USER = {
  apiKey: '',
  addresses: [],
  usdtRate: null,
  excludeSelf: true,
};

class Storage {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, 'users.json');
    this.users = {};
    this.ensureDataDir();
    this.load();
  }

  ensureDataDir() {
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  load() {
    try {
      if (!fs.existsSync(this.filePath)) {
        this.users = {};
        this.save();
        return;
      }
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw || '{}');
      this.users = parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
      console.error('读取用户数据失败，将使用空数据', error);
      this.users = {};
    }
  }

  save() {
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(this.users, null, 2), 'utf8');
    fs.renameSync(tempPath, this.filePath);
  }

  normalizeApiKey(value) {
    return String(value ?? '')
      .trim()
      .replace(/^<|>$/g, '')
      .replace(/^["']|["']$/g, '')
      .trim();
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
    const user = this.getUser(userId);
    if (user.addresses.some((item) => item.address === address)) {
      return { ok: false, reason: 'exists' };
    }
    user.addresses.push({ address, label: label || '默认标签' });
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
