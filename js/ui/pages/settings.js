/* ==========================================================================
   ui/pages/settings.js — 设置页
   依据 docs/02_ui.md §4.9、docs/03_data.md Settings。

   覆盖 docs 列出的五类配置：外观、首页显示内容、默认规划方式、数据相关设置、其它偏好。
   另含「游戏服务器」（用于自动生成历史归档的人事表地址）
   与「数据导出提醒」（docs/07_implementation.md §3.1）。
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

  function cardLabel(id) {
    const hit = KC.ui.DASHBOARD_CARDS.filter(function (c) { return c.id === id; })[0];
    return hit ? hit.label : id;
  }

  function hiddenIds() {
    return KC.ui.normalizeCardHidden(KC.store.getSettings());
  }

  /** 三档尺寸按钮（与首页编辑模式下的控件同源，取同一份 CARD_SIZES） */
  function sizeButtons(id, label, current) {
    return '<span class="size-group" role="group" aria-label="' +
      U.escapeHtml(label + '尺寸') + '">' +
      KC.ui.CARD_SIZES.map(function (s) {
        return '<button type="button" class="btn btn-icon btn-xs' +
          (s.key === current ? ' active' : '') + '"' +
          ' data-act="set-card-size" data-id="' + U.escapeHtml(id) + '"' +
          ' data-size="' + s.key + '" title="' + U.escapeHtml('设为' + s.label + '号') + '"' +
          ' aria-pressed="' + (s.key === current ? 'true' : 'false') + '">' +
          U.escapeHtml(s.label) + '</button>';
      }).join('') +
      '</span>';
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
    const settings = KC.store.getSettings();
    const order = KC.ui.normalizeCardOrder(settings);
    const hidden = KC.ui.normalizeCardHidden(settings);
    const sizes = KC.ui.normalizeCardSizes(settings);

    const rows = order.map(function (id, index) {
      const isHidden = hidden.indexOf(id) >= 0;
      const label = cardLabel(id);
      return '<div class="card-order-row' + (isHidden ? ' is-off' : '') + '">' +
        '<label class="check">' +
          '<input type="checkbox" data-act="toggle-card" data-id="' + U.escapeHtml(id) + '"' +
            (isHidden ? '' : ' checked') + '> 显示' +
        '</label>' +
        '<span class="card-order-label">' + U.escapeHtml(label) + '</span>' +
        sizeButtons(id, label, sizes[id]) +
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
      '<p class="panel-desc">首页按下列顺序展示已勾选的卡片，尺寸可选小 / 中 / 大。' +
        '同样的调整也能直接在首页点「编辑布局」拖动完成。' +
        '新增功能时会优先新增卡片，不会打乱这里的选择。</p>' +
      '<div class="card-order-list">' + rows + '</div>' +
      '<div class="panel-foot">' +
        '<button type="button" class="btn btn-ghost btn-sm" data-act="reset-card-layout">' +
          '恢复默认顺序与尺寸</button>' +
      '</div>' +
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

  function serverPanel() {
    const current = KC.store.getSettings().server || '';

    const options = ['<option value="">未设定</option>'].concat(
      KC.schema.SERVERS.map(function (s) {
        return '<option value="' + s.code + '"' + (s.code === current ? ' selected' : '') + '>' +
          U.escapeHtml(s.code + ' · ' + s.name) + '</option>';
      })
    ).join('');

    // 用「最近一个已结束的战果归属月」做示例，与归档表单的默认月份一致
    const sampleMonth = U.addMonths(KC.periods.currentAttributionMonth(new Date()), -1);
    const sample = KC.schema.rankImageUrl(sampleMonth, current);

    return '<div class="panel">' +
      '<div class="panel-head"><h2>游戏服务器</h2>' +
        '<span class="panel-count">用于自动生成「人事表」图片地址</span></div>' +
      '<div class="mode-row">' +
        '<span class="field-label">所在服务器</span>' +
        '<select data-act="set-server" class="inline-select">' + options + '</select>' +
      '</div>' +
      '<p class="form-hint">「历史归档」详情里的「人事表」地址由 <strong>归档月份 + 服务器编号</strong> 自动拼成：' +
        '<code>rank + 年(2位) + 月(2位) + 服务器编号(2位) + .jpg</code>。' +
        (sample
          ? '当前设置下，' + U.escapeHtml(U.monthLabel(sampleMonth)) + ' 对应 <code>' +
            U.escapeHtml(sample) + '</code>。'
          : '') +
        '该图片由游戏官方服务器提供，本工具只在点击链接时才访问网络。</p>' +
      '</div>';
  }

  /**
   * 数据导出提醒（docs/07_implementation.md §3.1 / §3.4）。
   * 提醒周期存在 settings.exportRemindMode；"上次已提醒的周期 id" 存在本机轻量存储，
   * 因此这里既能选周期，也能把当前周期的提醒状态说清楚（必要时可重新开启）。
   */
  function exportRemindPanel() {
    const settings = KC.store.getSettings();
    const R = KC.calc.reminder;
    const mode = R.normalizeMode(settings.exportRemindMode);
    const now = new Date();
    const cycleId = R.remindCycleId(mode, now);
    const notice = KC.ui.export.reminderState(now);

    const hit = R.MODE_OPTIONS.filter(function (o) { return o.value === mode; })[0];
    const status = mode === 'off' ? '提醒已关闭'
      : notice.show ? '待提醒（' + cycleId + '）'
      : '本周期（' + cycleId + '）已处理，不再提醒';
    // 只有"本周期被显式标记过已处理"才给恢复入口；
    // overdueCycles === 0（本周期内刚导出过）不该出现这个按钮。
    const dismissed = !!cycleId && KC.ui.export.remindedCycleId() === cycleId;

    const rows = [
      ['最近导出', settings.lastExportAt ? fmtDateTime(settings.lastExportAt) : '尚未导出过'],
      ['当前周期', cycleId || '—'],
      ['提醒状态', status]
    ];

    return '<div class="panel">' +
      '<div class="panel-head"><h2>数据导出提醒</h2>' +
        '<span class="panel-count">提醒条显示在首页顶部</span></div>' +
      '<p class="panel-desc">数据只保存在本机浏览器里，浏览器清理站点数据就会一并丢失。' +
        '按你选择的周期，首页顶部会提示把数据导出成文件；' +
        '<strong>「本地备份」不算导出</strong>，它和主数据存在同一处，会被一起清掉。</p>' +

      '<div class="mode-row">' +
        '<span class="field-label">提醒周期</span>' +
        segmented('set-export-remind', R.MODE_OPTIONS, mode, 'mode') +
      '</div>' +
      '<p class="form-hint">' + U.escapeHtml((hit && hit.hint) || '') + '</p>' +

      '<div class="table-wrap"><table class="data-table detail-table"><tbody>' +
        rows.map(function (r) {
          return '<tr><td>' + U.escapeHtml(r[0]) + '</td><td>' + U.escapeHtml(r[1]) + '</td></tr>';
        }).join('') +
      '</tbody></table></div>' +

      '<p class="form-hint">在首页点过「本周期不再提醒」后，本周期内不会再出现；' +
        '该记录只存在本机，换浏览器或清站点数据后自然失效。</p>' +
      (dismissed
        ? '<div class="panel-foot">' +
            '<button type="button" class="btn btn-ghost btn-sm" data-act="reset-export-remind">' +
              '恢复本周期提醒</button>' +
          '</div>'
        : '') +
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
        '图表由本地引入的 Chart.js 渲染，程序自身不访问任何外部网络；' +
        '只有你主动点击「历史归档」里的人事表链接时，浏览器才会去游戏官方服务器取图。</p>' +
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
      serverPanel() +
      exportRemindPanel() +
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

  async function setServer(code) {
    try { await KC.store.saveSettings({ server: code || null }); }
    catch (err) { KC.toast('保存失败：' + err.message, 'error'); }
  }

  /** 提醒周期：只影响首页提醒条是否出现，不改变任何业务数据 */
  async function setExportRemindMode(mode) {
    try {
      await KC.store.saveSettings({
        exportRemindMode: KC.calc.reminder.normalizeMode(mode)
      });
    } catch (err) { KC.toast('保存失败：' + err.message, 'error'); }
  }

  /** 清掉本机层里"本周期已提醒"的记录，让首页重新显示提醒条 */
  function resetExportRemind() {
    if (KC.ui.export.clearReminded()) KC.toast('本周期提醒已恢复');
    else KC.toast('本机临时层不可用，无法恢复', 'error');
    render();
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
    const order = KC.ui.normalizeCardOrder(KC.store.getSettings());
    const i = order.indexOf(id);
    const j = dir === 'up' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= order.length) return;
    const tmp = order[i];
    order[i] = order[j];
    order[j] = tmp;
    try { await KC.store.saveSettings({ dashboardOrder: order }); }
    catch (err) { KC.toast('保存失败：' + err.message, 'error'); }
  }

  /** 与首页编辑模式共用同一份尺寸字段，两处改的是一致的配置 */
  async function setCardSize(id, sizeKey) {
    if (!KC.ui.isKnownCard(id)) return;
    if (KC.ui.CARD_SIZES.map(function (s) { return s.key; }).indexOf(sizeKey) < 0) return;
    const sizes = KC.ui.normalizeCardSizes(KC.store.getSettings());
    sizes[id] = sizeKey;
    try { await KC.store.saveSettings({ dashboardSizes: sizes }); }
    catch (err) { KC.toast('保存失败：' + err.message, 'error'); }
  }

  async function resetCardLayout() {
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
      KC.toast('已恢复默认顺序与尺寸');
    } catch (err) {
      KC.toast('恢复失败：' + err.message, 'error');
    }
  }

  function handleClick(e) {
    const btn = KC.dom.closestFrom(e.target, '[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;

    if (act === 'set-theme') setTheme(btn.dataset.theme);
    else if (act === 'set-mode') setPlanningMode(btn.dataset.mode);
    else if (act === 'set-export-remind') setExportRemindMode(btn.dataset.mode);
    else if (act === 'reset-export-remind') resetExportRemind();
    else if (act === 'move-card') moveCard(btn.dataset.id, btn.dataset.dir);
    else if (act === 'set-card-size') setCardSize(btn.dataset.id, btn.dataset.size);
    else if (act === 'reset-card-layout') resetCardLayout();
    else if (act === 'goto-data') KC.router.navigate('data');
  }

  function handleChange(e) {
    const el = e.target;
    if (!el || !el.dataset) return;
    const act = el.dataset.act;
    if (act === 'toggle-card') toggleCard(el.dataset.id, el.checked);
    else if (act === 'set-prediction') setPrediction(el.value);
    else if (act === 'set-server') setServer(el.value);
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
