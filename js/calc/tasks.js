/* ==========================================================================
   calc/tasks.js — 任务战果计算（全部运行时计算，绝不落库）
   依据 docs/04_calculation.md §三 / §五 / §六 / §七。

   口径说明：
     · 任务是否刷新、对应 PeriodId —— 按任务刷新边界（docs 7.1）
     · 实际战果中的 EO 战果 / 任务战果 —— 取"战果归属月内已完成"的任务战果之和。
       归属判定：**每一条完成记录按其完成时刻（completedAt）归属到某一个月，恰好计一次**
       （docs/04_calculation.md §4.3）。归属按任务口径：前月末日 13:00 ～ 本月末日 13:00 完成
       归本月，本月末日 13:00 之后完成归次月；季常在季度第三月（2/5/8/11）末日 13:00 之后
       完成则直接失效。绝不能"按月份反查周期"——跨月的季常/年常周期会被它覆盖的每一个月
       重复命中：Q3 周期会在 9/10/11 三个月各计一次，年度周期会在 12 个月各计一次。
     · 规划池战果 —— 已勾选且"当前周期"尚未完成的任务战果之和；已完成任务不重复计入
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
   * 任务模板在指定"战果归属月"内所处的周期（用于任务列表 / 规划池的"本期"口径）。
   *
   * 与 periodOf 的区别：不依赖当前时刻，而是锚定到给定月份（该月 15 日 12:00），
   * 避免月末/月初的边界窗口把相邻月份的任务算进本月，也避免浏览历史月份时
   * 把"今天/本周"的日常周常串进那个月。
   *
   * DAILY / WEEKLY 例外：这两种周期比"月"短，没有"该月的周期"这一说。
   *   · 当前月 → 返回真正的"本期"（今天 / 本周），列表与规划池都该按它算
   *   · 历史月 → 无意义，锚定到该月 15 日那期（保证确定性、不串味）
   * 注意：这只影响"本期完成状态"的展示与规划池；已完成战果的统计一律走
   * completedSenkaInMonth（按完成时刻归属，与本函数无关）。
   */
  function periodForMonth(template, monthKey, now) {
    const opts = {
      eventPeriodId: template.eventPeriodId,
      resetMonth: template.resetMonth
    };
    const cycle = template.resetCycle;
    const at = now || new Date();

    if (cycle === 'DAILY' || cycle === 'WEEKLY') {
      if (monthKey === KC.periods.currentAttributionMonth(at)) {
        return KC.periods.taskPeriod(cycle, at, opts);
      }
    }

    const p = String(monthKey).split('-').map(Number);
    const anchor = new Date(p[0], p[1] - 1, 15, 12, 0, 0, 0);
    return KC.periods.taskPeriod(cycle, anchor, opts);
  }

  function findRecord(records, templateId, periodId) {
    return records.find(function (r) {
      return r.templateId === templateId && r.periodId === periodId;
    }) || null;
  }

  /**
   * 读取"当前周期"的记录，用于完成状态与节点进度。
   *
   * 任务若带进度（stepProgress），该进度只作为当前状态使用 —— 记录的周期已不是
   * 任务的当前周期时（日常/周常跨期、月常跨月等），整条记录视同不存在，
   * 于是进度自然重置。历史归属统计不走这里，因此旧周期记录不会丢。
   * 无进度的普通记录不参与这层重置，保持与旧版完全一致的行为。
   */
  function readRecord(templates, records, template, periodId, now) {
    const record = findRecord(records, template.id, periodId);
    if (!record) return null;
    const progress = record.stepProgress;
    if (!progress || typeof progress !== 'object' || !Object.keys(progress).length) return record;
    const cycle = template.resetCycle;
    if (!cycle || cycle === 'NONE') return record;
    const period = KC.periods.taskPeriod(cycle, now, {
      eventPeriodId: template.eventPeriodId,
      resetMonth: template.resetMonth
    });
    return period && period.id === periodId ? record : null;
  }

  /**
   * 任务完成状态。
   *
   * 判定顺序很重要，这里体现的是用户口径「读法 A：完成单调，需显式取消」：
   *   · record.completed === false（或没有记录）⇒ 未完成，直接返回 false
   *   · record.completed === true  ⇒ **已完成，且此后不再因进度回退而失效**。
   *     于是「节点全达成自动变完成」成立，「从满进度减回来不自动退回」也成立 ——
   *     后者保留 completed 这个事实，战果不丢，要撤销必须用户显式取消完成。
   *
   * 注意：节点未全达成却仍是 completed 的记录，只可能来自"先完成、后减进度"，
   * 或用户手动勾选。这是刻意允许的状态（见 store.setTaskStepProgress）。
   * 无节点任务（无 steps / steps 为空）时行为与改造前完全一致。
   */
  function isCompleted(record, template) {
    return !!(record && record.completed);
  }

  /**
   * 任务当前选中的期次是否"节点全部达成"。
   * 只用于界面提示（如标出"手动完成、节点未满"），不参与战果统计。
   */
  function stepsAllDone(record, template) {
    return KC.schema.taskCompletedBySteps(template, record && record.stepProgress);
  }

  /**
   * 汇总每个任务模板的当前状态。
   * @returns {Array<{template, period, record, completed}>}
   */
  function summarize(templates, records, now) {
    now = now || new Date();
    return templates.map(function (template) {
      const period = periodOf(template, now);
      const record = readRecord(templates, records, template, period.id, now);
      return {
        template: template,
        period: period,
        record: record,
        completed: isCompleted(record, template)
      };
    });
  }

  function senkaSum(items) {
    return U.round2(items.reduce(function (sum, it) {
      return sum + (Number(it.template.senkaValue) || 0);
    }, 0));
  }

  /* -------------------------------- 战果归属月判定与已完成战果累计 */

  /** 季常战果「直接失效」的归属月哨兵值（不等于任何 'YYYY-MM'） */
  const VOID_MONTH = 'void';

  /**
   * 某条完成记录的**战果归属月**（'YYYY-MM'）。
   *
   * 优先用完成时刻 completedAt；缺失时回退到该周期的起算时刻。
   * 归属按**任务口径**判定（docs/04_calculation.md §4.3）：
   *   · 前月末日 13:00 ～ 本月末日 13:00 完成 → 归本月
   *   · 本月末日 13:00 之后完成 → 归次月
   * 另外季常有失效例外：季度第三月（2/5/8/11）末日 13:00 之后完成的季常战果
   * 不计入次月、直接失效，返回 VOID_MONTH（任何月份都不会计入它）。
   *
   * @returns {string|null} 'YYYY-MM'；VOID_MONTH 表示已失效；
   *   无法判定时返回 null（如无完成时刻且周期无起算时刻的事件/长期任务）
   */
  function periodAttributionMonth(record, period, template) {
    let at = null;
    if (record && record.completedAt) {
      const d = new Date(record.completedAt);
      if (!isNaN(d.getTime())) at = d;
    }
    if (!at && period && period.start) at = period.start;
    if (!at) return null;

    if (template && template.resetCycle === 'QUARTERLY') {
      const month = U.monthKeyOf(U.toDateKey(at));
      const voided = KC.periods.isQuarterLastMonth(month) &&
        at.getTime() >= KC.periods.attributionEnd(month, 'TASK').getTime();
      if (voided) return VOID_MONTH;
    }
    return KC.periods.taskAttributionMonthOf(at);
  }

  /**
   * 与指定月份的「任务战果归属区间」有交集的 DAILY / WEEKLY 周期（按周期 id 去重）。
   *
   * 这里刻意取"有交集"而不是"起算时刻落在本月内"：跨月的周常（如 8/31 周一 ～ 9/6）
   * 同时是两个月的候选，最终由 periodAttributionMonth 决定它归哪个月。
   * 若按"起算时刻落在本月内"筛选，9/2 完成的那个周常会在 9 月里连候选都不是，
   * 而它在 8 月的候选里又因归属月是 9 月被跳过 —— 记录会凭空消失。
   */
  function periodsInAttributionWindow(resetCycle, monthKey) {
    const win = KC.periods.taskAttributionWindow(monthKey);
    const winStart = win.start.getTime();
    const winEnd = win.end.getTime();
    // 向前多取几天：周常可能起算于区间之前（其周期尾部落进区间）
    const back = resetCycle === 'WEEKLY' ? 7 : 1;

    const byId = {};
    const cursor = new Date(win.start.getFullYear(), win.start.getMonth(),
      win.start.getDate() - back, 12, 0, 0, 0);
    for (let i = 0; i < 60 && cursor.getTime() < winEnd; i++) {
      const period = KC.periods.taskPeriod(resetCycle, cursor);
      if (!byId[period.id]) byId[period.id] = period;
      cursor.setDate(cursor.getDate() + 1);
    }

    return Object.keys(byId).map(function (id) { return byId[id]; })
      .filter(function (period) {
        if (!period.start || !period.end) return false;
        return period.start.getTime() < winEnd && period.end.getTime() > winStart;
      });
  }

  /**
   * 某战果归属月内已完成的任务战果（按 EO / 非 EO 分组）。
   *
   * 算法：枚举"可能归属本月"的周期 → 找到对应 TaskRecord → 用 periodAttributionMonth
   * 判定它到底归哪个月，只有恰好归本月的才计入。因此
   *   · DAILY / WEEKLY 一个月内的多期会累加（周期刷新不清零）
   *   · 跨月的季常 / 年常周期只在其**完成月**计一次，不会重复
   *   · 末日 13:00 之后完成的任务算次月；季常在季度第三月此时完成直接失效
   * @param {Array} templates 任务模板（内部会跳过停用任务）
   */
  function completedSenkaInMonth(templates, records, monthKey, now) {
    const cache = {};
    function periodsFor(template) {
      const cycle = template.resetCycle;
      if (cycle === 'DAILY' || cycle === 'WEEKLY') {
        if (!cache[cycle]) cache[cycle] = periodsInAttributionWindow(cycle, monthKey);
        return cache[cycle];
      }
      // 月/季/年/活动/长期：候选 = 本月所在周期 + 上月所在周期。
      // 上月那个是必须的——末日 13:00 之后完成的任务归本月，而它的记录
      // 挂在上月的 periodId 上（"任务炮"），漏了它这条战果会凭空消失。
      const prev = U.addMonths(monthKey, -1);
      const list = [periodForMonth(template, monthKey, now), periodForMonth(template, prev, now)];
      const byId = {};
      list.forEach(function (p) { if (p && p.id && !byId[p.id]) byId[p.id] = p; });
      return Object.keys(byId).map(function (id) { return byId[id]; });
    }

    let eo = 0;
    let task = 0;

    (templates || []).forEach(function (template) {
      if (template.enabled === false) return;
      const value = Number(template.senkaValue) || 0;
      const isEo = template.taskGroup === 'EO';

      periodsFor(template).forEach(function (period) {
        const record = findRecord(records, template.id, period.id);
        // 只认 completed 这个事实。节点没满但仍是 completed 的情况（先完成后减进度）
        // 按读法 A 保留战果；要撤销得靠用户显式取消完成，而不是靠改进度。
        if (!record || !record.completed) return;
        const month = periodAttributionMonth(record, period, template);
        // 无法判定归属（事件/长期任务缺完成时刻）时按当前浏览月计入，保持旧行为
        if (month !== null && month !== monthKey) return;
        if (isEo) eo += value;
        else task += value;
      });
    });

    return { eo: U.round2(eo), task: U.round2(task) };
  }

  /** 同 summarize，但把任务周期锚定到指定月份 */
  function summarizeForMonth(templates, records, monthKey, now) {
    now = now || new Date();
    return templates.map(function (template) {
      const period = periodForMonth(template, monthKey, now);
      const record = readRecord(templates, records, template, period.id, now);
      return {
        template: template,
        period: period,
        record: record,
        completed: isCompleted(record, template)
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
    now = now || new Date();
    const all = monthKey
      ? summarizeForMonth(templates, records, monthKey, now)
      : summarize(templates, records, now);
    const active = all.filter(function (it) { return it.template.enabled !== false; });
    const completed = active.filter(function (it) { return it.completed; });

    const poolSet = new Set(poolIds || []);
    const poolPending = active.filter(function (it) {
      return !it.completed && poolSet.has(it.template.id);
    });

    // 已完成战果：枚举候选周期 → 按完成时刻判定归属月，每条记录恰好计一次
    const senka = completedSenkaInMonth(
      active.map(function (it) { return it.template; }),
      records,
      monthKey || KC.periods.currentAttributionMonth(now),
      now
    );

    const eoCompleted = senka.eo;
    const taskCompleted = senka.task;

    return {
      all: all,
      active: active,
      completed: completed,
      groups: groupItems(all),
      eoCompleted: eoCompleted,
      taskCompleted: taskCompleted,
      totalCompleted: U.round2(eoCompleted + taskCompleted),
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
    VOID_MONTH: VOID_MONTH,
    periodAttributionMonth: periodAttributionMonth,
    periodsInAttributionWindow: periodsInAttributionWindow,
    completedSenkaInMonth: completedSenkaInMonth,
    findRecord: findRecord,
    readRecord: readRecord,
    isCompleted: isCompleted,
    stepsAllDone: stepsAllDone,
    summarize: summarize,
    summarizeForMonth: summarizeForMonth,
    groupItems: groupItems,
    overview: overview
  };
})(window.KC = window.KC || {});
