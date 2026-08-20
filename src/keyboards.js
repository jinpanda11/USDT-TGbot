'use strict';

const { Markup } = require('telegraf');

// 底部常驻按钮文案
const BTN = {
  QUERY_MONTH: '📥 查询本月',
  PICK_MONTH: '📅 选择月份',
  EXPORT_MONTH: '📄 导出本月',
  ADDRESSES: '📋 地址管理',
  ADD_ADDR: '➕ 添加地址',
  TEMP_QUERY: '🔍 临时查询',
  SETTINGS: '⚙️ 设置',
  WATCH: '📡 地址监听',
  HELP: '❓ 帮助',
  CANCEL: '❌ 取消',
};

// 其他固定文案
const TEXT = {
  MENU_BUTTON: '📋 菜单',
  SPONSOR_LABEL: '📢赞助内容',
};

const MAIN_KEYBOARD = Markup.keyboard([
  [BTN.QUERY_MONTH, BTN.PICK_MONTH],
  [BTN.EXPORT_MONTH, BTN.ADDRESSES],
  [BTN.TEMP_QUERY, BTN.ADD_ADDR],
  [BTN.SETTINGS, BTN.WATCH],
  [BTN.HELP, BTN.CANCEL],
]).resize();

const CANCEL_KEYBOARD = Markup.keyboard([[BTN.CANCEL]]).resize();

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

function monthPickerKeyboard(exportMode = false, currentYear, currentMonth) {
  const prefix = exportMode ? 'exm' : 'qm';
  const rows = [
    [Markup.button.callback(`📊 今年总收入（${currentYear} 年至今）`, 'ytd:current')],
  ];
  // 当前年 12 个月
  for (let start = 1; start <= 12; start += 3) {
    rows.push(
      [0, 1, 2].map((offset) => {
        const m = start + offset;
        const label = m === currentMonth ? `·${m}月·` : `${m}月`;
        return Markup.button.callback(label, `${prefix}:${currentYear}:${m}`);
      })
    );
  }
  // 快速：上月 / 今年几个近月也可够用；再给上年入口
  const prevYear = currentYear - 1;
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

module.exports = {
  BTN,
  TEXT,
  MAIN_KEYBOARD,
  CANCEL_KEYBOARD,
  settingsKeyboard,
  addressKeyboard,
  monthPickerKeyboard,
  yearMonthPickerKeyboard,
  tempMonthPickerKeyboard,
  tempYearPickerKeyboard,
};
