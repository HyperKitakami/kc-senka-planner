/* ==========================================================================
   calc/tasks.js — 任务战果计算（全部运行时计算，绝不落库）
   依据 docs/04_calculation.md §三 / §五 / §六 / §七。

   口径说明：
     · 任务是否刷新、对应 PeriodId —— 按任务刷新边界（docs 7.1）
     · 实际战果中的 EO 战果 / 任务战果 —— 取"战果归属月内已完成"的对应战果之和。
       归属判定：**每一条完成记录按其完成时刻（completedAt）归属到某一个月，恰好计一次**。
       ⛔ EO 与任务**两套口径**：
         · EO  —— 上月末日 23:00 ～ 本月末日 21:00（与出击同结算时刻）；
           末日 21:00～23:00 血条未复活，此时段打掉的 EO 不给战果。
         · 任务 —— 前月末日 13:00 ～ 本月末日 13:00 完成归本月，之后完成归次月；
           季常在季度第三月（2/5/8/11）末日 13:00 之后完成则直接失效。
       绝不能"按月份反查周期"——跨月的季常/年常周期会被它覆盖的每一个月
       重复命中：Q3 周期会在 9/10/11 三个月各计一次，年度周期会在 12 个月各计一次。
     · **归属覆盖**：`TaskRecord.forceAttributionMonth` 是用户的显式覆盖（「强制计入本月」），
       只在任务页的**当前月**流程写入。过了归属截止时刻才勾的任务，自然归属会落到次月、
       季常甚至直接失效，界面会在任务行旁提示「未被计入」并给出强制入口
       （见 `attributionNotice`）。覆盖生效时该记录只归属那一个月，不变量依然成立。
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

  /**
   * 任务模板在当前时刻所处的周期。
   *
   * ⚠️ EO 任务（taskGroup === 'EO'）的一轮是 **EO 归属月**（末日 21:00 切换、血条 23:00 复活），
   * 不是它登记在模板上的「月常 1 日 04:00」—— 这个分流在 KC.periods.currentTaskPeriod 里，
   * 本函数只是唯一的调用入口。任何"这条记录该挂哪个 periodId"的地方都要走这里。
   */
  function periodOf(template, now) {
    return KC.periods.currentTaskPeriod(template, now);
  }

  /**
   * 任务模板在指定"战果归属月"内所处的周期（用于任务列表 / 规划池的"本期"口径）。
   *
   * 与 periodOf 的区别：不依赖当前时刻，而是锚定到给定月份（该月 15 日 12:00），
   * 避免月末/月初的边界窗口把相邻月份的任务算进本月，也避免浏览历史月份时
   * 把"今天/本周"的日常周常串进那个月。
   *
   * ⛔ EO 例外：EO 的一轮**就是**归属月本身，直接取该月那一轮，不做 15 日锚定
   *   （锚定会把"当月末日 23:00 之后开的那一轮"错认成上月）。
   *
   * DAILY / WEEKLY 例外：这两种周期比"月"短，没有"该月的周期"这一说。
   *   · 当前月 → 返回真正的"本期"（今天 / 本周），列表与规划池都该按它算
   *   · 历史月 → 无意义，锚定到该月 15 日那期（保证确定性、不串味）
   * 注意：这只影响"本期完成状态"的展示与规划池；已完成战果的统计一律走
   * completedSenkaInMonth（按完成时刻归属，与本函数无关）。
   */
  function periodForMonth(template, monthKey, now) {
    if (template.taskGroup === 'EO') return KC.periods.eoPeriod(monthKey);

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
    // 走 periodOf（内含 EO 分流）：EO 的一轮是 EO 归属月，按 resetCycle 直接算会误判"周期已过期"
    const period = periodOf(template, now);
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
   * 某条完成记录的**自然归属月** —— 纯按完成时刻算，不考虑用户的显式覆盖。
   *
   * 优先用完成时刻 completedAt；缺失时回退到该周期的起算时刻。
   *
   * ⛔ EO 与其它任务**不是同一个口径**，必须先分流：
   *   · EO（taskGroup === 'EO'）——与出击同为「本月末日 21:00」结算，
   *     区间 上月末日 23:00 ～ 本月末日 21:00；末日 21:00～23:00（血条复活前）为死区，
   *     返 VOID_MONTH（见 KC.periods.eoAttributionMonthOf）。
   *   · 其它任务——任务口径（docs/04_calculation.md §4.3）：
   *     前月末日 13:00 ～ 本月末日 13:00 完成 → 归本月；之后完成 → 归次月。
   *     季常有失效例外：季度第三月（2/5/8/11）末日 13:00 之后完成的季常战果
   *     不计入次月、直接失效，返回 VOID_MONTH。
   *
   * ⚠️ 早期实现把 EO 也丢给了任务口径的 taskAttributionMonthOf，于是本月末日
   * 13:00 ～ 21:00 勾选的 EO 会被错记到次月（EO 明明要到 21:00 才结算）。
   *
   * @returns {string|null} 'YYYY-MM'；VOID_MONTH 表示已失效；
   *   无法判定时返回 null（如无完成时刻且周期无起算时刻的事件/长期任务）
   */
  function naturalAttributionMonth(record, period, template) {
    let at = null;
    if (record && record.completedAt) {
      const d = new Date(record.completedAt);
      if (!isNaN(d.getTime())) at = d;
    }
    if (!at && period && period.start) at = period.start;
    if (!at) return null;

    if (template && template.taskGroup === 'EO') {
      const eoMonth = KC.periods.eoAttributionMonthOf(at);
      return eoMonth === null ? VOID_MONTH : eoMonth;
    }

    if (template && template.resetCycle === 'QUARTERLY') {
      const month = U.monthKeyOf(U.toDateKey(at));
      const voided = KC.periods.isQuarterLastMonth(month) &&
        at.getTime() >= KC.periods.attributionEnd(month, 'TASK').getTime();
      if (voided) return VOID_MONTH;
    }
    return KC.periods.taskAttributionMonthOf(at);
  }

  /** 归一化 `TaskRecord.forceAttributionMonth`；非法值（含 'void'）一律视为未设置 */
  function forceMonthOf(record) {
    const raw = record && record.forceAttributionMonth;
    if (raw === undefined || raw === null || raw === '') return null;
    const s = String(raw);
    return /^\d{4}-\d{2}$/.test(s) ? s : null;
  }

  /**
   * 某条完成记录的**战果归属月**（'YYYY-MM'）。
   *
   * = 用户的显式覆盖（`TaskRecord.forceAttributionMonth`，没有就跳过）
   *   ?? naturalAttributionMonth 的自然判定。
   *
   * ⚠️ 覆盖字段是**「强制计入本月」**这条用户操作的落点（docs/04_calculation.md §4.6）：
   *    月末过了归属截止时刻之后才勾的任务，自然归属会落到次月、季常甚至会直接失效，
   *    但用户可能确实希望把它算进本月。覆盖一旦写进记录，这条记录就**恰好归属那一个月**
   *    （不会同时算进自然归属月），"每条记录恰好计一次"的不变量依然成立。
   *
   * ⚠️ 覆盖**只由任务页的当前月流程写入**；往月补录走的是"把完成时刻落在目标月内"
   *    （见 ui/pages/tasks.js 的 backfillAt），不写这个字段。
   */
  function periodAttributionMonth(record, period, template) {
    return forceMonthOf(record) || naturalAttributionMonth(record, period, template);
  }

  /**
   * 「本月勾了，但没被算进本月」的提示模型（只在**当前归属月**下成立）。
   *
   * 场景：本月末日 13:00（任务）/ 21:00（EO）一过，再勾完成就会归到次月，
   * 季常在季度第三月甚至会直接失效 —— 用户看到的是"勾了却不涨战果"。
   * 本函数把这件事说成结构化事实，交给 UI 在任务行旁提示，并提供「强制计入」入口。
   *
   * ⛔ **只在当前归属月生效**：浏览历史月份时一律返回 `state: ''`（往月补录由
   *    backfillAt 把完成时刻写进目标月内，不需要也不该用覆盖）。
   *
   * @param {object} template
   * @param {object|null} record
   * @param {object} period 该记录/任务对应的周期
   * @param {string} month 当前浏览的归属月（'YYYY-MM'）
   * @param {Date} [now]
   * @returns {{state:string, counted:boolean, forced:boolean, voided:boolean,
   *            targetMonth:string|null, cutoffHour:number, isEo:boolean, month:string}}
   *   state: ''（无需提示）| 'missed'（算到次月）| 'void'（直接失效）| 'forced'（已强制计入本月）
   */
  function attributionNotice(template, record, period, month, now) {
    now = now || new Date();
    const isEo = !!(template && template.taskGroup === 'EO');
    const empty = {
      state: '', counted: true, forced: false, voided: false,
      targetMonth: null, cutoffHour: isEo ? 21 : 13, isEo: isEo, month: String(month || '')
    };
    if (!template || !month) return empty;
    // 往月：补录不涉及覆盖，不做任何提示
    if (String(month) !== KC.periods.currentAttributionMonth(now)) return empty;
    if (!record || !record.completed) return empty;

    const forced = forceMonthOf(record);
    const natural = naturalAttributionMonth(record, period, template);
    const targetMonth = (natural && natural !== VOID_MONTH) ? natural : null;
    const voided = natural === VOID_MONTH;

    // 没有覆盖：只要自然归属不是本月，就是"未被计入本月"
    if (!forced) {
      if (natural === month) return empty;
      return {
        state: voided ? 'void' : 'missed',
        counted: false, forced: false, voided: voided,
        targetMonth: targetMonth, cutoffHour: isEo ? 21 : 13, isEo: isEo, month: String(month)
      };
    }

    // 有覆盖：本来就不该计入本月时才值得提示（否则覆盖是多余的，静默按正常处理）
    if (natural === month) {
      return {
        state: '', counted: true, forced: true, voided: false,
        targetMonth: null, cutoffHour: isEo ? 21 : 13, isEo: isEo, month: String(month)
      };
    }
    return {
      state: 'forced', counted: true, forced: true, voided: voided,
      targetMonth: targetMonth, cutoffHour: isEo ? 21 : 13, isEo: isEo, month: String(month)
    };
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
   *   · 任务：末日 13:00 之后完成算次月；季常在季度第三月此时完成直接失效
   *   · EO：末日 21:00 之前完成都算本月（与任务口径差 8 小时）；21:00～23:00 打掉的无效
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
      // 上月那个是必须的，两种原因：
      //   · 任务炮：末日 13:00 之后完成的任务归本月，而它的记录挂在上月的 periodId 上；
      //   · 旧版 EO 记录：EO 曾按「月常 1 日 04:00」落 periodId，这些历史记录的键
      //     可能比归属月早一个月（末日 23:00 ～ 次月 04:00 那段）。多带一个上月候选，
      //     新旧键都能命中，老数据不会凭空丢战果。
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
    naturalAttributionMonth: naturalAttributionMonth,
    forceMonthOf: forceMonthOf,
    attributionNotice: attributionNotice,
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
