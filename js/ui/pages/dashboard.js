/* ==========================================================================
   ui/pages/dashboard.js — 首页 Dashboard
   依据 docs/02_ui.md §4.1 / §五 / §六、docs/04_calculation.md §十三。

   定位：总览页，快速了解当前状态，不承担复杂编辑功能。
     · 卡片（Widget）布局，每张卡片展示一种信息
     · 概览级图表：目标进度（三段进度条）+ 最近增长趋势（迷你折线）
     · 仅提供少量快捷操作，复杂编辑跳转到对应页面
   所有数字均运行时计算，不写入数据库。
   ========================================================================== */
(function (KC) {
  'use strict';

  const U = KC.utils;

  KC.pages = KC.pages || {};

  const TREND_DAYS = 14;
  const SUMMARY_DAYS = 7;
  const RECENT_LIST = 5;

  const pageState = { container: null };

  let unsubscribe = null;
  let handlers = null;

  function fmtDateTime(d) {
    return U.toDateKey(d) + ' ' + U.pad2(d.getHours()) + ':' + U.pad2(d.getMinutes());
  }

  /* -------------------------------------------------------------- 卡片 */

  /**
   * 网格型卡片（stat-card）注册表：id -> HTML。
   * 面板型卡片（整行）由 buildPanelRenderers 提供。
   */
  function gridCards(plan, ctx) {
    const tRec = ctx.todayRecord;
    const yRec = ctx.yesterdayRecord;

    const requiredValue = (plan.targetSenka === null || plan.requiredDaily === null)
      ? '—' : U.formatNumber(plan.requiredDaily);
    const requiredSub =
      plan.targetSenka === null ? '未设定月目标' :
      (plan.gap !== null && plan.gap <= 0) ? '目标已达成' :
      plan.requiredDaily === null ? '本期已结束，无法达成' :
      '剩余 ' + U.formatNumber(plan.gap) + ' ÷ ' + plan.remainingDays + ' 天';

    return {
      currentSenka: KC.ui.statCard('当前实际战果', U.formatNumber(plan.actualSenka),
        '继承 + 出击 + EO + 任务', 'gold'),

      target: KC.ui.statCard('月目标',
        plan.targetSenka === null ? '未设定' : U.formatNumber(plan.targetSenka),
        plan.completion === null ? '在「战果规划」页设定'
          : '完成率 ' + U.formatNumber(plan.completion, 1) + '%', 'purple'),

      remainingTarget: KC.ui.statCard('剩余目标',
        plan.gap === null ? '—' : U.formatNumber(Math.max(0, plan.gap)),
        plan.mode === 'combined' ? '综合进度口径' : '实际统计口径', ''),

      monthEndForecast: KC.ui.statCard(
        '预计月底' + (plan.mode === 'combined' ? '综合' : '') + '战果',
        U.formatNumber(plan.mode === 'combined' ? plan.forecastEndPlanned : plan.forecastEndActual),
        '预测日均 ' + U.formatNumber(plan.forecastDaily) + ' × 剩余 ' + plan.remainingDays + ' 天', 'green'),

      todayGrowth: KC.ui.statCard('今日增长',
        tRec ? U.formatNumber(tRec.sortieSenka) : '未记录',
        yRec ? '昨日 ' + U.formatNumber(yRec.sortieSenka) : '昨日无记录', ''),

      naturalDaily: KC.ui.statCard('当前自然日均',
        plan.naturalDailyAvg === null ? '数据不足' : U.formatNumber(plan.naturalDailyAvg),
        plan.elapsedDays > 0 ? '累计出击 ÷ 已过 ' + plan.elapsedDays + ' 天' : '本期尚未满 1 天', ''),

      requiredDaily: KC.ui.statCard('所需日均', requiredValue, requiredSub, ''),

      remainingPeriod: KC.ui.statCard('周期剩余', plan.remainingDays + ' 天',
        '精确 ' + KC.ui.remainText(plan.remainingDaysExact) + ' · 末日 21:00 结算', 'purple')
    };
  }

  /* -------------------------------------------------------- 战果日历面板 */

  const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

  /**
   * 月历表格：每格显示日号，下方显示该日的当日出击战果。
   * 数据来源与「战果记录」页完全一致（DailyRecord.sortieSenka），无记录留空。
   */
  function calendarPanel(cal) {
    const head = WEEK_LABELS.map(function (w, i) {
      return '<span' + (i >= 5 ? ' class="is-weekend"' : '') + '>周' + w + '</span>';
    }).join('');

    const blanks = [];
    for (let i = 0; i < cal.leading; i++) {
      blanks.push('<div class="cal-cell is-blank"></div>');
    }

    const cells = cal.cells.map(function (c) {
      const hasValue = c.value !== null;
      const cls = 'cal-cell' +
        (c.isToday ? ' is-today' : '') +
        (!c.isToday && c.isFuture && !hasValue ? ' is-future' : '');

      const title = c.date + ' · ' +
        (hasValue ? '出击战果 ' + U.formatNumber(c.value) : '无记录');

      return '<div class="' + cls + '" title="' + U.escapeHtml(title) + '">' +
        '<span class="cal-day">' + c.day + '</span>' +
        '<span class="cal-val">' + (hasValue ? U.formatNumber(c.value) : '') + '</span>' +
        '</div>';
    }).join('');

    return '<div class="panel">' +
      '<div class="panel-head">' +
        '<h2>战果日历</h2>' +
        '<span class="panel-count">' + U.escapeHtml(U.monthLabel(cal.monthKey)) +
          ' · 有记录 ' + cal.count + ' 天 · 合计 ' + U.formatNumber(cal.total) + '</span>' +
      '</div>' +
      '<div class="cal-head">' + head + '</div>' +
      '<div class="cal-grid">' + blanks.join('') + cells + '</div>' +
      '<p class="form-hint">格内为「战果记录」中的当日出击战果，无记录的日子留空；' +
        'EO / 任务战果没有按日归属，因此不计入本表。</p>' +
      '</div>';
  }

  /** 面板型卡片（独占整行）：id -> 渲染函数 */
  function buildPanelRenderers(cal) {
    return {
      calendar: function () { return calendarPanel(cal); }
    };
  }

  /**
   * 按设置中的顺序渲染全部首页卡片。
   * 连续的网格卡片合并进一个 .card-grid；面板型卡片独占整行，
   * 因此用户把面板卡片拖到中间也不会破坏网格布局。
   */
  function cardsBlock(plan, ctx, cal) {
    const grid = gridCards(plan, ctx);
    const panels = buildPanelRenderers(cal);
    const blocks = [];
    let buffer = [];

    function flush() {
      if (!buffer.length) return;
      blocks.push('<div class="card-grid">' + buffer.join('') + '</div>');
      buffer = [];
    }

    KC.ui.visibleDashboardCards(KC.store.getSettings()).forEach(function (id) {
      if (panels[id]) {
        flush();
        blocks.push(panels[id]());
      } else if (grid[id]) {
        buffer.push(grid[id]);
      }
    });
    flush();

    if (!blocks.length) {
      return '<div class="panel"><div class="empty-inline">' +
        '首页卡片已全部隐藏，可在「设置」中重新开启。</div></div>';
    }
    return blocks.join('');
  }

  /* -------------------------------------------------------------- 图表 */

  /* 趋势图坐标系（用户单位）。等比缩放，文字不会被拉伸。 */
  const TREND_W = 640;
  const TREND_H = 210;
  const TREND_PAD = { top: 14, right: 14, bottom: 28, left: 54 };

  /** 取一个不小于 v 的「整齐」刻度上限（1 / 2 / 2.5 / 5 / 10 × 10^n） */
  function niceCeil(v) {
    if (!(v > 0)) return 1;
    const exp = Math.floor(Math.log10(v));
    const base = Math.pow(10, exp);
    const n = v / base;
    const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
    return step * base;
  }

  /**
   * 最近增长趋势折线图（纯 SVG，无第三方依赖）。
   * 纵轴：0 ～ niceCeil(峰值) 四等分刻度 + 横向网格线；
   * 横轴：每 2 天一个日期刻度（MM-DD）。
   * 无记录的日期按 0 参与连线（与预测口径一致），但**不画点**，
   * 以便与「确实记录为 0」的日子区分。
   */
  function trendChart(series) {
    const values = series.map(function (p) { return p.value === null ? 0 : p.value; });
    const peak = Math.max.apply(null, values.concat([0]));
    const yMax = niceCeil(peak);

    const x0 = TREND_PAD.left;
    const y0 = TREND_PAD.top;
    const x1 = TREND_W - TREND_PAD.right;
    const y1 = TREND_H - TREND_PAD.bottom;
    const plotW = x1 - x0;
    const plotH = y1 - y0;

    const stepX = values.length > 1 ? plotW / (values.length - 1) : 0;
    const px = function (i) { return x0 + i * stepX; };
    const py = function (v) { return y1 - (v / yMax) * plotH; };

    /* 纵轴：四等分刻度 + 网格线 + 数值标签 */
    const Y_TICKS = 4;
    let yAxis = '';
    for (let t = 0; t <= Y_TICKS; t++) {
      const v = yMax / Y_TICKS * t;
      const y = py(v);
      yAxis += '<line class="trend-grid" x1="' + x0 + '" y1="' + y.toFixed(1) +
          '" x2="' + x1 + '" y2="' + y.toFixed(1) + '"></line>' +
        '<text class="trend-tick" x="' + (x0 - 8) + '" y="' + (y + 3.5).toFixed(1) +
          '" text-anchor="end">' + U.escapeHtml(U.formatInt(v)) + '</text>';
    }

    /* 横轴：每 2 天一个日期刻度 */
    let xAxis = '';
    series.forEach(function (p, i) {
      if (i % 2 !== 0) return;
      const x = px(i);
      xAxis += '<line class="trend-tick-mark" x1="' + x.toFixed(1) + '" y1="' + y1 +
          '" x2="' + x.toFixed(1) + '" y2="' + (y1 + 4) + '"></line>' +
        '<text class="trend-tick" x="' + x.toFixed(1) + '" y="' + (y1 + 16) +
          '" text-anchor="middle">' + U.escapeHtml(p.date.slice(5)) + '</text>';
    });

    /* 折线 + 面积 */
    const points = values.map(function (v, i) {
      return px(i).toFixed(1) + ',' + py(v).toFixed(1);
    });
    const line = 'M' + points.join(' L');
    const area = line + ' L' + x1.toFixed(1) + ',' + y1 + ' L' + x0 + ',' + y1 + ' Z';

    /* 只有真正有记录的日子才画点 */
    const dots = series.map(function (p, i) {
      if (p.value === null) return '';
      return '<circle class="trend-dot" cx="' + px(i).toFixed(1) +
        '" cy="' + py(p.value).toFixed(1) + '" r="2.4"></circle>';
    }).join('');

    return '<svg class="trend-chart" viewBox="0 0 ' + TREND_W + ' ' + TREND_H + '" ' +
      'role="img" aria-label="最近增长趋势折线图">' +
      yAxis +
      '<line class="trend-axis" x1="' + x0 + '" y1="' + y0 +
        '" x2="' + x0 + '" y2="' + y1 + '"></line>' +
      '<line class="trend-axis" x1="' + x0 + '" y1="' + y1 +
        '" x2="' + x1 + '" y2="' + y1 + '"></line>' +
      xAxis +
      '<path class="trend-area" d="' + area + '"></path>' +
      '<path class="trend-line" d="' + line + '"></path>' +
      dots +
      '</svg>';
  }

  function trendPanel(recent) {
    const series = recent.series;
    const last = series[series.length - 1];

    return '<div class="panel">' +
      '<div class="panel-head">' +
        '<h2>最近增长趋势</h2>' +
        '<span class="panel-count">最近 ' + recent.days + ' 天 · 单位：战果</span>' +
      '</div>' +
      (recent.count > 0
        ? trendChart(series)
        : '<div class="empty-inline">最近 ' + recent.days + ' 天还没有出击记录。</div>') +
      '<div class="spark-meta">' +
        '<span>' + U.escapeHtml(series[0].date) + ' ～ ' + U.escapeHtml(last.date) + '</span>' +
        '<span>有记录 ' + recent.count + ' 天 · 合计 ' + U.formatNumber(recent.total) +
          (recent.max === null ? '' : ' · 单日最高 ' + U.formatNumber(recent.max)) + '</span>' +
      '</div>' +
      '</div>';
  }

  function summaryPanel(recent) {
    const list = KC.store.listDailyRecords().slice(0, RECENT_LIST);

    return '<div class="panel">' +
      '<div class="panel-head">' +
        '<h2>最近数据摘要</h2>' +
        '<span class="panel-count">最近 ' + recent.days + ' 天</span>' +
      '</div>' +
      '<div class="mini-stats">' +
        '<span><em>' + recent.count + '</em> 天有记录</span>' +
        '<span><em>' + U.formatNumber(recent.total) + '</em> 合计出击</span>' +
        '<span><em>' + (recent.avg === null ? '—' : U.formatNumber(recent.avg)) + '</em> 有记录日均</span>' +
      '</div>' +
      (list.length
        ? '<ul class="mini-list">' + list.map(function (r) {
            return '<li><span class="mini-date">' + U.escapeHtml(r.date) + '</span>' +
              '<span class="mini-val">' + U.formatNumber(r.sortieSenka) + '</span></li>';
          }).join('') + '</ul>'
        : '<div class="empty-inline">还没有任何记录。</div>') +
      '<div class="panel-foot">' +
        '<button type="button" class="btn btn-ghost btn-sm" data-act="goto-records">查看全部记录</button>' +
      '</div>' +
      '</div>';
  }

  /* -------------------------------------------------------------- 渲染 */

  function render() {
    const host = pageState.container;
    if (!host) return;

    const now = new Date();
    const plan = KC.calc.plan.forCurrentMonth(KC.store, now);
    const month = plan.month;

    const todayKey = U.todayKey();
    const yesterdayKey = U.toDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
    const ctx = {
      todayRecord: KC.store.getDailyRecord(todayKey),
      yesterdayRecord: KC.store.getDailyRecord(yesterdayKey)
    };

    const records = KC.store.state.dailyRecords;
    const recent14 = KC.calc.stats.recentSummary(records, TREND_DAYS, now);
    const recent7 = KC.calc.stats.recentSummary(records, SUMMARY_DAYS, now);
    // 日历跟随首页的规划月份（战果归属月），与其它卡片口径一致
    const calendar = KC.calc.stats.monthCalendar(records, month, now);

    host.innerHTML =
      '<div class="page-head">' +
        '<div>' +
          '<h1>首页</h1>' +
          '<p class="page-sub">规划月份 ' + U.escapeHtml(U.monthLabel(month)) +
            ' · 战果归属区间 ' + fmtDateTime(KC.periods.attributionStart(month)) +
            ' ～ ' + fmtDateTime(KC.periods.attributionEnd(month)) + '</p>' +
        '</div>' +
        '<div class="head-actions">' +
          '<button type="button" class="btn btn-primary" data-act="goto-records">记录今日战果</button>' +
          '<button type="button" class="btn btn-ghost" data-act="goto-planning">战果规划</button>' +
          '<button type="button" class="btn btn-ghost" data-act="goto-tasks">战果任务</button>' +
        '</div>' +
      '</div>' +

      '<div class="panel">' +
        '<div class="panel-head">' +
          '<h2>战果进度</h2>' +
          '<span class="panel-count">' +
            (plan.targetSenka === null
              ? '未设定月目标'
              : '完成率 ' + U.formatNumber(plan.completion, 1) + '% · ' +
                (plan.mode === 'combined' ? '综合进度口径' : '实际统计口径')) +
          '</span>' +
        '</div>' +
        KC.ui.senkaProgress(plan) +
      '</div>' +

      cardsBlock(plan, ctx, calendar) +
      '<div class="dash-split">' +
        trendPanel(recent14) +
        summaryPanel(recent7) +
      '</div>';
  }

  /* -------------------------------------------------------------- 交互 */

  function handleClick(e) {
    const btn = KC.dom.closestFrom(e.target, '[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'goto-records') KC.router.navigate('records');
    else if (act === 'goto-planning') KC.router.navigate('planning');
    else if (act === 'goto-tasks') KC.router.navigate('tasks');
  }

  /* -------------------------------------------------------------- 生命周期 */

  KC.pages.dashboard = {
    mount: function (container) {
      pageState.container = container;
      handlers = { click: handleClick };
      container.addEventListener('click', handlers.click);
      unsubscribe = KC.store.subscribe(function (type) {
        if (type === 'change') render();
      });
      render();
    },
    unmount: function () {
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
      if (handlers && pageState.container) {
        pageState.container.removeEventListener('click', handlers.click);
      }
      handlers = null;
      pageState.container = null;
    }
  };
})(window.KC = window.KC || {});
