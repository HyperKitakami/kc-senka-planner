/* ==========================================================================
   ui/pages/records.js — 战果记录页
   依据 docs/02_ui.md §4.3、docs/01_requirements.md §一。

   职责：
     · 每日出击战果的新增 / 修改 / 删除
     · 按月份浏览历史记录
     · 本月汇总（累计、记录天数、自然日均、单日最高/最低）

   两种录入模式（页头切换，选择存入 settings.recordsMode）：
     · 列表模式：新增/修改表单 + 记录表格（默认）
     · 日历模式：月历表格，格子里直接输入当日出击战果，适合连续快速录入
       回车跳到下一格，Tab 同样按日期顺序前进；清空格子即删除该日记录。

   注意：
     · 只记录"当日出击战果"，不含任何任务奖励（docs/06 §1.1）
     · 所有统计均为运行时计算
     · 日历模式下 store 变更只刷新汇总数字，不重建网格——否则连续录入时输入框会失焦
   ========================================================================== */
(function (KC) {
  'use strict';

  const U = KC.utils;

  KC.pages = KC.pages || {};

  /** 月历表头（周一开头，与 KC.calc.stats.monthCalendar 的 leading 口径一致） */
  const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

  const MODES = [
    { value: 'list',     label: '列表模式' },
    { value: 'calendar', label: '日历模式' }
  ];

  const pageState = {
    container: null,
    month: null,
    editingDate: null,
    /** 录入模式：'list' | 'calendar'，初值取自 settings.recordsMode */
    mode: 'list'
  };

  let unsubscribe = null;
  let handlers = null;

  /* ------------------------------------------------------------ 渲染片段 */

  const statCard = KC.ui.statCard;

  function renderTable(list) {
    if (!list.length) {
      return '<div class="empty-inline">本月还没有记录，先在上方添加一条吧。</div>';
    }
    const today = U.todayKey();
    const rows = list.map(function (r) {
      const isToday = r.date === today;
      return '<tr' + (isToday ? ' class="row-today"' : '') + '>' +
        '<td class="cell-date">' + U.escapeHtml(r.date) +
          (isToday ? '<span class="tag tag-today">今天</span>' : '') + '</td>' +
        '<td class="col-senka">' + U.formatNumber(r.sortieSenka) + '</td>' +
        '<td class="cell-note">' + (r.note ? U.escapeHtml(r.note) : '<span class="muted">—</span>') + '</td>' +
        '<td class="cell-actions">' +
          '<button type="button" class="btn btn-ghost btn-sm" data-act="edit" data-date="' +
            U.escapeHtml(r.date) + '">编辑</button>' +
          '<button type="button" class="btn btn-ghost btn-sm btn-danger-text" data-act="delete" data-date="' +
            U.escapeHtml(r.date) + '">删除</button>' +
        '</td>' +
        '</tr>';
    }).join('');

    return '<div class="table-wrap"><table class="data-table">' +
      '<thead><tr>' +
        '<th>日期</th>' +
        '<th class="col-senka">当日出击战果</th>' +
        '<th>备注</th>' +
        '<th class="actions">操作</th>' +
      '</tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
      '</table></div>';
  }

  /* ------------------------------------------------------------ 页面片段 */

  function pageHead(month, isCurrentMonth) {
    return '<div class="page-head">' +
      '<div>' +
        '<h1>战果记录</h1>' +
        '<p class="page-sub">记录每日出击战果。EO / EX / 活动等任务战果请在「战果任务」中勾选，不写入每日记录。</p>' +
      '</div>' +
      '<div class="head-tools">' +
        '<div class="segmented" role="group" aria-label="录入模式">' +
          MODES.map(function (m) {
            return '<button type="button" data-act="mode" data-mode="' + m.value + '"' +
              (pageState.mode === m.value ? ' class="active"' : '') + '>' +
              U.escapeHtml(m.label) + '</button>';
          }).join('') +
        '</div>' +
        '<div class="month-switch">' +
          '<button type="button" class="btn btn-icon" data-act="prev-month" title="上个月" aria-label="上个月">‹</button>' +
          '<span class="month-label">' + U.escapeHtml(U.monthLabel(month)) + '</span>' +
          '<button type="button" class="btn btn-icon" data-act="next-month" title="下个月" aria-label="下个月">›</button>' +
          (isCurrentMonth ? '' : '<button type="button" class="btn btn-ghost btn-sm" data-act="this-month">回到本月</button>') +
        '</div>' +
      '</div>' +
      '</div>';
  }

  function statCards(summary) {
    return statCard('本月累计出击战果', U.formatNumber(summary.total), '共 ' + summary.count + ' 条记录', 'gold') +
      statCard('记录天数', summary.count + ' 天', '已过 ' + summary.elapsedDays + ' 天', '') +
      statCard('自然日均',
        summary.naturalDailyAvg === null ? '数据不足' : U.formatNumber(summary.naturalDailyAvg),
        summary.elapsedDays > 0
          ? '累计 ' + U.formatNumber(summary.total) + ' ÷ 已过 ' + summary.elapsedDays + ' 天'
          : '本期尚未满 1 天，暂无法计算',
        'green') +
      statCard('单日最高', U.formatNumber(summary.max),
        summary.min === null ? '暂无记录' : '单日最低 ' + U.formatNumber(summary.min), 'purple');
  }

  /** 列表模式：新增 / 修改表单 */
  function formPanel(month, isCurrentMonth) {
    const editing = pageState.editingDate ? KC.store.getDailyRecord(pageState.editingDate) : null;
    const formDate = editing ? editing.date : (isCurrentMonth ? U.todayKey() : month + '-01');
    const formValue = editing ? editing.sortieSenka : '';
    const formNote = editing ? editing.note : '';

    return '<div class="panel">' +
        '<div class="panel-head">' +
          '<h2>' + (editing ? '修改记录' : '新增记录') + '</h2>' +
          (editing ? '<span class="tag tag-edit">正在编辑 ' + U.escapeHtml(editing.date) + '</span>' : '') +
        '</div>' +
        '<form class="record-form" id="record-form" novalidate>' +
          '<label class="field">' +
            '<span class="field-label">日期</span>' +
            '<input type="date" name="date" value="' + U.escapeHtml(formDate) + '" required>' +
          '</label>' +
          '<label class="field">' +
            '<span class="field-label">当日出击战果</span>' +
            '<input type="number" name="sortieSenka" step="0.01" min="0" inputmode="decimal" ' +
              'placeholder="例如 12.34" value="' + U.escapeHtml(formValue) + '" required>' +
          '</label>' +
          '<label class="field field-grow">' +
            '<span class="field-label">备注（可选）</span>' +
            '<input type="text" name="note" maxlength="120" placeholder="可选" value="' + U.escapeHtml(formNote) + '">' +
          '</label>' +
          '<div class="form-actions">' +
            '<button type="submit" class="btn btn-primary">' + (editing ? '保存修改' : '新增记录') + '</button>' +
            (editing ? '<button type="button" class="btn btn-ghost" data-act="cancel-edit">取消</button>' : '') +
          '</div>' +
        '</form>' +
        '<p class="form-hint">同一天重复保存会覆盖该日记录；战果精确到小数点后 2 位。</p>' +
      '</div>';
  }

  /** 列表模式：本月记录表格 */
  function tablePanel(summary) {
    return '<div class="panel">' +
        '<div class="panel-head">' +
          '<h2>本月记录</h2>' +
          '<span class="panel-count">' + summary.count + ' 条</span>' +
        '</div>' +
        renderTable(summary.list) +
      '</div>';
  }

  function calendarCountText(cal) {
    return U.monthLabel(cal.monthKey) + ' · 有记录 ' + cal.count + ' 天 · 合计 ' + U.formatNumber(cal.total);
  }

  /**
   * 日历模式：月历快速录入。
   *
   * 结构与首页「战果日历」卡片一致（.cal-head / .cal-grid / .cal-cell），
   * 但格子里的数值是可编辑的 input：失焦即保存、清空即删除。
   * 未来日期不开放——出击战果是已发生的事实，不能提前录入。
   */
  function calendarPanel(month, cal) {
    const head = WEEK_LABELS.map(function (w, i) {
      return '<span' + (i >= 5 ? ' class="is-weekend"' : '') + '>周' + w + '</span>';
    }).join('');

    const blanks = [];
    for (let i = 0; i < cal.leading; i++) blanks.push('<div class="cal-cell is-blank"></div>');

    const cells = cal.cells.map(function (c) {
      const hasValue = c.value !== null;
      const cls = 'cal-cell is-editable' +
        (hasValue ? ' has-value' : '') +
        (c.isToday ? ' is-today' : '') +
        (!c.isToday && c.isFuture ? ' is-future' : '');
      const title = c.date + (c.isFuture
        ? ' · 未来日期，不可录入'
        : ' · 输入当日出击战果，清空即删除该日记录');

      return '<div class="' + cls + '" title="' + U.escapeHtml(title) + '">' +
        '<span class="cal-day">' + c.day + '</span>' +
        '<input type="number" class="cal-input" step="0.01" min="0" inputmode="decimal"' +
          ' data-act="cal-input" data-date="' + U.escapeHtml(c.date) + '"' +
          ' value="' + (hasValue ? U.escapeHtml(c.value) : '') + '"' +
          (c.isFuture ? ' disabled' : '') +
          ' aria-label="' + U.escapeHtml(c.date + ' 当日出击战果') + '">' +
        '</div>';
    }).join('');

    return '<div class="panel">' +
      '<div class="panel-head">' +
        '<h2>月历录入</h2>' +
        '<span class="panel-count" id="cal-count">' + U.escapeHtml(calendarCountText(cal)) + '</span>' +
      '</div>' +
      '<div class="cal-head">' + head + '</div>' +
      '<div class="cal-grid">' + blanks.join('') + cells + '</div>' +
      '<p class="form-hint">在格子里直接输入当日出击战果：<strong>回车</strong>跳到下一格并自动保存，' +
        '<strong>Tab</strong> 按日期顺序前进；清空格子即删除该日记录。未来日期不可录入。' +
        'EO / 任务战果请在「战果任务」中勾选，不计入本表。</p>' +
      '</div>';
  }

  function render() {
    const container = pageState.container;
    if (!container) return;

    const month = pageState.month;
    const now = new Date();
    const summary = KC.calc.stats.monthSummary(KC.store.state.dailyRecords, month, now);
    const isCurrentMonth = month === U.monthKeyOf(U.todayKey());

    container.innerHTML =
      pageHead(month, isCurrentMonth) +
      '<div class="card-grid" id="record-summary">' + statCards(summary) + '</div>' +
      (pageState.mode === 'calendar'
        ? calendarPanel(month, KC.calc.stats.monthCalendar(KC.store.state.dailyRecords, month, now))
        : formPanel(month, isCurrentMonth) + tablePanel(summary));
  }

  /**
   * 日历模式下只刷新汇总数字。
   * 若在这里重建整个页面，正在连续录入的输入框会立刻失焦，回车/Tab 连续录入就断了。
   */
  function refreshSummary() {
    const container = pageState.container;
    if (!container) return;

    const now = new Date();
    const summary = KC.calc.stats.monthSummary(KC.store.state.dailyRecords, pageState.month, now);

    const cards = container.querySelector('#record-summary');
    if (cards) cards.innerHTML = statCards(summary);

    const count = container.querySelector('#cal-count');
    if (count) {
      count.textContent = calendarCountText(
        KC.calc.stats.monthCalendar(KC.store.state.dailyRecords, pageState.month, now)
      );
    }
  }

  /* ---------------------------------------------------- 日历模式：录入 */

  function cellInput(date) {
    const container = pageState.container;
    if (!container) return null;
    return container.querySelector('input[data-act="cal-input"][data-date="' + date + '"]');
  }

  function focusCell(date) {
    const el = cellInput(date);
    if (el && el.focus) { el.focus(); if (el.select) el.select(); }
  }

  function nextDateKey(date) {
    const d = U.parseDateKey(date);
    d.setDate(d.getDate() + 1);
    return U.toDateKey(d);
  }

  function markCell(input, hasValue) {
    const cell = input.parentNode;
    if (cell && cell.classList) cell.classList.toggle('has-value', hasValue);
  }

  /**
   * 保存日历里的一格。
   * 空值 = 删除该日记录；值与已有记录相同则不做无谓写入（避免连续 Tab 时反复写库）。
   * 目标月份已归档时先按 docs/06_data_strategy.md §4.2 要求显式确认。
   */
  async function saveCalendarCell(input) {
    const date = input.dataset.date;
    const existing = KC.store.getDailyRecord(date);
    const text = String(input.value === undefined || input.value === null ? '' : input.value).trim();

    if (text === '' && !existing) return;

    let value = null;
    if (text !== '') {
      value = Number(text);
      if (!isFinite(value) || value < 0) {
        KC.toast('当日出击战果必须是不小于 0 的数字。', 'error');
        input.value = existing ? existing.sortieSenka : '';
        return;
      }
      value = U.round2(value);
      if (existing && Number(existing.sortieSenka) === value) return;
    }

    const ok = await KC.confirmArchivedMonth(U.monthKeyOf(date), '修改该月记录');
    if (!ok) { render(); return; }

    try {
      if (value === null) {
        await KC.store.deleteDailyRecord(date);
        KC.toast('已删除 ' + date + ' 的记录', 'ok');
        markCell(input, false);
      } else {
        await KC.store.saveDailyRecord({
          date: date,
          sortieSenka: value,
          note: existing ? existing.note : ''
        });
        KC.toast('已保存 ' + date + '：' + U.formatNumber(value), 'ok');
        markCell(input, true);
      }
    } catch (err) {
      KC.toast(err.message, 'error');
      input.value = existing ? existing.sortieSenka : '';
      markCell(input, !!existing);
    }
  }

  /* -------------------------------------------------------------- 交互 */

  function handleChange(e) {
    const el = e.target;
    if (!el || !el.dataset) return;
    if (el.dataset.act === 'cal-input') saveCalendarCell(el);
  }

  function handleKeydown(e) {
    const el = e.target;
    if (!el || !el.dataset || el.dataset.act !== 'cal-input') return;
    if (e.key !== 'Enter') return;
    // 回车 = 保存并跳到下一格：把焦点移到下一格会让本格触发 change 从而落库
    e.preventDefault();
    focusCell(nextDateKey(el.dataset.date));
  }

  function scrollToForm() {
    const form = pageState.container && pageState.container.querySelector('#record-form');
    if (form && form.scrollIntoView) form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const input = pageState.container && pageState.container.querySelector('input[name="sortieSenka"]');
    if (input) input.focus();
  }

  /**
   * 若目标月份已归档，按 docs/06_data_strategy.md §4.2 要求用户显式确认，
   * 避免补录 / 修改无声地影响已归档月份的结果。
   * 实现已提到 js/ui/feedback.js（KC.confirmArchivedMonth），战果记录 / 任务 / 规划三页共用。
   */

  async function handleSubmit(e) {
    e.preventDefault();
    const form = e.target;
    if (!form || form.id !== 'record-form') return;

    const data = new FormData(form);
    const input = {
      date: data.get('date'),
      sortieSenka: data.get('sortieSenka'),
      note: data.get('note')
    };

    // 先切换视图月份，使自动重绘落在正确月份（日期非法时保持原月份）
    const dateStr = String(input.date || '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      const month = U.monthKeyOf(dateStr);
      const proceed = await KC.confirmArchivedMonth(month, '修改该月记录');
      if (!proceed) return;
      pageState.month = month;
    }
    pageState.editingDate = null;

    try {
      await KC.store.saveDailyRecord(input);
      KC.toast('已保存 ' + input.date + ' 的记录', 'ok');
    } catch (err) {
      KC.toast(err.message, 'error');
      render();
    }
  }

  async function handleDelete(date) {
    const record = KC.store.getDailyRecord(date);
    const archive = KC.store.getArchive(U.monthKeyOf(date));
    const ok = await KC.confirmDialog({
      title: '删除记录',
      message: '确定删除 ' + date + ' 的记录（当日出击战果 ' +
        U.formatNumber(record ? record.sortieSenka : 0) + '）吗？此操作不可撤销。' +
        (archive
          ? '\n注意：该月已归档（最终战果 ' + U.formatNumber(archive.finalSenka) +
            '），删除会改变实时计算结果，但不会自动更新归档快照。'
          : ''),
      okText: '删除',
      danger: true
    });
    if (!ok) return;
    try {
      await KC.store.deleteDailyRecord(date);
      if (pageState.editingDate === date) pageState.editingDate = null;
      KC.toast('已删除 ' + date, 'ok');
    } catch (err) {
      KC.toast(err.message, 'error');
    }
  }

  function handleClick(e) {
    const btn = KC.dom.closestFrom(e.target, '[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;

    if (act === 'prev-month') {
      pageState.month = U.addMonths(pageState.month, -1);
      pageState.editingDate = null;
      render();
    } else if (act === 'next-month') {
      pageState.month = U.addMonths(pageState.month, 1);
      pageState.editingDate = null;
      render();
    } else if (act === 'this-month') {
      pageState.month = U.monthKeyOf(U.todayKey());
      pageState.editingDate = null;
      render();
    } else if (act === 'edit') {
      pageState.editingDate = btn.dataset.date;
      render();
      scrollToForm();
    } else if (act === 'cancel-edit') {
      pageState.editingDate = null;
      render();
    } else if (act === 'delete') {
      handleDelete(btn.dataset.date);
    } else if (act === 'mode') {
      switchMode(btn.dataset.mode);
    }
  }

  /** 切换录入模式（列表 / 日历），并把选择记到 settings 里，下次打开保持 */
  function switchMode(mode) {
    const next = mode === 'calendar' ? 'calendar' : 'list';
    if (next === pageState.mode) return;
    pageState.mode = next;
    pageState.editingDate = null;
    render();
    KC.store.saveSettings({ recordsMode: next }).catch(function () { /* 仅偏好，失败不阻断 */ });
  }

  /* -------------------------------------------------------------- 生命周期 */

  KC.pages.records = {
    mount: function (container) {
      pageState.container = container;
      pageState.month = U.monthKeyOf(U.todayKey());
      pageState.editingDate = null;
      pageState.mode = KC.store.getSettings().recordsMode === 'calendar' ? 'calendar' : 'list';

      handlers = { click: handleClick, submit: handleSubmit, change: handleChange, keydown: handleKeydown };
      container.addEventListener('click', handlers.click);
      container.addEventListener('submit', handlers.submit);
      container.addEventListener('change', handlers.change);
      container.addEventListener('keydown', handlers.keydown);

      unsubscribe = KC.store.subscribe(function (type) {
        if (type !== 'change') return;
        // 日历模式只刷新汇总数字：重建页面会让正在连续录入的输入框失焦
        if (pageState.mode === 'calendar') refreshSummary();
        else render();
      });

      render();
    },
    unmount: function () {
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
      if (handlers && pageState.container) {
        pageState.container.removeEventListener('click', handlers.click);
        pageState.container.removeEventListener('submit', handlers.submit);
        pageState.container.removeEventListener('change', handlers.change);
        pageState.container.removeEventListener('keydown', handlers.keydown);
      }
      handlers = null;
      pageState.container = null;
      pageState.editingDate = null;
    }
  };
})(window.KC = window.KC || {});
