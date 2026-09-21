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

   poi 数据同步（docs/... 「poi 数据接入」）：
     · 手动选择 %APPDATA%\roaming\poi\achieve\achieve.json（浏览器沙箱不允许自动读路径）
     · 同步后：空白记录格显示「建议值」（= poi 的当日仅出击+演习战果）
     · 「一键填充空白项」把建议值写进所有**尚未记录**的日期
     · 同步即落一份本月快照（poi 会跨月覆盖，历史只能靠自己存）

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
    mode: 'list',
    /** poi 同步：当前会话里刚读到的原始数据（不落库） */
    poiRaw: null,
    /** poi 同步：最近一次同步的文件名 / 来源说明 */
    poiFileName: '',
    /** poi 同步：同步后是否已把建议值展示出来（两步操作的第一步） */
    poiSynced: false
  };

  let unsubscribe = null;
  let handlers = null;

  /** 推荐给用户手动选择的文件路径（浏览器无法自动读取，只能给参考） */
  const POI_PATH_HINT = '%APPDATA%\\roaming\\poi\\achieve\\achieve.json';

  /* ------------------------------------------------------------ 渲染片段 */

  const statCard = KC.ui.statCard;

  /* -------------------------------------------------------- poi 建议值 */

  /**
   * 取当前页月份的建议值映射 {day: 战果}。
   *
   * 来源优先级：
   *   ① 本次会话刚同步的 live 数据（仅当同步的确实是当前页月份）
   *   ② 该月快照
   * 都没有 → 返回 null（面板会提示先同步）。
   *
   * 「同步的是不是当前页月份」无法从文件本身判断（poi 不给月份），
   * 所以以**用户同步时所在页面月份**为准，见 handlePoiSync。
   */
  function poiAdviceMap() {
    const month = pageState.month;
    if (!month) return null;

    if (pageState.poiSynced && pageState.poiRaw) {
      const days = KC.poiData.monthDays(month);
      const series = KC.poiSource.dailySeries(pageState.poiRaw, days, { mode: 'sortie' });
      return toDayMap(series);
    }

    const adv = KC.poiData.dailyAdvice(month, null);
    return adv ? toDayMap(adv.series) : null;
  }

  function toDayMap(series) {
    const map = {};
    (series || []).forEach(function (p) {
      if (p.hasData && p.value > 0) map[p.day] = p.value;
    });
    return map;
  }

  /** 建议值来源的可读说明（面板顶部展示） */
  function poiSourceLabel() {
    if (pageState.poiSynced && pageState.poiRaw) {
      const s = KC.poiSource.summary(pageState.poiRaw);
      return {
        state: 'live',
        text: '已同步' + (pageState.poiFileName ? '（' + pageState.poiFileName + '）' : '') +
          ' · 当前战果 ' + U.formatNumber(s.mySenka) +
          ' · 已完成 EO ' + s.eo.doneCount + '/' + s.eo.list.length
      };
    }
    const snap = KC.poiData.readSnapshot(pageState.month);
    if (snap) {
      return {
        state: 'snapshot',
        text: '来自本月快照 · 同步于 ' + fmtSyncTime(snap.syncedAt) +
          (snap.fileName ? '（' + snap.fileName + '）' : '')
      };
    }
    return { state: 'none', text: '' };
  }

  function fmtSyncTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return U.toDateKey(d) + ' ' + U.pad2(d.getHours()) + ':' + U.pad2(d.getMinutes());
  }

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

  /**
   * 未记录日期的清单（用于 poi 建议值）。
   * 只统计**本月已过去的日期**（未来日期不产生建议值，poi 也没有那天的数据）。
   * @returns {Array<{date:string, day:number, value:number}>} 升序
   */
  function pendingAdvice() {
    const advice = poiAdviceMap();
    if (!advice) return [];

    const month = pageState.month;
    const isCurrentMonth = month === U.monthKeyOf(U.todayKey());
    const days = KC.poiData.monthDays(month);
    const todayDay = isCurrentMonth ? Number(U.todayKey().slice(8)) : days;

    const out = [];
    for (let day = 1; day <= days; day++) {
      if (day > todayDay) break;                       // 未来日期不给建议
      if (!(day in advice)) continue;                  // poi 也没这天的数据
      const date = month + '-' + U.pad2(day);
      if (KC.store.getDailyRecord(date)) continue;     // 已有记录 → 不是空白项
      out.push({ date: date, day: day, value: advice[day] });
    }
    return out;
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
   * poi 数据同步面板。
   *
   * 两步操作（用户指定）：
   *   ① 「同步 poi 数据」——选文件、解析、把建议值显示到下方空白项里
   *   ② 「一键填充空白项」——把建议值实际写库
   *
   * 未同步时只显示说明 + 参考路径；同步后面板变成摘要 + 填充按钮。
   */
  function poiPanel() {
    return '<div class="panel poi-panel">' +
      '<div class="panel-head"><h2>poi 数据同步</h2>' +
        '<span class="panel-count" id="poi-status">' + U.escapeHtml(poiBadgeText()) + '</span></div>' +
      '<div id="poi-body">' + poiPanelBody() + '</div>' +
      '</div>';
  }

  /**
   * 面板内容（随录入进度可单独刷新，见 refreshSummary）。
   * 结构上刻意不含任何表单控件状态，因此整体替换是安全的。
   */
  function poiPanelBody() {
    const src = poiSourceLabel();
    const advice = poiAdviceMap();
    const pending = pendingAdvice();

    const pathHint = '<div class="poi-path"><span class="field-label">文件位置</span>' +
      '<code>' + U.escapeHtml(POI_PATH_HINT) + '</code></div>';

    const foot = function (extra) {
      return '<div class="panel-foot">' + (extra || '') +
        '<button type="button" class="btn btn-ghost" data-act="poi-pick">' +
        (src.state === 'none' ? '选择 poi 数据文件' : '重新选择文件') + '</button>' +
        '</div>';
    };

    if (src.state === 'none') {
      return '<p class="panel-desc">从 poi 的「战果」插件数据里取出<strong>每日仅出击 + 演习战果</strong>，' +
          '作为本月记录的<strong>建议值</strong>。它不含 EO / 任务战果，与本站「当日出击战果」口径一致。</p>' +
        pathHint +
        '<p class="form-hint">浏览器不允许网页自动读取本地路径，需要你手动选择该文件。' +
          '若改动过 poi 数据目录，请按实际位置选择。</p>' +
        '<p class="form-hint">本按钮走浏览器<strong>原生文件对话框</strong>，' +
          '可以正常选中 <code>%APPDATA%</code> 下的该文件。' +
          '若系统仍提示「无法打开，因为含有系统文件」，' +
          '把 <code>achieve.json</code> 复制到桌面等普通目录后再选择即可。</p>' +
        foot();
    }

    const hasAdvice = advice && Object.keys(advice).length > 0;
    const statusText = !hasAdvice
      ? '已同步，但本月还没有可用的每日出击数据'
      : (pending.length
          ? '可填充 ' + pending.length + ' 个空白日期'
          : '所有已过去的日期都已有记录');

    const preview = pending.slice(0, 12).map(function (p) {
      return '<span class="poi-chip">' + U.escapeHtml(p.date.slice(5)) +
        '<em>' + U.formatNumber(p.value) + '</em></span>';
    }).join('') + (pending.length > 12 ? '<span class="muted">…等 ' + pending.length + ' 项</span>' : '');

    return '<p class="panel-desc' + (src.state === 'snapshot' ? ' is-warn' : '') + '">' +
        U.escapeHtml(src.text) + '</p>' +
      '<p class="poi-status-line">' + U.escapeHtml(statusText) + '</p>' +
      (hasAdvice
        ? (pending.length
            ? '<div class="poi-preview">' + preview + '</div>' +
              '<p class="form-hint">以上为<strong>尚未记录</strong>日期的建议值，' +
                '点「一键填充空白项」写入。已有记录的日期<strong>不会被覆盖</strong>。</p>'
            : '<p class="form-hint">本月已过去的日期都已有记录，无需填充。</p>')
        : '<p class="form-hint">poi 侧本月可能还没有采样数据（需要先在 po 里刷新一次战果），' +
          '或该月已有快照但内容为空。</p>') +
      foot(pending.length
        ? '<button type="button" class="btn btn-primary" data-act="poi-fill">' +
            '一键填充空白项（' + pending.length + ' 天）</button>'
        : '');
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

    const advice = poiAdviceMap();

    const blanks = [];
    for (let i = 0; i < cal.leading; i++) blanks.push('<div class="cal-cell is-blank"></div>');

    const cells = cal.cells.map(function (c) {
      const hasValue = c.value !== null;
      const adv = advice && advice[c.day];
      const cls = 'cal-cell is-editable' +
        (hasValue ? ' has-value' : '') +
        (c.isToday ? ' is-today' : '') +
        (!c.isToday && c.isFuture ? ' is-future' : '') +
        (!hasValue && adv && !c.isFuture ? ' has-advice' : '');
      const title = c.date + (c.isFuture
        ? ' · 未来日期，不可录入'
        : ' · 输入当日出击战果，清空即删除该日记录') +
        (!hasValue && adv && !c.isFuture ? ' · poi 建议值 ' + U.formatNumber(adv) : '');

      return '<div class="' + cls + '" title="' + U.escapeHtml(title) + '">' +
        '<span class="cal-day">' + c.day + '</span>' +
        '<input type="number" class="cal-input" step="0.01" min="0" inputmode="decimal"' +
          ' data-act="cal-input" data-date="' + U.escapeHtml(c.date) + '"' +
          ' value="' + (hasValue ? U.escapeHtml(c.value) : '') + '"' +
          (!hasValue && adv && !c.isFuture
            ? ' placeholder="' + U.escapeHtml(U.formatNumber(adv)) + '"' : '') +
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
      poiPanel() +
      (pageState.mode === 'calendar'
        ? calendarPanel(month, KC.calc.stats.monthCalendar(KC.store.state.dailyRecords, month, now))
        : formPanel(month, isCurrentMonth) + tablePanel(summary));
  }

  function slot(id) {
    return pageState.container ? pageState.container.querySelector('#' + id) : null;
  }

  /**
   * 日历模式下只刷新汇总数字与 poi 面板。
   * 若在这里重建整个页面，正在连续录入的输入框会立刻失焦，回车/Tab 连续录入就断了。
   *
   * poi 面板用「面板外壳 + #poi-body 内容槽」结构：刷新只换 #poi-body 的 innerHTML，
   * 不重建 .poi-panel 本身，因此不需要在 DOM 树上做替换（假 DOM 也支持得过）。
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

    const poiBody = slot('poi-body');
    if (poiBody) poiBody.innerHTML = poiPanelBody();

    const poiStatus = slot('poi-status');
    if (poiStatus) poiStatus.textContent = poiBadgeText();
  }

  /** 面板右上角角标文案（render 与 refreshSummary 共用） */
  function poiBadgeText() {
    const src = poiSourceLabel();
    if (src.state === 'none') return '未同步';
    const advice = poiAdviceMap();
    if (!advice || !Object.keys(advice).length) return '已同步';
    const pending = pendingAdvice();
    return pending.length ? '可填充 ' + pending.length + ' 天' : '无需填充';
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

  /* ------------------------------------------------------- poi 同步交互 */

  /**
   * 步骤 ①：选文件 → 解析 → 落本月快照 → 展示建议值。
   *
   * ⚠️ 「文件里的数据属于哪个月」poi 并不给，只能以**用户此刻所在月份**为准。
   * 所以若用户在历史月份点同步，会按该月快照语义处理（覆盖该月快照），
   * 面板上会显示来源，避免误以为同步到了当前月。
   */
  async function handlePoiPick() {
    const picked = await KC.poiData.pickAndParse();
    if (!picked.ok) {
      if (!picked.cancelled) KC.toast(picked.error || '读取失败。', 'error');
      return;
    }

    pageState.poiRaw = picked.raw;
    pageState.poiFileName = picked.fileName || '';
    pageState.poiSynced = true;

    const persisted = KC.poiData.saveSnapshot(pageState.month, picked.raw, {
      fileName: picked.fileName || '',
      source: picked.format || ''
    });

    const s = KC.poiSource.summary(picked.raw);
    const adv = poiAdviceMap();
    const count = adv ? Object.keys(adv).length : 0;

    if (!count) {
      KC.toast('已同步，但本月还没有可用的每日出击数据（poi 可能尚未采样）。', 'error');
    } else {
      KC.toast('已同步 · 当前战果 ' + U.formatNumber(s.mySenka) +
        ' · 得到 ' + count + ' 天建议值', 'ok');
    }
    if (!persisted) {
      KC.toast('本机临时层不可用：快照仅在本次会话内有效，刷新页面即失效。', 'error');
    }

    render();
  }

  /**
   * 步骤 ②：把建议值写进所有空白日期。
   * 已有记录一律跳过（**绝不覆盖**用户已填的值）。
   */
  async function handlePoiFill() {
    const pending = pendingAdvice();
    if (!pending.length) {
      KC.toast('没有可填充的空白日期。', 'error');
      return;
    }

    const month = pageState.month;
    const total = pending.reduce(function (a, p) { return a + p.value; }, 0);
    const preview = pending.slice(0, 5).map(function (p) {
      return '  · ' + p.date.slice(5) + '  ' + U.formatNumber(p.value);
    }).join('\n');

    const ok = await KC.confirmDialog({
      title: '填充空白项',
      message: '将把 poi 建议值写入 ' + month + ' 的 ' + pending.length + ' 个空白日期' +
        '（合计 ' + U.formatNumber(total) + '）：\n' + preview +
        (pending.length > 5 ? '\n  · …等 ' + pending.length + ' 项' : '') +
        '\n\n已有记录的日期不会被改动。此操作可逐条撤销（编辑/删除），但无法一键回退。',
      okText: '填充 ' + pending.length + ' 天'
    });
    if (!ok) return;

    const archived = await KC.confirmArchivedMonth(month, '填充该月记录');
    if (!archived) return;

    let done = 0;
    let failed = 0;
    for (let i = 0; i < pending.length; i++) {
      const p = pending[i];
      try {
        await KC.store.saveDailyRecord({
          date: p.date,
          sortieSenka: p.value,
          note: 'poi 同步'
        });
        done++;
      } catch (err) {
        failed++;
      }
    }

    if (failed) {
      KC.toast('已填充 ' + done + ' 天，' + failed + ' 天失败。', 'error');
    } else {
      KC.toast('已填充 ' + done + ' 天（合计 ' + U.formatNumber(total) + '）', 'ok');
    }
    render();
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
      if (month !== pageState.month) {
        // 换月了：本次会话的 live poi 数据不再适用（见 switchMonth 说明）
        pageState.poiRaw = null;
        pageState.poiSynced = false;
        pageState.poiFileName = '';
      }
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
      switchMonth(U.addMonths(pageState.month, -1));
    } else if (act === 'next-month') {
      switchMonth(U.addMonths(pageState.month, 1));
    } else if (act === 'this-month') {
      switchMonth(U.monthKeyOf(U.todayKey()));
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
    } else if (act === 'poi-pick') {
      handlePoiPick();
    } else if (act === 'poi-fill') {
      handlePoiFill();
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

  /**
   * 切换查看月份时，把「本次会话刚同步的 live 数据」收起来。
   *
   * 原因：poi 文件不带月份，live 数据的归属靠「同步时所在的月份」认定；
   * 一旦换月，那份 live 数据就不再适用，必须回落到该月自己的快照。
   */
  function switchMonth(nextMonth) {
    pageState.month = nextMonth;
    pageState.editingDate = null;
    pageState.poiRaw = null;
    pageState.poiSynced = false;
    pageState.poiFileName = '';
    render();
  }

  KC.pages.records = {
    mount: function (container) {
      pageState.container = container;
      pageState.month = U.monthKeyOf(U.todayKey());
      pageState.editingDate = null;
      pageState.mode = KC.store.getSettings().recordsMode === 'calendar' ? 'calendar' : 'list';
      pageState.poiRaw = null;
      pageState.poiSynced = false;
      pageState.poiFileName = '';

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
      pageState.poiRaw = null;
      pageState.poiSynced = false;
      pageState.poiFileName = '';
    }
  };
})(window.KC = window.KC || {});
