'use strict';

const fs = require('fs');
const { validateAd, isQueryResultPlacement, AD_STATUSES } = require('./ad-config');

/**
 * 广告服务（阶段 A：查询结果赞助位）。
 * - 从 data/ads.json 读取并校验广告，非法条目丢弃并告警，绝不影响收入查询。
 * - 选择规则：approved + 查询结果位 + 时间窗 + 未达展示上限，按展示占比轮播。
 * - 曝光/点击写入 ads.json 计数器，并追加事件日志（JSONL）用于审计与统计。
 */
class AdService {
  constructor({ adsFile, eventsFile, logger, enabled = true, showRatio = 1 }) {
    this.adsFile = adsFile;
    this.eventsFile = eventsFile;
    this.logger = logger || console;
    // enabled 为初始默认值（来自 ADS_ENABLED 环境变量）；
    // 若 ads.json 中存在显式 enabled 字段，则以文件为准（支持 TG 运行时切换）
    this.enabled = Boolean(enabled);
    this.showRatio = Number(showRatio);
    this.ads = [];
    this._lastMtime = 0;
    this.load();
  }

  _readFileOrEmpty() {
    if (!this.adsFile || !fs.existsSync(this.adsFile)) return null;
    try {
      const stat = fs.statSync(this.adsFile);
      if (stat.mtimeMs === this._lastMtime) return null;
      this._lastMtime = stat.mtimeMs;
      return JSON.parse(fs.readFileSync(this.adsFile, 'utf8'));
    } catch (error) {
      this.logger.warn?.('ad.config.load_failed', { error: error.message });
      return null;
    }
  }

  /** 重载：文件 mtime 变化（运营编辑）时重新读取 */
  _sync() {
    const parsed = this._readFileOrEmpty();
    if (parsed === null) return;
    // 开关状态：文件中有显式布尔值则采用（TG 按钮或手动编辑切换）
    if (parsed && typeof parsed === 'object' && typeof parsed.enabled === 'boolean') {
      this.enabled = parsed.enabled;
    }
    const list = Array.isArray(parsed) ? parsed : parsed?.ads;
    if (!Array.isArray(list)) {
      this.logger.warn?.('ad.config.invalid', {});
      this.ads = [];
      return;
    }
    const next = [];
    for (const raw of list) {
      const result = validateAd(raw);
      if (!result.ok) {
        this.logger.warn?.('ad.config.rejected', {
          id: raw?.id,
          errors: result.errors,
        });
        continue;
      }
      const { ad } = result;
      next.push({
        ...ad,
        impressions: Math.max(0, Number(raw.impressions) || 0),
        clicks: Math.max(0, Number(raw.clicks) || 0),
      });
    }
    this.ads = next;
  }

  load() {
    this._sync();
  }

  getAdById(id) {
    this._sync();
    return this.ads.find((ad) => ad.id === id) || undefined;
  }

  getAllAds() {
    this._sync();
    return [...this.ads];
  }

  /** 候选广告：approved + 查询结果位 + 时间窗 + 未达展示上限 */
  getCandidates(now = Date.now()) {
    this._sync();
    return this.ads.filter(
      (ad) =>
        ad.status === 'approved' &&
        isQueryResultPlacement(ad) &&
        now >= ad.startsAt &&
        now < ad.endsAt &&
        (ad.maxImpressions <= 0 || ad.impressions < ad.maxImpressions)
    );
  }

