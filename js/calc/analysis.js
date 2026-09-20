/* ==========================================================================
   calc/analysis.js — 数据分析计算（全部运行时计算，绝不落库、绝不缓存）
   依据 docs/01_requirements.md §四 / §七、docs/02_ui.md §4.6、docs/04_calculation.md §十三。
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

  /**
   * 「月度比较」可选的四项战果构成。
   * key 与 monthComposition 的 parts key 完全一致，页面据此取同一份调色板，
   * 保证「月度比较」与「战果构成」两张卡片的同项颜色统一。
   * 数组顺序即图表的堆叠顺序与勾选框顺序，不要随意调整。
   */
  const COMPARE_METRICS = [
    { key: 'inherited', label: '继承战果' },
    { key: 'sortie',    label: '出击战果' },
    { key: 'eo',        label: 'EO 战果' },
    { key: 'task',      label: '任务战果' }
  ];

  /**
   * 归一化 settings.compareMetrics。
   * 非数组（含 undefined / null / 字符串）一律回退为「四项全选」；
   * 数组则过滤掉未知 key 并按 COMPARE_METRICS 的固定顺序重排。
   * **空数组原样保留**——那是用户主动取消全部勾选，不是非法值。
   */
  function normalizeCompareMetrics(value) {
    if (!Array.isArray(value)) {
      return COMPARE_METRICS.map(function (m) { return m.key; });
    }
    return COMPARE_METRICS.filter(function (m) {
      return value.indexOf(m.key) >= 0;
    }).map(function (m) { return m.key; });
  }

  /** 「月度比较」横轴区间的月份数上限与默认值 */
  const COMPARE_MAX_MONTHS = 24;
  const COMPARE_DEFAULT_MONTHS = 12;

  /**
   * 是否为合法的月份键。
   * 光靠 /^\d{4}-\d{2}$/ 不够：'2026-13' 能过正则，但 addMonths 会把它滚成 2027-01，
   * 于是"用户填了 13 月"会静默变成另一个区间。这里连月份范围一起校验。
   */
  function isMonthKey(value) {
    const s = String(value === null || value === undefined ? '' : value);
    if (!/^\d{4}-\d{2}$/.test(s)) return false;
    const m = Number(s.slice(5));
    return m >= 1 && m <= 12;
  }

  /** [from, to] 的月份键列表（升序，含两端）；带上限保护，避免异常输入转不出来 */
  function monthRange(from, to) {
    const out = [];
    let cur = from;
    for (let i = 0; i < COMPARE_MAX_MONTHS && cur <= to; i++) {
      out.push(cur);
      cur = U.addMonths(cur, 1);
    }
    return out;
  }

  /**
   * 归一化「月度比较」的横轴区间（用户可自由指定起止月份）。
   * 保证输出一定是一个合法区间：
   *   · 起止任一非法（缺失 / 非 'YYYY-MM'）→ 回退「最近 COMPARE_DEFAULT_MONTHS 个月」，
   *     止 = 当前战果归属月；只有一端非法时，另一端保留用户的选择
   *   · 起 > 止 → 自动交换（两个框填反了不该变成空图）
   *   · 跨度超过 COMPARE_MAX_MONTHS → 以「止」为准向前截断，并置 truncated = true
   *
   * @returns {{from: string, to: string, months: Array<string>, truncated: boolean}}
   *   months 为升序月份键数组，长度 1 ～ COMPARE_MAX_MONTHS
   */
  function normalizeCompareRange(from, to, now) {
    now = now || new Date();
    const fallbackTo = KC.periods.currentAttributionMonth(now);

    let end = isMonthKey(to) ? String(to) : fallbackTo;
    let start = isMonthKey(from) ? String(from) : U.addMonths(end, -(COMPARE_DEFAULT_MONTHS - 1));

    if (start > end) { const swap = start; start = end; end = swap; }

    let truncated = false;
    const earliest = U.addMonths(end, -(COMPARE_MAX_MONTHS - 1));
    if (start < earliest) { start = earliest; truncated = true; }

    return { from: start, to: end, months: monthRange(start, end), truncated: truncated };
  }

  /**
   * 指定若干月份的战果构成（按传入顺序返回，供「月度比较」堆叠柱状图使用）。
   *
   * 四项构成与「战果构成」卡片同源（同一份 plan.forMonth，口径固定 actual），
   * 所以两处的数字与颜色都能一一对上。
   * 规划池不影响构成与 actualSenka（见 monthComposition 注释），传 [] 即可，
   * 免得为每个月各多算一次 displayPoolIds。
   */
  function monthlyComparison(store, monthKeys, now) {
    now = now || new Date();
    return (monthKeys || []).map(function (monthKey) {
      const plan = KC.calc.plan.forMonth(store, monthKey, now, {
        mode: 'actual',
        poolIds: []
      });
      const list = KC.calc.stats.recordsOfMonth(store.state.dailyRecords, monthKey);
      let max = null;
      list.forEach(function (r) {
        const v = Number(r.sortieSenka) || 0;
        if (max === null || v > max) max = v;
      });
      return {
        monthKey: monthKey,
        label: monthKey.slice(2),          // '26-09'，图表标签用短格式
        inherited: plan.inheritedSenka,
        sortie: plan.sortieTotal,
        eo: plan.eoCompleted,
        task: plan.taskCompleted,
        actual: plan.actualSenka,          // 四项之和
        count: list.length,                // 出击记录天数
        max: max                           // 单日出击最高
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
   *
   * 口径固定为实际统计（mode: 'actual'）——分析页的构成只关心"已经发生了什么"。
   * 但同一份 plan 还驱动「战果进度」卡片的"已规划战果"（poolSenka），
   * 因此当前月的规划池必须按生效选择传入；传 [] 会让已规划战果恒为 0、进度条中段恒为空。
   * （构成 parts 与 actualSenka 均不受规划池影响，故不影响构成图与各指标卡。）
   * 展示口径（历史月不凭空捏造规划池）统一由 KC.calc.plan.displayPoolIds 负责。
   */
  function monthComposition(store, monthKey, now) {
    const plan = KC.calc.plan.forMonth(store, monthKey, now, {
      mode: 'actual',
      poolIds: KC.calc.plan.displayPoolIds(store, monthKey, now)
    });
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
    COMPARE_METRICS: COMPARE_METRICS,
    COMPARE_MAX_MONTHS: COMPARE_MAX_MONTHS,
    COMPARE_DEFAULT_MONTHS: COMPARE_DEFAULT_MONTHS,
    normalizeCompareMetrics: normalizeCompareMetrics,
    normalizeCompareRange: normalizeCompareRange,
    monthDailySeries: monthDailySeries,
    monthlyComparison: monthlyComparison,
    recentMonths: recentMonths,
    availableMonths: availableMonths,
    monthComposition: monthComposition
  };
})(window.KC = window.KC || {});
