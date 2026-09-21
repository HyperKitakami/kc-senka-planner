/* ==========================================================================
   ui/pages/dashboard.js — 首页 Dashboard
   依据 docs/02_ui.md §4.1 / §五 / §六、docs/04_calculation.md §十三。

   定位：总览页，快速了解当前状态，不承担复杂编辑功能。
     · 卡片（Widget）布局，每张卡片展示一种信息
     · 概览级图表：目标进度（三段进度条）+ 最近增长趋势（迷你折线）
     · 顶部常驻「定期导出提醒」条（docs/07_implementation.md §3.4）：
       数据只在本机浏览器里，提醒条在未处理前持续显示，而不是"弹一次就消失"
     · 仅提供少量快捷操作，复杂编辑跳转到对应页面
   所有数字均运行时计算，不写入数据库。

   布局（docs/02_ui.md §五「显示或隐藏卡片、调整卡片顺序、卡片大小」）：
     · 顺序与尺寸来自 Settings.dashboardOrder / dashboardSizes，运行时自愈；
     · 首页**必须进入「编辑布局」模式**才能拖动排序或改尺寸，平时卡片是纯展示的，
       避免误触与拖拽与卡片内点击的冲突；
     · 统计卡与面板卡处在同一个网格里（单网格 + 列跨度），因此面板卡也能排序与缩放；
       窄屏下列数不足时，跨度自动夹取到 1 列，不会溢出错行。

   编辑模式属于临时 UI 状态（pageState），不写入数据库；unmount 时自然丢弃。
   ========================================================================== */
