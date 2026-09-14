/* ==========================================================================
   ui/pages/settings.js — 设置页
   依据 docs/02_ui.md §4.8、docs/03_data.md Settings。

   覆盖 docs 列出的五类配置：外观、首页显示内容、默认规划方式、数据相关设置、其它偏好。
   设置只影响展示与默认值，**不影响任何历史数据**。
   ========================================================================== */
(function (KC) {
  'use strict';

  const U = KC.utils;

  KC.pages = KC.pages || {};

  const PREDICTION_OPTIONS = [
    { value: 'recent:3',  label: '最近 3 天平均' },
    { value: 'recent:7',  label: '最近 7 天平均' },
    { value: 'recent:14', label: '最近 14 天平均' },
    { value: 'recent:30', label: '最近 30 天平均' },
    { value: 'period',    label: '当前周期平均' }
  ];

  const THEME_OPTIONS = [
    { value: 'light', label: '浅色' },
    { value: 'dark',  label: '深色' }
  ];

  const pageState = { container: null };

  let unsubscribe = null;
  let handlers = null;

  /* ------------------------------------------------------------ 小工具 */

  function knownCardIds() {
    return KC.ui.DASHBOARD_CARDS.map(function (c) { return c.id; });
  }

  function cardLabel(id) {
    const hit = KC.ui.DASHBOARD_CARDS.filter(function (c) { return c.id === id; })[0];
    return hit ? hit.label : id;
  }

  /** 顺序表自愈：过滤未知 id、补齐缺失的已知 id */
  function normalizedOrder() {
    const known = knownCardIds();
    const stored = (KC.store.getSettings().dashboardOrder || []).filter(function (id) {
      return known.indexOf(id) >= 0;
    });
    known.forEach(function (id) { if (stored.indexOf(id) < 0) stored.push(id); });
    return stored;
  }

  function hiddenIds() {
    const known = knownCardIds();
    return (KC.store.getSettings().dashboardHidden || []).filter(function (id) {
      return known.indexOf(id) >= 0;
    });
  }

  function fmtDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return U.toDateKey(d) + ' ' + U.pad2(d.getHours()) + ':' + U.pad2(d.getMinutes());
  }

  function segmented(act, options, current, dataKey) {
    return '<div class="segmented" role="group">' + options.map(function (o) {
      return '<button type="button" data-act="' + act + '" data-' + dataKey + '="' + o.value + '"' +
        (o.value === current ? ' class="active"' : '') + '>' + U.escapeHtml(o.label) + '</button>';
    }).join('') + '</div>';
  }

  /* -------------------------------------------------------------- 渲染 */

  function appearancePanel() {
    const settings = KC.store.getSettings();
    return '<div class="panel">' +
      '<div class="panel-head"><h2>外观</h2>' +
        '<span class="panel-count">仅影响显示，不影响数据</span></div>' +
      '<div class="mode-row">' +
        '<span class="field-label">主题</span>' +
        segmented('set-theme', THEME_OPTIONS, KC.theme.normalize(settings.theme), 'theme') +
      '</div>' +
      '<p class="form-hint">深色主题与浅色主题共用同一套样式，仅覆盖配色变量；图表颜色也会随之切换。</p>' +
      '</div>';
  }

  function dashboardPanel() {
    const order = normalizedOrder();
    const hidden = hiddenIds();

    const rows = order.map(function (id, index) {
      const isHidden = hidden.indexOf(id) >= 0;
      return '<div class="card-order-row' + (isHidden ? ' is-off' : '') + '">' +
        '<label class="check">' +
          '<input type="checkbox" data-act="toggle-card" data-id="' + U.escapeHtml(id) + '"' +
            (isHidden ? '' : ' checked') + '> 显示' +
        '</label>' +
        '<span class="card-order-label">' + U.escapeHtml(cardLabel(id)) + '</span>' +
        '<span class="card-order-actions">' +
          '<button type="button" class="btn btn-icon btn-xs" data-act="move-card" data-id="' +
            U.escapeHtml(id) + '" data-dir="up"' + (index === 0 ? ' disabled' : '') +
            ' title="上移" aria-label="上移">↑</button>' +
          '<button type="button" class="btn btn-icon btn-xs" data-act="move-card" data-id="' +
            U.escapeHtml(id) + '" data-dir="down"' + (index === order.length - 1 ? ' disabled' : '') +
            ' title="下移" aria-label="下移">↓</button>' +
        '</span>' +
        '</div>';
    }).join('');

    const visibleCount = order.length - hidden.length;

    return '<div class="panel">' +
      '<div class="panel-head"><h2>首页显示内容</h2>' +
        '<span class="panel-count">显示 ' + visibleCount + ' / ' + order.length + ' 张卡片</span></div>' +
      '<p class="panel-desc">首页按下列顺序展示已勾选的卡片。新增功能时会优先新增卡片，不会打乱这里的选择。</p>' +
      '<div class="card-order-list">' + rows + '</div>' +
      '</div>';
  }

  function planningPanel() {
    const settings = KC.store.getSettings();
    const predValue = settings.predictionMode === 'period'
      ? 'period' : 'recent:' + (settings.predictionDays || 7);

    return '<div class="panel">' +
      '<div class="panel-head"><h2>默认规划方式</h2>' +
        '<span class="panel-count">影响首页与战果规划页的默认展示</span></div>' +

      '<div class="mode-row">' +
        '<span class="field-label">展示口径</span>' +
        segmented('set-mode', [
          { value: 'actual', label: '实际统计口径' },
          { value: 'combined', label: '综合进度口径' }
        ], settings.planningMode === 'combined' ? 'combined' : 'actual', 'mode') +
      '</div>' +
      '<p class="form-hint">实际统计口径只计已获得的战果；综合进度口径会把规划池中计划完成的任务一并计入。' +
        '该选择仅影响显示，不会写入任何业务数据。</p>' +

      '<div class="mode-row">' +
        '<span class="field-label">默认预测方式</span>' +
        '<select data-act="set-prediction" class="inline-select">' +
          PREDICTION_OPTIONS.map(function (o) {
            return '<option value="' + o.value + '"' +
              (o.value === predValue ? ' selected' : '') + '>' + U.escapeHtml(o.label) + '</option>';
          }).join('') +
        '</select>' +
      '</div>' +
      '<p class="form-hint">用于计算「预计月底战果」。最近 N 天平均按日历日统计，窗口内没有记录的日期按 0 计。</p>' +
      '</div>';
  }

  function dataPanel() {
    const st = KC.store.state;
    const settings = KC.store.getSettings();

    const rows = [
      ['数据结构版本', 'v' + ((st.config && st.config.schemaVersion) || KC.schema.SCHEMA_VERSION)],
      ['存储方式', 'IndexedDB · kc-senka-planner（本机浏览器）'],
      ['每日记录', st.dailyRecords.length + ' 条'],
      ['任务模板 / 任务记录', st.taskTemplates.length + ' 个 / ' + st.taskRecords.length + ' 条'],
      ['月度上下文 / 归档', st.monthlyContexts.length + ' 个 / ' + st.archives.length + ' 个'],
      ['最近导出', settings.lastExportAt ? fmtDateTime(settings.lastExportAt) : '尚未导出过']
    ];

    return '<div class="panel">' +
      '<div class="panel-head"><h2>数据相关设置</h2>' +
        '<span class="panel-count">导入导出与备份请到「数据管理」</span></div>' +
      '<div class="table-wrap"><table class="data-table detail-table"><tbody>' +
        rows.map(function (r) {
          return '<tr><td>' + U.escapeHtml(r[0]) + '</td><td>' + U.escapeHtml(r[1]) + '</td></tr>';
        }).join('') +
      '</tbody></table></div>' +
      '<div class="panel-foot">' +
        '<button type="button" class="btn btn-primary" data-act="goto-data">前往「数据管理」</button>' +
      '</div>' +
      '</div>';
  }

  function aboutPanel() {
    return '<div class="panel">' +
      '<div class="panel-head"><h2>关于</h2></div>' +
      '<p class="panel-desc">Kancolle Senka Planner —— 完全本地运行的《艦隊これくしょん》战果记录、规划与统计工具。' +
        '无需服务器、无需数据库，双击 <code>index.html</code> 即可离线使用。</p>' +
      '<p class="form-hint">数据默认保存在本机浏览器中。浏览器清理站点数据会一并清除，请定期在「数据管理」中导出 JSON 备份。' +
        '图表由本地引入的 Chart.js 渲染，不访问任何外部网络。</p>' +
      '</div>';
  }

  function render() {
    const host = pageState.container;
    if (!host) return;

    host.innerHTML =
      '<div class="page-head">' +
        '<div>' +
          '<h1>设置</h1>' +
          '<p class="page-sub">程序配置。所有设置只影响展示与默认值，不影响任何历史数据。</p>' +
        '</div>' +
      '</div>' +
      appearancePanel() +
      dashboardPanel() +
      planningPanel() +
      dataPanel() +
      aboutPanel();
  }

  /* -------------------------------------------------------------- 交互 */

  async function setTheme(theme) {
    try { await KC.store.saveSettings({ theme: KC.theme.normalize(theme) }); }
    catch (err) { KC.toast('切换主题失败：' + err.message, 'error'); }
  }

  async function setPlanningMode(mode) {
    try { await KC.store.saveSettings({ planningMode: mode === 'combined' ? 'combined' : 'actual' }); }
    catch (err) { KC.toast('保存失败：' + err.message, 'error'); }
  }

  async function setPrediction(value) {
    const mode = value === 'period' ? 'period' : 'recent';
    const days = value === 'period' ? 7 : (Number(String(value).split(':')[1]) || 7);
    try { await KC.store.saveSettings({ predictionMode: mode, predictionDays: days }); }
    catch (err) { KC.toast('保存失败：' + err.message, 'error'); }
  }

  async function toggleCard(id, checked) {
    const hidden = hiddenIds();
    const idx = hidden.indexOf(id);
    if (checked && idx >= 0) hidden.splice(idx, 1);
    if (!checked && idx < 0) hidden.push(id);
    try { await KC.store.saveSettings({ dashboardHidden: hidden }); }
    catch (err) { KC.toast('保存失败：' + err.message, 'error'); }
  }

  async function moveCard(id, dir) {
    const order = normalizedOrder();
    const i = order.indexOf(id);
    const j = dir === 'up' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= order.length) return;
    const tmp = order[i];
    order[i] = order[j];
    order[j] = tmp;
    try { await KC.store.saveSettings({ dashboardOrder: order }); }
    catch (err) { KC.toast('保存失败：' + err.message, 'error'); }
  }

  function handleClick(e) {
    const btn = KC.dom.closestFrom(e.target, '[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;

    if (act === 'set-theme') setTheme(btn.dataset.theme);
    else if (act === 'set-mode') setPlanningMode(btn.dataset.mode);
    else if (act === 'move-card') moveCard(btn.dataset.id, btn.dataset.dir);
    else if (act === 'goto-data') KC.router.navigate('data');
  }

  function handleChange(e) {
    const el = e.target;
    if (!el || !el.dataset) return;
    const act = el.dataset.act;
    if (act === 'toggle-card') toggleCard(el.dataset.id, el.checked);
    else if (act === 'set-prediction') setPrediction(el.value);
  }

  /* -------------------------------------------------------------- 生命周期 */

  KC.pages.settings = {
    mount: function (container) {
      pageState.container = container;

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
      pageState.container = null;
    }
  };
})(window.KC = window.KC || {});
