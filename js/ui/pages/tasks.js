/* ==========================================================================
   ui/pages/tasks.js — 战果任务页
   依据 docs/02_ui.md §4.4、docs/01_requirements.md §三、docs/04_calculation.md §六 / §七。

   职责：
     · 管理所有战果来源任务（EO / EX / 活动 / 用户自定义）
     · 每项展示：名称、当前状态、战果值、当前周期、是否参与规划
     · 快速完成 / 取消完成
     · 新增、编辑、删除用户任务；启用 / 停用
     · 规划池：单项选择、分类全选、分类取消全选、全部清空

   结构：页面外壳只构建一次，之后分别刷新「汇总 / 表单 / 列表」三块，
   避免勾选任务时把正在填写的表单冲掉。
   ========================================================================== */
(function (KC) {
  'use strict';

  const U = KC.utils;

  KC.pages = KC.pages || {};

  const RESET_CYCLE_LABEL = {
    NONE: '不重置',
    DAILY: '每日',
    WEEKLY: '每周',
    MONTHLY: '每月',
    QUARTERLY: '每季度',
    YEARLY: '每年',
    EVENT: '活动周期'
  };

  const GROUP_OPTION_LABEL = {
    EO: 'EO（Extra Operation）',
    EX: 'EX（任务战果）',
    EVENT: '活动任务',
    USER: '用户自定义'
  };

  const pageState = {
    container: null,
    formOpen: false,
    editingId: null
  };

  let unsubscribe = null;
  let handlers = null;

  /* ------------------------------------------------------------ 小工具 */

  function fmtDateTime(d) {
    return U.toDateKey(d) + ' ' + U.pad2(d.getHours()) + ':' + U.pad2(d.getMinutes());
  }

  function periodText(item) {
    if (item.template.resetCycle === 'NONE') return '长期';
    return item.period.id;
  }

  function periodTitle(item) {
    if (!item.period.start || !item.period.end) return '';
    return fmtDateTime(item.period.start) + ' ～ ' + fmtDateTime(item.period.end);
  }

  function planningMonth() {
    return KC.periods.currentAttributionMonth(new Date());
  }

  function slot(id) {
    return pageState.container ? pageState.container.querySelector('#' + id) : null;
  }

  /* -------------------------------------------------------------- 汇总 */

  const statCard = KC.ui.statCard;

  function renderSummary() {
    const host = slot('task-summary');
    if (!host) return;
    const month = planningMonth();
    const pool = KC.store.getEffectivePlanningPool(month);
    const ov = KC.calc.tasks.overview(
      KC.store.state.taskTemplates, KC.store.state.taskRecords, pool, new Date()
    );

    host.innerHTML =
      statCard('本期已完成 EO 战果', U.formatNumber(ov.eoCompleted),
        '规划月份 ' + U.monthLabel(month), 'gold') +
      statCard('本期已完成任务战果', U.formatNumber(ov.taskCompleted),
        'EX / 活动 / 自定义', 'green') +
      statCard('本期已完成合计', U.formatNumber(ov.totalCompleted),
        '共 ' + ov.completedCount + ' / ' + ov.activeCount + ' 项已完成', 'purple') +
      statCard('规划池待完成', U.formatNumber(ov.poolPendingSenka),
        ov.poolPendingCount + ' 项待完成', '');
  }

  /* -------------------------------------------------------------- 表单 */

  function selectOptions(map, current) {
    return Object.keys(map).map(function (key) {
      return '<option value="' + key + '"' + (key === current ? ' selected' : '') + '>' +
        U.escapeHtml(map[key]) + '</option>';
    }).join('');
  }

  function toggleFormConditional(cycle) {
    const host = slot('task-form-slot');
    if (!host) return;
    KC.dom.qsa('[data-cond]', host).forEach(function (el) {
      el.hidden = el.dataset.cond !== cycle;
    });
  }

  function renderForm() {
    const host = slot('task-form-slot');
    if (!host) return;

    if (!pageState.formOpen) { host.innerHTML = ''; return; }

    const editing = pageState.editingId ? KC.store.getTaskTemplate(pageState.editingId) : null;
    if (pageState.editingId && !editing) { pageState.formOpen = false; pageState.editingId = null; host.innerHTML = ''; return; }

    const t = editing || {
      name: '', taskGroup: 'EX', senkaValue: '', resetCycle: 'MONTHLY',
      resetMonth: 1, eventPeriodId: '', enabled: true, defaultInPlan: false
    };

    host.innerHTML =
      '<div class="panel">' +
        '<div class="panel-head">' +
          '<h2>' + (editing ? '编辑任务' : '新增任务') + '</h2>' +
          (editing && editing.isSystem
            ? '<span class="tag tag-edit">系统任务仅可调整启用状态</span>'
            : '<span class="tag tag-edit">用户任务</span>') +
        '</div>' +
        '<form class="task-form" id="task-form" novalidate>' +
          '<div class="form-row">' +
            '<label class="field field-grow">' +
              '<span class="field-label">任务名称</span>' +
              '<input type="text" name="name" maxlength="40" placeholder="例如 夏季活动 E1" value="' +
                U.escapeHtml(t.name) + '"' + (editing && editing.isSystem ? ' disabled' : '') + ' required>' +
            '</label>' +
            '<label class="field">' +
              '<span class="field-label">所属任务组</span>' +
              '<select name="taskGroup"' + (editing && editing.isSystem ? ' disabled' : '') + '>' +
                selectOptions(GROUP_OPTION_LABEL, t.taskGroup) + '</select>' +
            '</label>' +
            '<label class="field">' +
              '<span class="field-label">战果值</span>' +
              '<input type="number" name="senkaValue" step="1" min="0" placeholder="例如 200" value="' +
                U.escapeHtml(t.senkaValue) + '"' + (editing && editing.isSystem ? ' disabled' : '') + ' required>' +
            '</label>' +
            '<label class="field">' +
              '<span class="field-label">周期类型</span>' +
              '<select name="resetCycle" data-act="form-cycle"' +
                (editing && editing.isSystem ? ' disabled' : '') + '>' +
                selectOptions(RESET_CYCLE_LABEL, t.resetCycle) + '</select>' +
            '</label>' +
            '<label class="field" data-cond="YEARLY">' +
              '<span class="field-label">重置月份</span>' +
              '<input type="number" name="resetMonth" min="1" max="12" value="' +
                U.escapeHtml(t.resetMonth || 1) + '"' + (editing && editing.isSystem ? ' disabled' : '') + '>' +
            '</label>' +
            '<label class="field field-grow" data-cond="EVENT">' +
              '<span class="field-label">活动周期名</span>' +
              '<input type="text" name="eventPeriodId" maxlength="40" placeholder="例如 2026 夏季活动" value="' +
                U.escapeHtml(t.eventPeriodId || '') + '"' + (editing && editing.isSystem ? ' disabled' : '') + '>' +
            '</label>' +
          '</div>' +
          '<div class="form-row form-row-flags">' +
            '<label class="check"><input type="checkbox" name="enabled"' +
              (t.enabled !== false ? ' checked' : '') + '> 启用</label>' +
            '<label class="check"><input type="checkbox" name="defaultInPlan"' +
              (t.defaultInPlan ? ' checked' : '') + '> 默认纳入规划池</label>' +
          '</div>' +
          '<div class="form-actions">' +
            '<button type="submit" class="btn btn-primary">保存</button>' +
            '<button type="button" class="btn btn-ghost" data-act="cancel-form">取消</button>' +
          '</div>' +
        '</form>' +
        '<p class="form-hint">周期类型决定任务何时刷新：每日 / 每周（周一）04:00，每月 1 日 04:00，每季度首月 1 日 04:00，每年指定月份 1 日 04:00；活动周期由用户手动指定。</p>' +
      '</div>';

    toggleFormConditional(t.resetCycle);
  }

  /* -------------------------------------------------------------- 列表 */

  function renderRow(item, poolSet) {
    const t = item.template;
    const disabled = t.enabled === false;
    const cls = 'task-row' + (item.completed ? ' is-done' : '') + (disabled ? ' is-off' : '');
    const poolChecked = poolSet.has(t.id) && !item.completed && !disabled;

    const actions = [];
    if (t.isSystem) {
      actions.push('<button type="button" class="btn btn-ghost btn-sm" data-act="toggle-enabled" data-id="' +
        U.escapeHtml(t.id) + '">' + (disabled ? '启用' : '停用') + '</button>');
    } else {
      actions.push('<button type="button" class="btn btn-ghost btn-sm" data-act="edit-task" data-id="' +
        U.escapeHtml(t.id) + '">编辑</button>');
      actions.push('<button type="button" class="btn btn-ghost btn-sm" data-act="toggle-enabled" data-id="' +
        U.escapeHtml(t.id) + '">' + (disabled ? '启用' : '停用') + '</button>');
      actions.push('<button type="button" class="btn btn-ghost btn-sm btn-danger-text" data-act="delete-task" data-id="' +
        U.escapeHtml(t.id) + '">删除</button>');
    }

    return '<tr class="' + cls + '">' +
      '<td class="cell-check">' +
        '<input type="checkbox" data-act="toggle" data-id="' + U.escapeHtml(t.id) + '"' +
          (item.completed ? ' checked' : '') + (disabled ? ' disabled' : '') +
          ' aria-label="标记完成">' +
      '</td>' +
      '<td class="cell-name">' + U.escapeHtml(t.name) +
        (t.isSystem ? '<span class="tag tag-sys">系统</span>' : '') +
        (disabled ? '<span class="tag tag-off">已停用</span>' : '') +
      '</td>' +
      '<td class="cell-num">' + U.formatNumber(t.senkaValue) + '</td>' +
      '<td class="cell-period"><span class="period-id" title="' + U.escapeHtml(periodTitle(item)) + '">' +
        U.escapeHtml(periodText(item)) + '</span>' +
        '<span class="period-cycle">' + U.escapeHtml(RESET_CYCLE_LABEL[t.resetCycle] || t.resetCycle) + '</span>' +
      '</td>' +
      '<td class="cell-check">' +
        '<input type="checkbox" data-act="plan" data-id="' + U.escapeHtml(t.id) + '"' +
          (poolChecked ? ' checked' : '') + (item.completed || disabled ? ' disabled' : '') +
          ' title="' + (item.completed ? '已完成，不重复计入规划池' : (disabled ? '任务已停用' : '纳入规划池')) + '"' +
          ' aria-label="参与规划">' +
      '</td>' +
      '<td class="cell-actions">' + actions.join('') + '</td>' +
      '</tr>';
  }

  function renderGroup(group, poolSet) {
    const done = group.items.filter(function (it) { return it.completed; }).length;
    const active = group.items.filter(function (it) { return it.template.enabled !== false; });
    const earned = U.round2(active.filter(function (it) { return it.completed; })
      .reduce(function (s, it) { return s + (Number(it.template.senkaValue) || 0); }, 0));

    return '<div class="panel">' +
      '<div class="panel-head">' +
        '<h2>' + U.escapeHtml(group.label) + '</h2>' +
        '<div class="panel-tools">' +
          '<span class="panel-count">已完成 ' + done + ' / ' + group.items.length +
            ' · 已获得 ' + U.formatNumber(earned) + '</span>' +
          '<button type="button" class="btn btn-ghost btn-sm" data-act="group-plan" data-group="' +
            U.escapeHtml(group.group) + '" data-select="1">全选规划</button>' +
          '<button type="button" class="btn btn-ghost btn-sm" data-act="group-plan" data-group="' +
            U.escapeHtml(group.group) + '" data-select="0">取消全选</button>' +
        '</div>' +
      '</div>' +
      '<div class="table-wrap"><table class="data-table task-table">' +
        '<thead><tr>' +
          '<th class="cell-check">完成</th>' +
          '<th>任务</th>' +
          '<th class="num">战果值</th>' +
          '<th>当前周期</th>' +
          '<th class="cell-check">参与规划</th>' +
          '<th class="actions">操作</th>' +
        '</tr></thead>' +
        '<tbody>' + group.items.map(function (it) { return renderRow(it, poolSet); }).join('') + '</tbody>' +
      '</table></div>' +
      '</div>';
  }

  function renderList() {
    const host = slot('task-list-slot');
    if (!host) return;

    const month = planningMonth();
    const pool = KC.store.getEffectivePlanningPool(month);
    const poolSet = new Set(pool);
    const ov = KC.calc.tasks.overview(
      KC.store.state.taskTemplates, KC.store.state.taskRecords, pool, new Date()
    );

    const toolbar =
      '<div class="pool-bar">' +
        '<span>规划月份：<strong>' + U.escapeHtml(U.monthLabel(month)) + '</strong>' +
          '<span class="muted"> · 规划池待完成 ' + ov.poolPendingCount + ' 项 / ' +
            U.formatNumber(ov.poolPendingSenka) + ' 战果</span></span>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-act="clear-pool">清空规划池</button>' +
      '</div>';

    if (!ov.groups.length) {
      host.innerHTML = toolbar +
        '<div class="panel"><div class="empty-inline">还没有任何任务，点右上角「新增任务」开始吧。</div></div>';
      return;
    }

    host.innerHTML = toolbar + ov.groups.map(function (g) { return renderGroup(g, poolSet); }).join('');
  }

  /* -------------------------------------------------------------- 交互 */

  async function toggleComplete(id, checked) {
    const template = KC.store.getTaskTemplate(id);
    if (!template) return;
    const periodId = KC.calc.tasks.periodOf(template, new Date()).id;
    try {
      await KC.store.setTaskCompleted(id, periodId, checked);
      KC.toast(checked ? '已完成：' + template.name : '已取消完成：' + template.name, 'ok');
    } catch (err) {
      KC.toast(err.message, 'error');
      renderList();
    }
  }

  async function togglePlan(id, checked) {
    try {
      const month = planningMonth();
      const pool = KC.store.getEffectivePlanningPool(month);
      const idx = pool.indexOf(id);
      if (checked && idx < 0) pool.push(id);
      if (!checked && idx >= 0) pool.splice(idx, 1);
      await KC.store.setPlanningPool(month, pool);
    } catch (err) {
      KC.toast(err.message, 'error');
    }
  }

  async function groupPlan(group, select) {
    try {
      const month = planningMonth();
      const pool = KC.store.getEffectivePlanningPool(month);
      const ids = KC.store.state.taskTemplates
        .filter(function (t) { return t.taskGroup === group && t.enabled !== false; })
        .map(function (t) { return t.id; });
      let next;
      if (select) {
        next = pool.concat(ids.filter(function (id) { return pool.indexOf(id) < 0; }));
      } else {
        next = pool.filter(function (id) { return ids.indexOf(id) < 0; });
      }
      await KC.store.setPlanningPool(month, next);
      KC.toast(select ? '已全选该组规划' : '已取消该组规划', 'ok');
    } catch (err) {
      KC.toast(err.message, 'error');
    }
  }

  async function clearPool() {
    const month = planningMonth();
    const ok = await KC.confirmDialog({
      title: '清空规划池',
      message: '确定清空 ' + U.monthLabel(month) + ' 的规划池吗？任务的实际完成状态不受影响。',
      okText: '清空',
      danger: true
    });
    if (!ok) return;
    try {
      await KC.store.setPlanningPool(month, []);
      KC.toast('已清空规划池', 'ok');
    } catch (err) {
      KC.toast(err.message, 'error');
    }
  }

  async function toggleEnabled(id) {
    const template = KC.store.getTaskTemplate(id);
    if (!template) return;
    try {
      await KC.store.setTaskEnabled(id, template.enabled === false);
      KC.toast((template.enabled === false ? '已启用：' : '已停用：') + template.name, 'ok');
    } catch (err) {
      KC.toast(err.message, 'error');
    }
  }

  async function deleteTask(id) {
    const template = KC.store.getTaskTemplate(id);
    if (!template) return;
    const ok = await KC.confirmDialog({
      title: '删除任务',
      message: '确定删除任务「' + template.name + '」吗？历史完成记录会保留，不会被删除。',
      okText: '删除',
      danger: true
    });
    if (!ok) return;
    try {
      await KC.store.deleteTaskTemplate(id);
      KC.toast('已删除任务：' + template.name, 'ok');
    } catch (err) {
      KC.toast(err.message, 'error');
    }
  }

  function handleSubmit(e) {
    e.preventDefault();
    const form = e.target;
    if (!form || form.id !== 'task-form') return;

    const fd = new FormData(form);
    const input = {
      id: pageState.editingId || undefined,
      name: fd.get('name'),
      taskGroup: fd.get('taskGroup'),
      senkaValue: fd.get('senkaValue'),
      resetCycle: fd.get('resetCycle'),
      resetMonth: fd.get('resetMonth'),
      eventPeriodId: fd.get('eventPeriodId'),
      enabled: fd.get('enabled') === 'on',
      defaultInPlan: fd.get('defaultInPlan') === 'on'
    };

    KC.store.saveTaskTemplate(input).then(function () {
      pageState.formOpen = false;
      pageState.editingId = null;
      renderForm();
      KC.toast('已保存任务：' + String(input.name || '').trim(), 'ok');
    }).catch(function (err) {
      KC.toast(err.message, 'error');
    });
  }

  function handleClick(e) {
    const btn = KC.dom.closestFrom(e.target, '[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;

    if (act === 'new-task') {
      pageState.formOpen = true;
      pageState.editingId = null;
      renderForm();
      const first = slot('task-form-slot') && slot('task-form-slot').querySelector('input[name="name"]');
      if (first) first.focus();
    } else if (act === 'edit-task') {
      pageState.formOpen = true;
      pageState.editingId = btn.dataset.id;
      renderForm();
      const first = slot('task-form-slot') && slot('task-form-slot').querySelector('input[name="name"]');
      if (first) first.focus();
    } else if (act === 'cancel-form') {
      pageState.formOpen = false;
      pageState.editingId = null;
      renderForm();
    } else if (act === 'toggle-enabled') {
      toggleEnabled(btn.dataset.id);
    } else if (act === 'delete-task') {
      deleteTask(btn.dataset.id);
    } else if (act === 'group-plan') {
      groupPlan(btn.dataset.group, btn.dataset.select === '1');
    } else if (act === 'clear-pool') {
      clearPool();
    }
  }

  function handleChange(e) {
    const el = e.target;
    if (!el || !el.dataset) return;
    const act = el.dataset.act;

    if (act === 'toggle') toggleComplete(el.dataset.id, el.checked);
    else if (act === 'plan') togglePlan(el.dataset.id, el.checked);
    else if (act === 'form-cycle') toggleFormConditional(el.value);
  }

  /* -------------------------------------------------------------- 生命周期 */

  function buildShell() {
    pageState.container.innerHTML =
      '<div class="page-head">' +
        '<div>' +
          '<h1>战果任务</h1>' +
          '<p class="page-sub">管理所有战果来源任务。勾选即标记为已完成；程序按周期自动读取对应记录，不做「重置任务」。</p>' +
        '</div>' +
        '<button type="button" class="btn btn-primary" data-act="new-task">+ 新增任务</button>' +
      '</div>' +
      '<div class="card-grid" id="task-summary"></div>' +
      '<div id="task-form-slot"></div>' +
      '<div id="task-list-slot"></div>';
  }

  KC.pages.tasks = {
    mount: function (container) {
      pageState.container = container;
      pageState.formOpen = false;
      pageState.editingId = null;

      handlers = { click: handleClick, change: handleChange, submit: handleSubmit };
      container.addEventListener('click', handlers.click);
      container.addEventListener('change', handlers.change);
      container.addEventListener('submit', handlers.submit);

      unsubscribe = KC.store.subscribe(function (type) {
        if (type !== 'change') return;
        renderSummary();
        renderList();
        if (pageState.formOpen) renderForm();
      });

      buildShell();
      renderSummary();
      renderForm();
      renderList();
    },
    unmount: function () {
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
      if (handlers && pageState.container) {
        pageState.container.removeEventListener('click', handlers.click);
        pageState.container.removeEventListener('change', handlers.change);
        pageState.container.removeEventListener('submit', handlers.submit);
      }
      handlers = null;
      pageState.container = null;
      pageState.formOpen = false;
      pageState.editingId = null;
    }
  };
})(window.KC = window.KC || {});