(function (KC) {
  'use strict';

  const U = KC.utils;

  KC.pages = KC.pages || {};

  const TREND_DAYS = 14;
  const SUMMARY_DAYS = 7;
  const RECENT_LIST = 5;

  const pageState = { container: null, editing: false, dragId: null };

  let unsubscribe = null;
  let handlers = null;

  function fmtDateTime(d) {
    return U.toDateKey(d) + ' ' + U.pad2(d.getHours()) + ':' + U.pad2(d.getMinutes());
  }

  function currentSettings() { return KC.store.getSettings(); }

  /* -------------------------------------------------------------- 布局 */

  function dashEl() { return KC.dom.qs('#dash-cards', pageState.container); }

  /** 已渲染卡片：id -> 元素 */
  function cardElements() {
    const cards = {};
    KC.dom.qsa('[data-card-id]', pageState.container).forEach(function (el) {
      cards[el.dataset.cardId] = el;
    });
    return cards;
  }

  /**
   * 测量并写入网格列数（--dash-cols）。
   * 列数必须由 JS 决定：CSS 的 auto-fit 无法表达「跨 N 列」，窄屏会溢出错行。
   */
  function measureCols() {
    const host = pageState.container;
    const grid = dashEl();
    const cols = KC.ui.gridColCount(grid ? grid.clientWidth : host.clientWidth);
    if (grid) grid.style.setProperty('--dash-cols', String(cols));
    return cols;
  }

  /**
   * 把当前尺寸配置落到卡片上（跨度 + 是否占满整行）。
   * 所有布局路径都走这里：首次渲染、改尺寸、窗口缩放，保证三者一致。
   */
  function applyCardLayout(sizes) {
    if (!pageState.container || !dashEl()) return;
    const cols = measureCols();
    const cards = cardElements();
    Object.keys(cards).forEach(function (id) {
      const el = cards[id];
      const span = KC.ui.cardSpan(sizes[id], cols);
      el.style.gridColumn = 'span ' + span;
      el.classList.toggle('is-full', span === cols && cols > 1);
    });
  }

  /**
   * 按最新的顺序 / 尺寸重排已有 DOM，不重建内容（避免重绘闪烁与丢焦点）。
   * 目前只有设置页改顺序会走到这里；首页拖拽直接用 DOM 顺序。
   */
  function applyLayout(sizes) {
    const grid = dashEl();
    if (!grid) return;
    const cards = cardElements();

    KC.ui.normalizeCardOrder(currentSettings()).forEach(function (id) {
      if (cards[id]) grid.appendChild(cards[id]);   // appendChild 移动节点 = 按新顺序重排
    });
    applyCardLayout(sizes);
  }

  /* -------------------------------------------------------------- 卡片 */

  function sizeControl(id, sizeKey, label) {
    if (!pageState.editing) return '';
    const buttons = KC.ui.CARD_SIZES.map(function (s) {
      return '<button type="button" class="btn btn-icon btn-xs' +
        (s.key === sizeKey ? ' active' : '') + '" data-act="set-card-size" data-id="' +
        U.escapeHtml(id) + '" data-size="' + s.key + '" title="' +
        U.escapeHtml('设为' + s.label + '号') + '" aria-label="' +
        U.escapeHtml(label + '设为' + s.label + '号') +
        '" aria-pressed="' + (s.key === sizeKey ? 'true' : 'false') + '">' +
        U.escapeHtml(s.label) + '</button>';
    }).join('');
    return '<span class="card-tools">' +
      '<span class="card-drag" title="按住拖动排序" aria-hidden="true">⠿</span>' +
      '<span class="card-sizes" role="group" aria-label="' + U.escapeHtml(label + '尺寸') + '">' +
        buttons +
      '</span>' +
      '</span>';
  }

  /**
   * 卡片外壳的开始标签：带排序 / 尺寸所需的数据属性与编辑态控件。
   * kind 用来区分统计卡与面板卡，方便样式与调试；data-card-id 是拖拽落库的依据。
   */
  function cardOpen(id, label, kind, info) {
    const sizeKey = info.sizes[id] || KC.ui.DEFAULT_CARD_SIZE;
    return '<div class="dash-card is-' + kind + (pageState.editing ? ' is-editing' : '') + '"' +
      ' data-card-id="' + U.escapeHtml(id) + '"' +
      (pageState.editing ? ' draggable="true"' : '') + '>' +
      sizeControl(id, sizeKey, label);
  }

  /**
   * 网格型卡片（stat-card）注册表：id -> HTML。
   * 面板型卡片由 buildPanelRenderers 提供。
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

  /* -------------------------------------------------------- 图表 */

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

  /** 面板型卡片渲染器：id -> 渲染函数 */
  function buildPanelRenderers(cal, recent14, recent7) {
    return {
      calendar: function () { return calendarPanel(cal); },
      trend: function () { return trendPanel(recent14); },
      recentSummary: function () { return summaryPanel(recent7); }
    };
  }

  /**
   * 按设置中的顺序渲染全部首页卡片。
   *
   * 统计卡与面板卡都长成同一个网格项（.card-grid 的直接子元素），
   * 因此用户可以把面板卡拖到任意位置、也能让统计卡和面板卡并排换行。
   * 实际列跨度由 applyCardLayout 在插入 DOM 后写入，渲染阶段只负责内容与数据属性。
   */
  function cardsBlock(plan, ctx, cal, recent14, recent7, info) {
    const grid = gridCards(plan, ctx);
    const panels = buildPanelRenderers(cal, recent14, recent7);
    const settings = currentSettings();

    const items = KC.ui.visibleDashboardCards(settings).map(function (id) {
      const card = KC.ui.DASHBOARD_CARDS.filter(function (c) { return c.id === id; })[0];
      const label = card ? card.label : id;
      const kind = card ? card.kind : 'stat';
      const body = kind === 'panel' ? panels[id]() : grid[id];
      if (!body) return '';
      return cardOpen(id, label, kind, info) +
        '<div class="card-body">' + body + '</div>' +
        '</div>';
    }).filter(Boolean);

    return '<div id="dash-toolbar">' + toolbarHtml() + '</div>' +
      (items.length
        ? '<div class="card-grid" id="dash-cards">' + items.join('') + '</div>'
        : '<div class="panel"><div class="empty-inline">' +
          '首页卡片已全部隐藏，可在「设置」中重新开启。</div></div>');
  }

  /* ---------------------------------------------------------- 编辑模式 */

  /**
   * 编辑模式工具条的 HTML。
   * 只有进入编辑模式后卡片才可拖动与改尺寸，平时首页保持纯展示，避免误触。
   */
  function toolbarHtml() {
    if (!pageState.editing) {
      return '<div class="dash-bar">' +
        '<button type="button" class="btn btn-ghost btn-sm" data-act="dash-edit">编辑布局</button>' +
        '</div>';
    }
    const cols = (dashEl() && measureCols()) || 0;
    return '<div class="dash-bar is-editing">' +
      '<span class="dash-edit-hint">拖动卡片调整顺序；用卡片右上角的' +
        '<strong>小 / 中 / 大</strong>改尺寸' +
        (cols > 1 ? '（当前 ' + cols + ' 列，大号占满整行）' : '') + '。</span>' +
      '<span class="dash-edit-actions">' +
        '<button type="button" class="btn btn-ghost btn-sm" data-act="dash-reset">恢复默认布局</button>' +
        '<button type="button" class="btn btn-primary btn-sm" data-act="dash-done">完成</button>' +
      '</span>' +
      '</div>';
  }

  /** 重建工具条（切换编辑模式时调用；列数等文案随重新渲染刷新） */
  function buildToolbar() {
    const host = pageState.container;
    const bar = KC.dom.qs('#dash-toolbar', host);
    if (bar) bar.innerHTML = toolbarHtml();
  }

  /**
   * 改尺寸：写库 + 立即刷新跨度。
   * 不重绘，所以顺手把该卡片的按钮选中态也更新掉（用户可能连点几档）。
   */
  async function setCardSize(id, sizeKey) {
    if (!pageState.editing) return;
    const next = KC.ui.normalizeCardSizes(currentSettings());
    next[id] = sizeKey;
    try {
      await KC.store.saveSettings({ dashboardSizes: next });
    } catch (err) {
      KC.toast('保存尺寸失败：' + err.message, 'error');
      return;
    }
    // 拖拽与改尺寸都不整页重建：重建会清空 DOM、打断交互，图表也会闪。
    applyCardLayout(next);
    syncSizeButtons(id, sizeKey);
  }

  /** 把某张卡片的尺寸按钮选中态对齐到当前值 */
  function syncSizeButtons(id, sizeKey) {
    KC.dom.qsa('[data-act="set-card-size"][data-id="' + id + '"]', pageState.container)
      .forEach(function (btn) {
        const on = btn.dataset.size === sizeKey;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
  }

  async function resetLayout() {
    const ok = await KC.confirmDialog({
      title: '恢复默认布局',
      message: '将首页卡片的顺序与尺寸恢复为默认，卡片本身的显示 / 隐藏状态保留。确定继续吗？',
      okText: '恢复'
    });
    if (!ok) return;
    try {
      await KC.store.saveSettings({
        dashboardOrder: KC.ui.DASHBOARD_CARDS.map(function (c) { return c.id; }),
        dashboardSizes: {}
      });
      KC.toast('已恢复默认布局');
    } catch (err) {
      KC.toast('恢复失败：' + err.message, 'error');
    }
  }

  /* ---------------------------------------------------------- 拖拽排序 */

  /**
   * 指针落在哪个插入位（0 ～ 除拖动卡外的卡片数）。
   * 按行优先数「几何上排在指针前面的卡片数」：
   *   · 中心明显在上方 → 前面的（+1）
   *   · 同一行且中心在指针左边 → 前面的（+1）
   *   · 其余（同行的右侧、下方的行）→ 不在前面，停止
   * 关键点：只参考**其它卡片**的位置，拖动中的卡片自身位置变化不影响结果，
   * 否则边拖边算会自相矛盾（卡片会被反复送回顶部）。
   */
  function dragInsertionIndex(grid, x, y) {
    const items = KC.dom.qsa('[data-card-id]', grid).filter(function (el) {
      return el.dataset.dragSource !== '1';
    }).map(function (el) {
      const box = el.getBoundingClientRect();
      return { el: el, top: box.top, height: box.height, centerX: box.left + box.width / 2 };
    }).sort(function (a, b) { return a.top - b.top; });

    if (!items.length) return 0;

    let index = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      // 行的判定阈值取卡片高度的一半：卡片高度已知，比固定像素更可靠
      const rowTolerance = Math.max(12, it.height / 2);
      if (y > it.top + rowTolerance) { index = i + 1; continue; }
      if (y >= it.top - rowTolerance && x > it.centerX) { index = i + 1; continue; }
      break;
    }
    return index;
  }

  /** 把拖动卡移到目标插入位 */
  function applyDragOrder(grid, dragged, index) {
    const others = KC.dom.qsa('[data-card-id]', grid).filter(function (el) { return el !== dragged; });
    const clamped = Math.max(0, Math.min(index, others.length));
    if (clamped >= others.length) grid.appendChild(dragged);
    else grid.insertBefore(dragged, others[clamped]);
  }

  /**
   * 进入拖动：给拖动卡打标记（后续据此把它排除在插入位计算外），
   * 并让拖动影像与卡片当前的实际宽度一致——默认影像是拖动瞬间的快照，
   * 尺寸大改过之后会看到一块宽窄不对的虚影。
   */
  function onDragStart(e) {
    if (!pageState.editing) return;
    const card = KC.dom.closestFrom(e.target, '[data-card-id]');
    if (!card) return;

    // 上一次拖动若异常中断（dragend 没来），标记可能还留在卡片上，
    // 会让这张卡在插入位计算里被误判成"拖动卡"。这里先兜底清一遍。
    if (pageState.dragId) clearDragMarks(pageState.container);

    pageState.dragId = card.dataset.cardId;
    card.dataset.dragSource = '1';
    card.classList.add('is-dragging');
    clearDropHint();

    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', pageState.dragId); } catch (err) { /* 兼容旧浏览器 */ }
      const box = card.getBoundingClientRect();
      if (box.width > 0 && typeof document.createElement === 'function') {
        const ghost = document.createElement('div');
        ghost.className = 'drag-ghost';
        ghost.style.width = Math.round(box.width) + 'px';
        ghost.textContent = card.dataset.cardId || '';
        document.body.appendChild(ghost);
        try { e.dataTransfer.setDragImage(ghost, 20, 18); } catch (err) { /* 忽略 */ }
        setTimeout(function () { ghost.remove(); }, 0);
      }
    }
  }

  function clearDropHint() {
    KC.dom.qsa('.is-drop-target', pageState.container).forEach(function (el) {
      el.classList.remove('is-drop-target');
    });
  }

  function onDragOver(e) {
    if (!pageState.editing || !pageState.dragId) return;
    const grid = dashEl();
    if (!grid || !grid.contains(e.target)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';

    const dragged = grid.querySelector('[data-card-id="' + pageState.dragId + '"]');
    if (!dragged) return;

    const index = dragInsertionIndex(grid, e.clientX, e.clientY);
    applyDragOrder(grid, dragged, index);

    // 虚线提示：高亮「松手后会被顶开的那张卡」，末尾则续在拖动卡自己身上
    clearDropHint();
    const others = KC.dom.qsa('[data-card-id]', grid).filter(function (el) { return el !== dragged; });
    const clamped = Math.max(0, Math.min(index, others.length));
    const hintOn = clamped < others.length ? others[clamped] : dragged;
    if (hintOn) hintOn.classList.add('is-drop-target');
  }

  function onDrop(e) {
    if (!pageState.editing || !pageState.dragId) return;
    e.preventDefault();
  }

  /**
   * 拖动结束：先做**同步**清理（摘标记、清虚线），再异步落库。
   * 顺序很重要——清理若排在 await 之后，一旦落库抛错，标记就会留在卡片上，
   * 下次拖动时这张卡会被误判为"正在拖动"而错开落点。
   */
  async function onDragEnd() {
    const id = pageState.dragId;
    pageState.dragId = null;

    // 无论 dragId 是否在，都先清干净：拖出窗口等异常情况下留下的
    // is-dragging / is-drop-target 会让卡片一直保持压暗或虚线的假状态。
    clearDragMarks(pageState.container);
    clearDropHint();
    if (!id) return;

    const grid = dashEl();
    if (!grid) return;

    const order = KC.dom.qsa('[data-card-id]', grid).map(function (el) {
      return el.dataset.cardId;
    });
    const current = KC.ui.normalizeCardOrder(currentSettings());
    let changed = false;
    for (let i = 0; i < order.length; i++) {
      if (order[i] !== current[i]) { changed = true; break; }
    }
    if (!changed) return;

    try {
      // 持久化后不重建：DOM 里的顺序已经是用户要的，重建反而会闪一下。
      await KC.store.saveSettings({ dashboardOrder: order });
      applyLayout(KC.ui.normalizeCardSizes(currentSettings()));
    } catch (err) {
      KC.toast('保存顺序失败：' + err.message, 'error');
    }
  }

  /** 清掉拖动相关的全部临时标记 */
  function clearDragMarks(host) {
    KC.dom.qsa('.is-dragging', host).forEach(function (el) {
      el.classList.remove('is-dragging');
    });
    KC.dom.qsa('[data-card-id]', host).forEach(function (el) {
      delete el.dataset.dragSource;
    });
  }

  function onWinResize() {
    if (!pageState.container || !dashEl()) return;
    applyCardLayout(KC.ui.normalizeCardSizes(currentSettings()));
  }

  /**
   * 切到编辑模式：卡片变可拖动，并出现拖拽柄与尺寸控件。
   * 尺寸控件是卡片 HTML 的一部分（见 sizeControl），所以这里必须重绘一次；
   * 拖拽过程本身不会重绘（那会清空 DOM 并打断拖动），落库也只在 dragend 发生。
   */
  function enterEdit() {
    pageState.editing = true;
    render();                       // render 末尾会刷新工具条
    KC.toast('已进入编辑布局：拖动卡片排序，右上角改尺寸');
  }

  /**
   * 退出编辑模式：只摘掉编辑态，不重绘——尺寸控件由 CSS（.card-tools）隐藏，
   * 没必要为了隐藏几个按钮重建整页图表。
   */
  function exitEdit() {
    pageState.editing = false;
    pageState.dragId = null;
    const host = pageState.container;
    host.classList.remove('is-dash-editing');
    KC.dom.qsa('[data-card-id]', host).forEach(function (el) {
      el.classList.remove('is-editing', 'is-dragging');
      el.removeAttribute('draggable');
    });
    buildToolbar();
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

    const settings = currentSettings();
    const sizes = KC.ui.normalizeCardSizes(settings);
    const info = { sizes: sizes, cols: 0, editing: pageState.editing, span: 0 };

    host.classList.toggle('is-dash-editing', pageState.editing);

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

      // 导出提醒条（docs/07_implementation.md §3.4）：**只在首页判断**，
      // 不放在 main.js 的 boot 阶段 —— saveSettings() 会广播 change，
      // 若在 router.start 之前调用会打到未挂载的页面上。
      KC.ui.exportNotice(KC.ui.export.reminderState(now)) +

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

      cardsBlock(plan, ctx, calendar, recent14, recent7, info);

    applyCardLayout(sizes);
    // 工具条文案含列数，且卡片列数就绪后才知道要提示几列，所以放在最后刷新
    buildToolbar();
  }

  /* -------------------------------------------------------- 导出提醒条 */

  /**
   * 「立即导出」：导出成功后记下本周期，提醒自然消失。
   * 只导出、不写别的业务数据；导出失败（exportData 返回 null）时保持原样。
   */
  async function exportNow() {
    const state = KC.ui.export.reminderState(new Date());
    const name = await KC.ui.export.exportData();
    if (!name) return;
    if (state.cycleId) KC.ui.export.markReminded(state.cycleId);
    render();
  }

  /**
   * 「本周期不再提醒」：只写本机轻量存储，不碰任何业务数据。
   * 本机层不可用时（隐私模式 / 配额满）明确告知"不会被保留"，避免用户误以为已经关掉了。
   */
  function dismissExportNotice() {
    const state = KC.ui.export.reminderState(new Date());
    if (!state.cycleId) return;
    if (KC.ui.export.markReminded(state.cycleId)) {
      KC.toast('本周期不再提醒导出');
    } else {
      KC.toast('本机临时层不可用，本次选择不会被保留', 'error');
    }
    render();
  }

  /* -------------------------------------------------------------- 交互 */

  function handleClick(e) {
    const btn = KC.dom.closestFrom(e.target, '[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;

    // 编辑模式下的控件优先；其余快捷操作在两种模式下都可用
    if (act === 'dash-edit') { enterEdit(); return; }
    if (act === 'dash-done') { exitEdit(); return; }
    if (act === 'dash-reset') { resetLayout(); return; }
    if (act === 'set-card-size') { setCardSize(btn.dataset.id, btn.dataset.size); return; }

    if (act === 'export-now') { exportNow(); return; }
    if (act === 'export-dismiss') { dismissExportNotice(); return; }
    if (act === 'export-settings') { KC.router.navigate('settings'); return; }

    if (act === 'goto-records') KC.router.navigate('records');
    else if (act === 'goto-planning') KC.router.navigate('planning');
    else if (act === 'goto-tasks') KC.router.navigate('tasks');
  }

  /* -------------------------------------------------------------- 生命周期 */

  KC.pages.dashboard = {
    mount: function (container) {
      pageState.container = container;
      pageState.editing = false;
      pageState.dragId = null;

      handlers = {
        click: handleClick,
        dragstart: onDragStart,
        dragover: onDragOver,
        drop: onDrop,
        dragend: onDragEnd
      };
      Object.keys(handlers).forEach(function (type) {
        container.addEventListener(type, handlers[type]);
      });
      window.addEventListener('resize', onWinResize);

      unsubscribe = KC.store.subscribe(function (type) {
        if (type === 'change') render();
      });
      render();
    },
    unmount: function () {
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
      window.removeEventListener('resize', onWinResize);
      if (handlers && pageState.container) {
        Object.keys(handlers).forEach(function (type) {
          pageState.container.removeEventListener(type, handlers[type]);
        });
        pageState.container.classList.remove('is-dash-editing');
      }
      handlers = null;
      pageState.container = null;
      pageState.editing = false;
      pageState.dragId = null;
    }
  };
})(window.KC = window.KC || {});
