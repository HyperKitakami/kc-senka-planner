/* ==========================================================================
   calc/plan.js — 规划计算（全部运行时计算，绝不落库）
   依据 docs/04_calculation.md §二 / §五 / §六 / §七 / §八 / §九 / §十 / §十一 / §十二。

   核心口径：
     实际战果 = 继承战果 + 累计出击战果 + 已完成 EO 战果 + 已完成任务战果
     规划战果 = 实际战果 + 规划池战果
     自然日均 = 累计出击战果 ÷ 已经过天数（按战果归属边界，仅出击口径）
     所需日均 = max(0, 目标 − 所选口径战果) ÷ 剩余天数（剩余周期按战果归属边界）
     预计月底 = 所选口径战果 + 预测日均 × 剩余天数
   ========================================================================== */
(function (KC) {
  'use strict';

  const U = KC.utils;

  /** 最近 N 天的出击战果平均（窗口内无记录的日期按 0 计） */
  function recentSortieAvg(records, days, now) {
    now = now || new Date();
    const n = Number(days);
    if (!isFinite(n) || n <= 0) return 0;

    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - (n - 1));
    const startTime = start.getTime();
    const endTime = end.getTime() + 86399999;   // 含当天全天

    let sum = 0;
    (records || []).forEach(function (r) {
      const t = U.parseDateKey(r.date).getTime();
      if (t >= startTime && t <= endTime) sum += Number(r.sortieSenka) || 0;
    });
    return U.round2(sum / n);
  }

  /** 预测日均（docs §十一） */
  function forecastDailyAvg(records, monthStats, prediction, now) {
    const pred = prediction || {};
    if (pred.mode === 'period') {
      // 当前周期平均即自然日均；已过天数不足 1 天时无法计算，按 0 处理
      return monthStats.naturalDailyAvg === null ? 0 : monthStats.naturalDailyAvg;
    }
    return recentSortieAvg(records, pred.days || 7, now);
  }

  /**
   * 生成完整的规划结果。
   * @param {{
   *   month: string, now?: Date, mode?: 'actual'|'combined',
   *   records: Array, taskTemplates: Array, taskRecords: Array,
   *   monthlyContext?: object, poolIds?: Array<string>, prediction?: {mode, days}
   * }} input
   */
  function buildPlan(input) {
    const now = input.now || new Date();
    const month = input.month;
    const mode = input.mode === 'combined' ? 'combined' : 'actual';

    const monthStats = KC.calc.stats.monthSummary(input.records || [], month, now);

    const ctx = input.monthlyContext || {};
    const inheritedSenka = U.round2(Number(ctx.inheritedSenka) || 0);
    const rawTarget = ctx.targetSenka;
    const targetSenka = (rawTarget === null || rawTarget === undefined || rawTarget === '')
      ? null : U.round2(Number(rawTarget));

    const taskOv = KC.calc.tasks.overview(
      input.taskTemplates || [], input.taskRecords || [],
      input.poolIds || [], now, month
    );

    const sortieTotal = monthStats.total;
    const eoCompleted = taskOv.eoCompleted;
    const taskCompleted = taskOv.taskCompleted;

    const actualSenka = U.round2(inheritedSenka + sortieTotal + eoCompleted + taskCompleted);
    const poolSenka = taskOv.poolPendingSenka;
    const plannedSenka = U.round2(actualSenka + poolSenka);

    // 日数一律取整：已过天数向下取整、剩余天数向下取整 +1（见 periods.elapsedDayCount）
    const elapsedDays = monthStats.elapsedDays;
    const remainingDays = monthStats.remainingDays;
    const remainingDaysExact = monthStats.remainingDaysExact;

    const forecastDaily = forecastDailyAvg(input.records || [], monthStats, input.prediction, now);
    const futureSortie = U.round2(forecastDaily * remainingDays);

    const base = mode === 'combined' ? plannedSenka : actualSenka;
    const gap = targetSenka === null ? null : U.round2(targetSenka - base);
    const completion = (targetSenka !== null && targetSenka > 0)
      ? U.round2(base / targetSenka * 100) : null;

    let requiredDaily = null;
    if (gap !== null) {
      if (gap <= 0) requiredDaily = 0;
      else requiredDaily = remainingDays > 0 ? U.round2(gap / remainingDays) : null;
    }

    return {
      month: month,
      mode: mode,
      // 构成
      inheritedSenka: inheritedSenka,
      sortieTotal: sortieTotal,
      eoCompleted: eoCompleted,
      taskCompleted: taskCompleted,
      actualSenka: actualSenka,
      poolSenka: poolSenka,
      plannedSenka: plannedSenka,
      poolPendingCount: taskOv.poolPendingCount,
      // 周期
      elapsedDays: elapsedDays,
      remainingDays: remainingDays,
      remainingDaysExact: remainingDaysExact,
      // 日均
      naturalDailyAvg: monthStats.naturalDailyAvg,
      forecastDaily: forecastDaily,
      // 预测
      futureSortie: futureSortie,
      forecastEndActual: U.round2(actualSenka + futureSortie),
      forecastEndPlanned: U.round2(plannedSenka + futureSortie),
      // 目标
      targetSenka: targetSenka,
      base: base,
      gap: gap,
      completion: completion,
      requiredDaily: requiredDaily,
      achieved: gap !== null && gap <= 0,
      // 明细
      records: monthStats.list,
      pendingItems: taskOv.pendingItems || []
    };
  }

  /**
   * 便捷入口：按指定「战果归属月」与用户偏好生成规划结果。
   * @param {object} store KC.store
   * @param {string} monthKey 'YYYY-MM'
   * @param {Date} [now]
   * @param {{mode?: 'actual'|'combined', poolIds?: Array<string>}} [opts]
   *   mode   强制指定口径（数据分析页固定用 actual）
   *   poolIds 指定规划池；传入 [] 可让历史月份不带规划池
   */
  function forMonth(store, monthKey, now, opts) {
    opts = opts || {};
    now = now || new Date();
    const settings = store.getSettings();
    return buildPlan({
      month: monthKey,
      now: now,
      mode: opts.mode || settings.planningMode,
      records: store.state.dailyRecords,
      taskTemplates: store.state.taskTemplates,
      taskRecords: store.state.taskRecords,
      monthlyContext: store.getMonthlyContext(monthKey),
      poolIds: opts.poolIds !== undefined ? opts.poolIds : store.getEffectivePlanningPool(monthKey),
      prediction: { mode: settings.predictionMode, days: settings.predictionDays }
    });
  }

  /**
   * 便捷入口：按「当前战果归属月」生成规划结果。
   * 首页与战果规划页共用，保证两页数字完全一致。
   */
  function forCurrentMonth(store, now) {
    now = now || new Date();
    return forMonth(store, KC.periods.currentAttributionMonth(now), now);
  }

  /** 进度条分段占比（相对目标；无目标时以规划战果为基准） */
  function progressSegments(plan) {
    const ref = Math.max(plan.targetSenka || 0, plan.plannedSenka, plan.actualSenka, 1);
    const actual = U.clamp(plan.actualSenka / ref * 100, 0, 100);
    const planned = U.clamp((plan.plannedSenka - plan.actualSenka) / ref * 100, 0, 100 - actual);
    const remaining = U.clamp(((plan.targetSenka || 0) - plan.plannedSenka) / ref * 100, 0, 100 - actual - planned);
    return { ref: ref, actual: actual, planned: planned, remaining: remaining };
  }

  KC.calc = KC.calc || {};
  KC.calc.plan = {
    recentSortieAvg: recentSortieAvg,
    forecastDailyAvg: forecastDailyAvg,
    buildPlan: buildPlan,
    forMonth: forMonth,
    forCurrentMonth: forCurrentMonth,
    progressSegments: progressSegments
  };
})(window.KC = window.KC || {});
