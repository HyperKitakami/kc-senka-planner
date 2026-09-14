/* ==========================================================================
   calc/analysis.js — 数据分析计算（全部运行时计算，绝不落库、绝不缓存）
   依据 docs/01_requirements.md §四 / §七、docs/02_ui.md §4.5、docs/04_calculation.md §十三。
   ========================================================================== */
(function (KC) {
  'use strict';

  const U = KC.utils;

  /**
   * 某月逐日序列（用于「每日出击增长趋势」图表）。
   * value 为 null 表示当天没有记录（图表上表现为空档，而不是 0）；
   * cumulative 为截至当天的累计出击战果，无记录的日期沿用前一日累计值。
   */
  function monthDailySeries(records, monthKey) {
    const map = {};
    (records || []).forEach(function (r) {
      if (U.monthKeyOf(r.date) === monthKey) map[r.date] = Number(r.sortieSenka) || 0;
    });

    const days = U.daysInMonth(monthKey);
    const out = [];
    let cumulative = 0;

    for (let d = 1; d <= days; d++) {
      const key = monthKey + '-' + U.pad2(d);
      const has = Object.prototype.hasOwnProperty.call(map, key);
      if (has) cumulative += map[key];
      out.push({
        day: d,
        date: key,
        value: has ? map[key] : null,
        cumulative: U.round2(cumulative)
      });
    }
    return out;
  }

  /** 指定若干月份的累计出击战果（按传入顺序返回，供月度比较图使用） */
  function monthlyComparison(records, monthKeys) {
    return (monthKeys || []).map(function (monthKey) {
      const list = KC.calc.stats.recordsOfMonth(records, monthKey);
      let total = 0;
      let max = null;
      list.forEach(function (r) {
        const v = Number(r.sortieSenka) || 0;
        total += v;
        if (max === null || v > max) max = v;
      });
      return {
        monthKey: monthKey,
        label: monthKey.slice(2),          // '26-09'，图表标签用短格式
        total: U.round2(total),
        count: list.length,
        max: max
      };
    });
  }

  /** 最近 N 个月的月份键（升序，含当前战果归属月） */
  function recentMonths(now, count) {
    now = now || new Date();
    const current = KC.periods.currentAttributionMonth(now);
    const out = [];
    for (let i = count - 1; i >= 0; i--) out.push(U.addMonths(current, -i));
    return out;
  }

  /** 有数据的月份（倒序，含当前战果归属月），用于月份浏览 */
  function availableMonths(store, now) {
    now = now || new Date();
    const set = {};
    (store.state.dailyRecords || []).forEach(function (r) { set[U.monthKeyOf(r.date)] = true; });
    (store.state.monthlyContexts || []).forEach(function (m) { set[m.month] = true; });
    (store.state.archives || []).forEach(function (a) { set[a.month] = true; });
    set[KC.periods.currentAttributionMonth(now)] = true;
    return Object.keys(set).sort().reverse();
  }

  /**
   * 某月的战果构成（继承 / 出击 / EO / 任务）。
   * 固定用实际统计口径，且不带规划池——分析页只关心"已经发生了什么"。
   */
  function monthComposition(store, monthKey, now) {
    const plan = KC.calc.plan.forMonth(store, monthKey, now, { mode: 'actual', poolIds: [] });
    const parts = [
      { key: 'inherited', label: '继承战果', value: plan.inheritedSenka },
      { key: 'sortie',    label: '出击战果', value: plan.sortieTotal },
      { key: 'eo',        label: 'EO 战果',  value: plan.eoCompleted },
      { key: 'task',      label: '任务战果', value: plan.taskCompleted }
    ];
    return { plan: plan, parts: parts, total: plan.actualSenka };
  }

  KC.calc = KC.calc || {};
  KC.calc.analysis = {
    monthDailySeries: monthDailySeries,
    monthlyComparison: monthlyComparison,
    recentMonths: recentMonths,
    availableMonths: availableMonths,
    monthComposition: monthComposition
  };
})(window.KC = window.KC || {});
