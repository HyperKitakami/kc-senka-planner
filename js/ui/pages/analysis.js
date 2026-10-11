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

  /* ------------------------------------------- 战果线对比（poi 数据） */

  /** 战果线配色：联合 / 一群 / 二群 / 三群 + 自己（自己用最醒目的金色） */
  function rankColors() {
    return {
      r5: color('--rank-1', '#c0392b'),
      r20: color('--rank-2', '#b9861b'),
      r100: color('--rank-3', '#2f6fed'),
      r501: color('--rank-4', '#128a4d'),
      my: color('--accent', '#7a4fd6')
    };
  }

  /**
   * 「战果线对比」卡片。
   *
   * 数据来自 poi 快照：四条戦果線（poi 按日累积）+ 自己的累计出击战果。
   * 没有当月快照时给引导文案（去记录页同步），不画空图。
   *
   * ⚠️ 快照只含「已同步过的月份」，所以换到没有快照的月份会看到空态；
   * 这是刻意设计——战果线是 poi 的历史事实，本工具不编造。
   */
  function rankPanel(month) {
    const data = KC.poiData.chartData(month, KC.store.state.dailyRecords);
    const hasAnyHis = data && data.lines.some(function (l) {
      return l.key !== 'my' && l.values.some(function (v) { return v !== null; });
    });

    let body;
    if (!data) {
      body = '<div class="empty-inline">该月还没有 poi 战果线快照。' +
        '到「战果记录」页同步一次 poi 数据（' +
        '<code>%APPDATA%\\poi\\achieve\\achieve.json</code>）后即可查看。</div>';
    } else if (!hasAnyHis) {
      body = '<div class="empty-inline">该月快照里还没有战果线数据。</div>';
    } else if (!hasChartJs()) {
      body = chartFallback('图表库未加载（vendor/chart.umd.min.js），暂时无法显示图表。');
    } else {
      body = '<div class="chart-box chart-box-lg"><canvas id="chart-rank"></canvas></div>';
    }

    const srcNote = data && data.source === 'poi'
      ? '自己的累计取自 poi 记录'
      : (data && data.source === 'records' ? '自己的累计取自本工具记录（该月快照无累计数据）' : '');
    const syncNote = data && data.syncedAt
      ? '快照同步于 ' + U.escapeHtml(fmtSyncTime(data.syncedAt))
      : '';

    return '<div class="panel">' +
      '<div class="panel-head"><h2>战果线对比</h2>' +
        '<span class="panel-count">' + U.escapeHtml(U.monthLabel(month)) +
          (syncNote ? ' · ' + syncNote : '') + '</span></div>' +
      body +
      (data && hasAnyHis
        ? '<ul class="rank-legend">' + data.lines.map(function (l) {
            const last = lastValue(l.values);
            // ⚠️ 与 tooltip 同精度：**整数**（formatInt）。两处都显示同一条线的「当前值」，
            //    一个 6000.00 一个 6000 会让人怀疑是两个不同的数。
            return '<li><span class="rank-dot" style="background:' +
              rankColors()[l.key] + '"></span>' +
              U.escapeHtml(l.label) +
              '<em>' + (last === null ? '—' : U.formatInt(last)) + '</em></li>';
          }).join('') + '</ul>'
        : '') +
      '<p class="form-hint">四条战果线来自 poi（联合 / 一群 / 二群 / 三群，poi 按半天槽累积的排名线）；' +
        '「我的累计」是本月的累计出击战果。' +
        '横轴每个日号对应两个点（前半日 / 后半日），日期标注画在后半日那个点上。' +
        '悬停曲线时，每条战果线后面会附带它与「我的累计」的差值（同一槽两边都有值时才给出）。' +
        (srcNote ? U.escapeHtml(srcNote) + '。' : '') +
        '数据来自「本机轻量存储」里的 poi 快照，不参与导入导出，换浏览器或清站点数据会丢失。</p>' +
      '</div>';
  }

  /** 一条线的最后一个非 null 值（图例里显示"当前值"） */
  function lastValue(values) {
    const arr = Array.isArray(values) ? values : [];
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i] !== null && arr[i] !== undefined) return arr[i];
    }
    return null;
  }

  /**
   * 取某条线在**指定半天槽**的值；该槽没有值返回 null。
   *
   * ⚠️ **只认同一个槽**，不向前沿用邻近值 —— 本卡片的既定口径是
   *    「数据缺失的槽连线断开，不伪造数值」（docs/02_ui.md §4.6.1）。
   *    差值若拿一个别槽的值来凑，会给出一个图上并不存在的读数。
   */
  function valueAtSlot(values, index) {
    const arr = Array.isArray(values) ? values : [];
    const i = Number(index);
    if (!isFinite(i) || i < 0 || i >= arr.length) return null;
    const v = arr[i];
    return (v === null || v === undefined) ? null : v;
  }

  /**
   * 「战果线对比」tooltip 一行的内容：名称 / 数值 / 差值。
   *
   * 差值口径：**差值 = 该战果线 − 我的累计**，且**只认同一个半天槽**（见 valueAtSlot）——
   *   · 正数 ⇒ 该线还在我之上，我还差这么多才追平它（**红**）；
   *   · 负数 ⇒ 我已经超过该线（**绿**）。
   * 文案不带括号、也不写「比我高 / 低」：正负号本身就是方向，
   * 口径由 tooltip 脚注一句话交代（见 buildRankChart 的 footer 回调）。
   * 只有「我的累计」这条基准线自己、以及该槽我的累计没有数据时不给差值。
   *
   * ⚠️ **数值与差值一律整数**（用户口径；`formatInt` = 四舍五入）：
   *    · 差值是**两个整数相减**（各自先取整），所以「数值 − 数值 = 差值」在显示上能对上；
   *      若改成「原始值相减再取整」，小数数据下会出现差 1 的对不上（6000.6 − 2000.4 显示 6001/2000
   *      却写 4000）。
   *    · 先取整再由结果定符号与颜色，避免 0.4 显示成「+0」这种自相矛盾的东西。
   *    · 基准线（我的累计）与战果线的取整口径一致，缺值仍是「—」。
   *
   * @param {object} dataset 数据集（用到 label 与自加的 key）
   * @param {number} index 半天槽号
   * @param {number|null} value 该槽的数值
   * @param {Array<number|null>|null} myValues 「我的累计」的逐槽值（差值的基准）
   * @returns {{name:string, value:string, diff:({text:string,dir:number}|null)}}
   *   diff.dir：1 正 / -1 负 / 0 持平（着色用）；diff = null 表示这一行不显示差值
   */
  function rankTooltipRow(dataset, index, value, myValues) {
    const absent = (value === null || value === undefined);
    const row = {
      name: String(dataset ? dataset.label : ''),
      value: absent ? '—' : U.formatInt(value),
      diff: null
    };
    if (absent || !dataset || dataset.key === 'my') return row;

    const mine = valueAtSlot(myValues, index);
    if (mine === null) return row;

    // 两边都先取整再相减：显示出来的三个数彼此自洽
    const delta = Math.round(Number(value)) - Math.round(Number(mine));
    row.diff = {
      text: delta === 0
        ? '0'
        : (delta > 0 ? '+' : '-') + U.formatInt(Math.abs(delta)),
      dir: delta === 0 ? 0 : (delta > 0 ? 1 : -1)
    };
    return row;
  }

  /**
   * 「战果线对比」tooltip 的**自绘**渲染器（Chart.js 的 `external` 钩子）。
   *
   * 为什么不用内置的 canvas tooltip：差值那个数要**单独着色**（正红 / 负绿），
   * 而内置 tooltip 的文字是画在 canvas 上的、**一行只能一个颜色**
   * （`label` 回调只返回纯文本，没有富文本能力；`labelColor` 又是逐行的），
   * 做不到「联合：6000.00  +4000.00」里只把 +4000.00 涂红。
   * 于是自绘一个 DOM 浮层，外观复刻 Chart.js 默认样式（深色圆角块 + 色块 + 标题 + 脚注）。
   *
   * ⚠️ 浮层挂在 canvas 的父节点（`.chart-box`，`position: relative`）里，每次重绘整页重建
   *    ⇒ 旧节点自然消失，这里按需新建；鼠标移开时只把 opacity 归零（留着复用）。
   *    必须在 CSS 里 `pointer-events: none`，否则它压住鼠标、把悬停交互自己掐掉。
   *
   * ⚠️ 位置直接用 Chart.js 算好的 tooltip 框左上角（`tooltip.x/y`，已含贴边翻转），
   *    不再自己按 caret 推 —— 少一套会跟 Chart.js 打架的定位逻辑。
   *
   * @param {{chart:object, tooltip:object}} ctx Chart.js 传进来的上下文
   * @param {Array<number|null>|null} myValues 「我的累计」的逐槽值（差值的基准）
   */
  function renderRankTooltip(ctx, myValues) {
    const canvas = ctx && ctx.chart && ctx.chart.canvas;
    const tt = ctx && ctx.tooltip;
    const host = canvas && canvas.parentNode;
    if (!tt || !host || typeof host.querySelector !== 'function') return;

    let el = host.querySelector('.chart-tooltip');
    if (!el) {
      el = document.createElement('div');
      el.className = 'chart-tooltip';
      host.appendChild(el);
    }
    if (!tt.opacity) { el.style.opacity = '0'; return; }

    const rows = (tt.dataPoints || []).map(function (dp) {
      const row = rankTooltipRow(dp.dataset, dp.dataIndex, dp.parsed.y, myValues);
      const cls = !row.diff ? '' : (row.diff.dir > 0 ? ' is-up' : (row.diff.dir < 0 ? ' is-down' : ''));
      return '<li>' +
        '<span class="tt-dot" style="background:' +
          U.escapeHtml(dp.dataset.borderColor || '') + '"></span>' +
        '<span class="tt-name">' + U.escapeHtml(row.name) + '</span>' +
        '<span class="tt-val">' + U.escapeHtml(row.value) + '</span>' +
        (row.diff
          ? '<span class="tt-diff' + cls + '">' + U.escapeHtml(row.diff.text) + '</span>'
          : '') +
        '</li>';
    }).join('');

    const title = (tt.title && tt.title.length) ? tt.title[0] : '';
    const foot = (tt.footer && tt.footer.length) ? tt.footer[0] : '';

    el.innerHTML =
      (title ? '<div class="chart-tooltip-title">' + U.escapeHtml(title) + '</div>' : '') +
      '<ul class="chart-tooltip-list">' + rows + '</ul>' +
      (foot ? '<div class="chart-tooltip-foot">' + U.escapeHtml(foot) + '</div>' : '');
    el.style.opacity = '1';

    // 位置取 Chart.js 算好的框左上角（含它自己的贴边翻转），再按**自绘框**的实际尺寸
    // 夹一次 —— 两边的宽度算法不同（我们的行是 flex 小表、脚注还会折行），
    // 只靠 Chart.js 的钳制在右 / 下边缘仍可能溢出卡片。
    let left = (canvas.offsetLeft || 0) + tt.x;
    let top = (canvas.offsetTop || 0) + tt.y;
    const boxW = host.clientWidth || 0;
    const boxH = host.clientHeight || 0;
    if (boxW && el.offsetWidth) left = Math.max(0, Math.min(left, boxW - el.offsetWidth));
    if (boxH && el.offsetHeight) top = Math.max(0, Math.min(top, boxH - el.offsetHeight));
    el.style.left = Math.round(left) + 'px';
    el.style.top = Math.round(top) + 'px';
  }

  /** ISO 时间 → 'MM-DD HH:mm'（本机时区） */
  function fmtSyncTime(iso) {
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return String(iso);
      return U.pad2(d.getMonth() + 1) + '-' + U.pad2(d.getDate()) + ' ' +
        U.pad2(d.getHours()) + ':' + U.pad2(d.getMinutes());
    } catch (err) {
      return String(iso);
    }
  }

  /** 「战果线对比」折线图：四条排名线 + 自己的累计，x 轴为日 */
  function buildRankChart(month) {
    const canvas = slot('chart-rank');
    if (!canvas || !hasChartJs()) return;

    const data = KC.poiData.chartData(month, KC.store.state.dailyRecords);
    if (!data) return;

    const palette = rankColors();
    const gridColor = color('--border', '#e4e8ee');
    const textColor = color('--text-muted', '#667085');

    const datasets = data.lines.map(function (l) {
      const isMine = l.key === 'my';
      return {
        // tooltip 要用它认出「哪条是我自己」（差值以「我的累计」为基准）
        key: l.key,
        label: l.label,
        data: l.values,
        borderColor: palette[l.key],
        backgroundColor: palette[l.key],
        // 自己那条更粗、带点，其余细线，避免 5 条线糊在一起
        borderWidth: isMine ? 2.5 : 1.5,
        pointRadius: isMine ? 0 : 0,
        pointHoverRadius: 4,
        tension: 0.25,
        spanGaps: true,
        fill: false
      };
    });

    // 「我的累计」这条线的逐槽值 —— tooltip 里各战果线的差值都以它为基准
    const myLine = data.lines.filter(function (l) { return l.key === 'my'; })[0] || null;
    const myValues = myLine ? myLine.values : null;

    pageState.charts.push(new window.Chart(canvas, {
      type: 'line',
      data: { labels: data.labels, datasets: datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            position: 'bottom',
            labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true, color: textColor }
          },
          tooltip: {
            // ⚠️ `enabled: false` 与 `external` **必须成对写**：只给 external 的话，内置 tooltip
            //    照样会画出来 —— Chart.js 的 Tooltip.draw() 只认 `enabled`（`enabled && 有内容`
            //    才画），`external` 只决定「update() 时回调自绘一个」而**不抑制内置绘制**
            //    （v4 实测，别凭「external 就是不画内置」的直觉删掉这行，会出现两个浮层叠着）。
            //    关掉 enabled 不影响 external：命中判定的门是 (enabled || external)。
            enabled: false,
            external: function (ctx) { renderRankTooltip(ctx, myValues); },
            callbacks: {
              // 横轴是**半天槽**：前半日那个点没有刻度文字，
              // 标题按槽号还原成「N 日 前半日 / 后半日」（槽模型见 calc/senkaLine）
              title: function (items) {
                if (!items.length) return '';
                const SL = KC.calc.senkaLine;
                const p = SL.slotParts(items[0].dataIndex);
                return p.day + ' 日 ' + SL.SLOT_LABEL_HALF[p.half];
              },
              // 纯文本形态的一行（自绘渲染器复用同一个 rankTooltipRow 组装 HTML，
              // 文本口径只有那一处；这里返回的字符串就是它的无格式版本）
              label: function (item) {
                const row = rankTooltipRow(item.dataset, item.dataIndex, item.parsed.y, myValues);
                return row.name + '：' + row.value + (row.diff ? '  ' + row.diff.text : '');
              },
              // 口径写在脚注里，免得每行都重复一遍；没有「我的累计」线时不出现。
              // ⚠️ 这句脚注同时**决定浮层的宽度**（行是 max-content 紧凑排的，宽度由最宽的一行
              //    / 这句脚注撑出）—— 写长了会在右侧留一大片空白，所以只留「差值怎么算」，
              //    「同一槽两边都有值时才给出」这条细节交给卡片下方的说明文字。
              footer: function () {
                return myValues ? '差值 = 战果线 − 我的累计' : '';
              }
            }
          }
        },
        scales: {
          x: {
            grid: { display: false },
            // ⚠️ **必须关掉 autoSkip**：横轴是 2×天数的半天槽，而 Chart.js 自动跳步固定
            //    从下标 0 起按步长取（0,2,4…）—— 恰好全落在「前半日」那些空标注上，
            //    结果一个日号都不显示。关掉后每个刻度都画：空标注占位、
            //    日号正落在后半日那个点上（刻度数量与前一样，只是中间多一个空位）。
            ticks: Object.assign(axisTicks(textColor), { autoSkip: false }),
            title: { display: true, text: '日', color: textColor }
          },
          y: {
            beginAtZero: false,
            grid: { color: gridColor },
            ticks: { color: textColor }
          }
        }
      }
    }));
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
      rankPanel(month) +
      historyPanel(history, now);

    buildDailyChart(records, month);
    buildCompareChart(KC.store, range.months);
    buildCompositionChart(comp);
    buildRankChart(month);
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
