'use strict';

/**
 * 解析 /query 或 /export 的参数。
 * 返回 period：{ type: 'month', year, month } 或 { type: 'ytd', year }。
 * 'ytd' / '今年' 表示今年 1 月 1 日至今。
 */
function parsePeriod(args, fallback) {
  if (!args.length) return { type: 'month', year: fallback.year, month: fallback.month };
  const first = String(args[0]).toLowerCase();
  if (first === 'ytd' || first === '今年') {
    return { type: 'ytd', year: fallback.year };
  }
  if (args.length === 1) {
    const value = args[0];
    if (/^\d{4}-\d{1,2}$/.test(value)) {
      const [y, m] = value.split('-').map((part) => Number.parseInt(part, 10));
      return { type: 'month', year: y, month: m };
    }
    const month = Number.parseInt(value, 10);
    return { type: 'month', year: fallback.year, month };
  }
  return {
    type: 'month',
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
  // 反复剥离首尾的 <> 与引号，直到稳定（兼容 <"KEY">、"<KEY>" 等组合）
  let result = String(value ?? '').trim();
  let previous;
  do {
    previous = result;
    result = result.replace(/^<|>$/g, '').replace(/^["']|["']$/g, '');
  } while (result !== previous);
  return result.trim();
}

function monthLabel(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

module.exports = {
  parsePeriod,
  validateYearMonth,
  normalizeApiKey,
  monthLabel,
};
