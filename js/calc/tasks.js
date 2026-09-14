/* ==========================================================================
   calc/tasks.js — 任务战果计算（全部运行时计算，绝不落库）
   依据 docs/04_calculation.md §三 / §五 / §六 / §七。

   口径说明：
     · 任务是否刷新、对应 PeriodId —— 按任务刷新边界（docs 7.1）
     · 实际战果中的 EO 战果 / 任务战果 —— 取"当前周期已完成"的任务战果之和
     · 规划池战果 —— 已勾选且尚未完成的任务战果之和；已完成任务不重复计入
   ========================================================================== */
(function (KC) {
  'use strict';

  const U = KC.utils;

  const GROUP_ORDER = ['EO', 'EX', 'EVENT', 'USER'];

  const GROUP_LABEL = {
    EO: 'EO（Extra Operation）',
    EX: 'EX（任务战果）',
    EVENT: '活动任务',
    USER: '用户自定义'
  };

  /** 任务模板在当前时刻所处的周期 */
  function periodOf(template, now) {
    return KC.periods.taskPeriod(template.resetCycle, now, {
      eventPeriodId: template.eventPeriodId,
      resetMonth: template.resetMonth
    });
  }

  /**
   * 任务模板在指定"战果归属月"内所处的周期。
   * 与 periodOf 的区别：不依赖当前时刻，而是锚定到给定月份，
   * 避免月末/月初的边界窗口把相邻月份的任务算进本月规划。
   * DAILY / WEEKLY 天然是"当下"概念，仍按当前时刻解析。
   */
  function periodForMonth(template, monthKey, now) {
    const opts = {
      eventPeriodId: template.eventPeriodId,
      resetMonth: template.resetMonth
    };
    if (template.resetCycle === 'DAILY' || template.resetCycle === 'WEEKLY') {
      return KC.periods.taskPeriod(template.resetCycle, now || new Date(), opts);
    }
    const p = String(monthKey).split('-').map(Number);
    const anchor = new Date(p[0], p[1] - 1, 15, 12, 0, 0, 0);
    return KC.periods.taskPeriod(template.resetCycle, anchor, opts);
  }

  function findRecord(records, templateId, periodId) {
    return records.find(function (r) {
      return r.templateId === templateId && r.periodId === periodId;
    }) || null;
  }

  /**
   * 汇总每个任务模板的当前状态。
   * @returns {Array<{template, period, record, completed}>}
   */
  function summarize(templates, records, now) {
    now = now || new Date();
    return templates.map(function (template) {
      const period = periodOf(template, now);
      const record = findRecord(records, template.id, period.id);
      return {
        template: template,
        period: period,
        record: record,
        completed: !!(record && record.completed)
      };
    });
  }

  function senkaSum(items) {
    return U.round2(items.reduce(function (sum, it) {
      return sum + (Number(it.template.senkaValue) || 0);
    }, 0));
  }

  /** 同 summarize，但把任务周期锚定到指定月份 */
  function summarizeForMonth(templates, records, monthKey, now) {
    return templates.map(function (template) {
      const period = periodForMonth(template, monthKey, now);
      const record = findRecord(records, template.id, period.id);
      return {
        template: template,
        period: period,
        record: record,
        completed: !!(record && record.completed)
      };
    });
  }

  /** 按任务组归类（保持 GROUP_ORDER 顺序，未知组排在最后） */
  function groupItems(items) {
    const groups = [];
    GROUP_ORDER.forEach(function (g) { groups.push(g); });
    items.forEach(function (it) {
      const g = it.template.taskGroup;
      if (groups.indexOf(g) < 0) groups.push(g);
    });
    return groups.map(function (g) {
      return {
        group: g,
        label: GROUP_LABEL[g] || g,
        items: items.filter(function (it) { return it.template.taskGroup === g; })
      };
    }).filter(function (g) { return g.items.length > 0; });
  }

  /**
   * 任务模块总览。
   * @param {Array} templates 全部任务模板
   * @param {Array} records 全部 TaskRecord
   * @param {Array<string>} poolIds 规划池中已勾选的模板 id
   * @param {Date} [now]
   * @param {string} [monthKey] 给定时，任务周期锚定到该月份（用于规划）
   */
  function overview(templates, records, poolIds, now, monthKey) {
    const all = monthKey
      ? summarizeForMonth(templates, records, monthKey, now)
      : summarize(templates, records, now);
    const active = all.filter(function (it) { return it.template.enabled !== false; });
    const completed = active.filter(function (it) { return it.completed; });

    const poolSet = new Set(poolIds || []);
    const poolPending = active.filter(function (it) {
      return !it.completed && poolSet.has(it.template.id);
    });

    return {
      all: all,
      active: active,
      completed: completed,
      groups: groupItems(all),
      eoCompleted: senkaSum(completed.filter(function (it) { return it.template.taskGroup === 'EO'; })),
      taskCompleted: senkaSum(completed.filter(function (it) { return it.template.taskGroup !== 'EO'; })),
      totalCompleted: senkaSum(completed),
      poolPendingSenka: senkaSum(poolPending),
      poolPendingCount: poolPending.length,
      pendingItems: poolPending,
      completedCount: completed.length,
      activeCount: active.length
    };
  }

  KC.calc = KC.calc || {};
  KC.calc.tasks = {
    GROUP_ORDER: GROUP_ORDER,
    GROUP_LABEL: GROUP_LABEL,
    periodOf: periodOf,
    periodForMonth: periodForMonth,
    findRecord: findRecord,
    summarize: summarize,
    summarizeForMonth: summarizeForMonth,
    groupItems: groupItems,
    overview: overview
  };
})(window.KC = window.KC || {});
