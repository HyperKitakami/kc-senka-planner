/* ==========================================================================
   ui/pages/planning.js — 战果规划页
   依据 docs/02_ui.md §4.4、docs/01_requirements.md §二、docs/04_calculation.md §六~§十三。

   职责：
     · 目标设定（继承战果 / 月目标 / 月备注）
     · 规划计算展示：当前目标、剩余目标、自然日均、所需日均、预计月底战果、剩余周期
     · 展示口径切换（实际统计 / 综合进度）—— 仅影响显示，不影响数据存储
     · 预测方式切换（最近 3 / 7 / 14 / 30 天、当前周期平均）
     · 切换「战果归属月」以补录历史月份的继承战果 / 月目标
       （docs/04_calculation.md §十五、docs/06_data_strategy.md §4.1）

   注意：本页只读取与展示，所有数字均为运行时计算，不写入数据库
        （唯一写入的是 MonthlyContext 与 Settings 中的参数与偏好）。
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

  const pageState = {
    container: null,
    /** 当前查看的「战果归属月」；null = 本月。切换后即可补录该月的继承战果 / 月目标 */
    month: null
  };

  let unsubscribe = null;
  let handlers = null;

  /* ------------------------------------------------------------ 小工具 */

  function planningMonth() {
    return pageState.month || KC.periods.currentAttributionMonth(new Date());
  }

  function slot(id) {
    return pageState.container ? pageState.container.querySelector('#' + id) : null;
  }

  function fmtDateTime(d) {
    return U.toDateKey(d) + ' ' + U.pad2(d.getHours()) + ':' + U.pad2(d.getMinutes());
  }

  /**
   * 当前查看的归属月的规划结果（切到历史月即为该月的回看 / 补录）。
   * 规划池用展示口径：历史月没保存过规划池时为空，不凭空捏造"已规划战果"。
   */
  function currentPlan() {
    const now = new Date();
    const month = planningMonth();
    return KC.calc.plan.forMonth(KC.store, month, now, {
      poolIds: KC.calc.plan.displayPoolIds(KC.store, month, now)
    });
  }

  /* -------------------------------------------------------------- 渲染 */

  const statCard = KC.ui.statCard;
  const remainText = KC.ui.remainText;

  function naturalDailyText(plan) {
    return plan.naturalDailyAvg === null ? '数据不足' : U.formatNumber(plan.naturalDailyAvg);
  }

  function naturalDailySub(plan) {
    if (plan.elapsedDays <= 0) return '本期尚未满 1 天，暂无法计算';
    return '累计出击 ' + U.formatNumber(plan.sortieTotal) + ' ÷ 已过 ' + plan.elapsedDays + ' 天';
  }

  function remainSub(plan) {
    if (!(plan.remainingDaysExact > 0)) return '本期已结束（末日 21:00 结算）';
    return '精确剩余 ' + remainText(plan.remainingDaysExact) + ' · 截至本月末日 21:00';
  }

  function requiredDailyText(plan) {
    if (plan.targetSenka === null) return '—';
    if (plan.requiredDaily === null) return '—';
    return U.formatNumber(plan.requiredDaily);
  }

  function requiredDailySub(plan) {
    if (plan.targetSenka === null) return '未设定月目标';
    if (plan.gap !== null && plan.gap <= 0) return '目标已达成';
    if (plan.requiredDaily === null) return '本期已结束，无法达成';
    return '剩余 ' + U.formatNumber(plan.gap) + ' ÷ ' + plan.remainingDays + ' 天';
  }

  function progressPanel(plan) {
    const modeText = plan.mode === 'combined' ? '综合进度口径' : '实际统计口径';
    const targetText = plan.targetSenka === null
      ? '未设定月目标'
      : '完成率 ' + U.formatNumber(plan.completion, 1) + '% · ' + modeText;

    return '<div class="panel">' +
      '<div class="panel-head">' +
        '<h2>战果进度</h2>' +
        '<span class="panel-count">' + U.escapeHtml(targetText) + '</span>' +
      '</div>' +
      KC.ui.senkaProgress(plan) +
      '</div>';
  }

  function detailPanel(plan) {
    const target = plan.targetSenka;
    const gapActual = target === null ? null : Math.max(0, U.round2(target - plan.actualSenka));
    const gapPlanned = target === null ? null : Math.max(0, U.round2(target - plan.plannedSenka));

    function row(label, value, cls) {
      return '<tr' + (cls ? ' class="' + cls + '"' : '') + '>' +
        '<td>' + U.escapeHtml(label) + '</td>' +
        '<td class="num">' + U.escapeHtml(value) + '</td>' +
        '</tr>';
    }

    return '<div class="panel">' +
      '<div class="panel-head"><h2>战果构成</h2>' +
        '<span class="panel-count">' + U.escapeHtml(U.monthLabel(plan.month)) + '</span></div>' +
      '<div class="table-wrap"><table class="data-table detail-table">' +
        '<tbody>' +
          row('继承战果', U.formatNumber(plan.inheritedSenka)) +
          row('累计出击战果', U.formatNumber(plan.sortieTotal)) +
          row('已完成 EO 战果', U.formatNumber(plan.eoCompleted)) +
          row('已完成任务战果', U.formatNumber(plan.taskCompleted)) +
          row('实际战果小计', U.formatNumber(plan.actualSenka), 'is-sum') +
          row('规划池待完成（' + plan.poolPendingCount + ' 项）', U.formatNumber(plan.poolSenka)) +
          row('规划战果合计', U.formatNumber(plan.plannedSenka), 'is-sum') +
          row('月目标', target === null ? '未设定' : U.formatNumber(target)) +
          row('剩余目标（实际口径）', gapActual === null ? '—' : U.formatNumber(gapActual)) +
          row('剩余目标（综合口径）', gapPlanned === null ? '—' : U.formatNumber(gapPlanned)) +
        '</tbody>' +
      '</table></div>' +
      '</div>';
  }

  function poolPanel(plan) {
    const gotoBtn = '<button type="button" class="btn btn-ghost btn-sm" data-act="goto-tasks">去战果任务调整</button>';
    const items = plan.pendingItems || [];

    if (!items.length) {
      return '<div class="panel">' +
        '<div class="panel-head"><h2>规划池</h2>' + gotoBtn + '</div>' +
        '<div class="empty-inline">规划池为空。到「战果任务」勾选计划完成的任务，规划结果会实时更新。</div>' +
        '</div>';
    }

    return '<div class="panel">' +
      '<div class="panel-head"><h2>规划池待完成</h2>' + gotoBtn + '</div>' +
      '<div class="pool-list">' +
        items.map(function (it) {
          return '<span class="pool-chip">' + U.escapeHtml(it.template.name) +
            '<em>' + U.formatNumber(it.template.senkaValue) + '</em></span>';
        }).join('') +
      '</div>' +
      '<p class="form-hint">合计 ' + U.formatNumber(plan.poolSenka) +
        ' 战果；已完成任务不会重复计入规划池。</p>' +
      '</div>';
  }

  function renderTop() {
    const host = slot('plan-top');
    if (!host) return;
    const plan = currentPlan();
    const modeLabel = plan.mode === 'combined' ? '综合进度口径' : '实际统计口径';

    host.innerHTML =
      progressPanel(plan) +
      '<div class="card-grid">' +
        statCard('当前实际战果', U.formatNumber(plan.actualSenka), '已真实获得', 'gold') +
        statCard('当前规划战果', U.formatNumber(plan.plannedSenka),
          '含规划池 ' + U.formatNumber(plan.poolSenka), 'green') +
        statCard('月目标',
          plan.targetSenka === null ? '未设定' : U.formatNumber(plan.targetSenka),
          plan.completion === null ? '在下方设定月目标' : '完成率 ' + U.formatNumber(plan.completion, 1) + '%',
          'purple') +
        statCard('剩余目标',
          plan.gap === null ? '—' : U.formatNumber(Math.max(0, plan.gap)),
          modeLabel, '') +
      '</div>' +
      '<div class="card-grid">' +
        statCard('当前自然日均', naturalDailyText(plan), naturalDailySub(plan), '') +
        statCard('所需日均', requiredDailyText(plan), requiredDailySub(plan), '') +
        statCard('预计月底' + (plan.mode === 'combined' ? '综合' : '') + '战果',
          U.formatNumber(plan.mode === 'combined' ? plan.forecastEndPlanned : plan.forecastEndActual),
          '预测日均 ' + U.formatNumber(plan.forecastDaily) + ' × 剩余 ' + plan.remainingDays + ' 天', 'green') +
        statCard('剩余周期', plan.remainingDays + ' 天', remainSub(plan), 'purple') +
      '</div>' +
      detailPanel(plan) +
      poolPanel(plan);
  }

  function renderSub() {
    const el = slot('plan-sub');
    if (!el) return;
    const month = planningMonth();
    el.textContent = '战果归属月 ' + U.monthLabel(month) +
      ' · 战果归属区间 ' + fmtDateTime(KC.periods.attributionStart(month)) +
      ' ～ ' + fmtDateTime(KC.periods.attributionEnd(month));
  }

  function renderForm() {
    const host = slot('plan-form-slot');
    if (!host) return;

    const month = planningMonth();
    const ctx = KC.store.getMonthlyContext(month) || KC.schema.createMonthlyContext(month);
    const settings = KC.store.getSettings();
    const predValue = settings.predictionMode === 'period'
      ? 'period' : 'recent:' + (settings.predictionDays || 7);

    function field(label, control, extra) {
      return '<label class="field' + (extra ? ' ' + extra : '') + '">' +
        '<span class="field-label">' + U.escapeHtml(label) + '</span>' + control + '</label>';
    }

    const targetValue = (ctx.targetSenka === null || ctx.targetSenka === undefined) ? '' : ctx.targetSenka;

    host.innerHTML =
      '<div class="panel">' +
        '<div class="panel-head"><h2>规划参数</h2>' +
          '<span class="panel-count">' + U.escapeHtml(U.monthLabel(month)) + '</span></div>' +
        '<form class="task-form" id="plan-form" novalidate>' +
          '<div class="form-row">' +
            field('继承战果',
              '<input type="number" name="inheritedSenka" step="0.01" min="0" value="' +
                U.escapeHtml(ctx.inheritedSenka || 0) + '">') +
            field('月目标战果',
              '<input type="number" name="targetSenka" step="0.01" min="0" placeholder="留空 = 未设定" value="' +
                U.escapeHtml(targetValue) + '">') +
            field('月备注',
              '<input type="text" name="note" maxlength="120" placeholder="可选" value="' +
                U.escapeHtml(ctx.note || '') + '">', 'field-grow') +
            field('预测方式',
              '<select name="prediction">' +
                PREDICTION_OPTIONS.map(function (o) {
                  return '<option value="' + o.value + '"' +
                    (o.value === predValue ? ' selected' : '') + '>' + U.escapeHtml(o.label) + '</option>';
                }).join('') +
              '</select>') +
          '</div>' +
          '<div class="form-actions">' +
            '<button type="submit" class="btn btn-primary">保存参数</button>' +
          '</div>' +
        '</form>' +
        '<p class="form-hint">继承战果会计入该月的实际战果，可切到历史月份补录；月目标仅用于规划，不影响历史统计。' +
          '继承战果每月仅一个值；每年 12 月末清零，次年 1 月为 0。' +
          '所需日均与预计月底战果的终点均为本月末日 21:00（战果结算时刻）。</p>' +
      '</div>';
  }

  function updateModeButtons() {
    const box = slot('mode-switch');
    if (!box) return;
    const mode = KC.store.getSettings().planningMode === 'combined' ? 'combined' : 'actual';
    KC.dom.qsa('button[data-act="mode"]', box).forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    });
  }

  /* -------------------------------------------------------------- 交互 */

  async function handleSubmit(e) {
    e.preventDefault();
    const form = e.target;
    if (!form || form.id !== 'plan-form') return;

    const fd = new FormData(form);
    const month = planningMonth();

    const inherited = Number(fd.get('inheritedSenka'));
    if (!isFinite(inherited) || inherited < 0) {
      KC.toast('继承战果必须是不小于 0 的数字。', 'error');
      return;
    }

    const targetRaw = String(fd.get('targetSenka') || '').trim();
    let target = null;
    if (targetRaw !== '') {
      const t = Number(targetRaw);
      if (!isFinite(t) || t < 0) {
        KC.toast('月目标必须是不小于 0 的数字。', 'error');
        return;
      }
      target = U.round2(t);
    }

    const pred = String(fd.get('prediction') || 'recent:7');
    const predictionMode = pred === 'period' ? 'period' : 'recent';
    const predictionDays = pred === 'period' ? 7 : (Number(pred.split(':')[1]) || 7);

    // 补录历史月份时，若该月已归档，按 docs/06_data_strategy.md §4.2 要求显式确认
    const ok = await KC.confirmArchivedMonth(month, '修改该月继承战果 / 月目标');
    if (!ok) return;

    try {
      await Promise.all([
        KC.store.saveMonthlyContext(month, {
          inheritedSenka: U.round2(inherited),
          targetSenka: target,
          note: String(fd.get('note') || '').trim()
        }),
        KC.store.saveSettings({ predictionMode: predictionMode, predictionDays: predictionDays })
      ]);
      renderForm();
      KC.toast('已保存规划参数（' + U.monthLabel(month) + '）', 'ok');
    } catch (err) {
      KC.toast(err.message, 'error');
    }
  }

  function handleClick(e) {
    const btn = KC.dom.closestFrom(e.target, '[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;

    if (act === 'mode') {
      const mode = btn.dataset.mode === 'combined' ? 'combined' : 'actual';
      if (mode === KC.store.getSettings().planningMode) return;
      KC.store.saveSettings({ planningMode: mode })
        .then(function () { updateModeButtons(); })
        .catch(function (err) { KC.toast(err.message, 'error'); });
    } else if (act === 'goto-tasks') {
      KC.router.navigate('tasks');
    } else if (act === 'prev-month') {
      switchMonth(U.addMonths(planningMonth(), -1));
    } else if (act === 'next-month') {
      switchMonth(U.addMonths(planningMonth(), 1));
    } else if (act === 'this-month') {
      switchMonth(KC.periods.currentAttributionMonth(new Date()));
    }
  }

  /* -------------------------------------------------------------- 生命周期 */

  function buildShell() {
    const month = planningMonth();
    const isCurrent = month === KC.periods.currentAttributionMonth(new Date());

    pageState.container.innerHTML =
      '<div class="page-head">' +
        '<div>' +
          '<h1>战果规划</h1>' +
          '<p class="page-sub" id="plan-sub"></p>' +
        '</div>' +
        '<div class="head-tools">' +
          '<div class="month-switch">' +
            '<button type="button" class="btn btn-icon" data-act="prev-month" title="上个月" aria-label="上个月">‹</button>' +
            '<span class="month-label">' + U.escapeHtml(U.monthLabel(month)) + '</span>' +
            '<button type="button" class="btn btn-icon" data-act="next-month" title="下个月" aria-label="下个月">›</button>' +
            (isCurrent ? '' : '<button type="button" class="btn btn-ghost btn-sm" data-act="this-month">回到本月</button>') +
          '</div>' +
          '<div class="segmented" id="mode-switch" role="group" aria-label="展示口径">' +
            '<button type="button" data-act="mode" data-mode="actual">实际统计口径</button>' +
            '<button type="button" data-act="mode" data-mode="combined">综合进度口径</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div id="plan-top"></div>' +
      '<div id="plan-form-slot"></div>';
  }

  /**
   * 切换「战果归属月」（补录历史继承战果 / 月目标用）。
   * 页头的月份文案要一起更新，所以整页重绘。
   */
  function switchMonth(month) {
    pageState.month = month;
    render();
  }

  /** 整页重绘：挂载时与切换归属月时使用 */
  function render() {
    buildShell();
    renderSub();
    updateModeButtons();
    renderTop();
    renderForm();
  }

  KC.pages.planning = {
    mount: function (container) {
      pageState.container = container;

      handlers = { click: handleClick, submit: handleSubmit };
      container.addEventListener('click', handlers.click);
      container.addEventListener('submit', handlers.submit);

      unsubscribe = KC.store.subscribe(function (type) {
        if (type !== 'change') return;
        updateModeButtons();
        renderSub();
        renderTop();
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
      pageState.month = null;
    }
  };
})(window.KC = window.KC || {});
