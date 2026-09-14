/* ==========================================================================
   ui/pages/records.js — 战果记录页
   依据 docs/02_ui.md §4.2、docs/01_requirements.md §一。

   职责：
     · 每日出击战果的新增 / 修改 / 删除
     · 按月份浏览历史记录
     · 本月汇总（累计、记录天数、自然日均、单日最高/最低）
   注意：
     · 只记录"当日出击战果"，不含任何任务奖励（docs/06 §1.1）
     · 所有统计均为运行时计算
   ========================================================================== */
(function (KC) {
  'use strict';

  const U = KC.utils;

  KC.pages = KC.pages || {};

  const pageState = {
    container: null,
    month: null,
    editingDate: null
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
        '<td class="cell-num">' + U.formatNumber(r.sortieSenka) + '</td>' +
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
        '<th class="num">当日出击战果</th>' +
        '<th>备注</th>' +
        '<th class="actions">操作</th>' +
      '</tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
      '</table></div>';
  }

  function render() {
    const container = pageState.container;
    if (!container) return;

    const month = pageState.month;
    const summary = KC.calc.stats.monthSummary(KC.store.state.dailyRecords, month, new Date());
    const isCurrentMonth = month === U.monthKeyOf(U.todayKey());

    const editing = pageState.editingDate ? KC.store.getDailyRecord(pageState.editingDate) : null;
    const formDate = editing ? editing.date : (isCurrentMonth ? U.todayKey() : month + '-01');
    const formValue = editing ? editing.sortieSenka : '';
    const formNote = editing ? editing.note : '';

    container.innerHTML =
      '<div class="page-head">' +
        '<div>' +
          '<h1>战果记录</h1>' +
          '<p class="page-sub">记录每日出击战果。EO / EX / 活动等任务战果请在「战果任务」中勾选，不写入每日记录。</p>' +
        '</div>' +
        '<div class="month-switch">' +
          '<button type="button" class="btn btn-icon" data-act="prev-month" title="上个月" aria-label="上个月">‹</button>' +
          '<span class="month-label">' + U.escapeHtml(U.monthLabel(month)) + '</span>' +
          '<button type="button" class="btn btn-icon" data-act="next-month" title="下个月" aria-label="下个月">›</button>' +
          (isCurrentMonth ? '' : '<button type="button" class="btn btn-ghost btn-sm" data-act="this-month">回到本月</button>') +
        '</div>' +
      '</div>' +

      '<div class="card-grid">' +
        statCard('本月累计出击战果', U.formatNumber(summary.total), '共 ' + summary.count + ' 条记录', 'gold') +
        statCard('记录天数', summary.count + ' 天', '已过 ' + summary.elapsedDays + ' 天', '') +
        statCard('自然日均',
          summary.naturalDailyAvg === null ? '数据不足' : U.formatNumber(summary.naturalDailyAvg),
          summary.elapsedDays > 0
            ? '累计 ' + U.formatNumber(summary.total) + ' ÷ 已过 ' + summary.elapsedDays + ' 天'
            : '本期尚未满 1 天，暂无法计算',
          'green') +
        statCard('单日最高', U.formatNumber(summary.max),
          summary.min === null ? '暂无记录' : '单日最低 ' + U.formatNumber(summary.min), 'purple') +
      '</div>' +

      '<div class="panel">' +
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
      '</div>' +

      '<div class="panel">' +
        '<div class="panel-head">' +
          '<h2>本月记录</h2>' +
          '<span class="panel-count">' + summary.count + ' 条</span>' +
        '</div>' +
        renderTable(summary.list) +
      '</div>';
  }

  /* -------------------------------------------------------------- 交互 */

  function scrollToForm() {
    const form = pageState.container && pageState.container.querySelector('#record-form');
    if (form && form.scrollIntoView) form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const input = pageState.container && pageState.container.querySelector('input[name="sortieSenka"]');
    if (input) input.focus();
  }

  /**
   * 若目标月份已归档，按 docs/06_data_strategy.md §4.2 要求用户显式确认，
   * 避免补录 / 修改无声地影响已归档月份的结果。
   */
  async function confirmArchivedMonth(month, action) {
    const archive = KC.store.getArchive(month);
    if (!archive) return true;
    return KC.confirmDialog({
      title: '该月份已归档',
      message: U.monthLabel(month) + ' 已有归档记录（最终战果 ' +
        U.formatNumber(archive.finalSenka) + '）。\n' +
        action + '会改变该月的实时计算结果，但不会自动更新归档快照。确定继续吗？',
      okText: '继续',
      danger: true
    });
  }

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
      const proceed = await confirmArchivedMonth(month, '修改该月记录');
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
    }
  }

  /* -------------------------------------------------------------- 生命周期 */

  KC.pages.records = {
    mount: function (container) {
      pageState.container = container;
      pageState.month = U.monthKeyOf(U.todayKey());
      pageState.editingDate = null;

      handlers = { click: handleClick, submit: handleSubmit };
      container.addEventListener('click', handlers.click);
      container.addEventListener('submit', handlers.submit);

      unsubscribe = KC.store.subscribe(function (type) {
        if (type === 'change') render();
      });

      render();
    },
    unmount: function () {
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
      if (handlers && pageState.container) {
        pageState.container.removeEventListener('click', handlers.click);
        pageState.container.removeEventListener('submit', handlers.submit);
      }
      handlers = null;
      pageState.container = null;
      pageState.editingDate = null;
    }
  };
})(window.KC = window.KC || {});
