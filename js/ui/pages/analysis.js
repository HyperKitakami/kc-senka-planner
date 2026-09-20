/* ==========================================================================
   ui/pages/analysis.js — 数据分析页
   依据 docs/02_ui.md §4.6 / §六、docs/01_requirements.md §四 / §七、
        docs/04_calculation.md §十三。

   定位：只做分析与展示，不承担任何数据编辑。
   图表由当前数据实时生成，程序不缓存图表数据（每次重绘都重建）。
   图表库：vendor/chart.umd.min.js（本地引入，不走 CDN；缺失时页面降级为提示文字）。
   ========================================================================== */
(function (KC) {
  'use strict';

  const U = KC.utils;

  KC.pages = KC.pages || {};

  /** 「历史月份统计」列表最多列出多少个月（与月度比较的区间上限无关） */
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

  /**
   * 四项战果构成的配色，「战果构成」与「月度比较」两张卡片共用同一份，
   * 因此同项在两处颜色必然一致（key 与 KC.calc.analysis.COMPARE_METRICS 一致）。
   */
  function partColors() {
    return {
      inherited: color('--senka-inherited', '#8b93a7'),
      sortie: color('--senka-planned', '#2f6fed'),
      eo: color('--senka-actual', '#b98420'),
      task: color('--senka-task', '#128a4d')
    };
  }

  /** 当前生效的月度比较项（来自 settings.compareMetrics，非法值回退四项全选） */
  function compareMetricKeys() {
    return KC.calc.analysis.normalizeCompareMetrics(KC.store.getSettings().compareMetrics);
  }

  /** 当前勾选的数据项（按 COMPARE_METRICS 的固定顺序，即堆叠顺序） */
  function selectedMetrics() {
    const keys = compareMetricKeys();
    return KC.calc.analysis.COMPARE_METRICS.filter(function (m) {
      return keys.indexOf(m.key) >= 0;
    });
  }

  /**
   * 当前生效的月度比较区间（settings.compareFrom / compareTo 归一化后的结果）。
   * 归一化保证 from ≤ to、跨度 ≤ COMPARE_MAX_MONTHS、缺失时回退最近 12 个月。
   */
  function compareRange() {
    const settings = KC.store.getSettings();
    return KC.calc.analysis.normalizeCompareRange(
      settings.compareFrom, settings.compareTo, new Date());
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

  /**
   * 「月度比较」堆叠柱状图。
   * 每根柱子按当前勾选的数据项堆叠，颜色与「战果构成」一致；
   * 未勾选任何一项时给出提示，不画空图。
   */
  function buildCompareChart(store, monthKeys) {
    const canvas = slot('chart-compare');
    if (!canvas || !hasChartJs()) return;

    const metrics = selectedMetrics();
    if (!metrics.length) {
      replaceWithFallback(canvas, '至少勾选一项数据。');
      return;
    }

    const data = KC.calc.analysis.monthlyComparison(store, monthKeys, new Date());
    const hasData = data.some(function (d) {
      return metrics.some(function (m) { return d[m.key] > 0; });
    });
    if (!hasData) {
      replaceWithFallback(canvas, '最近 ' + monthKeys.length + ' 个月所选数据都还没有战果。');
      return;
    }

    const palette = partColors();
    const gridColor = color('--border', '#e4e8ee');
    const textColor = color('--text-muted', '#667085');

    pageState.charts.push(new window.Chart(canvas, {
      type: 'bar',
      data: {
        labels: data.map(function (d) { return d.label; }),
        datasets: metrics.map(function (m, i) {
          return {
            label: m.label,
            data: data.map(function (d) { return d[m.key]; }),
            backgroundColor: palette[m.key],
            stack: 'senka',
            maxBarThickness: 30,
            // 只有最上面一段圆角，堆叠柱的柱顶才好看
            borderRadius: i === metrics.length - 1 ? 4 : 0
          };
        })
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: metrics.length > 1
            ? {
                position: 'bottom',
                labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true, color: textColor }
              }
            : { display: false },
          tooltip: {
            callbacks: {
              afterBody: function (items) {
                if (!items.length) return '';
                const item = data[items[0].dataIndex];
                return '合计 ' + U.formatNumber(item.actual) +
                  ' · 记录 ' + item.count + ' 天' +
                  (item.max === null ? '' : ' · 单日最高 ' + U.formatNumber(item.max));
              }
            }
          }
        },
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: axisTicks(textColor) },
          y: {
            stacked: true, beginAtZero: true,
            grid: { color: gridColor }, ticks: { color: textColor }
          }
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

    const palette = partColors();
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

  /** 「月度比较」横轴区间：起止月份 + 快捷回到默认区间 */
  function rangeBarHtml(range) {
    const A = KC.calc.analysis;
    return '<div class="range-bar">' +
      '<label class="range-field">从' +
        '<input type="month" data-act="compare-from" value="' + U.escapeHtml(range.from) +
          '" aria-label="月度比较起始月份">' +
      '</label>' +
      '<span class="range-sep">～</span>' +
      '<label class="range-field">到' +
        '<input type="month" data-act="compare-to" value="' + U.escapeHtml(range.to) +
          '" aria-label="月度比较结束月份">' +
      '</label>' +
      '<button type="button" class="btn btn-ghost btn-sm range-reset" data-act="compare-reset">' +
        '最近 ' + A.COMPARE_DEFAULT_MONTHS + ' 个月</button>' +
      '</div>';
  }

  /** 「月度比较」的勾选框：顺序与堆叠顺序一致，勾选结果存 settings.compareMetrics */
  function metricTogglesHtml() {
    const keys = compareMetricKeys();
    return '<div class="metric-toggles">' +
      KC.calc.analysis.COMPARE_METRICS.map(function (m) {
        return '<label class="check"><input type="checkbox" data-act="compare-metric" data-key="' +
          m.key + '"' + (keys.indexOf(m.key) >= 0 ? ' checked' : '') + '>' +
          U.escapeHtml(m.label) + '</label>';
      }).join('') +
      '</div>';
  }

  function comparePanel(range) {
    const A = KC.calc.analysis;
    const count = selectedMetrics().length;
    return '<div class="panel">' +
      '<div class="panel-head"><h2>月度比较</h2>' +
        '<span class="panel-count">' + range.months.length + ' 个月' +
          (count ? '' : ' · 未选择数据') + '</span></div>' +
      rangeBarHtml(range) +
      metricTogglesHtml() +
      (hasChartJs()
        ? '<div class="chart-box"><canvas id="chart-compare"></canvas></div>'
        : chartFallback('图表库未加载，暂时无法显示图表。')) +
      '<p class="form-hint">横轴区间可自由选择（1 ～ ' + A.COMPARE_MAX_MONTHS +
        ' 个月，超长会自动截断）；勾选要比较的数据项，颜色与「战果构成」一致；' +
        '堆叠柱的高度即该月实际战果（继承 + 出击 + EO + 任务）。</p>' +
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
    const range = compareRange();
    const history = KC.calc.analysis.availableMonths(KC.store, now).slice(0, HISTORY_LIMIT);

    host.innerHTML =
      pageHead(isCurrent) +
      '<div class="card-grid">' + statCards(summary, comp.plan) + '</div>' +
      progressPanel(comp.plan) +
      dailyPanel(month) +
      '<div class="dash-split">' + comparePanel(range) + compositionPanel(comp) + '</div>' +
      historyPanel(history, now);

    buildDailyChart(records, month);
    buildCompareChart(KC.store, range.months);
    buildCompositionChart(comp);
  }

  /* -------------------------------------------------------------- 交互 */

  /**
   * 勾选 / 取消「月度比较」的数据项。
   * 只写 settings，界面交给 store 广播的 change 重绘——
   * 这样保存失败时页面保持原样，不会出现"勾上了却没存住"的假象。
   */
  function handleChange(e) {
    const el = e.target;
    if (!el || !el.dataset) return;

    if (el.dataset.act === 'compare-from' || el.dataset.act === 'compare-to') {
      const isFrom = el.dataset.act === 'compare-from';
      applyCompareRange(isFrom ? el.value : undefined, isFrom ? undefined : el.value, el);
      return;
    }

    if (el.dataset.act !== 'compare-metric') return;

    const key = el.dataset.key;
    const current = compareMetricKeys();
    const has = current.indexOf(key) >= 0;
    // 存库前归一化：过滤未知 key 并按 COMPARE_METRICS 的固定顺序重排，
    // 免得"后勾的排最后"这种顺序被写进设置（页面虽然会归一化读取，但存值应当干净）
    const next = KC.calc.analysis.normalizeCompareMetrics(
      el.checked
        ? (has ? current : current.concat([key]))
        : current.filter(function (k) { return k !== key; })
    );

    KC.store.saveSettings({ compareMetrics: next })
      .catch(function (err) { KC.toast(err.message, 'error'); });
  }

  /**
   * 保存月度比较区间。只改一端时，另一端沿用当前设置。
   * 传 null 表示"该端用默认值"（「最近 12 个月」按钮走这条路）。
   *
   * 存进设置的一律是**归一化之后**的值，也就是界面上真正画出来的区间——
   * 这样"设置 = 生效区间"是唯一不变量，输入框不会显示一个并不是当前区间的月份。
   * 因此超长截断只能在这里告知用户（设置落库后已经夹好，重绘时再算就看不到 truncated 了）。
   *
   * @param {string|undefined|null} from  undefined = 沿用当前设置；null = 用默认值
   * @param {string|undefined|null} to
   * @param {object} [input] 触发本次变更的输入框（用于把用户填的无效值拨回生效值）
   */
  function applyCompareRange(from, to, input) {
    const A = KC.calc.analysis;
    const settings = KC.store.getSettings();
    const range = A.normalizeCompareRange(
      from === undefined ? settings.compareFrom : from,
      to === undefined ? settings.compareTo : to,
      new Date()
    );

    if (range.from === settings.compareFrom && range.to === settings.compareTo) {
      // 归一化结果与现有区间一致：不落库也不重绘。
      // 但输入框里可能还留着用户刚填的不合理值（超长 / 颠倒 / 清空），
      // 直接把它拨回生效值，免得界面显示一个并不是当前区间的月份。
      if (input) {
        const want = from === undefined ? range.to : range.from;
        if (input.value !== want) input.value = want;
      }
      return;
    }

    if (range.truncated) {
      KC.toast('区间最长 ' + A.COMPARE_MAX_MONTHS + ' 个月，已截断为 ' +
        range.from + ' ～ ' + range.to, 'ok');
    }

    KC.store.saveSettings({ compareFrom: range.from, compareTo: range.to })
      .catch(function (err) { KC.toast(err.message, 'error'); });
  }

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
    } else if (act === 'compare-reset') {
      applyCompareRange(null, null);
    }
  }

  /* -------------------------------------------------------------- 生命周期 */

  KC.pages.analysis = {
    mount: function (container) {
      pageState.container = container;
      pageState.month = KC.periods.currentAttributionMonth(new Date());
      pageState.charts = [];

      handlers = { click: handleClick, change: handleChange };
      container.addEventListener('click', handlers.click);
      container.addEventListener('change', handlers.change);

      unsubscribe = KC.store.subscribe(function (type) {
        if (type === 'change') render();
      });

      render();
    },
    unmount: function () {
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
      if (handlers && pageState.container) {
        pageState.container.removeEventListener('click', handlers.click);
        pageState.container.removeEventListener('change', handlers.change);
      }
      handlers = null;
      destroyCharts();
      pageState.container = null;
    }
  };
})(window.KC = window.KC || {});
