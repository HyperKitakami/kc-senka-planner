/* ==========================================================================
   ui/pages/periods.js — 周期查询（剩余周期）
   依据 docs/03_data.md §七、docs/04_calculation.md §十二、docs/02_ui.md §4.2。

   定位：只读的时间边界速查页。回答两个问题——
     · 任务什么时候刷新（任务刷新边界，04:00）
     · 战果什么时候结算、现在算哪个月的战果（战果归属边界，13:00 / 21:00）

   两条硬规则：
     1. **两套边界不得混用**，所以本页把它们分成上下两块并列展示，
        而不是合并成一张"周期表"——那正是文档反复警告的错误。
     2. 页面**不自动刷新**（用户选择"只在打开/切换回来时算一次"）。
        所有数值在 render 时一次性算好，页头显示快照时刻，
        另给一个「刷新」按钮；不做秒级倒计时，避免长期停留时持续重绘。
   ========================================================================== */
(function (KC) {
  'use strict';

  const U = KC.utils;

  KC.pages = KC.pages || {};

  const pageState = { container: null };

  let unsubscribe = null;
  let handlers = null;

  /* ------------------------------------------------------------ 小工具 */

  /** 2026-09-30 21:00 */
  function fmtMoment(d) {
    return U.toDateKey(d) + ' ' + U.pad2(d.getHours()) + ':' + U.pad2(d.getMinutes());
  }

  /** 9 月 30 日 21:00 */
  function fmtMomentCn(d) {
    return (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日 ' +
      U.pad2(d.getHours()) + ':' + U.pad2(d.getMinutes());
  }

  /**
   * 剩余时长的可读写法：12 小时 30 分 / 3 天 4 小时 / 已结束。
   * days 取整天数，hours 是去掉整日后的余数小时。
   */
  function fmtRemain(ms) {
    if (!(ms > 0)) return '已结束';
    const totalMin = Math.floor(ms / 60000);
    const days = Math.floor(totalMin / 1440);
    const hours = Math.floor((totalMin - days * 1440) / 60);
    const mins = totalMin % 60;
    if (days > 0) return days + ' 天 ' + hours + ' 小时';
    if (hours > 0) return hours + ' 小时 ' + mins + ' 分';
    return mins + ' 分钟';
  }

  /** 区间长短：396 小时（16.5 天） */
  function fmtSpan(start, end) {
    const ms = end.getTime() - start.getTime();
    const hours = ms / 3600000;
    const days = ms / 86400000;
    return U.formatNumber(hours, hours % 1 === 0 ? 0 : 1) + ' 小时（' +
      U.formatNumber(days, days % 1 === 0 ? 0 : 1) + ' 天）';
  }

  /** 进度条：走过多少 */
  function rail(pct) {
    const v = Math.max(0, Math.min(100, Number(pct) || 0));
    return '<span class="period-rail" role="img" aria-label="区间进度">' +
      '<span class="period-rail-fill" style="width:' + v.toFixed(2) + '%"></span>' +
      '</span>';
  }

  function remainCell(remainMs, pct) {
    return '<div class="period-remain">' + U.escapeHtml(fmtRemain(remainMs)) + '</div>' +
      rail(pct);
  }

  /* -------------------------------------------------------- 一、任务刷新 */

  function taskBlock(data) {
    const rows = data.taskCycles.map(function (row) {
      const rem = row.remainder;
      const idCell = rem
        ? '<code>' + U.escapeHtml(rem.id) + '</code>'
        : '<span class="muted">—</span>';
      const spanCell = rem
        ? '<span class="period-span">' + U.escapeHtml(fmtMoment(rem.start)) + '<br>' +
          '<span class="muted">→ ' + U.escapeHtml(fmtMoment(rem.end)) + '</span></span>'
        : '<span class="muted">无固定边界</span>';
      const remain = rem ? remainCell(rem.remainMs, rem.elapsedPct) : '<span class="muted">—</span>';
      const spanLen = rem
        ? '<span class="muted">' + U.escapeHtml(fmtSpan(rem.start, rem.end)) + '</span>'
        : '<span class="muted">—</span>';

      return '<tr>' +
        '<td><strong>' + U.escapeHtml(row.label) + '</strong><br>' +
          '<span class="muted">' + U.escapeHtml(row.refresh) + '</span></td>' +
        '<td>' + idCell + '</td>' +
        '<td>' + spanCell + '</td>' +
        '<td class="num">' + spanLen + '</td>' +
        '<td>' + remain + '</td>' +
        '</tr>';
    }).join('');

    const yearlyCount = data.taskCycles.filter(function (c) { return c.resetCycle === 'YEARLY'; }).length;
    const notes = data.taskCycles.map(function (row) {
      return '<li><strong>' + U.escapeHtml(row.label) + '</strong>：' + U.escapeHtml(row.note) + '</li>';
    }).join('') +
      '<li><strong>年常区间</strong>：' + U.escapeHtml(KC.calc.periods.YEARLY_TEMPLATE_NOTE) +
      (yearlyCount ? '' : ' 当前<strong>没有年常任务</strong>，所以上面没有年常行。') + '</li>';

    return '<div class="panel">' +
      '<div class="panel-head">' +
        '<h2>任务更新周期</h2>' +
        '<span class="panel-count">任务刷新边界 · 一律 04:00</span>' +
      '</div>' +
      '<p class="panel-desc">决定任务<strong>什么时候刷新</strong>（进入新周期）。' +
        '这个边界<strong>只用于判定任务刷新</strong>，不参与战果归属、所需日均与预测。</p>' +
      '<div class="table-wrap"><table class="data-table period-table">' +
        '<thead><tr>' +
          '<th>周期</th><th>当前周期</th><th>起算 → 结束</th>' +
          '<th class="num">周期长度</th><th>剩余</th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table></div>' +
      '<ul class="period-notes">' + notes + '</ul>' +
      '<p class="form-hint">跨日以 <strong>04:00</strong> 为界而不是 00:00：' +
        '例如 9 月 14 日 03:00 仍属于 9 月 13 日那一期日常。' +
        '季度起点为 3 / 6 / 9 / 12 月，冬季跨年（12、1、2 月）。</p>' +
      '</div>';
  }

  /* -------------------------------------------------------- 二、战果结算 */

  function attributionBlock(data) {
    const a = data.attribution;

    const rows = a.rows.map(function (row) {
      const crossed = row.key === 'TASK' && a.inCutoffGap;
      return '<tr' + (crossed ? ' class="is-next"' : '') + '>' +
        '<td><strong>' + U.escapeHtml(row.label) + '</strong><br>' +
          '<span class="muted">' + U.escapeHtml(row.window) + '</span></td>' +
        '<td><code>' + U.escapeHtml(U.monthLabel(row.month)) + '</code>' +
          (crossed ? '<br><span class="period-flag">已归次月</span>' : '') + '</td>' +
        '<td>' + U.escapeHtml(fmtMoment(row.end)) + '<br>' +
          '<span class="muted">本月末日 ' + U.pad2(row.hours) + ':00</span></td>' +
        '<td>' + remainCell(row.remainMs, row.elapsedPct) + '</td>' +
        '</tr>';
    }).join('');

    const notes = a.rows.map(function (row) {
      return '<li><strong>' + U.escapeHtml(row.label) + '</strong>：' + U.escapeHtml(row.note) + '</li>';
    }).join('');

    // 13:00 ～ 21:00 这段窗口：任务战果已归次月，出击战果还属本月
    let gapAlert = '';
    if (a.inCutoffGap) {
      gapAlert = '<div class="alert alert-warn">' +
        '<strong>当前处于归属切换窗口</strong>（本月末日 13:00 ～ 21:00）：' +
        '现在完成的任务，战果计入 ' + U.escapeHtml(U.monthLabel(a.taskMonth)) +
        '；而打出的出击战果仍计入 ' + U.escapeHtml(U.monthLabel(a.sortieMonth)) + '。' +
        '这正是两套边界必须分开看的原因。</div>';
    }

    const quarterAlert = a.quarterLast
      ? '<div class="alert alert-error"><strong>本月是季度第三月</strong>（2 / 5 / 8 / 11 月）：' +
        '本月末日 13:00 ～ 23:00 完成的<strong>季常任务战果直接失效</strong>，' +
        '既不计入本月也不计入次月，请在末日 13:00 之前完成。</div>'
      : '';

    const revive = a.eoRevive;
    const reviveMs = revive.at.getTime() - data.now.getTime();

    return '<div class="panel">' +
      '<div class="panel-head">' +
        '<h2>战果结算周期</h2>' +
        '<span class="panel-count">战果归属边界 · 13:00 / 21:00</span>' +
      '</div>' +
      '<p class="panel-desc">决定战果<strong>算进哪个月</strong>，以及本月战果什么时候定格。' +
        '三种战果来源的截止时刻不同：出击与 EO 看 <strong>末日 21:00</strong>，' +
        '任务战果看 <strong>末日 13:00</strong>。</p>' +
      '<div class="table-wrap"><table class="data-table period-table">' +
        '<thead><tr>' +
          '<th>战果来源</th><th>当前归属月</th><th>结算时刻</th><th>剩余</th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table></div>' +
      gapAlert +
      quarterAlert +
      '<div class="period-extra">' +
        '<span class="period-extra-label">EO 血条复活</span>' +
        '<span>' + U.escapeHtml(fmtMomentCn(revive.at)) +
          '（' + U.escapeHtml(U.monthLabel(revive.month)) + '末日 23:00）· 还有 ' +
          U.escapeHtml(fmtRemain(reviveMs)) + '</span>' +
      '</div>' +
      '<ul class="period-notes">' + notes + '</ul>' +
      '<p class="form-hint">战果结算时刻为<strong>本月末日 21:00</strong>，' +
        '本月战果在此刻定格（排名与演习榜单在北京时间 02:00 与 14:00 更新）。' +
        '「剩余周期」的日均与预测一律以这个时刻为终点。</p>' +
      '</div>';
  }

  /* -------------------------------------------------------------- 渲染 */

  function render() {
    const host = pageState.container;
    if (!host) return;

    const data = KC.calc.periods.overview(new Date());

    host.innerHTML =
      '<div class="page-head">' +
        '<div>' +
          '<h1>周期查询</h1>' +
          '<p class="page-sub">两套时间边界速查：任务刷新（04:00）与战果结算（末日 13:00 / 21:00）。' +
            '快照时刻 ' + U.escapeHtml(fmtMoment(data.now)) + '</p>' +
        '</div>' +
        '<div class="head-actions">' +
          '<button type="button" class="btn btn-ghost" data-act="refresh-periods">刷新</button>' +
          '<button type="button" class="btn btn-primary" data-act="goto-records">记录今日战果</button>' +
        '</div>' +
      '</div>' +

      taskBlock(data) +
      attributionBlock(data);
  }

  /* -------------------------------------------------------------- 交互 */

  function handleClick(e) {
    const btn = KC.dom.closestFrom(e.target, '[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'refresh-periods') render();
    else if (act === 'goto-records') KC.router.navigate('records');
    else if (act === 'goto-planning') KC.router.navigate('planning');
  }

  /* -------------------------------------------------------------- 生命周期 */

  KC.pages.periods = {
    mount: function (container) {
      pageState.container = container;
      handlers = { click: handleClick };
      container.addEventListener('click', handlers.click);
      // 数据变化（如切换服务器等设置）时重算；本页不写入任何数据
      unsubscribe = KC.store.subscribe(function (type) {
        if (type === 'change') render();
      });
      render();
    },
    unmount: function () {
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
      if (handlers && pageState.container) {
        pageState.container.removeEventListener('click', handlers.click);
      }
      handlers = null;
      pageState.container = null;
    }
  };
})(window.KC = window.KC || {});
