/* ==========================================================================
   ui/pages/analysis.js — 数据分析页
   依据 docs/02_ui.md §4.5 / §六、docs/01_requirements.md §四 / §七、
        docs/04_calculation.md §十三。

   定位：只做分析与展示，不承担任何数据编辑。
   图表由当前数据实时生成，程序不缓存图表数据（每次重绘都重建）。
   图表库：vendor/chart.umd.min.js（本地引入，不走 CDN；缺失时页面降级为提示文字）。
   ========================================================================== */
(function (KC) {
  'use strict';

  const U = KC.utils;

  KC.pages = KC.pages || {};

  const COMPARE_MONTHS = 12;
  const HISTORY_LIMIT = 24;

  const pageState = { container: null, month: null, charts: [] };

  let unsubscribe = null;
  let handlers = null;

  /* ------------------------------------------------------------ 小工具 */

  function slot(id) {
    return pageState.container ? pageState.container.querySelector('#' + id) : null;
  }

  function hasChartJs() {
    return typeof window.Chart === 'function';
  }

  /** 从 CSS 变量取色，保证图表与全站配色一致 */
  function color(name, fallback) {
    try {
      const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return value || fallback;
    } catch (err) {
      return fallback;
    }
  }

  function destroyCharts() {
    pageState.charts.forEach(function (chart) {
      try { chart.destroy(); } catch (err) { /* 忽略 */ }
    });
    pageState.charts = [];
  }

  function chartFallback(message) {
    return '<div class="chart-fallback">' + U.escapeHtml(message) + '</div>';
  }

  function replaceWithFallback(canvas, message) {
    const box = canvas && canvas.parentNode;
    if (box) box.innerHTML = chartFallback(message);
  }

  function axisTicks(textColor) {
    return { color: textColor, maxRotation: 0, autoSkip: true };
  }

  /* -------------------------------------------------------------- 图表 */

  function buildDailyChart(records, month) {
    const canvas = slot('chart-daily');
    if (!canvas || !hasChartJs()) return;

    const series = KC.calc.analysis.monthDailySeries(records, month);
    if (!series.some(function (p) { return p.value !== null; })) {
      replaceWithFallback(canvas, '该月还没有出击记录。');
      return;
    }

    const barColor = color('--senka-planned', '#2f6fed');
    const lineColor = color('--senka-actual', '#b98420');
    const gridColor = color('--border', '#e4e8ee');
    const textColor = color('--text-muted', '#667085');

    pageState.charts.push(new window.Chart(canvas, {
      data: {
        labels: series.map(function (p) { return String(p.day); }),
        datasets: [
          {
            type: 'bar', label: '每日出击战果', order: 2, yAxisID: 'y',
            data: series.map(function (p) { return p.value; }),
            backgroundColor: barColor, borderRadius: 3, maxBarThickness: 22
          },
          {
            type: 'line', label: '累计出击战果', order: 1, yAxisID: 'y1',
            data: series.map(function (p) { return p.cumulative; }),
            borderColor: lineColor, backgroundColor: 'transparent',
            borderWidth: 2, tension: 0.25, pointRadius: 0, pointHoverRadius: 4
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            position: 'bottom',
            labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true, color: textColor }
          }
        },
        scales: {
          x: { grid: { display: false }, ticks: axisTicks(textColor) },
          y: {
            beginAtZero: true, position: 'left',
            grid: { color: gridColor }, ticks: { color: textColor },
            title: { display: true, text: '每日', color: textColor }
          },
          y1: {
            beginAtZero: true, position: 'right',
            grid: { drawOnChartArea: false }, ticks: { color: textColor },
            title: { display: true, text: '累计', color: textColor }
          }
        }
      }
    }));
  }

  function buildCompareChart(records, monthKeys) {
    const canvas = slot('chart-compare');
    if (!canvas || !hasChartJs()) return;

    const data = KC.calc.analysis.monthlyComparison(records, monthKeys);
    if (!data.some(function (d) { return d.total > 0; })) {
      replaceWithFallback(canvas, '最近 ' + monthKeys.length + ' 个月还没有出击记录。');
      return;
    }

    const barColor = color('--senka-planned', '#2f6fed');
    const gridColor = color('--border', '#e4e8ee');
    const textColor = color('--text-muted', '#667085');

    pageState.charts.push(new window.Chart(canvas, {
      type: 'bar',
      data: {
        labels: data.map(function (d) { return d.label; }),
        datasets: [{
          label: '累计出击战果',
          data: data.map(function (d) { return d.total; }),
          backgroundColor: barColor, borderRadius: 4, maxBarThickness: 30
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              afterLabel: function (ctx) {
                const item = data[ctx.dataIndex];
                return '记录 ' + item.count + ' 天' +
                  (item.max === null ? '' : ' · 单日最高 ' + U.formatNumber(item.max));
              }
            }
          }
        },
        scales: {
          x: { grid: { display: false }, ticks: axisTicks(textColor) },
          y: { beginAtZero: true, grid: { color: gridColor }, ticks: { color: textColor } }
        }
      }
    }));
  }

  function buildCompositionChart(comp) {
    const canvas = slot('chart-composition');
    if (!canvas || !hasChartJs()) return;

    const parts = comp.parts.filter(function (p) { return p.value > 0; });
    if (!parts.length) {
      replaceWithFallback(canvas, '该月还没有战果数据。');
      return;
    }

    const palette = {
      inherited: '#8b93a7',
      sortie: color('--senka-planned', '#2f6fed'),
      eo: color('--senka-actual', '#b98420'),
      task: '#128a4d'
    };
    const textColor = color('--text-muted', '#667085');

    pageState.charts.push(new window.Chart(canvas, {
      type: 'doughnut',
      data: {
        labels: parts.map(function (p) { return p.label; }),
        datasets: [{
          data: parts.map(function (p) { return p.value; }),
          backgroundColor: parts.map(function (p) { return palette[p.key]; }),
          borderWidth: 0
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '58%',
        plugins: {
          legend: {
            position: 'bottom',
            labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true, color: textColor }
          }
        }
      }
    }));
  }

  /* -------------------------------------------------------------- 渲染 */

  function pageHead(isCurrent) {
    return '<div class="page-head">' +
      '<div>' +
        '<h1>数据分析</h1>' +
        '<p class="page-sub">统计与图表均由当前数据实时计算，仅作分析参考，不承担数据编辑。</p>' +
      '</div>' +
      '<div class="month-switch">' +
        '<button type="button" class="btn btn-icon" data-act="prev-month" title="上个月" aria-label="上个月">‹</button>' +
        '<span class="month-label">' + U.escapeHtml(U.monthLabel(pageState.month)) + '</span>' +
        '<button type="button" class="btn btn-icon" data-act="next-month" title="下个月" aria-label="下个月">›</button>' +
        (isCurrent ? '' : '<button type="button" class="btn btn-ghost btn-sm" data-act="this-month">回到本月</button>') +
      '</div>' +
      '</div>';
  }

  function statCards(summary, plan) {
    const avgText = summary.naturalDailyAvg === null ? '数据不足' : U.formatNumber(summary.naturalDailyAvg);
    const avgSub = summary.elapsedDays > 0
      ? '累计 ' + U.formatNumber(summary.total) + ' ÷ 已过 ' + summary.elapsedDays + ' 天'
      : '本期尚未满 1 天';

    return KC.ui.statCard('累计出击战果', U.formatNumber(summary.total),
        '记录 ' + summary.count + ' 天', 'gold') +
      KC.ui.statCard('自然日均', avgText, avgSub, '') +
      KC.ui.statCard('单日最高', U.formatNumber(summary.max),
        summary.min === null ? '暂无记录' : '单日最低 ' + U.formatNumber(summary.min), 'green') +
      KC.ui.statCard('实际战果', U.formatNumber(plan.actualSenka),
        '含继承 / EO / 任务', 'purple') +
      KC.ui.statCard('月目标',
        plan.targetSenka === null ? '未设定' : U.formatNumber(plan.targetSenka),
        plan.completion === null ? '在「战果规划」页设定' : '完成率 ' + U.formatNumber(plan.completion, 1) + '%', '') +
      KC.ui.statCard('剩余目标',
        plan.gap === null ? '—' : U.formatNumber(Math.max(0, plan.gap)),
        plan.gap !== null && plan.gap <= 0 ? '目标已达成' : '实际统计口径', '');
  }

  function progressPanel(plan) {
    return '<div class="panel">' +
      '<div class="panel-head"><h2>战果进度</h2>' +
        '<span class="panel-count">' +
          (plan.targetSenka === null ? '未设定月目标'
            : '完成率 ' + U.formatNumber(plan.completion, 1) + '%') +
        '</span></div>' +
      KC.ui.senkaProgress(plan) +
      '</div>';
  }

  function dailyPanel(month) {
    return '<div class="panel">' +
      '<div class="panel-head"><h2>每日出击增长</h2>' +
        '<span class="panel-count">' + U.escapeHtml(U.monthLabel(month)) + ' · 柱状为每日，折线为累计</span></div>' +
      (hasChartJs()
        ? '<div class="chart-box chart-box-lg"><canvas id="chart-daily"></canvas></div>'
        : chartFallback('图表库未加载（vendor/chart.umd.min.js），暂时无法显示图表。')) +
      '</div>';
  }

  function comparePanel() {
    return '<div class="panel">' +
      '<div class="panel-head"><h2>月度比较</h2>' +
        '<span class="panel-count">最近 ' + COMPARE_MONTHS + ' 个月</span></div>' +
      (hasChartJs()
        ? '<div class="chart-box"><canvas id="chart-compare"></canvas></div>'
        : chartFallback('图表库未加载，暂时无法显示图表。')) +
      '</div>';
  }

  function compositionPanel(comp) {
    const total = comp.parts.reduce(function (s, p) { return s + p.value; }, 0);

    const list = comp.parts.map(function (p) {
      const pct = total > 0 ? (p.value / total * 100) : 0;
      return '<li><span>' + U.escapeHtml(p.label) + '</span>' +
        '<span class="comp-val">' + U.formatNumber(p.value) +
        '<em>' + U.formatNumber(pct, 1) + '%</em></span></li>';
    }).join('');

    return '<div class="panel">' +
      '<div class="panel-head"><h2>战果构成</h2>' +
        '<span class="panel-count">合计 ' + U.formatNumber(total) + '</span></div>' +
      (hasChartJs()
        ? '<div class="chart-box"><canvas id="chart-composition"></canvas></div>'
        : chartFallback('图表库未加载，暂时无法显示图表。')) +
      '<ul class="comp-list">' + list + '</ul>' +
      '</div>';
  }

  function historyPanel(months, now) {
    if (!months.length) {
      return '<div class="panel"><div class="panel-head"><h2>历史月份统计</h2></div>' +
        '<div class="empty-inline">还没有任何历史数据。</div></div>';
    }

    const rows = months.map(function (m) {
      const s = KC.calc.stats.monthSummary(KC.store.state.dailyRecords, m, now);
      return '<tr' + (m === pageState.month ? ' class="row-viewing"' : '') + '>' +
        '<td class="cell-date">' + U.escapeHtml(U.monthLabel(m)) + '</td>' +
        '<td class="num">' + U.formatNumber(s.total) + '</td>' +
        '<td class="num">' + s.count + '</td>' +
        '<td class="num">' + (s.naturalDailyAvg === null ? '—' : U.formatNumber(s.naturalDailyAvg)) + '</td>' +
        '<td class="num">' + U.formatNumber(s.max) + '</td>' +
        '<td class="actions">' +
          '<button type="button" class="btn btn-ghost btn-sm" data-act="view-month" data-month="' +
            U.escapeHtml(m) + '">查看</button>' +
        '</td>' +
        '</tr>';
    }).join('');

    return '<div class="panel">' +
      '<div class="panel-head"><h2>历史月份统计</h2>' +
        '<span class="panel-count">共 ' + months.length + ' 个月</span></div>' +
      '<div class="table-wrap"><table class="data-table">' +
        '<thead><tr>' +
          '<th>月份</th><th class="num">累计出击</th><th class="num">记录天数</th>' +
          '<th class="num">自然日均</th><th class="num">单日最高</th><th class="actions">操作</th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table></div>' +
      '</div>';
  }

  function render() {
    const host = pageState.container;
    if (!host) return;

    destroyCharts();

    const now = new Date();
    const month = pageState.month;
    const records = KC.store.state.dailyRecords;
    const summary = KC.calc.stats.monthSummary(records, month, now);
    const comp = KC.calc.analysis.monthComposition(KC.store, month, now);
    const isCurrent = month === KC.periods.currentAttributionMonth(now);
    const compareMonths = KC.calc.analysis.recentMonths(now, COMPARE_MONTHS);
    const history = KC.calc.analysis.availableMonths(KC.store, now).slice(0, HISTORY_LIMIT);

    host.innerHTML =
      pageHead(isCurrent) +
      '<div class="card-grid">' + statCards(summary, comp.plan) + '</div>' +
      progressPanel(comp.plan) +
      dailyPanel(month) +
      '<div class="dash-split">' + comparePanel() + compositionPanel(comp) + '</div>' +
      historyPanel(history, now);

    buildDailyChart(records, month);
    buildCompareChart(records, compareMonths);
    buildCompositionChart(comp);
  }

  /* -------------------------------------------------------------- 交互 */

  function handleClick(e) {
    const btn = KC.dom.closestFrom(e.target, '[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;

    if (act === 'prev-month') {
      pageState.month = U.addMonths(pageState.month, -1);
      render();
    } else if (act === 'next-month') {
      pageState.month = U.addMonths(pageState.month, 1);
      render();
    } else if (act === 'this-month') {
      pageState.month = KC.periods.currentAttributionMonth(new Date());
      render();
    } else if (act === 'view-month') {
      pageState.month = btn.dataset.month;
      render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  /* -------------------------------------------------------------- 生命周期 */

  KC.pages.analysis = {
    mount: function (container) {
      pageState.container = container;
      pageState.month = KC.periods.currentAttributionMonth(new Date());
      pageState.charts = [];

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
      destroyCharts();
      pageState.container = null;
    }
  };
})(window.KC = window.KC || {});
