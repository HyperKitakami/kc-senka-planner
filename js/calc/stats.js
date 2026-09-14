/* ==========================================================================
   calc/stats.js — 统计计算（全部运行时计算，绝不落库）
   依据 docs/04_calculation.md §一 / §九。
   ========================================================================== */
(function (KC) {
  'use strict';

  const U = KC.utils;

  /** 取出某个月份的每日记录 */
  function recordsOfMonth(records, monthKey) {
    return records.filter(function (r) { return U.monthKeyOf(r.date) === monthKey; });
  }

  /**
   * 最近 N 天的逐日出击战果序列（按日期升序）。
   * 无记录的日期 value 为 null，以便区分「当天未记录」与「当天为 0」。
   */
  function dailySeries(records, days, now) {
    now = now || new Date();
    const map = {};
    (records || []).forEach(function (r) { map[r.date] = Number(r.sortieSenka) || 0; });

    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(end.getFullYear(), end.getMonth(), end.getDate() - i);
      const key = U.toDateKey(d);
      out.push({
        date: key,
        value: Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null
      });
    }
    return out;
  }

  /** 最近 N 天的记录摘要：有记录天数、合计、日均（按有记录天数） */
  function recentSummary(records, days, now) {
    const series = dailySeries(records, days, now);
    let count = 0;
    let total = 0;
    let max = null;
    series.forEach(function (p) {
      if (p.value === null) return;
      count++;
      total += p.value;
      if (max === null || p.value > max) max = p.value;
    });
    return {
      days: days,
      series: series,
      count: count,
      total: U.round2(total),
      max: max,
      avg: count > 0 ? U.round2(total / count) : null
    };
  }

  /**
   * 月份统计摘要。
   * 自然日均 = 累计出击战果 ÷ 已经过天数（按战果归属边界计算）。
   * EO / EX / 活动任务战果不参与自然日均。
   */
  function monthSummary(records, monthKey, now) {
    now = now || new Date();
    const list = recordsOfMonth(records, monthKey).slice().sort(function (a, b) {
      return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
    });

    let total = 0;
    let max = null;
    let min = null;
    list.forEach(function (r) {
      const v = Number(r.sortieSenka) || 0;
      total += v;
      if (max === null || v > max) max = v;
      if (min === null || v < min) min = v;
    });

    const elapsedDays = KC.periods.elapsedDayCount(monthKey, now);
    const remainingDays = KC.periods.remainingDayCount(monthKey, now);

    return {
      monthKey: monthKey,
      list: list,
      count: list.length,
      total: U.round2(total),
      max: max,
      min: min,
      /** 已过天数（整数；不足一天不计，本月首日不满一天时为 0） */
      elapsedDays: elapsedDays,
      /** 剩余天数（整数；向下取整后 +1，已结束为 0） */
      remainingDays: remainingDays,
      /** 精确剩余天数（小数，仅用于展示倒计时） */
      remainingDaysExact: KC.periods.remainingDays(monthKey, now),
      /** 自然日均；已过天数为 0 时数据不足，返回 null */
      naturalDailyAvg: elapsedDays > 0 ? U.round2(total / elapsedDays) : null
    };
  }

  KC.calc = KC.calc || {};
  KC.calc.stats = {
    recordsOfMonth: recordsOfMonth,
    monthSummary: monthSummary,
    dailySeries: dailySeries,
    recentSummary: recentSummary
  };
})(window.KC = window.KC || {});
