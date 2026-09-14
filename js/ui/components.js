/* ==========================================================================
   ui/components.js — 跨页面复用的展示组件
   首页 / 战果记录 / 战果任务 / 战果规划 共用，避免各页重复实现。
   ========================================================================== */
(function (KC) {
  'use strict';

  const U = KC.utils;

  /** 指标卡片 */
  function statCard(label, value, sub, tone) {
    return '<div class="stat-card' + (tone ? ' is-' + tone : '') + '">' +
      '<div class="stat-label">' + U.escapeHtml(label) + '</div>' +
      '<div class="stat-value">' + U.escapeHtml(value) + '</div>' +
      '<div class="stat-sub">' + U.escapeHtml(sub) + '</div>' +
      '</div>';
  }

  /**
   * 任务战果归属截止提示（docs/04_calculation.md §4.3 / §4.6）。
   *
   * 本月末日 13:00 起，任务的战果归属已切到次月；但页面的战果归属月按出击口径
   * （末日 21:00）算，所以这段时间里页面仍停在本月 —— 用户会觉得"刚勾完任务、战果却没涨"。
   * 只在「页面月份 = 当前自然月 且 已过任务截止」这段窗口提示，避免误报。
   *
   * 首页 / 战果规划页 / 战果任务页共用这一份文案，避免各处口径走偏。
   *
   * @param {string} planMonth 页面当前展示的战果归属月
   * @param {Date} [now] 便于测试注入
   * @returns {string} HTML（无需提示时返回空串）
   */
  function taskCutoffNotice(planMonth, now) {
    now = now || new Date();
    const natural = U.monthKeyOf(U.toDateKey(now));
    if (!planMonth || planMonth !== natural) return '';
    if (!KC.periods.pastTaskCutoff(now)) return '';

    let text = '已过本月任务战果归属截止时间（本月末日 13:00）：现在完成的任务，战果计入 ' +
      U.monthLabel(U.addMonths(natural, 1)) + '。';
    let tone = 'alert-warn';
    if (KC.periods.isQuarterLastMonth(natural)) {
      text += ' 本月是季度第三月，此时完成季常，战果会直接失效（不计入次月）。';
      tone = 'alert-error';
    }
    return '<div class="alert ' + tone + '">' + U.escapeHtml(text) + '</div>';
  }

  /**
   * 战果进度条（三段：已获得 / 已规划 / 距目标）。
   * 配色统一使用 --senka-actual / --senka-planned / --senka-remaining
   * （docs/04_calculation.md §十三）。
   * @param {object} plan KC.calc.plan.buildPlan 的结果
   * @param {Date} [now] 便于测试注入
   */
  function senkaProgress(plan, now) {
    const seg = KC.calc.plan.progressSegments(plan);
    return '<div class="progress-track" role="img" aria-label="战果进度">' +
        '<div class="progress-seg seg-actual" style="width:' + seg.actual.toFixed(3) + '%"></div>' +
        '<div class="progress-seg seg-planned" style="width:' + seg.planned.toFixed(3) + '%"></div>' +
        '<div class="progress-seg seg-remaining" style="width:' + seg.remaining.toFixed(3) + '%"></div>' +
      '</div>' +
      '<div class="progress-legend">' +
        '<span class="legend-item"><i class="dot dot-actual"></i>已获得战果 ' +
          U.formatNumber(plan.actualSenka) + '</span>' +
        '<span class="legend-item"><i class="dot dot-planned"></i>已规划战果 ' +
          U.formatNumber(plan.poolSenka) + '</span>' +
        '<span class="legend-item"><i class="dot dot-remaining"></i>距目标 ' +
          (plan.targetSenka === null ? '未设定' : U.formatNumber(Math.max(0, plan.gap))) + '</span>' +
      '</div>' +
      taskCutoffNotice(plan.month, now);
  }

  /** 剩余周期文案：17 天 8 小时 */
  function remainText(days) {
    if (!(days > 0)) return '已结束';
    const d = Math.floor(days);
    const hours = Math.floor((days - d) * 24);
    const mins = Math.floor(((days - d) * 24 - hours) * 60);
    if (d > 0) return d + ' 天 ' + hours + ' 小时';
    if (hours > 0) return hours + ' 小时 ' + mins + ' 分';
    return mins + ' 分钟';
  }

  /**
   * 首页卡片注册表（docs/02_ui.md §4.1 / §五）。
   * 首页按此顺序渲染；设置页据此提供显示/隐藏与排序。
   * 新增卡片只需在此追加一项，并同步 Settings.dashboardOrder 的默认值。
   */
  const DASHBOARD_CARDS = [
    { id: 'currentSenka',     label: '当前实际战果' },
    { id: 'target',           label: '月目标' },
    { id: 'remainingTarget',  label: '剩余目标' },
    { id: 'monthEndForecast', label: '预计月底战果' },
    { id: 'todayGrowth',      label: '今日增长' },
    { id: 'naturalDaily',     label: '当前自然日均' },
    { id: 'requiredDaily',    label: '所需日均' },
    { id: 'remainingPeriod',  label: '周期剩余' },
    { id: 'calendar',         label: '战果日历（整行）' }
  ];

  /**
   * 首页实际要渲染的卡片 id（已按顺序排列并剔除隐藏项）。
   * 对顺序表做一次自愈：过滤未知 id、补齐缺失的已知 id，
   * 这样升级后新增的卡片不会因为旧配置而消失。
   */
  function visibleDashboardCards(settings) {
    const known = DASHBOARD_CARDS.map(function (c) { return c.id; });
    const stored = (settings && settings.dashboardOrder) || [];
    const order = stored.filter(function (id) { return known.indexOf(id) >= 0; });
    known.forEach(function (id) { if (order.indexOf(id) < 0) order.push(id); });

    const hidden = ((settings && settings.dashboardHidden) || []).filter(function (id) {
      return known.indexOf(id) >= 0;
    });
    return order.filter(function (id) { return hidden.indexOf(id) < 0; });
  }

  KC.ui = {
    statCard: statCard,
    senkaProgress: senkaProgress,
    taskCutoffNotice: taskCutoffNotice,
    remainText: remainText,
    DASHBOARD_CARDS: DASHBOARD_CARDS,
    visibleDashboardCards: visibleDashboardCards
  };
})(window.KC = window.KC || {});
