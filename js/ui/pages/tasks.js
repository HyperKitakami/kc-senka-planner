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
    periodPick: {},
    /** 已展开进度面板的任务 id（默认全部折叠，见「任务进度」） */
    expanded: {}
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
    // readRecord 会对"带进度但周期已过期"的记录做重置；补录历史周期时
    // 界面走的是"当前此期就是我要记的那一期"，因此这里传 pickedPeriod 的 id。
    const record = period.id
      ? KC.calc.tasks.readRecord([], KC.store.state.taskRecords, template, period.id, new Date())
      : null;
    return {
      template: template,
      period: period,
      record: record,
      completed: KC.calc.tasks.isCompleted(record, template)
    };
  }

  /**
   * 已是记录里的完成态、但节点并未全部达成（先完成后减进度，或用户手动勾选）。
   * 节点判定统一走 `KC.calc.tasks.stepsAllDone(record, template)`，页面不再自备一份，
   * 避免同一个名字出现两套参数顺序。
   */
  function isManualDone(template, record) {
    return !!(record && record.completed) &&
      KC.calc.tasks.stepsAllDone(record, template) === false;
  }

  /**
   * 当前是否允许修改该任务的节点进度。
   *
   * 已完成的任务必须先取消完成才能改进度 —— 这样"完成"始终是一个用户明确表达过的状态，
   * 不会出现"我明明没勾完成、却因为改了进度而悄悄变成已完成"的困惑。
   * 注意取消完成**不会**清掉进度（读法 A），所以解锁后可以从原进度继续改。
   * 历史月（补录场景）不做此限制。
   */
  function progressEditable(template, record, month) {
    if (template.enabled === false) return false;
    if (month !== KC.periods.currentAttributionMonth(new Date())) return true;
    return !(record && record.completed);
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

  /* ------------------------------------------- poi EO 批量同步 */
  const POI_PATH_HINT = '%APPDATA%\\roaming\\poi\\achieve\\achieve.json';

  /** 同步面板的 DOM 槽（在 buildShell 里建一次，之后只刷 innerHTML） */
  function renderPoiSlot() {
    const host = slot('task-poi-slot');
    if (!host) return;
    host.innerHTML = poiPanel();
  }

  /** 当前归属月的 poi EO 差异（无快照返回 null） */
  function poiDiff() {
    return KC.poiData.eoDiff(
      planningMonth(),
      KC.store.state.taskTemplates,
      KC.store.state.taskRecords,
      KC.calc.tasks.readRecord,
      new Date()
    );
  }

  /**
   * poi 同步面板。
   *
   * 只做**批量勾选**（poi 说完成 → 我们也勾上），不做自动取消：
   * poi 的 rankuex 只反映"当前血条在不在"，而战果归属有 21:00 边界，
   * 自动取消会把已经计入历史归属的战果抹掉。反向差异只列出来提示。
   */
  function poiPanel() {
    const diff = poiDiff();
    const month = planningMonth();

    if (!diff) {
      return '<div class="panel poi-panel">' +
        '<div class="panel-head"><h2>poi EO 同步</h2>' +
          '<span class="panel-count">该月无快照</span></div>' +
        '<p class="form-hint">还没有 ' + U.escapeHtml(U.monthLabel(month)) +
          ' 的 poi 数据快照。到「战果记录」页选择 poi 数据文件（<code>' +
          U.escapeHtml(POI_PATH_HINT) + '</code>）同步一次，再回到本页即可批量勾选 EO 任务。</p>' +
        '</div>';
    }

    const c = diff.counts;
    const nothing = c.done === 0 && c.undone === 0;

    const rows = function (list, mark) {
      return list.map(function (r) {
        return '<li><span class="poi-chip-badge">' + mark + '</span>' +
          '<span class="poi-eo-name">' + U.escapeHtml(r.code) + '</span>' +
          '<span class="poi-eo-senka">' + U.formatNumber(r.senka) + '</span></li>';
      }).join('');
    };

    let body;
    if (nothing) {
      body = '<div class="empty-inline">poi 与本工具记录的 EO 完成状态一致，无需同步。</div>';
    } else {
      body = '<div class="poi-diff">' +
        (c.done
          ? '<div class="poi-diff-block"><div class="poi-diff-head">poi 已完成，本工具未勾选（' +
              c.done + ' 项）</div><ul class="poi-eo-list">' + rows(diff.done, '待勾选') + '</ul></div>'
          : '') +
        (c.undone
          ? '<div class="poi-diff-block"><div class="poi-diff-head">本工具已勾选，poi 显示未完成（' +
              c.undone + ' 项）</div><ul class="poi-eo-list">' + rows(diff.undone, '仅提示') + '</ul>' +
              '<p class="form-hint">poi 只反映「当前血条是否还在」。这些任务本工具已标记完成，' +
              '可能已计入战果归属 —— 不会自动取消，请自行确认后手动处理。</p></div>'
          : '') +
        '</div>';
    }

    const foot = c.done
      ? '<div class="panel-foot">' +
          '<button type="button" class="btn btn-primary" data-act="poi-eo-sync">' +
            '批量勾选 ' + c.done + ' 项 EO 任务</button>' +
          '<span class="poi-status-line">共 ' + diff.same.length + ' 项状态一致' +
            (diff.unknown.length ? ' · ' + diff.unknown.length + ' 项无法匹配' : '') +
            (diff.syncedAt ? ' · 快照同步于 ' + U.escapeHtml(fmtDateTime(new Date(diff.syncedAt))) : '') +
          '</span>' +
        '</div>'
      : '<p class="form-hint">共 ' + diff.same.length + ' 项状态一致' +
        (diff.unknown.length ? ' · ' + diff.unknown.length + ' 项无法匹配' : '') + '。</p>';

    return '<div class="panel poi-panel">' +
      '<div class="panel-head"><h2>poi EO 同步</h2>' +
        '<span class="panel-count">' + U.escapeHtml(U.monthLabel(month)) + '</span></div>' +
      body + foot +
      '<p class="form-hint">数据来自「本机轻量存储」里的 poi 快照，不参与导入导出；' +
        '换浏览器或清站点数据会丢失。勾选后仍可在列表中逐项取消完成。</p>' +
      '</div>';
  }

  /** 批量勾选：确认 → 批量写入 → 提示 */
  async function handlePoiEoSync() {
    const diff = poiDiff();
    if (!diff || !diff.counts.done) return;

    const month = planningMonth();
    const total = U.round2(diff.done.reduce(function (s, r) { return s + r.senka; }, 0));
    const preview = diff.done.slice(0, 8).map(function (r) {
      return '  · ' + r.code + '  ' + U.formatNumber(r.senka);
    }).join('\n');

    const ok = await KC.confirmDialog({
      title: '批量勾选 EO 任务',
      message: '将把 ' + month + ' 的 ' + diff.done.length + ' 项 EO 任务标记为已完成' +
        '（合计 ' + U.formatNumber(total) + '）：\n' + preview +
        (diff.done.length > 8 ? '\n  · …等 ' + diff.done.length + ' 项' : '') +
        '\n\n依据是 poi 的「未完成海域」列表。已有进度节点的任务会保留其进度；' +
        '勾选后仍可逐项取消完成。',
      okText: '勾选 ' + diff.done.length + ' 项'
    });
    if (!ok) return;

    // 补录历史月时，完成时刻要落在目标归属月内（否则战果会被算到当前月）
    const items = diff.done.map(function (r) {
      return {
        templateId: r.template.id,
        periodId: r.period.id,
        completedAt: backfillAt(month, r.period)
      };
    });

    try {
      const res = await KC.store.setTasksCompletedBatch(items);
      if (res.failed.length) {
        KC.toast('已勾选 ' + res.ok + ' 项，' + res.failed.length + ' 项失败。', 'error');
      } else {
        KC.toast('已勾选 ' + res.ok + ' 项 EO 任务', 'ok');
      }
    } catch (err) {
      KC.toast(err.message, 'error');
    }
    renderPoiSlot();
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

  /* --------------------------------------------- 表单：进度节点编辑 */

  /**
   * 单个节点行（DOM 构造）。
   *
   * 为什么不用 innerHTML 拼字符串：节点行需要**动态增删**且不能重绘整个表单
   * （表单里还有用户正在填的其它字段，整块重绘会把它们冲掉）。DOM 构造还能让
   * value 直接赋值，天然免掉 HTML 转义问题。
   *
   * @param {{code?:string,label?:string,requiredCount?:number}} [step]
   */
  function stepEditRow(step) {
    const s = step || {};
    const row = document.createElement('div');
    row.className = 'step-edit-row';
    row.dataset.stepRow = '';

    function field(cls, type, key, aria, placeholder, value) {
      const input = document.createElement('input');
      input.type = type;
      input.className = cls;
      input.dataset.field = key;
      input.setAttribute('aria-label', aria);
      if (placeholder) input.placeholder = placeholder;
      if (value !== undefined) input.value = value;
      return input;
    }

    row.appendChild(field('step-edit-code', 'text', 'code', '节点代号',
      '如 1-1-A', String(s.code || '')));
    row.appendChild(field('step-edit-label', 'text', 'label', '节点说明',
      '如 1-1 A胜（留空则用代号）', String(s.label || '')));
    row.appendChild(field('step-edit-need', 'number', 'requiredCount', '需要次数',
      '', String(Math.max(1, Math.round(Number(s.requiredCount)) || 1))));

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'step-edit-del';
    del.dataset.act = 'del-step-row';
    del.setAttribute('aria-label', '删除该节点');
    del.title = '删除该节点';
    del.textContent = '×';
    row.appendChild(del);

    return row;
  }

  /**
   * 「海域攻略进度节点」编辑区外壳。
   *
   * 这里是**配置**节点的地方（TaskTemplate.steps）；页面列表里那个可折叠面板
   * 是**记录**进度的（TaskRecord.stepProgress）。两者容易混淆，故在提示里点明。
   *
   * 系统任务仅可调整启用状态，不显示本区域（与其它字段的 disabled 口径一致）。
   * 行内容由 mountStepRows 在写入 innerHTML 之后追加（见 renderForm）。
   */
  function stepsEditorHtml(locked) {
    if (locked) return '';
    return '<div class="steps-editor">' +
        '<div class="steps-editor-head">' +
          '<span class="field-label">海域攻略进度节点</span>' +
          '<span class="steps-editor-count" id="step-rows-count"></span>' +
        '</div>' +
        '<div class="step-edit-list" id="step-edit-list"></div>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-act="add-step-row">' +
          '+ 添加节点</button>' +
      '</div>' +
      '<p class="form-hint">节点用于逐项记录攻略进度（如「1-1 A胜 1 次」「1-2 S胜 2 次」），' +
        '全部达成后任务会自动标记为已完成；不需要逐项记录的任务留空即可。' +
        '代号留空的节点在保存时会被丢弃，代号重复只保留第一个。</p>';
  }

  /**
   * 表单里的节点行容器。
   * 用页面根容器的 id 查询（而不是在表单元素内向下查），这样在真实 DOM 与
   * 测试用假 DOM 下都能拿到同一个节点（假 DOM 不解析 innerHTML）。
   */
  function stepEditorList() { return slot('step-edit-list'); }

  /** 同步节点计数文案（增删行 / 重建表单后调用） */
  function syncStepRowCount() {
    const label = slot('step-rows-count');
    const list = stepEditorList();
    if (!label || !list) return;
    label.textContent = KC.dom.qsa('[data-step-row]', list).length + ' 个节点';
  }

  /** 清空并重建全部节点行（打开表单 / 切换编辑对象时用） */
  function mountStepRows(steps) {
    const list = stepEditorList();
    if (!list) return;
    KC.dom.clear(list);
    (steps || []).forEach(function (s) { list.appendChild(stepEditRow(s)); });
    syncStepRowCount();
  }

  /** 添加一个空的节点行并聚焦到代号输入框 */
  function addStepRow() {
    const list = stepEditorList();
    if (!list) return;
    const row = stepEditRow(null);
    list.appendChild(row);
    syncStepRowCount();
    const input = row.querySelector('[data-field="code"]');
    if (input && typeof input.focus === 'function') input.focus();
  }

  /** 删除某个节点行（由行内 × 按钮触发） */
  function removeStepRow(btn) {
    const row = KC.dom.closestFrom(btn, '[data-step-row]');
    if (!row || !row.parentNode) return;
    row.parentNode.removeChild(row);
    syncStepRowCount();
  }

  /**
   * 从表单中收集节点配置。
   * 返回 **null** 表示没有有效节点 —— 与 schema.normalizeSteps 的语义一致，
   * 交给 store 决定"不写 steps 键"。这里只读值不清洗（去重 / 收敛次数由
   * schema.normalizeSteps 统一负责，避免两处规则走偏）。
   */
  function collectSteps() {
    const list = stepEditorList();
    if (!list) return null;
    const rows = KC.dom.qsa('[data-step-row]', list).map(function (row) {
      const codeEl = row.querySelector('[data-field="code"]');
      const labelEl = row.querySelector('[data-field="label"]');
      const needEl = row.querySelector('[data-field="requiredCount"]');
      return {
        code: codeEl ? codeEl.value : '',
        label: labelEl ? labelEl.value : '',
        requiredCount: needEl ? needEl.value : 1
      };
    });
    return KC.schema.normalizeSteps(rows);
  }

  function renderForm() {
    const host = slot('task-form-slot');
    if (!host) return;

    if (!pageState.formOpen) { host.innerHTML = ''; return; }

    const editing = pageState.editingId ? KC.store.getTaskTemplate(pageState.editingId) : null;
    if (pageState.editingId && !editing) { pageState.formOpen = false; pageState.editingId = null; host.innerHTML = ''; return; }

    const t = editing || {
      name: '', taskGroup: 'EX', senkaValue: '', resetCycle: 'MONTHLY',
      resetMonth: 1, eventPeriodId: '', enabled: true, defaultInPlan: false, steps: null
    };
    const locked = !!(editing && editing.isSystem);

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
          stepsEditorHtml(locked) +
          '<div class="form-actions">' +
            '<button type="submit" class="btn btn-primary">保存</button>' +
            '<button type="button" class="btn btn-ghost" data-act="cancel-form">取消</button>' +
          '</div>' +
        '</form>' +
        '<p class="form-hint">周期类型决定任务何时刷新：日常 / 周常（周一）04:00，每月 1 日 04:00，每季度首月 1 日 04:00，每年指定月份 1 日 04:00；活动周期由用户手动指定。</p>' +
      '</div>';

    // 节点行用 DOM 追加（外壳的 innerHTML 才刚写完，真实 DOM 下此时才能查到容器）
    if (!locked) mountStepRows(t.steps);
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

  /**
   * 任务名单元格。
   * 带节点的任务多一个折叠箭头 + 「进度 n/m」角标；默认折叠（见 pageState.expanded）。
   */
  function nameCell(item) {
    const t = item.template;
    const steps = t.steps || [];

    let toggle = '';
    let badge = '';
    if (steps.length) {
      const open = !!pageState.expanded[t.id];
      const stat = KC.schema.taskStepProgress(t, item.record && item.record.stepProgress);
      toggle = '<button type="button" class="step-toggle" data-act="toggle-steps" data-id="' +
        U.escapeHtml(t.id) + '" aria-expanded="' + (open ? 'true' : 'false') +
        '" title="' + (open ? '收起进度' : '展开进度') + '">' + (open ? '▾' : '▸') + '</button>';
      const manual = isManualDone(t, item.record);
      badge = '<span class="step-badge' + (stat.done >= stat.total ? ' is-full' : '') +
        (manual ? ' is-manual' : '') + '" title="' +
        (manual ? '已完成（未走完节点，或完成后调低了进度）' : '进度 ' + stat.done + '/' + stat.total) + '">' +
        stat.done + '/' + stat.total + '</span>';
    }

    return '<td class="cell-name">' + toggle + '<span class="task-name-text">' +
      U.escapeHtml(t.name) + '</span>' +
      (t.isSystem ? '<span class="tag tag-sys">系统</span>' : '') +
      (t.enabled === false ? '<span class="tag tag-off">已停用</span>' : '') +
      badge +
      '</td>';
  }

  /**
   * 进度面板（展开行）。
   * 每个节点一行：label + [−] n/need [+]。
   * 已完成的任务默认只读，需先取消完成 —— 否则改完进度会出现
   * "节点没满但任务仍显示已完成"的不一致（用户口径：完成状态单调、需显式取消）。
   */
  function stepPanel(item, month) {
    const t = item.template;
    const steps = t.steps || [];
    if (!steps.length || !pageState.expanded[t.id]) return '';

    const progress = (item.record && item.record.stepProgress) || {};
    const editable = progressEditable(t, item.record, month);
    const stat = KC.schema.taskStepProgress(t, progress);

    const rows = steps.map(function (s) {
      const need = Math.max(1, Math.round(Number(s.requiredCount)) || 1);
      const got = Math.min(need, Math.max(0, Math.round(Number(progress[s.code])) || 0));
      const done = KC.schema.isStepDone(s, progress);
      const code = U.escapeHtml(s.code);
      const dis = editable ? '' : ' disabled';

      return '<div class="step-row' + (done ? ' is-done' : '') + '">' +
        '<span class="step-label">' + U.escapeHtml(s.label || s.code) +
          (need > 1 ? '<span class="step-need">×' + need + '</span>' : '') + '</span>' +
        '<span class="step-ctrl">' +
          '<button type="button" class="step-btn" data-act="step-minus" data-id="' + U.escapeHtml(t.id) +
            '" data-code="' + code + '" aria-label="减少一次"' + dis + '>−</button>' +
          '<span class="step-count"' + (dis ? ' title="任务已完成，请先取消完成再调整进度"' : '') + '>' +
            got + ' / ' + need + '</span>' +
          '<button type="button" class="step-btn" data-act="step-plus" data-id="' + U.escapeHtml(t.id) +
            '" data-code="' + code + '" aria-label="增加一次"' + dis + '>＋</button>' +
        '</span>' +
        '</div>';
    }).join('');

    const manual = isManualDone(t, item.record);
    const allSteps = KC.calc.tasks.stepsAllDone(item.record, t) === true;
    let hint;
    if (!editable) {
      // 已完成 ⇒ 节点按钮锁定。这里要说清取消完成之后进度会怎样，
      // 因为它取决于"取消那一刻节点是否全满"（全满则连带清零）。
      hint = allSteps
        ? '任务已完成。取消「完成」会同时重置这些进度记录（本轮视为重新开始）。'
        : '任务已完成，但节点未全部达成 —— 取消「完成」后这些进度会保留，可继续记录。';
    } else if (manual) {
      hint = '这是「已完成」但节点未满的状态（完成后调低了进度）。战果按已计算入，' +
        '要撤销请取消「完成」；补满所有节点即可回到正常完成。';
    } else {
      hint = '点击 ＋ / − 记录达成次数；全部节点达成后任务会自动标记为已完成。';
    }

    return '<td colspan="6" class="cell-steps">' +
      '<div class="step-panel"' + (editable ? '' : ' data-locked="1"') + '>' +
        '<div class="step-panel-head">' +
          '<span>海域攻略进度</span>' +
          '<span class="step-panel-count">' + stat.done + ' / ' + stat.total + ' 节点达成</span>' +
        '</div>' +
        rows +
        '<p class="step-hint">' + hint + '</p>' +
      '</div>' +
      '</td>';
  }

  function renderRow(item, poolSet, month) {
    const t = item.template;
    const hasSteps = !!(t.steps && t.steps.length);
    const disabled = t.enabled === false;
    // 有节点且有进度/完成状态时才画"已完成"底纹，避免 0 进度任务看起来像已完成
    const cls = 'task-row' + (item.completed ? ' is-step-done' : '') + (disabled ? ' is-off' : '');

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

    // 带节点的任务：完成状态由进度推导，但勾选框仍可操作 ——
    // 勾上=直接标记完成（不必走完节点），取消=显式撤回完成（读法 A 要求的唯一回退途径）。
    const checkTitle = hasSteps ? '勾选可直接标记完成；取消勾选即撤回完成（进度会保留）' : '';
    const check =
      '<td class="cell-check">' +
        '<input type="checkbox" data-act="toggle" data-id="' + U.escapeHtml(t.id) + '"' +
          (item.completed ? ' checked' : '') +
          (disabled ? ' disabled' : '') +
          (hasSteps ? ' title="' + checkTitle + '"' : '') +
          ' aria-label="标记完成">' +
      '</td>';

    const main = '<tr class="' + cls + '">' +
      check +
      nameCell(item) +
      '<td class="col-senka">' + U.formatNumber(t.senkaValue) + '</td>' +
      periodCell(item, month) +
      '<td class="cell-check">' +
        '<input type="checkbox" data-act="plan" data-id="' + U.escapeHtml(t.id) + '"' +
          (poolSet.has(t.id) && !item.completed && !disabled ? ' checked' : '') +
          (item.completed || disabled ? ' disabled' : '') +
          ' title="' + (item.completed ? '已完成，不重复计入规划池' : (disabled ? '任务已停用' : '纳入规划池')) + '"' +
          ' aria-label="参与规划">' +
      '</td>' +
      '<td class="cell-actions">' + actions.join('') + '</td>' +
      '</tr>';

    const panel = stepPanel(item, month);
    return main + (panel ? '<tr class="task-steps-row">' + panel + '</tr>' : '');
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

    // 取消完成时，若此刻节点全部达成，取消完成会连带把进度清零（"这一轮重来"）。
    // 这会丢掉用户一条条记下的进度，所以先显式确认；其余情况静默取消。
    let resetProgress = false;
    if (!checked) {
      resetProgress = KC.store.willResetProgressOnUncomplete(id, period.id);
      if (resetProgress) {
        const sure = await KC.confirmDialog({
          title: '取消完成并重置进度',
          message: '「' + template.name + '」的进度节点已全部达成。\n' +
            '取消完成会同时清空这些进度记录，下次需要重新逐项记录。确定继续吗？',
          okText: '取消完成并重置',
          danger: true
        });
        if (!sure) { renderList(); return; }
      }
    }

    // 只有"正在完成当前这一期"才用真实时刻；补录历史周期用落在目标月内的近似时刻，
    // 否则战果会被算到当前月（归属按完成时刻判定，见 docs/04_calculation.md §4.6）。
    const isCurrentPeriod = period.id === KC.calc.tasks.periodOf(template, now).id;
    const at = isCurrentPeriod ? now : backfillAt(month, period);

    try {
      await KC.store.setTaskCompleted(id, period.id, checked, at);
      if (resetProgress) {
        KC.toast('已取消完成，并重置了进度记录：' + template.name, 'ok');
      } else {
        const msg = completeToast(template, checked, now, month, period);
        KC.toast(msg.text, msg.tone);
      }
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

  /**
   * 折叠 / 展开某任务的进度面板（默认折叠）。
   */
  function toggleSteps(id) {
    if (pageState.expanded[id]) delete pageState.expanded[id];
    else pageState.expanded[id] = true;
    renderList();
  }

  /**
   * 调整某任务某个节点的达成次数（Δ = ±1）。
   *
   * 完成状态联动遵循用户口径「读法 A」：节点全达成会自动把任务标为已完成；
   * 而从满进度减回来**不会**自动退回完成状态，需要用户显式取消完成。
   * 归档月份与勾选完成走同一套确认（docs/06_data_strategy.md §4.2）。
   */
  async function bumpStep(id, code, delta) {
    const template = KC.store.getTaskTemplate(id);
    if (!template) return;
    const step = (template.steps || []).filter(function (s) { return s.code === code; })[0];
    if (!step) return;

    const now = new Date();
    const month = planningMonth();
    const period = pickedPeriod(template, month);
    if (!period.id) return;

    const view = itemView(template, month);
    if (!progressEditable(template, view.record, month)) {
      KC.toast('任务已标记完成，请先取消完成再调整进度。', 'error');
      return;
    }

    const need = Math.max(1, Math.round(Number(step.requiredCount)) || 1);
    const progress = (view.record && view.record.stepProgress) || {};
    const cur = Math.min(need, Math.max(0, Math.round(Number(progress[code])) || 0));
    const next = Math.min(need, Math.max(0, cur + delta));
    if (next === cur) return;

    const ok = await KC.confirmArchivedMonth(month, '记录该月任务的攻略进度');
    if (!ok) { renderList(); return; }

    const isCurrentPeriod = period.id === KC.calc.tasks.periodOf(template, now).id;
    const at = isCurrentPeriod ? now : backfillAt(month, period);

    try {
      const before = view.completed;
      const result = await KC.store.setTaskStepProgress(id, period.id, code, next, at);
      const label = step.label || step.code;

      if (!before && result.completed) {
        const msg = completeToast(template, true, now, month, period);
        KC.toast('节点已达成：' + label + '，' + msg.text, msg.tone);
      } else {
        KC.toast('已记录进度：' + label + ' ' + next + ' / ' + need, 'ok');
      }
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
    const editing = pageState.editingId ? KC.store.getTaskTemplate(pageState.editingId) : null;
    // 系统任务只允许改启用状态，不读节点区域（该区域也不会渲染，collectSteps 返回 null）
    const isSystem = !!(editing && editing.isSystem);
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
    if (!isSystem) input.steps = collectSteps();

    KC.store.saveTaskTemplate(input).then(function (saved) {
      pageState.formOpen = false;
      pageState.editingId = null;
      renderForm();
      const n = (saved && saved.steps) ? saved.steps.length : 0;
      KC.toast('已保存任务：' + String(input.name || '').trim() +
        (isSystem ? '' : (n ? '（' + n + ' 个进度节点）' : '')), 'ok');
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
    } else if (act === 'add-step-row') {
      addStepRow();
    } else if (act === 'del-step-row') {
      removeStepRow(btn);
    } else if (act === 'toggle-steps') {
      toggleSteps(btn.dataset.id);
    } else if (act === 'step-plus') {
      bumpStep(btn.dataset.id, btn.dataset.code, 1);
    } else if (act === 'step-minus') {
      bumpStep(btn.dataset.id, btn.dataset.code, -1);
    } else if (act === 'delete-task') {
      deleteTask(btn.dataset.id);
    } else if (act === 'group-plan') {
      groupPlan(btn.dataset.group, btn.dataset.select === '1');
    } else if (act === 'clear-pool') {
      clearPool();
    } else if (act === 'poi-eo-sync') {
      handlePoiEoSync();
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
    // ⚠️ 面板内容**直接写进外壳字符串**（而不是先建空槽再填充）：
    //    ① 首屏不会出现"空槽 → 下一帧才有内容"的闪烁；
    //    ② 假 DOM 不解析 innerHTML，槽位只是个缓存占位元素，往槽里写的内容
    //       在容器字符串里看不到。把它放进外壳，页面级测试才能断言到内容。
    //    后续刷新（renderPoiSlot）才走槽位，避免整页重绘。
    pageState.container.innerHTML =
      pageHead() +
      '<div class="card-grid" id="task-summary"></div>' +
      '<div id="task-poi-slot">' + poiPanel() + '</div>' +
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
        renderPoiSlot();
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
      pageState.expanded = {};
    }
  };
})(window.KC = window.KC || {});