  /** 简单轮播：展示占比最低的优先，其次按 id 稳定排序 */
  selectAd(now = Date.now()) {
    const candidates = this.getCandidates(now);
    if (!candidates.length) return undefined;
    candidates.sort((a, b) => {
      const ratioA = a.maxImpressions > 0 ? a.impressions / a.maxImpressions : 0;
      const ratioB = b.maxImpressions > 0 ? b.impressions / b.maxImpressions : 0;
      if (ratioA !== ratioB) return ratioA - ratioB;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return candidates[0];
  }

  /** 灰度比例：showRatio>=1 恒展示；>0 按概率；=0 不展示 */
  shouldShow() {
    if (!this.enabled) return false;
    if (this.showRatio >= 1) return true;
    if (this.showRatio <= 0) return false;
    return Math.random() < this.showRatio;
  }

  /** 原子写回 ads.json（临时文件 + rename + 0600） */
  persist() {
    if (!this.adsFile) return;
    const payload = {
      enabled: this.enabled,
      ads: this.ads.map((ad) => ({
        id: ad.id,
        title: ad.title,
        body: ad.body,
        sponsor_name: ad.sponsorName,
        button_text: ad.buttonText,
        target_url: ad.targetUrl,
        status: ad.status,
        placement: ad.placement,
        starts_at: new Date(ad.startsAt).toISOString(),
        ends_at: new Date(ad.endsAt).toISOString(),
        max_impressions: ad.maxImpressions,
        impressions: ad.impressions,
        clicks: ad.clicks,
      })),
    };
    const tempPath = `${this.adsFile}.tmp`;
    try {
      fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf8');
      try {
        fs.chmodSync(tempPath, 0o600);
      } catch {
        // 平台不支持时忽略
      }
      fs.renameSync(tempPath, this.adsFile);
    } catch (error) {
      this.logger.warn?.('ad.persist.failed', { error: error.message });
    }
  }

  appendEvent(adId, userId, eventType, source) {
    if (!this.eventsFile) return;
    try {
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        adId,
        userId,
        eventType,
        source,
      });
      fs.appendFileSync(this.eventsFile, `${line}\n`, 'utf8');
    } catch (error) {
      this.logger.warn?.('ad.event.failed', { error: error.message });
    }
  }

  /** 曝光：必须在消息发送成功后调用，否则会虚增曝光量 */
  recordImpression(adId, userId) {
    const ad = this.getAdById(adId);
    if (!ad) return;
    ad.impressions += 1;
    this.persist();
    this.appendEvent(adId, userId, 'impression', 'query_result');
  }

  recordClick(adId, userId) {
    const ad = this.getAdById(adId);
    if (!ad) return;
    ad.clicks += 1;
    this.persist();
    this.appendEvent(adId, userId, 'click', 'query_result');
  }

  // ---------- 管理员操作（阶段 C 子集） ----------

  /** 创建广告草稿，返回 { ok, errors?, ad? } */
  createAd(fields, adminId) {
    const id = String(fields.id || `ad-${Date.now().toString(36)}`).trim();
    const raw = {
      id,
      title: fields.title,
      body: fields.body || '',
      sponsor_name: fields.sponsorName,
      button_text: fields.buttonText,
      target_url: fields.targetUrl,
      status: 'draft',
      placement: fields.placement || 'query_result',
      starts_at: fields.startsAt,
      ends_at: fields.endsAt,
      max_impressions: fields.maxImpressions,
    };
    const result = validateAd(raw);
    if (!result.ok) return { ok: false, errors: result.errors };
    this._sync();
    if (this.ads.some((ad) => ad.id === id)) {
      return { ok: false, errors: ['广告 ID 已存在'] };
    }
    this.ads.push({ ...result.ad, impressions: 0, clicks: 0 });
    this.persist();
    this.appendEvent(id, adminId, 'admin_ad_created', 'admin');
    return { ok: true, ad: this.getAdById(id) };
  }

  /** 修改广告状态：draft/pending_review/approved/paused/expired */
  setStatus(id, status, adminId) {
    const ad = this.getAdById(id);
    if (!ad) return { ok: false, errors: ['广告不存在'] };
    if (!AD_STATUSES.has(status)) return { ok: false, errors: [`状态非法：${status}`] };
    ad.status = status;
    this.persist();
    this.appendEvent(id, adminId, `admin_ad_${status}`, 'admin');
    return { ok: true, ad };
  }

  /** 统计：曝光 / 点击 / CTR */
  getStats(id) {
    const ad = this.getAdById(id);
    if (!ad) return undefined;
    const impressions = ad.impressions;
    return {
      impressions,
      clicks: ad.clicks,
      ctr: impressions > 0 ? ad.clicks / impressions : 0,
    };
  }

  /** 运行时切换总开关（TG 按钮操作），持久化并写审计事件 */
  setEnabled(value, adminId) {
    const next = Boolean(value);
    if (this.enabled === next) return next;
    this.enabled = next;
    this.persist();
    this.appendEvent('system', adminId, next ? 'admin_ad_enabled' : 'admin_ad_disabled', 'admin');
    return next;
  }
}

module.exports = { AdService };
