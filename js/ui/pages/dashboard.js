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

  function buildCards(plan, ctx) {
    const tRec = ctx.todayRecord;
    const yRec = ctx.yesterdayRecord;

    const requiredValue = (plan.targetSenka === null || plan.requiredDaily === null)
      ? '—' : U.formatNumber(plan.requiredDaily);
    const requiredSub =
      plan.targetSenka === null ? '未设定月目标' :
      (plan.gap !== null && plan.gap <= 0) ? '目标已达成' :
      plan.requiredDaily === null ? '本期已结束，无法达成' :
      '剩余 ' + U.formatNumber(plan.gap) + ' ÷ ' + plan.remainingDays + ' 天';

    const cards = {
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

    return KC.ui.visibleDashboardCards(KC.store.getSettings()).map(function (id) {
      return cards[id];
    }).join('');
  }

  function cardsBlock(plan, ctx) {
    const html = buildCards(plan, ctx);
    if (!html) {
      return '<div class="panel"><div class="empty-inline">' +
        '首页卡片已全部隐藏，可在「设置」中重新开启。</div></div>';
    }
    return '<div class="card-grid">' + html + '</div>';
  }

  /* -------------------------------------------------------------- 图表 */

  /** 迷你折线图（纯 SVG，无第三方依赖） */
  function sparkline(series) {
    const w = 100;
    const h = 34;
    const values = series.map(function (p) { return p.value === null ? 0 : p.value; });
    const peak = Math.max.apply(null, values.concat([0])) || 1;
    const stepX = values.length > 1 ? w / (values.length - 1) : 0;

    const points = values.map(function (v, i) {
      const x = i * stepX;
      const y = h - 3 - (v / peak) * (h - 8);
      return x.toFixed(2) + ',' + y.toFixed(2);
    });
    const line = 'M' + points.join(' L');
    const area = line + ' L' + w + ',' + h + ' L0,' + h + ' Z';

    return '<svg class="spark" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" aria-hidden="true">' +
      '<path class="spark-area" d="' + area + '"></path>' +
      '<path class="spark-line" d="' + line + '"></path>' +
      '</svg>';
  }

  function trendPanel(recent) {
    const series = recent.series;
    const last = series[series.length - 1];

    return '<div class="panel">' +
      '<div class="panel-head">' +
        '<h2>最近增长趋势</h2>' +
        '<span class="panel-count">最近 ' + recent.days + ' 天</span>' +
      '</div>' +
      (recent.count > 0
        ? sparkline(series)
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

      cardsBlock(plan, ctx) +
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
