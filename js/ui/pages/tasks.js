/* ==========================================================================
   ui/pages/tasks.js — 战果任务页
   依据 docs/02_ui.md §4.5、docs/01_requirements.md §三、docs/04_calculation.md §六 / §七。

   职责：
     · 管理所有战果来源任务（EO / EX / 活动 / 用户自定义）
     · 每项展示：名称、当前状态、战果值、当前周期、是否参与规划
     · 快速完成 / 取消完成
     · 切换「战果归属月」以补录历史周期；日常 / 周常可逐期选择
       （docs/04_calculation.md §十五、docs/06_data_strategy.md §4.1）
     · 新增、编辑、删除用户任务；启用 / 停用
     · 规划池：单项选择、分类全选、分类取消全选、全部清空

   结构：页面外壳只构建一次，之后分别刷新「汇总 / 表单 / 列表」三块，
   避免勾选任务时把正在填写的表单冲掉。切换归属月时会整页重绘（页头月份要一起更新）。
   ========================================================================== */
(function (KC) {
  'use strict';

  const U = KC.utils;

  KC.pages = KC.pages || {};

  const RESET_CYCLE_LABEL = {
    NONE: '不重置',
    DAILY: '日常',
    WEEKLY: '周常',
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
    editingId: null,
    /** 当前查看的「战果归属月」；null = 本月。切换后即可补录该月的任务 */
    month: null,
    /** 各任务当前选中的期次 id（仅 DAILY / WEEKLY 需要，见 pickedPeriod） */
    periodPick: {}
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
    return pageState.month || KC.periods.currentAttributionMonth(new Date());
  }

  /* ------------------------------------------------- 归属月 / 期次（补录） */

  /**
   * 某任务在指定归属月下可选的期次。
   * DAILY / WEEKLY 一个月内有多个周期，必须逐期选择才能补录；
   * 其余周期类型一个月只对应一个周期。
   */
  function periodsOf(template, month) {
    const cycle = template.resetCycle;
    if (cycle === 'DAILY' || cycle === 'WEEKLY') {
      return KC.calc.tasks.periodsInAttributionWindow(cycle, month);
    }
    return [KC.calc.tasks.periodForMonth(template, month, new Date())];
  }

  /**
   * 该任务当前选中的期次。
   * 默认值：当前月 → 真正的"本期"（今天 / 本周）；历史月 → 该月最后一期。
   * 选中的期次若不属于当前查看的月份（例如刚切换过月份），自动回落到默认值。
   */
  function pickedPeriod(template, month) {
    const list = periodsOf(template, month);
    if (!list.length) return { id: null, start: null, end: null };

    const pick = pageState.periodPick[template.id];
    const hit = list.filter(function (p) { return p.id === pick; })[0];
    if (hit) return hit;

    const now = new Date();
    if (month === KC.periods.currentAttributionMonth(now)) {
      const current = KC.calc.tasks.periodOf(template, now);
      const currentHit = list.filter(function (p) { return p.id === current.id; })[0];
      if (currentHit) return currentHit;
    }
    return list[list.length - 1];
  }

  /** 列表行 / 分组统计用的视图模型：完成状态按"所选期次"判定 */
  function itemView(template, month) {
    const period = pickedPeriod(template, month);
    const record = period.id ? KC.store.getTaskRecord(template.id, period.id) : null;
    return {
      template: template,
      period: period,
      record: record,
      completed: !!(record && record.completed)
    };
  }

  /**
   * 补录历史周期时写进 TaskRecord 的完成时刻。
   *
   * 战果归属按完成时刻判定（docs/04_calculation.md §4.6），而补录时"真实完成时刻"
   * 已不可知，只能取一个落在目标归属月内的近似值：
   *   · 周期的起算时刻就在该月内（月常 / 当月内的日常周常）→ 直接用它，最精确
   *   · 否则（季常 / 年常 / 跨月周常）→ 用该月 15 日 12:00
   * 用当月 15 日而非"现在"，是为了避免补录被算到当前月、或撞上末日 13:00 的归属边界。
   */
  function backfillAt(month, period) {
    if (period && period.start && U.monthKeyOf(U.toDateKey(period.start)) === month) {
      return period.start;
    }
    const p = String(month).split('-').map(Number);
    return new Date(p[0], p[1] - 1, 15, 12, 0, 0, 0);
  }

  function slot(id) {
    return pageState.container ? pageState.container.querySelector('#' + id) : null;
  }

  /**
   * 页头：标题 + 「战果归属月」切换 + 新增任务。
   * 切换归属月即可补录历史周期（docs/04_calculation.md §十五、docs/06_data_strategy.md §4.1）。
   */
  function pageHead() {
    const month = planningMonth();
    const isCurrent = month === KC.periods.currentAttributionMonth(new Date());
    return '<div class="page-head">' +
      '<div>' +
        '<h1>战果任务</h1>' +
        '<p class="page-sub">管理所有战果来源任务。勾选即标记为已完成；' +
          '切换「战果归属月」可补录历史周期，日常 / 周常可逐期选择。</p>' +
      '</div>' +
      '<div class="head-tools">' +
        '<div class="month-switch">' +
          '<button type="button" class="btn btn-icon" data-act="prev-month" title="上个月" aria-label="上个月">‹</button>' +
          '<span class="month-label">' + U.escapeHtml(U.monthLabel(month)) + '</span>' +
          '<button type="button" class="btn btn-icon" data-act="next-month" title="下个月" aria-label="下个月">›</button>' +
          (isCurrent ? '' : '<button type="button" class="btn btn-ghost btn-sm" data-act="this-month">回到本月</button>') +
        '</div>' +
        '<button type="button" class="btn btn-primary" data-act="new-task">+ 新增任务</button>' +
      '</div>' +
      '</div>';
  }

  /* -------------------------------------------------------------- 汇总 */

  const statCard = KC.ui.statCard;

  /**
   * 列表与汇总共用的行视图集合。
   * 完成状态按「所选期次」判定（补录时才能逐期勾选），规划池待完成也据此计算，
   * 保证顶部汇总卡与表格里的勾选状态永远一致。
   */
  function listViews(month) {
    // 展示口径：历史月没保存过规划池时为空（与首页 / 规划页 / 分析页一致）
    const poolSet = new Set(KC.calc.plan.displayPoolIds(KC.store, month, new Date()));
    const items = KC.store.listTaskTemplates().map(function (t) { return itemView(t, month); });
    const active = items.filter(function (it) { return it.template.enabled !== false; });
    const pending = active.filter(function (it) {
      return !it.completed && poolSet.has(it.template.id);
    });
    return {
      poolSet: poolSet,
      items: items,
      active: active,
      done: active.filter(function (it) { return it.completed; }).length,
      pending: pending,
      pendingSenka: U.round2(pending.reduce(function (s, it) {
        return s + (Number(it.template.senkaValue) || 0);
      }, 0))
    };
  }

  function renderSummary() {
    const host = slot('task-summary');
    if (!host) return;

    const month = planningMonth();
    const pool = KC.calc.plan.displayPoolIds(KC.store, month, new Date());
    const ov = KC.calc.tasks.overview(
      KC.store.state.taskTemplates, KC.store.state.taskRecords, pool, new Date(), month
    );
    const view = listViews(month);

    host.innerHTML =
      statCard('已完成 EO 战果', U.formatNumber(ov.eoCompleted),
        '战果归属月 ' + U.monthLabel(month), 'gold') +
      statCard('已完成任务战果', U.formatNumber(ov.taskCompleted),
        'EX / 活动 / 自定义', 'green') +
      statCard('已完成合计', U.formatNumber(ov.totalCompleted),
        '共 ' + view.done + ' / ' + view.active.length + ' 项已完成', 'purple') +
      statCard('规划池待完成', U.formatNumber(view.pendingSenka),
        view.pending.length + ' 项待完成', '');
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
        '<p class="form-hint">周期类型决定任务何时刷新：日常 / 周常（周一）04:00，每月 1 日 04:00，每季度首月 1 日 04:00，每年指定月份 1 日 04:00；活动周期由用户手动指定。</p>' +
      '</div>';

    toggleFormConditional(t.resetCycle);
  }

  /* -------------------------------------------------------------- 列表 */

  /**
   * 「当前周期」单元格。
   * DAILY / WEEKLY 一个月内有多个周期 → 给一个期次下拉，用于逐期补录；
   * 其余类型一个月只对应一个周期 → 直接显示周期 id。
   */
  function periodCell(item, month) {
    const t = item.template;
    const cycleLabel = RESET_CYCLE_LABEL[t.resetCycle] || t.resetCycle;
    const title = periodTitle(item);

    if (t.resetCycle === 'DAILY' || t.resetCycle === 'WEEKLY') {
      const list = periodsOf(t, month);
      const options = list.map(function (p) {
        return '<option value="' + U.escapeHtml(p.id) + '"' +
          (p.id === item.period.id ? ' selected' : '') + '>' + U.escapeHtml(p.id) + '</option>';
      }).join('');
      return '<td class="cell-period">' +
        '<select class="period-pick" data-act="pick-period" data-id="' + U.escapeHtml(t.id) + '"' +
          ' aria-label="选择期次" title="选择要查看 / 补录的期次">' + options + '</select>' +
        '<span class="period-cycle">' + U.escapeHtml(cycleLabel) + '</span>' +
        '</td>';
    }

    return '<td class="cell-period"><span class="period-id" title="' + U.escapeHtml(title) + '">' +
      U.escapeHtml(periodText(item)) + '</span>' +
      '<span class="period-cycle">' + U.escapeHtml(cycleLabel) + '</span>' +
      '</td>';
  }

  function renderRow(item, poolSet, month) {
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
      '<td class="col-senka">' + U.formatNumber(t.senkaValue) + '</td>' +
      periodCell(item, month) +
      '<td class="cell-check">' +
        '<input type="checkbox" data-act="plan" data-id="' + U.escapeHtml(t.id) + '"' +
          (poolChecked ? ' checked' : '') + (item.completed || disabled ? ' disabled' : '') +
          ' title="' + (item.completed ? '已完成，不重复计入规划池' : (disabled ? '任务已停用' : '纳入规划池')) + '"' +
          ' aria-label="参与规划">' +
      '</td>' +
      '<td class="cell-actions">' + actions.join('') + '</td>' +
      '</tr>';
  }

  function renderGroup(group, poolSet, month) {
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
          '<th class="col-senka">战果值</th>' +
          '<th>当前周期</th>' +
          '<th class="cell-check">参与规划</th>' +
          '<th class="actions">操作</th>' +
        '</tr></thead>' +
        '<tbody>' + group.items.map(function (it) { return renderRow(it, poolSet, month); }).join('') + '</tbody>' +
      '</table></div>' +
      '</div>';
  }

  /**
   * 任务战果归属截止提示（docs/04_calculation.md §4.3 / §4.6）。
   * 文案与首页 / 战果规划页共用 KC.ui.taskCutoffNotice，避免各处口径走偏。
   */
  function renderNotice() {
    const host = slot('task-notice-slot');
    if (!host) return;
    host.innerHTML = KC.ui.taskCutoffNotice(planningMonth(), new Date());
  }

  function renderList() {
    renderNotice();

    const host = slot('task-list-slot');
    if (!host) return;

    const month = planningMonth();
    // 行状态按"所选期次"判定（补录时才能逐期勾选）；汇总卡仍走 overview 的归属月累计。
    const view = listViews(month);
    const groups = KC.calc.tasks.groupItems(view.items);

    const toolbar =
      '<div class="pool-bar">' +
        '<span>战果归属月：<strong>' + U.escapeHtml(U.monthLabel(month)) + '</strong>' +
          '<span class="muted"> · 规划池待完成 ' + view.pending.length + ' 项 / ' +
            U.formatNumber(view.pendingSenka) + ' 战果</span></span>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-act="clear-pool">清空规划池</button>' +
      '</div>';

    if (!groups.length) {
      host.innerHTML = toolbar +
        '<div class="panel"><div class="empty-inline">还没有任何任务，点右上角「新增任务」开始吧。</div></div>';
      return;
    }

    host.innerHTML = toolbar +
      groups.map(function (g) { return renderGroup(g, view.poolSet, month); }).join('');
  }

  /* -------------------------------------------------------------- 交互 */

  /**
   * 勾选 / 取消完成。
   * 作用于**所选期次**（默认是本期），因此切到历史月即可补录历史周期
   * （docs/04_calculation.md §十五、docs/06_data_strategy.md §4.1）。
   * 目标月份已归档时先按 §4.2 要求显式确认。
   */
  async function toggleComplete(id, checked) {
    const template = KC.store.getTaskTemplate(id);
    if (!template) return;

    const now = new Date();
    const month = planningMonth();
    const period = pickedPeriod(template, month);
    if (!period.id) return;

    const ok = await KC.confirmArchivedMonth(
      month, checked ? '标记该月任务为已完成' : '取消该月任务的完成状态'
    );
    if (!ok) { renderList(); return; }

    // 只有"正在完成当前这一期"才用真实时刻；补录历史周期用落在目标月内的近似时刻，
    // 否则战果会被算到当前月（归属按完成时刻判定，见 docs/04_calculation.md §4.6）。
    const isCurrentPeriod = period.id === KC.calc.tasks.periodOf(template, now).id;
    const at = isCurrentPeriod ? now : backfillAt(month, period);

    try {
      await KC.store.setTaskCompleted(id, period.id, checked, at);
      const msg = completeToast(template, checked, now, month, period);
      KC.toast(msg.text, msg.tone);
    } catch (err) {
      KC.toast(err.message, 'error');
      renderList();
    }
  }

  /**
   * 勾选/取消完成后的提示文案。
   * 补录历史周期时说明期次与去向；本月末日 13:00 之后完成的任务按归属边界说明去向，
   * 季常在季度第三月此时完成会直接失效，单独警告。
   * @returns {{text: string, tone: string}}
   */
  function completeToast(template, checked, now, month, period) {
    if (!checked) {
      return { text: '已取消完成：' + template.name + '（' + period.id + '）', tone: 'ok' };
    }
    if (month !== KC.periods.currentAttributionMonth(now)) {
      return { text: '已补录：' + template.name + '（' + period.id + '，计入 ' +
        U.monthLabel(month) + '）', tone: 'ok' };
    }

    const base = '已完成：' + template.name;
    const att = KC.calc.tasks.periodAttributionMonth(
      { completedAt: now.toISOString() }, null, template
    );
    if (att === KC.calc.tasks.VOID_MONTH) {
      return { tone: 'error', text: base +
        '。注意：本月是季度第三月，已过末日 13:00，这笔季常战果会直接失效。' };
    }
    const natural = U.monthKeyOf(U.toDateKey(now));
    if (att && att !== natural) {
      return { tone: 'ok', text: base + '。已过本月任务战果归属截止时间，战果计入 ' +
        U.monthLabel(att) + '。' };
    }
    return { text: base, tone: 'ok' };
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
    } else if (act === 'prev-month') {
      switchMonth(U.addMonths(planningMonth(), -1));
    } else if (act === 'next-month') {
      switchMonth(U.addMonths(planningMonth(), 1));
    } else if (act === 'this-month') {
      switchMonth(KC.periods.currentAttributionMonth(new Date()));
    }
  }

  function handleChange(e) {
    const el = e.target;
    if (!el || !el.dataset) return;
    const act = el.dataset.act;

    if (act === 'toggle') toggleComplete(el.dataset.id, el.checked);
    else if (act === 'plan') togglePlan(el.dataset.id, el.checked);
    else if (act === 'pick-period') {
      pageState.periodPick[el.dataset.id] = el.value;
      renderList();
    }
    else if (act === 'form-cycle') toggleFormConditional(el.value);
  }

  /* -------------------------------------------------------------- 生命周期 */

  function buildShell() {
    pageState.container.innerHTML =
      pageHead() +
      '<div class="card-grid" id="task-summary"></div>' +
      '<div id="task-notice-slot"></div>' +
      '<div id="task-form-slot"></div>' +
      '<div id="task-list-slot"></div>';
  }

  /**
   * 切换「战果归属月」（补录历史周期用）。
   * 页头里的月份文案需要一起更新，所以整页重绘；期次选择同时清空，回到各任务默认期。
   */
  function switchMonth(month) {
    pageState.month = month;
    pageState.periodPick = {};
    render();
  }

  /** 整页重绘：挂载时与切换归属月时使用 */
  function render() {
    buildShell();
    renderSummary();
    renderForm();
    renderList();
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

      render();
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
      pageState.month = null;
      pageState.periodPick = {};
    }
  };
})(window.KC = window.KC || {});
