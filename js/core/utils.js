/* ==========================================================================
   core/utils.js — 通用工具函数
   命名遵循 docs/05_glossary.md 的命名规范。
   ========================================================================== */
(function (KC) {
  'use strict';

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  /** Date -> 'YYYY-MM-DD'（本地时区，项目统一按 UTC+8 使用） */
  function toDateKey(date) {
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
  }

  function todayKey() {
    return toDateKey(new Date());
  }

  /** 'YYYY-MM-DD' -> Date（当日 00:00） */
  function parseDateKey(key) {
    const p = String(key).split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]);
  }

  /** 'YYYY-MM-DD' -> 'YYYY-MM' */
  function monthKeyOf(dateKey) {
    return String(dateKey).slice(0, 7);
  }

  function monthLabel(monthKey) {
    const p = String(monthKey).split('-');
    return p[0] + ' 年 ' + Number(p[1]) + ' 月';
  }

  function daysInMonth(monthKey) {
    const p = String(monthKey).split('-').map(Number);
    return new Date(p[0], p[1], 0).getDate();
  }

  /** 'YYYY-MM' 偏移 delta 个月 */
  function addMonths(monthKey, delta) {
    const p = String(monthKey).split('-').map(Number);
    const d = new Date(p[0], p[1] - 1 + delta, 1);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
  }

  function formatNumber(value, digits) {
    if (digits === undefined) digits = 2;
    const n = Number(value);
    if (value === null || value === undefined || value === '' || !isFinite(n)) return '—';
    return n.toFixed(digits);
  }

  function formatInt(value) {
    const n = Number(value);
    if (value === null || value === undefined || value === '' || !isFinite(n)) return '—';
    return String(Math.round(n));
  }

  function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function uid(prefix) {
    return (prefix || 'id') + '_' + Date.now().toString(36) + '_' +
      Math.random().toString(36).slice(2, 8);
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  /** 保留 2 位小数（战果实际计算至小数点后 2 位） */
  function round2(value) {
    return Math.round((Number(value) || 0) * 100) / 100;
  }

  /**
   * 解析「必填」数字输入（表单里的战果值等）。
   *
   * ⛔ **别直接用 `Number(raw)`**：`Number('')` / `Number('   ')` / `Number(null)` 全是 `0`，
   * 会把"没填"静默存成 0（records / tasks / archive 三个表单都踩过）。
   * 留空、非法、负数一律抛错，由调用方 catch 后 toast 给用户。
   *
   * 可选字段请照 `planning.js` 的写法自行判空（空 ⇒ `null`），不要用这个函数。
   *
   * @param {*} raw 表单原始值（字符串 / null / undefined）
   * @param {string} label 字段名，用于错误文案（如「当日出击战果」）
   * @returns {number} 已保留 2 位小数的数值
   */
  function requiredNumber(raw, label) {
    const name = label || '数值';
    const text = (raw === null || raw === undefined) ? '' : String(raw).trim();
    if (text === '') throw new Error('请填写' + name + '。');
    const n = Number(text);
    if (!isFinite(n) || n < 0) throw new Error(name + '必须是不小于 0 的数字。');
    return round2(n);
  }

  KC.utils = {
    pad2: pad2,
    toDateKey: toDateKey,
    todayKey: todayKey,
    parseDateKey: parseDateKey,
    monthKeyOf: monthKeyOf,
    monthLabel: monthLabel,
    daysInMonth: daysInMonth,
    addMonths: addMonths,
    formatNumber: formatNumber,
    formatInt: formatInt,
    escapeHtml: escapeHtml,
    uid: uid,
    clamp: clamp,
    round2: round2,
    requiredNumber: requiredNumber
  };
})(window.KC = window.KC || {});
