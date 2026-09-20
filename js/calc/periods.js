/* ==========================================================================
   calc/periods.js — 周期查询（剩余周期）
   依据 docs/03_data.md §七、docs/04_calculation.md §十二。

   本模块只做**运行时计算**，不写入任何数据（docs/03_data.md §1.2）。

   两套边界严格分开，不得混用（docs/03_data.md §7.1 / §7.2）：
     · 任务刷新周期：日/周/月/季/年，起算时刻一律 04:00
     · 战果结算周期：出击与 EO 截至本月末日 21:00；任务战果截至本月末日 13:00
   本页把两者**并列展示**，正是为了让用户看清它们不是同一个边界。
   ========================================================================== */
(function (KC) {
  'use strict';

  const U = KC.utils;
  const P = KC.periods;

  const HOUR = 3600000;
  const DAY = 86400000;

  /**
   * 任务刷新周期的展示元数据。
   * 顺序 = 周期由短到长，与 docs/03_data.md §7.1 表格一致。
   *
   * YEARLY 不在这里：年常的起算月份由**用户添加的任务**里的 resetMonth 决定，
   * 一个月份一个区间，因此由 yearCycles() 单独生成（见下）。
   * EVENT 也不在这里：它由用户手动开始与结束，没有可计算的边界。
   */
  const TASK_CYCLES = [
    { resetCycle: 'DAILY', label: '日常', refresh: '每日 04:00',
      note: '每天 04:00 刷新，跨日以 04:00 为界而不是 00:00。' },
    { resetCycle: 'WEEKLY', label: '周常', refresh: '每周一 04:00',
      note: 'ISO 周；周一的 04:00 之后才算进入新的一周。' },
    { resetCycle: 'MONTHLY', label: '月常', refresh: '每月 1 日 04:00',
      note: '含 EO 海域（EO 血条在末日 23:00 复活，见下一块说明）。' },
    { resetCycle: 'QUARTERLY', label: '季常', refresh: '每季度首月 1 日 04:00',
      note: '季度按 3/6/9/12 月起算（春 3-5、夏 6-8、秋 9-11、冬 12-2）。' }
  ];

  const EVENT_CYCLE = {
    resetCycle: 'EVENT',
    label: '活动 / 期间限定',
    refresh: '用户手动开始与结束',
    note: '没有固定边界，无法预先算出结束时刻；期间限定任务的战果仍按任务口径（末日 13:00）归属。'
  };

  const YEARLY_TEMPLATE_NOTE =
    '年常的区间按你在「战果任务」里添加的年常任务所填的起算月份生成：' +
    '同一个月只算一个区间（重复添加同月的年常任务不会重复计算）；' +
    '没有年常任务时不显示任何区间。';

  /**
   * 战果结算周期的展示元数据。
   * hours 是「本月末日」当天的截止小时数，与 periods.ATTRIBUTION_HOUR 对应。
   */
  const ATTRIBUTION_KINDS = [
    { key: 'SORTIE', label: '出击战果', hours: P.ATTRIBUTION_HOUR.SORTIE,
      window: '上月末日 21:00 ～ 本月末日 21:00',
      note: '本月末日 21:00 之后打出的战果计入次月。' },
    { key: 'EO', label: 'EO 战果', hours: P.ATTRIBUTION_HOUR.EO,
      window: '上月末日 23:00 ～ 本月末日 21:00',
      note: '各海域血条在本月末日 23:00 复活；末日 21:00 ～ 23:00 打掉的 EO 不给战果（仍可拿勋章）。' },
    { key: 'TASK', label: '任务战果', hours: P.ATTRIBUTION_HOUR.TASK,
      window: '前月末日 13:00 ～ 本月末日 13:00',
      note: '包含季常 / 年常 / 期间限定月常；末日 13:00 之后完成的任务，战果归属次月。季常存在特殊性，跨季度末日13:00后完成不计入任何区间。' }
  ];

  /* ------------------------------------------------------------ 小工具 */

  /** 区间进度：0 ～ 100（用于画结算时间轴） */
  function progressPct(start, end, now) {
    const total = end.getTime() - start.getTime();
    if (!(total > 0)) return 0;
    const pct = (now.getTime() - start.getTime()) / total * 100;
    return Math.max(0, Math.min(100, pct));
  }

  function diffDays(start, end) {
    return (end.getTime() - start.getTime()) / DAY;
  }

  /* -------------------------------------------------- 一、任务刷新周期 */

  /**
   * 当前任务刷新周期的剩余时间。
   *
   * periods.taskPeriod() 在周期切换点之前（例如 03:00 查日常）会返回**上一期**，
   * 那一期的 end 已经过去。这里做一次滚动：把参考时刻往后推到下一期，
   * 让每一行反映的都是「正在走的那一期」。
   *
   * @param {string} resetCycle DAILY/WEEKLY/MONTHLY/QUARTERLY/YEARLY
   * @param {Date} now
   * @param {{resetMonth?: number}} [opts]
   * @returns {{id, start, end, remainMs, remainDays, elapsedPct}|null}
   */
  function taskCycleRemainder(resetCycle, now, opts) {
    if (['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY'].indexOf(resetCycle) < 0) return null;

    let ref = now;
    let period = P.taskPeriod(resetCycle, ref, opts);
    for (let i = 0; i < 2 && period.end && period.end.getTime() <= ref.getTime(); i++) {
      // 步进必须大于起点：日常在起点前 1 秒查询时，+1 天刚好跨到下一期
      ref = new Date(period.end.getTime() + 1000);
      period = P.taskPeriod(resetCycle, ref, opts);
    }
    if (!period.start || !period.end) return null;

    const remainMs = Math.max(0, period.end.getTime() - now.getTime());
    return {
      id: period.id,
      start: period.start,
      end: period.end,
      remainMs: remainMs,
      remainDays: diffDays(now, period.end),
      elapsedPct: progressPct(period.start, period.end, now)
    };
  }

  /**
   * 年常区间：一个**去重后的起算月份**一个区间。
   *
   * 依据 docs/03_data.md §7.1「YEARLY：指定月份 1 日 04:00」，
   * 起算月份来自用户在「战果任务」里添加的年常任务（TaskTemplate.resetMonth，
   * 缺省 1 月，见 store.normalizeTaskTemplate）。
   *
   * 去重是必须的：用户可以添加多个同月的年常任务（例如两个都是 6 月起算），
   * 它们是**同一个周期**，只应产生一个区间，否则剩余时间会被重复列出。
   * 停用（enabled === false）的年常任务不产生区间 —— 与任务列表"停用则不参与"一致。
   *
   * @param {Date} now
   * @param {Array} templates 任务模板（一般传 KC.store.listTaskTemplates()）
   */
  function yearCycles(now, templates) {
    const months = [];
    (templates || []).forEach(function (t) {
      if (!t || t.resetCycle !== 'YEARLY' || t.enabled === false) return;
      const m = U.clamp(Number(t.resetMonth) || 1, 1, 12);
      if (months.indexOf(m) < 0) months.push(m);
    });
    months.sort(function (a, b) { return a - b; });

    return months.map(function (m) {
      return {
        resetCycle: 'YEARLY',
        resetMonth: m,
        label: '年常（' + m + ' 月起算）',
        refresh: '每年 ' + m + ' 月 1 日 04:00',
        note: '区间为 ' + m + ' 月 1 日 04:00 ～ 次年 ' + m + ' 月 1 日 04:00。',
        remainder: taskCycleRemainder('YEARLY', now, { resetMonth: m })
      };
    });
  }

  /**
   * 全部任务刷新周期：固定周期 + 每个去重后的年常区间 + 活动。
   * @param {Date} now
   * @param {{templates?: Array}} [opts]
   */
  function taskCycles(now, opts) {
    const options = opts || {};
    const rows = TASK_CYCLES.map(function (meta) {
      return Object.assign({}, meta, { remainder: taskCycleRemainder(meta.resetCycle, now, options) });
    });
    yearCycles(now, options.templates).forEach(function (row) { rows.push(row); });
    rows.push(Object.assign({}, EVENT_CYCLE, { remainder: null }));
    return rows;
  }

  /* -------------------------------------------------- 二、战果结算周期 */

  /**
   * 战果结算周期：三种战果来源各自的截止时刻与剩余时间。
   *
   * 口径差异（docs/03_data.md §7.2）：
   *   · 出击 / EO 用「出击归属月」（末日 21:00 切换），窗口 上月末日 21:00 → 本月末日 21:00
   *   · 任务战果用「任务归属月」（末日 13:00 切换），窗口 前月末日 13:00 → 本月末日 13:00
   * 所以末日 13:00 ～ 21:00 这段窗口里，任务战果已归次月而出击战果还属于本月
   * —— 这正是首页 / 规划页的「归属截止提示」要提醒的时间段。
   */
  function attributionCycles(now) {
    const sortieMonth = P.currentAttributionMonth(now);
    const taskMonth = P.currentTaskAttributionMonth(now);

    const rows = ATTRIBUTION_KINDS.map(function (meta) {
      const month = meta.key === 'TASK' ? taskMonth : sortieMonth;
      const end = P.attributionEnd(month, meta.key);
      const start = meta.key === 'TASK'
        ? P.taskAttributionWindow(month).start
        : P.attributionStart(month, meta.key);
      return {
        key: meta.key,
        label: meta.label,
        hours: meta.hours,
        window: meta.window,
        note: meta.note,
        month: month,
        end: end,
        start: start,
        remainMs: Math.max(0, end.getTime() - now.getTime()),
        remainDays: diffDays(now, end),
        elapsedPct: progressPct(start, end, now)
      };
    });

    return {
      rows: rows,
      sortieMonth: sortieMonth,
      taskMonth: taskMonth,
      /** 任务战果已归次月、而出击战果仍属本月 —— 归属提示窗口 */
      inCutoffGap: P.pastTaskCutoff(now),
      /** 当前归属月是否为季度第三月（季常战果有失效例外） */
      quarterLast: P.isQuarterLastMonth(sortieMonth),
      /** 下一个 EO 血条复活时刻：本月末日 23:00（docs/03_data.md §7.2） */
      eoRevive: eoReviveAt(now)
    };
  }

  /** 下一次 EO 血条复活时刻（归属月末日 23:00；已过则取下一个月末日） */
  function eoReviveAt(now) {
    const month = P.currentAttributionMonth(now);
    const p = String(month).split('-').map(Number);
    const candidate = new Date(p[0], p[1] - 1, U.daysInMonth(month), 23, 0, 0, 0);
    if (candidate.getTime() > now.getTime()) return { at: candidate, month: month };
    const next = U.addMonths(month, 1);
    const q = String(next).split('-').map(Number);
    return {
      at: new Date(q[0], q[1] - 1, U.daysInMonth(next), 23, 0, 0, 0),
      month: next
    };
  }

  /**
   * 一次性给出本页需要的全部数据。
   *
   * 年常区间需要任务模板（起算月份）与是否启用（停用的任务不产生区间），
   * 但本模块不直接依赖 store：模板由调用方传入，缺省时才回退到 store，
   * 这样纯计算测试不需要初始化数据层。
   *
   * @param {Date} [now] 便于测试注入
   * @param {{templates?: Array}} [opts]
   */
  function overview(now, opts) {
    const at = now || new Date();
    const options = opts || {};
    let templates = options.templates;
    if (!templates) {
      templates = (KC.store && KC.store.listTaskTemplates) ? KC.store.listTaskTemplates() : [];
    }
    return {
      now: at,
      taskCycles: taskCycles(at, { templates: templates }),
      attribution: attributionCycles(at)
    };
  }

  KC.calc = KC.calc || {};
  KC.calc.periods = {
    TASK_CYCLES: TASK_CYCLES,
    EVENT_CYCLE: EVENT_CYCLE,
    YEARLY_TEMPLATE_NOTE: YEARLY_TEMPLATE_NOTE,
    ATTRIBUTION_KINDS: ATTRIBUTION_KINDS,
    taskCycleRemainder: taskCycleRemainder,
    yearCycles: yearCycles,
    taskCycles: taskCycles,
    attributionCycles: attributionCycles,
    eoReviveAt: eoReviveAt,
    overview: overview
  };
})(window.KC = window.KC || {});
