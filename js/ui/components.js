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
   * 定期导出提醒条。
   *
   * 只在首页渲染，且**未处理前持续显示**（不是"弹一次就消失"）——
   * 数据只在本机浏览器里，浏览器清理站点数据就会一并丢失，
   * 提醒条本身必须写明"本地备份不算导出"（createBackup() 不写 lastExportAt，
   * 用户很容易以为"我刚备份过"）。
   *
   * 三个动作由首页处理（data-act）：export-now / export-dismiss / export-settings。
   * 本机轻量存储不可用时额外提示"不会被保留"。
   *
   * @param {object} state KC.calc.reminder.exportReminderState 的结果
   * @returns {string} HTML（无需提醒时返回空串）
   */
  function exportNotice(state) {
    if (!state || !state.show) return '';

    const degraded = !!(KC.localLayer && !KC.localLayer.available());
    const tone = state.level === 'warn' ? 'alert-warn' : 'alert-info';

    return '<div class="alert ' + tone + ' export-notice">' +
      '<span class="export-notice-icon" aria-hidden="true">⚠</span>' +
      '<div class="export-notice-text">' +
        '<strong>' + U.escapeHtml(state.title) + '</strong>' +
        '<span>' + U.escapeHtml(state.text) + '</span>' +
        (degraded
          ? '<span class="export-notice-degraded">本机临时层不可用（隐私模式或浏览器禁用了本地存储）：' +
            '「本周期不再提醒」不会被保留。</span>'
          : '') +
      '</div>' +
      '<div class="export-notice-actions">' +
        '<button type="button" class="btn btn-primary btn-sm" data-act="export-now">' +
          U.escapeHtml(state.primaryLabel || '立即导出') + '</button>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-act="export-dismiss">' +
          '本周期不再提醒</button>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-act="export-settings">' +
          '去设置</button>' +
      '</div>' +
      '</div>';
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
   * 首页按此顺序渲染；设置页据此提供显示/隐藏、排序与尺寸。
   * 新增卡片只需在此追加一项，并同步 Settings.dashboardOrder 的默认值。
   *
   * kind：stat = 指标小卡（落在 .card-grid 网格里）；panel = 面板型卡片（自带
   *       标题栏与图表，默认整行）。两类都可排序、可调尺寸——这正是把它们放进
   *       同一注册表的原因：顺序与尺寸只依赖 id，与卡片长什么样无关。
   */
  const DASHBOARD_CARDS = [
    { id: 'currentSenka',     label: '当前实际战果', kind: 'stat' },
    { id: 'target',           label: '月目标',       kind: 'stat' },
    { id: 'remainingTarget',  label: '剩余目标',     kind: 'stat' },
    { id: 'monthEndForecast', label: '预计月底战果', kind: 'stat' },
    { id: 'todayGrowth',      label: '今日增长',     kind: 'stat' },
    { id: 'naturalDaily',     label: '当前自然日均', kind: 'stat' },
    { id: 'requiredDaily',    label: '所需日均',     kind: 'stat' },
    { id: 'remainingPeriod',  label: '周期剩余',     kind: 'stat' },
    { id: 'calendar',         label: '战果日历',     kind: 'panel' },
    { id: 'trend',            label: '最近增长趋势', kind: 'panel' },
    { id: 'recentSummary',    label: '最近数据摘要', kind: 'panel' }
  ];

  const KNOWN_CARD_IDS = DASHBOARD_CARDS.map(function (c) { return c.id; });

  /** 卡片尺寸档位（数值即网格列跨度，经列数夹取后生效） */
  const CARD_SIZES = [
    { key: 'sm', label: '小', span: 1 },
    { key: 'md', label: '中', span: 2 },
    { key: 'lg', label: '大', span: 3 }
  ];
  const DEFAULT_SIZE = 'md';
  const SIZE_KEYS = CARD_SIZES.map(function (s) { return s.key; });

  /** 网格列数上下限与单列最小宽度（与 css 的 --dash-min / --dash-gap 保持一致） */
  const GRID_MIN_COL = 204;
  const GRID_GAP = 14;
  const GRID_MIN_COLS = 1;
  const GRID_MAX_COLS = 4;

  /**
   * 按可用宽度算网格列数。
   * 与 CSS 的 `.card-grid { grid-template-columns: repeat(var(--dash-cols), 1fr) }`
   * 配套：列数由 JS 决定并写进 --dash-cols，卡片列跨度才可预测
   * （旧的 auto-fit 无法表达"跨 2 列"，窄屏会直接溢出）。
   * 用 floor 而不是 round —— 宁可少一列，也不能让卡片被压到最小宽度以下。
   */
  function gridColCount(width) {
    const w = Number(width);
    if (!(w > 0)) return GRID_MAX_COLS;
    const n = Math.floor((w + GRID_GAP) / (GRID_MIN_COL + GRID_GAP));
    return Math.max(GRID_MIN_COLS, Math.min(GRID_MAX_COLS, n));
  }

  /** 卡片尺寸键 → 实际列跨度（不会超过当前列数） */
  function cardSpan(sizeKey, cols) {
    const hit = CARD_SIZES.filter(function (s) { return s.key === sizeKey; })[0];
    const span = hit ? hit.span : 2;
    return Math.max(1, Math.min(cols || GRID_MAX_COLS, span));
  }

  function isKnownCard(id) { return KNOWN_CARD_IDS.indexOf(id) >= 0; }

  function cardSizeLabel(sizeKey) {
    const hit = CARD_SIZES.filter(function (s) { return s.key === sizeKey; })[0];
    return hit ? hit.label : '中';
  }

  /** 校验后的尺寸配置：未知键丢弃、非法值落回默认 */
  function sanitizeSizes(map) {
    const out = {};
    if (!map || typeof map !== 'object') return out;
    KNOWN_CARD_IDS.forEach(function (id) {
      if (SIZE_KEYS.indexOf(map[id]) >= 0) out[id] = map[id];
    });
    return out;
  }

  /** 全部卡片的尺寸（已知卡片一律有值，未配置即默认） */
  function defaultSizes() {
    const out = {};
    KNOWN_CARD_IDS.forEach(function (id) { out[id] = DEFAULT_SIZE; });
    return out;
  }

  function normalizeCardOrder(settings) {
    const stored = (settings && settings.dashboardOrder) || [];
    const order = stored.filter(isKnownCard);
    KNOWN_CARD_IDS.forEach(function (id) { if (order.indexOf(id) < 0) order.push(id); });
    return order;
  }

  function normalizeCardHidden(settings) {
    return ((settings && settings.dashboardHidden) || []).filter(isKnownCard);
  }

  function normalizeCardSizes(settings) {
    const stored = sanitizeSizes(settings && settings.dashboardSizes);
    const out = defaultSizes();
    KNOWN_CARD_IDS.forEach(function (id) {
      if (stored[id]) out[id] = stored[id];   // 缺失的卡片自动落回默认尺寸
    });
    return out;
  }

  /**
   * 首页实际要渲染的卡片 id（已按顺序排列并剔除隐藏项）。
   * 对顺序表做一次自愈：过滤未知 id、补齐缺失的已知 id，
   * 这样升级后新增的卡片不会因为旧配置而消失。
   */
  function visibleDashboardCards(settings) {
    const hidden = normalizeCardHidden(settings);
    return normalizeCardOrder(settings).filter(function (id) {
      return hidden.indexOf(id) < 0;
    });
  }

  KC.ui = {
    statCard: statCard,
    senkaProgress: senkaProgress,
    exportNotice: exportNotice,
    taskCutoffNotice: taskCutoffNotice,
    remainText: remainText,
    DASHBOARD_CARDS: DASHBOARD_CARDS,
    visibleDashboardCards: visibleDashboardCards,
    /* 首页布局（排序 + 尺寸）共用逻辑，设置页与首页都从这里取 */
    CARD_SIZES: CARD_SIZES,
    DEFAULT_CARD_SIZE: DEFAULT_SIZE,
    GRID_GAP: GRID_GAP,
    gridColCount: gridColCount,
    cardSpan: cardSpan,
    cardSizeLabel: cardSizeLabel,
    isKnownCard: isKnownCard,
    defaultCardSizes: defaultSizes,
    sanitizeCardSizes: sanitizeSizes,
    normalizeCardOrder: normalizeCardOrder,
    normalizeCardHidden: normalizeCardHidden,
    normalizeCardSizes: normalizeCardSizes
  };
})(window.KC = window.KC || {});
