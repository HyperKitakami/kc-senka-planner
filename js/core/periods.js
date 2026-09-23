/* ==========================================================================
   core/periods.js — 周期与战果归属边界
   依据 docs/03_data.md §7 与 docs/04_calculation.md §4。

   重要：项目存在两套互不混用的时间边界。
     · 任务刷新边界（TaskRefreshBoundary）—— 判定任务是否刷新
     · 战果归属边界（SenkaAttributionBoundary）—— 判定战果归属哪个月份、
       剩余周期、所需日均、预测终点
   ========================================================================== */
(function (KC) {
  'use strict';

  const U = KC.utils;

  /** 战果归属截止时刻（北京时间小时数，按当月最后一日为基准） */
  const ATTRIBUTION_HOUR = {
    SORTIE: 21, // 出击战果：本月末日 21:00
    EO: 21,     // EO 战果：本月末日 21:00
    TASK: 13    // 任务战果：本月末日 13:00
  };

  /**
   * 战果归属**起始**时刻的小时数（落在上月末日当天）。
   * 出击 / 任务与各自的截止小时相同，区间长度正好一个月；
   * ⛔ EO 例外：截止是本月末日 21:00，起点却是**上月末日 23:00**
   * —— 血条 23:00 才复活，末日 21:00～23:00 打掉的 EO 不给战果（docs/03_data.md §7.2）。
   * 所以 EO 的起点**不能**复用 ATTRIBUTION_HOUR.EO，否则整条区间会多算 2 小时。
   */
  const ATTRIBUTION_START_HOUR = {
    SORTIE: 21,
    EO: 23,
    TASK: 13
  };

  /** 任务刷新边界（新周期开始时刻，北京时间小时数） */
  const REFRESH_HOUR = {
    DAILY: 4,
    WEEKLY: 4,
    MONTHLY: 4,
    QUARTERLY: 4,
    YEARLY: 4
  };

  /** 某月的战果归属结束时刻（默认出击口径：本月末日 21:00） */
  function attributionEnd(monthKey, kind) {
    const hour = ATTRIBUTION_HOUR[kind || 'SORTIE'];
    const p = String(monthKey).split('-').map(Number);
    return new Date(p[0], p[1] - 1, U.daysInMonth(monthKey), hour, 0, 0, 0);
  }

  /**
   * 某月的战果归属开始时刻（默认出击口径：上月末日 21:00；EO 为上月末日 23:00）。
   * ⚠️ 起点小时取 ATTRIBUTION_START_HOUR，**不是** ATTRIBUTION_HOUR —— 两者只有 EO 不同。
   */
  function attributionStart(monthKey, kind) {
    const k = kind || 'SORTIE';
    const prev = U.addMonths(monthKey, -1);
    const p = String(prev).split('-').map(Number);
    return new Date(p[0], p[1] - 1, U.daysInMonth(prev), ATTRIBUTION_START_HOUR[k], 0, 0, 0);
  }

  /**
   * 当前时刻所属的战果归属月（出击口径）。
   * 本月末日 21:00 之后，战果已归属次月。
   */
  function currentAttributionMonth(now) {
    now = now || new Date();
    const month = U.monthKeyOf(U.toDateKey(now));
    if (now.getTime() >= attributionEnd(month, 'SORTIE').getTime()) {
      return U.addMonths(month, 1);
    }
    return month;
  }

  /**
   * 某月"已经过天数"（按战果归属边界计算）。
   * 起算点为上月末日 21:00，终点为本月末日 21:00；
   * 过去月份返回整月天数，未来月份返回 0。
   */
  function elapsedDays(monthKey, now) {
    now = now || new Date();
    const start = attributionStart(monthKey, 'SORTIE').getTime();
    const end = attributionEnd(monthKey, 'SORTIE').getTime();
    const t = U.clamp(now.getTime(), start, end);
    return (t - start) / 86400000;
  }

  /** 某月"剩余天数"（截至本月末日 21:00） */
  function remainingDays(monthKey, now) {
    now = now || new Date();
    const start = attributionStart(monthKey, 'SORTIE').getTime();
    const end = attributionEnd(monthKey, 'SORTIE').getTime();
    const t = U.clamp(now.getTime(), start, end);
    return (end - t) / 86400000;
  }

  /* --- 整数日数（用于日均除数）-----------------------------------------
     计算日均时，日数一律取整：
       · 已过天数：向下取整（不足一天不计），因此本月首日不满一天时为 0
       · 剩余天数：向下取整后 +1（把尚未过完的当天算作可用的 1 天）
     两者相加恰好等于当月总天数。
     ------------------------------------------------------------------- */

  /** 已过天数（整数，向下取整） */
  function elapsedDayCount(monthKey, now) {
    return Math.max(0, Math.floor(elapsedDays(monthKey, now)));
  }

  /** 剩余天数（整数，向下取整后 +1；本期已结束则为 0） */
  function remainingDayCount(monthKey, now) {
    const rest = remainingDays(monthKey, now);
    if (rest <= 0) return 0;
    return Math.floor(rest) + 1;
  }

  /* ======================================================================
     任务周期解析（TaskRefreshBoundary）
     依据 docs/03_data.md §7.1、docs/04_calculation.md §4.2 / §4.5。
     仅用于判定任务是否刷新、查询对应 PeriodId；
     不得用于战果归属、剩余周期、所需日均或预测。
     ====================================================================== */

  /** 季度序号：春=1（3~5 月）、夏=2（6~8 月）、秋=3（9~11 月）、冬=4（12~2 月） */
  function quarterIndex(month) {
    if (month >= 3 && month <= 5) return 1;
    if (month >= 6 && month <= 8) return 2;
    if (month >= 9 && month <= 11) return 3;
    return 4;
  }

  /** 各季度首月 */
  const QUARTER_START_MONTH = { 1: 3, 2: 6, 3: 9, 4: 12 };

  /** 某一日所属的 ISO 周（返回 { year, week }，用于 WEEKLY 的 PeriodId） */
  function isoWeek(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dow = d.getUTCDay() || 7;              // 周一=1 … 周日=7
    d.setUTCDate(d.getUTCDate() + 4 - dow);      // 移到本周周四
    const year = d.getUTCFullYear();
    const yearStart = new Date(Date.UTC(year, 0, 1));
    const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
    return { year: year, week: week };
  }

  /**
   * 解析某个任务模板在给定时刻所处的周期。
   * @param {string} resetCycle NONE/DAILY/WEEKLY/MONTHLY/QUARTERLY/YEARLY/EVENT
   * @param {Date} [now]
   * @param {{eventPeriodId?: string, resetMonth?: number}} [opts]
   * @returns {{id: string, start: Date|null, end: Date|null}}
   */
  function taskPeriod(resetCycle, now, opts) {
    now = now || new Date();
    opts = opts || {};
    const y = now.getFullYear();
    const m = now.getMonth() + 1;
    const d = now.getDate();
    const hour = REFRESH_HOUR[resetCycle] || 0;

    if (resetCycle === 'NONE') {
      return { id: 'all', start: null, end: null };
    }
    if (resetCycle === 'EVENT') {
      return { id: opts.eventPeriodId || '未命名活动', start: null, end: null };
    }

    if (resetCycle === 'DAILY') {
      let start = new Date(y, m - 1, d, hour, 0, 0, 0);
      if (now.getTime() < start.getTime()) start = new Date(y, m - 1, d - 1, hour, 0, 0, 0);
      return {
        id: U.toDateKey(start),
        start: start,
        end: new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1, hour, 0, 0, 0)
      };
    }

    if (resetCycle === 'WEEKLY') {
      const backToMonday = (now.getDay() + 6) % 7;   // 周一=0
      let start = new Date(y, m - 1, d - backToMonday, hour, 0, 0, 0);
      if (now.getTime() < start.getTime()) start = new Date(y, m - 1, d - backToMonday - 7, hour, 0, 0, 0);
      const w = isoWeek(start);
      return {
        id: w.year + '-W' + U.pad2(w.week),
        start: start,
        end: new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7, hour, 0, 0, 0)
      };
    }

    if (resetCycle === 'MONTHLY') {
      let start = new Date(y, m - 1, 1, hour, 0, 0, 0);
      if (now.getTime() < start.getTime()) start = new Date(y, m - 2, 1, hour, 0, 0, 0);
      return {
        id: start.getFullYear() + '-' + U.pad2(start.getMonth() + 1),
        start: start,
        end: new Date(start.getFullYear(), start.getMonth() + 1, 1, hour, 0, 0, 0)
      };
    }

    if (resetCycle === 'QUARTERLY') {
      // 在所有季度起点中取不晚于 now 的最近一个（冬跨年，需同时考虑上一年）
      let start = null;
      [y - 1, y].forEach(function (yy) {
        [3, 6, 9, 12].forEach(function (sm) {
          const candidate = new Date(yy, sm - 1, 1, hour, 0, 0, 0);
          if (candidate.getTime() <= now.getTime() &&
              (!start || candidate.getTime() > start.getTime())) {
            start = candidate;
          }
        });
      });
      const qn = quarterIndex(start.getMonth() + 1);
      return {
        id: start.getFullYear() + '-Q' + qn,
        start: start,
        end: new Date(start.getFullYear(), start.getMonth() + 3, 1, hour, 0, 0, 0)
      };
    }

    if (resetCycle === 'YEARLY') {
      const rm = U.clamp(Number(opts.resetMonth) || 1, 1, 12);
      let start = new Date(y, rm - 1, 1, hour, 0, 0, 0);
      if (now.getTime() < start.getTime()) start = new Date(y - 1, rm - 1, 1, hour, 0, 0, 0);
      return {
        id: String(start.getFullYear()),
        start: start,
        end: new Date(start.getFullYear() + 1, rm - 1, 1, hour, 0, 0, 0)
      };
    }

    // 未知周期类型：退化为不重置，避免产生错误数据
    return { id: 'all', start: null, end: null };
  }

  /**
   * 当前时刻是否已过本月「任务战果归属截止」（本月末日 13:00）。
   * 过了之后完成的任务，其战果归属次月（docs/04_calculation.md §4.3）。
   */
  function pastTaskCutoff(now) {
    now = now || new Date();
    const month = U.monthKeyOf(U.toDateKey(now));
    return now.getTime() >= attributionEnd(month, 'TASK').getTime();
  }

  /**
   * 当前时刻所属的「任务战果归属月」（任务口径：本月末日 13:00 之后为次月）。
   * 与 currentAttributionMonth（出击口径 21:00）是两套边界，不得混用。
   */
  function currentTaskAttributionMonth(now) {
    now = now || new Date();
    const month = U.monthKeyOf(U.toDateKey(now));
    return pastTaskCutoff(now) ? U.addMonths(month, 1) : month;
  }

  /**
   * 某月「任务战果归属区间」：前月末日 13:00 ～ 本月末日 13:00（左闭右开）。
   * 判定一条完成记录归属哪个月时，看它的完成时刻落在哪个区间。
   */
  function taskAttributionWindow(monthKey) {
    return {
      start: attributionEnd(U.addMonths(monthKey, -1), 'TASK'),
      end: attributionEnd(monthKey, 'TASK')
    };
  }

  /**
   * 某时刻落在「任务战果归属区间」的哪个月（'YYYY-MM'）。
   * 本月末日 13:00 之后完成的算次月。
   */
  function taskAttributionMonthOf(at) {
    const month = U.monthKeyOf(U.toDateKey(at));
    return at.getTime() >= attributionEnd(month, 'TASK').getTime() ? U.addMonths(month, 1) : month;
  }

  /** 某月是否为「季度第三月」（2/5/8/11 月）——季常战果在此月有失效例外 */
  function isQuarterLastMonth(monthKey) {
    return [2, 5, 8, 11].indexOf(Number(String(monthKey).split('-')[1])) >= 0;
  }

  KC.periods = {
    ATTRIBUTION_HOUR: ATTRIBUTION_HOUR,
    ATTRIBUTION_START_HOUR: ATTRIBUTION_START_HOUR,
    REFRESH_HOUR: REFRESH_HOUR,
    QUARTER_START_MONTH: QUARTER_START_MONTH,
    attributionEnd: attributionEnd,
    attributionStart: attributionStart,
    currentAttributionMonth: currentAttributionMonth,
    pastTaskCutoff: pastTaskCutoff,
    currentTaskAttributionMonth: currentTaskAttributionMonth,
    taskAttributionWindow: taskAttributionWindow,
    taskAttributionMonthOf: taskAttributionMonthOf,
    isQuarterLastMonth: isQuarterLastMonth,
    elapsedDays: elapsedDays,
    remainingDays: remainingDays,
    elapsedDayCount: elapsedDayCount,
    remainingDayCount: remainingDayCount,
    quarterIndex: quarterIndex,
    isoWeek: isoWeek,
    taskPeriod: taskPeriod
  };
})(window.KC = window.KC || {});
