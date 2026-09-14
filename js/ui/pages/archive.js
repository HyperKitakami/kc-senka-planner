/* ==========================================================================
   ui/pages/archive.js — 历史归档页
   依据 docs/02_ui.md §4.6、docs/01_requirements.md §五、docs/03_data.md Archive、
        docs/06_data_strategy.md §2.2 / §4.2。

   职责：
     · 保存每月最终结果（最终战果、排名、奖励区间、奖励线、奖励装备、奖励时间、备注）
     · 长期查询：列表 + 详情
   注意：
     · Archive 仅作结果快照，**不作为统计计算来源**（页面会同时展示实时计算值以便对照）
     · 月度最终战果以当月末日 21:00 的战果结算为准
   ========================================================================== */
(function (KC) {
  'use strict';

  const U = KC.utils;

  KC.pages = KC.pages || {};

  const pageState = {
    container: null,
    formOpen: false,
    editingMonth: null,    // null = 新建
    selectedMonth: null
  };

  let unsubscribe = null;
  let handlers = null;

  /* ------------------------------------------------------------ 小工具 */

  function slot(id) {
    return pageState.container ? pageState.container.querySelector('#' + id) : null;
  }

  function tierOf(key) {
    return KC.schema.REWARD_TIERS.filter(function (t) { return t.key === key; })[0] || null;
  }

  function tierShort(key) {
    const t = tierOf(key);
    return t ? t.label.split('（')[0] : null;
  }

  function fmtDate(value) {
    if (!value) return '—';
    return String(value);
  }

  function fmtDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return U.toDateKey(d) + ' ' + U.pad2(d.getHours()) + ':' + U.pad2(d.getMinutes());
  }

  /** 按当前原始记录实时计算某月的结算战果（仅用于对照展示） */
  function calcFinalSenka(month) {
    return KC.calc.plan.forMonth(KC.store, month, new Date(), { mode: 'actual', poolIds: [] }).actualSenka;
  }

  function diffHtml(diff) {
    if (diff === null || diff === undefined) return '';
    const cls = diff >= 0 ? 'pos' : 'neg';
    const sign = diff >= 0 ? '+' : '';
    return '<em class="diff ' + cls + '">' + sign + U.formatNumber(diff) + '</em>';
  }

  /* -------------------------------------------------------------- 渲染 */

  function renderStats() {
    const host = slot('archive-stats');
    if (!host) return;

    const list = KC.store.listArchives();
    const latest = list[0] || null;
    const best = list.reduce(function (m, a) {
      return (m === null || a.finalSenka > m.finalSenka) ? a : m;
    }, null);
    const total = list.reduce(function (s, a) { return s + a.finalSenka; }, 0);
    const avg = list.length ? U.round2(total / list.length) : null;

    host.innerHTML =
      KC.ui.statCard('已归档月份', list.length + ' 个月',
        latest ? '最近 ' + U.monthLabel(latest.month) : '还没有归档', 'gold') +
      KC.ui.statCard('最近归档战果', latest ? U.formatNumber(latest.finalSenka) : '—',
        latest ? U.monthLabel(latest.month) : '—', 'green') +
      KC.ui.statCard('历史最高战果', best ? U.formatNumber(best.finalSenka) : '—',
        best ? U.monthLabel(best.month) : '—', 'purple') +
      KC.ui.statCard('平均每月战果', avg === null ? '—' : U.formatNumber(avg),
        '共 ' + list.length + ' 个月', '');
  }

  function renderList() {
    const host = slot('archive-list-slot');
    if (!host) return;

    const list = KC.store.listArchives();
    if (!list.length) {
      host.innerHTML = '<div class="panel">' +
        '<div class="panel-head"><h2>归档记录</h2></div>' +
        '<div class="empty-inline">还没有归档记录。点右上角「新建归档」，记录某个月的最终结果。</div>' +
        '</div>';
      return;
    }

    const rows = list.map(function (a) {
      const short = tierShort(a.rewardTier);
      return '<tr' + (a.month === pageState.selectedMonth ? ' class="row-viewing"' : '') + '>' +
        '<td class="cell-date">' + U.escapeHtml(U.monthLabel(a.month)) + '</td>' +
        '<td class="cell-num">' + U.formatNumber(a.finalSenka) + '</td>' +
        '<td class="num">' + (a.rank === null ? '<span class="muted">—</span>' : a.rank) + '</td>' +
        '<td>' + (short
          ? U.escapeHtml(short) + (a.rewardFirst ? '<span class="tag tag-first">人事</span>' : '')
          : '<span class="muted">—</span>') + '</td>' +
        '<td class="num">' + (a.rewardLine === null
          ? '<span class="muted">—</span>'
          : U.formatNumber(a.rewardLine) + diffHtml(a.lineDiff)) + '</td>' +
        '<td class="actions">' +
          '<button type="button" class="btn btn-ghost btn-sm" data-act="view-archive" data-month="' +
            U.escapeHtml(a.month) + '">详情</button>' +
          '<button type="button" class="btn btn-ghost btn-sm" data-act="edit-archive" data-month="' +
            U.escapeHtml(a.month) + '">编辑</button>' +
          '<button type="button" class="btn btn-ghost btn-sm btn-danger-text" data-act="delete-archive" data-month="' +
            U.escapeHtml(a.month) + '">删除</button>' +
        '</td>' +
        '</tr>';
    }).join('');

    host.innerHTML = '<div class="panel">' +
      '<div class="panel-head"><h2>归档记录</h2>' +
        '<span class="panel-count">共 ' + list.length + ' 个月</span></div>' +
      '<div class="table-wrap"><table class="data-table">' +
        '<thead><tr>' +
          '<th>月份</th><th class="num">最终战果</th><th class="num">排名</th>' +
          '<th>奖励区间</th><th class="num">奖励线（差值）</th><th class="actions">操作</th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table></div>' +
      '</div>';
  }

  function renderDetail() {
    const host = slot('archive-detail-slot');
    if (!host) return;

    if (pageState.formOpen || !pageState.selectedMonth) { host.innerHTML = ''; return; }
    const a = KC.store.getArchive(pageState.selectedMonth);
    if (!a) { host.innerHTML = ''; return; }

    const tier = tierOf(a.rewardTier);
    const live = calcFinalSenka(a.month);
    const drift = U.round2(live - a.finalSenka);

    function row(label, value) {
      return '<tr><td>' + U.escapeHtml(label) + '</td><td>' + value + '</td></tr>';
    }

    const rewards = a.rewards.length
      ? '<ul class="reward-list">' + a.rewards.map(function (r) {
          return '<li>' + U.escapeHtml(r) + '</li>';
        }).join('') + '</ul>'
      : '<span class="muted">未记录</span>';

    host.innerHTML = '<div class="panel">' +
      '<div class="panel-head">' +
        '<h2>' + U.escapeHtml(U.monthLabel(a.month)) + ' · 归档详情</h2>' +
        '<div class="panel-tools">' +
          '<button type="button" class="btn btn-ghost btn-sm" data-act="edit-archive" data-month="' +
            U.escapeHtml(a.month) + '">编辑</button>' +
          '<button type="button" class="btn btn-ghost btn-sm" data-act="close-detail">关闭</button>' +
        '</div>' +
      '</div>' +

      '<div class="table-wrap"><table class="data-table detail-table"><tbody>' +
        row('最终战果（末日 21:00 结算）', '<span class="cell-num">' + U.formatNumber(a.finalSenka) + '</span>') +
        row('排名', a.rank === null ? '<span class="muted">未记录</span>' : String(a.rank)) +
        row('奖励区间', tier
          ? U.escapeHtml(tier.label) +
            (a.rewardFirst ? '<span class="tag tag-first">人事</span>' : '') +
            '<div class="detail-note">' + U.escapeHtml(tier.range) +
            (tier.note ? ' · ' + U.escapeHtml(tier.note) : '') + '</div>'
          : '<span class="muted">未记录</span>') +
        row('官方对应奖励线', a.rewardLine === null
          ? '<span class="muted">未记录</span>'
          : U.formatNumber(a.rewardLine) + diffHtml(a.lineDiff)) +
        row('奖励时间', U.escapeHtml(fmtDate(a.rewardAt))) +
        row('奖励装备', rewards) +
        row('月度备注', a.note ? U.escapeHtml(a.note) : '<span class="muted">—</span>') +
        row('归档更新于', U.escapeHtml(fmtDateTime(a.updatedAt))) +
      '</tbody></table></div>' +

      '<p class="form-hint">归档仅作结果快照，不参与统计计算。按当前原始记录实时计算，该月结算战果为 ' +
        U.formatNumber(live) +
        (Math.abs(drift) < 0.005
          ? '，与归档值一致。'
          : '，与归档值相差 ' + (drift > 0 ? '+' : '') + U.formatNumber(drift) +
            '（' + (drift > 0 ? '归档值偏低' : '归档值偏高') + '）。') +
      '</p>' +
      '</div>';
  }

  function renderForm() {
    const host = slot('archive-form-slot');
    if (!host) return;

    if (!pageState.formOpen) { host.innerHTML = ''; return; }

    const editing = pageState.editingMonth ? KC.store.getArchive(pageState.editingMonth) : null;
    if (pageState.editingMonth && !editing) {
      pageState.formOpen = false;
      pageState.editingMonth = null;
      host.innerHTML = '';
      return;
    }

    const a = editing || {
      month: U.addMonths(KC.periods.currentAttributionMonth(new Date()), -1),
      finalSenka: '',
      rank: null,
      rewardTier: null,
      rewardFirst: false,
      rewardLine: null,
      rewards: [],
      rewardAt: null,
      note: ''
    };

    const tierOptions = ['<option value="">未记录</option>'].concat(
      KC.schema.REWARD_TIERS.map(function (t) {
        return '<option value="' + t.key + '"' +
          (t.key === a.rewardTier ? ' selected' : '') + '>' +
          U.escapeHtml(t.label) + '　' + U.escapeHtml(t.range) + '</option>';
      })
    ).join('');

    host.innerHTML = '<div class="panel">' +
      '<div class="panel-head">' +
        '<h2>' + (editing ? '编辑归档' : '新建归档') + '</h2>' +
        '<span class="panel-count">最终战果以当月末日 21:00 结算为准</span>' +
      '</div>' +
      '<form class="task-form" id="archive-form" novalidate>' +

        '<div class="form-row">' +
          '<label class="field">' +
            '<span class="field-label">月份</span>' +
            '<input type="month" name="month" value="' + U.escapeHtml(a.month) + '"' +
              (editing ? ' readonly' : '') + ' required>' +
          '</label>' +
          '<label class="field">' +
            '<span class="field-label">最终战果</span>' +
            '<input type="number" name="finalSenka" step="0.01" min="0" placeholder="例如 3200.00" value="' +
              U.escapeHtml(a.finalSenka === null ? '' : a.finalSenka) + '" required>' +
          '</label>' +
          '<div class="form-actions">' +
            '<button type="button" class="btn btn-ghost" data-act="calc-final">按记录计算</button>' +
          '</div>' +
          '<label class="field">' +
            '<span class="field-label">排名（可选）</span>' +
            '<input type="number" name="rank" min="1" step="1" placeholder="例如 42" value="' +
              U.escapeHtml(a.rank === null ? '' : a.rank) + '">' +
          '</label>' +
        '</div>' +

        '<div class="form-row">' +
          '<label class="field field-grow">' +
            '<span class="field-label">奖励区间</span>' +
            '<select name="rewardTier" data-act="form-tier">' + tierOptions + '</select>' +
          '</label>' +
          '<label class="field" data-cond="combined">' +
            '<span class="field-label">&nbsp;</span>' +
            '<span class="check"><input type="checkbox" name="rewardFirst"' +
              (a.rewardFirst ? ' checked' : '') + '> 联合区间第 1 名（人事）</span>' +
          '</label>' +
          '<label class="field">' +
            '<span class="field-label">官方对应奖励线（可选）</span>' +
            '<input type="number" name="rewardLine" step="0.01" min="0" placeholder="留空 = 未记录" value="' +
              U.escapeHtml(a.rewardLine === null ? '' : a.rewardLine) + '">' +
          '</label>' +
          '<label class="field">' +
            '<span class="field-label">奖励时间（可选）</span>' +
            '<input type="date" name="rewardAt" value="' + U.escapeHtml(a.rewardAt || '') + '">' +
          '</label>' +
        '</div>' +

        '<label class="field">' +
          '<span class="field-label">奖励装备（每行一条）</span>' +
          '<textarea name="rewards" rows="3" placeholder="每行一件装备">' +
            U.escapeHtml(a.rewards.join('\n')) + '</textarea>' +
        '</label>' +

        '<label class="field">' +
          '<span class="field-label">月度备注</span>' +
          '<textarea name="note" rows="2" maxlength="300" placeholder="可选">' +
            U.escapeHtml(a.note) + '</textarea>' +
        '</label>' +

        '<div class="form-actions">' +
          '<button type="submit" class="btn btn-primary">保存归档</button>' +
          '<button type="button" class="btn btn-ghost" data-act="cancel-form">取消</button>' +
        '</div>' +
      '</form>' +
      '<p class="form-hint">排名与官方奖励线均为可选记录。奖励区间按最终排名划分：' +
        '联合 1～5 / 一群 6～20 / 二群 21～100 / 三群 101～500；特务与田选奖励同三群。</p>' +
      '</div>';

    toggleFormConditional(a.rewardTier);
  }

  function toggleFormConditional(tierKey) {
    const host = slot('archive-form-slot');
    if (!host) return;
    KC.dom.qsa('[data-cond]', host).forEach(function (el) {
      el.hidden = el.dataset.cond !== tierKey;
    });
  }

  function renderAll() {
    renderStats();
    renderList();
    renderDetail();
  }

  /* -------------------------------------------------------------- 交互 */

  async function doCalcFinal() {
    const host = slot('archive-form-slot');
    if (!host) return;
    const monthInput = host.querySelector('input[name="month"]');
    const finalInput = host.querySelector('input[name="finalSenka"]');
    if (!monthInput || !finalInput) return;

    const month = String(monthInput.value || '').trim();
    if (!/^\d{4}-\d{2}$/.test(month)) {
      KC.toast('请先选择月份。', 'error');
      return;
    }
    finalInput.value = calcFinalSenka(month);
    KC.toast('已按当前记录填入结算战果', 'ok');
  }

  function handleSubmit(e) {
    e.preventDefault();
    const form = e.target;
    if (!form || form.id !== 'archive-form') return;

    const fd = new FormData(form);
    const input = {
      month: fd.get('month'),
      finalSenka: fd.get('finalSenka'),
      rank: fd.get('rank'),
      rewardTier: fd.get('rewardTier'),
      rewardFirst: fd.get('rewardFirst') === 'on',
      rewardLine: fd.get('rewardLine'),
      rewardAt: fd.get('rewardAt'),
      rewards: String(fd.get('rewards') || '').split('\n')
        .map(function (s) { return s.trim(); })
        .filter(Boolean),
      note: fd.get('note')
    };

    KC.store.saveArchive(input).then(function (record) {
      pageState.formOpen = false;
      pageState.editingMonth = null;
      pageState.selectedMonth = record.month;
      renderForm();
      renderAll();
      KC.toast('已保存 ' + U.monthLabel(record.month) + ' 的归档', 'ok');
    }).catch(function (err) {
      KC.toast(err.message, 'error');
    });
  }

  async function doDelete(month) {
    const a = KC.store.getArchive(month);
    const ok = await KC.confirmDialog({
      title: '删除归档',
      message: '确定删除 ' + U.monthLabel(month) + ' 的归档记录吗？' +
        '（该月的每日记录与任务记录不会被删除，仅移除归档快照。）此操作不可撤销。',
      okText: '删除',
      danger: true
    });
    if (!ok) return;
    try {
      await KC.store.deleteArchive(month);
      if (pageState.selectedMonth === month) pageState.selectedMonth = null;
      if (pageState.editingMonth === month) { pageState.formOpen = false; pageState.editingMonth = null; }
      renderForm();
      renderAll();
      KC.toast('已删除 ' + U.monthLabel(month) + ' 的归档', 'ok');
    } catch (err) {
      KC.toast(err.message, 'error');
    }
  }

  function handleClick(e) {
    const btn = KC.dom.closestFrom(e.target, '[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;

    if (act === 'new-archive') {
      pageState.formOpen = true;
      pageState.editingMonth = null;
      pageState.selectedMonth = null;
      renderForm();
      renderDetail();
      const first = slot('archive-form-slot') &&
        slot('archive-form-slot').querySelector('input[name="month"]');
      if (first) first.focus();
    } else if (act === 'edit-archive') {
      pageState.formOpen = true;
      pageState.editingMonth = btn.dataset.month;
      renderForm();
      renderDetail();
    } else if (act === 'view-archive') {
      pageState.selectedMonth = btn.dataset.month;
      pageState.formOpen = false;
      pageState.editingMonth = null;
      renderForm();
      renderList();
      renderDetail();
    } else if (act === 'close-detail') {
      pageState.selectedMonth = null;
      renderList();
      renderDetail();
    } else if (act === 'cancel-form') {
      pageState.formOpen = false;
      pageState.editingMonth = null;
      renderForm();
      renderDetail();
    } else if (act === 'delete-archive') {
      doDelete(btn.dataset.month);
    } else if (act === 'calc-final') {
      doCalcFinal();
    }
  }

  function handleChange(e) {
    const el = e.target;
    if (!el || !el.dataset) return;
    if (el.dataset.act === 'form-tier') toggleFormConditional(el.value);
  }

  /* -------------------------------------------------------------- 生命周期 */

  function buildShell() {
    pageState.container.innerHTML =
      '<div class="page-head">' +
        '<div>' +
          '<h1>历史归档</h1>' +
          '<p class="page-sub">保存每月最终结果（最终战果、排名、奖励区间与奖励装备），供长期查询。' +
            '归档仅作快照，不参与统计计算。</p>' +
        '</div>' +
        '<button type="button" class="btn btn-primary" data-act="new-archive">+ 新建归档</button>' +
      '</div>' +
      '<div class="card-grid" id="archive-stats"></div>' +
      '<div id="archive-form-slot"></div>' +
      '<div id="archive-detail-slot"></div>' +
      '<div id="archive-list-slot"></div>';
  }

  KC.pages.archive = {
    mount: function (container) {
      pageState.container = container;
      pageState.formOpen = false;
      pageState.editingMonth = null;
      pageState.selectedMonth = null;

      handlers = { click: handleClick, change: handleChange, submit: handleSubmit };
      container.addEventListener('click', handlers.click);
      container.addEventListener('change', handlers.change);
      container.addEventListener('submit', handlers.submit);

      unsubscribe = KC.store.subscribe(function (type) {
        if (type !== 'change') return;
        renderAll();
        if (pageState.formOpen) renderForm();
      });

      buildShell();
      renderAll();
      renderForm();
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
      pageState.editingMonth = null;
      pageState.selectedMonth = null;
    }
  };
})(window.KC = window.KC || {});
