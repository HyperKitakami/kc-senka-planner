/* ==========================================================================
   ui/pages/settings.js — 设置页
   依据 docs/02_ui.md §4.9、docs/03_data.md Settings。

   覆盖 docs 列出的五类配置：外观、首页显示内容、默认规划方式、数据相关设置、其它偏好。
   另含「游戏服务器」（用于自动生成历史归档的人事表地址）
   与「数据导出提醒」。
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
   * 数据导出提醒。
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

  /**
   * poi 数据快照（战果记录 / 任务页 / 分析页的 poi 功能都依赖它）。
   *
   * 快照存在「本机轻量存储」（localStorage），**不参与导入导出**，
   * 因此这里必须给出一个独立的清除入口 —— 否则用户在「数据管理」里清空数据后，
   * 快照仍留在本机，会让人误以为 poi 数据也被清掉了。
   */
  function poiPanel() {
    const P = KC.poiData;
    const months = P.snapshotMonths();
    const meta = P.readMeta();
    const bytes = KC.localLayer.usage();
    const usable = KC.localLayer.available();

    const rows = [
      ['快照月份', months.length ? months.join('、') : '尚无快照'],
      ['最近同步', meta.lastSyncedAt ? fmtDateTime(meta.lastSyncedAt) : '尚未同步过'],
      ['来源文件', meta.lastFileName || '—'],
      ['本机轻量存储占用', bytes ? (bytes + ' 字节') : '0 字节']
    ];

    return '<div class="panel">' +
      '<div class="panel-head"><h2>poi 数据快照</h2>' +
        '<span class="panel-count">' + months.length + ' 个月</span></div>' +
      '<p class="panel-desc">poi 战果插件（数据文件 <code>achieve.json</code>）只保存当月数据，下个月会被覆盖。' +
        '本工具在「战果记录」页同步时会把关键字段存成本机快照，' +
        '供「分析 → 战果线对比」与「战果任务 → poi EO 同步」使用。</p>' +

      (usable ? '' :
        '<p class="form-hint">⚠️ 本机轻量存储不可用，快照只存在于本次会话，关闭页面即丢失。</p>') +

      '<div class="table-wrap"><table class="data-table detail-table"><tbody>' +
        rows.map(function (r) {
          return '<tr><td>' + U.escapeHtml(r[0]) + '</td><td>' + U.escapeHtml(r[1]) + '</td></tr>';
        }).join('') +
      '</tbody></table></div>' +

      '<p class="form-hint">快照保存在「本机轻量存储」里，<strong>不参与导入导出</strong>，' +
        '也不影响任何战果统计；换浏览器或清理站点数据后会一并丢失，' +
        '需要重新到「战果记录」页同步 poi 数据。</p>' +

      (months.length
        ? '<div class="panel-foot">' +
            '<button type="button" class="btn btn-ghost btn-sm" data-act="clear-poi-snapshot">' +
              '清除全部 ' + months.length + ' 个月的快照</button>' +
          '</div>'
        : '') +
      '</div>';
  }

  /**
   * 「战果线数据」面板（wiki 采集，docs/02_ui.md §4.9）。
   *
   * 数据源是 wikiwiki「情報倉庫/時系列各順位戦果値」。该站有 Cloudflare 访问保护：
   * 普通 HTTP 请求返回 403，无头浏览器也过不去，服务端代理取回的数字还会被篡改
   * （docs/03_data.md §9.2）。所以程序**不可能**自己去抓，只能：
   *   ① 复制一段提取脚本 → ② 用户在 wiki 页面的 Console 里执行 → ③ 把 JSON 粘回来。
   *
   * ⚠️ 粘贴的内容不会自动解析，必须点「解析并导入」—— 避免粘到一半就落库。
   * ⚠️ 与 poi 快照一样，数据存在「本机轻量存储」，**不参与导入导出**，
   *    所以这里必须给出独立的清除入口。
   */
  function senkaLinePanel() {
    const D = KC.senkaLineData;
    const settings = KC.store.getSettings();
    const server = settings.server || '';
    const list = D.list();
    const usable = KC.localLayer.available();

    const serverName = KC.schema.serverName(server);
    // 「前一个已结束月」——wiki 只收录已结束月份，直接指向它最省事
    const latestMonth = U.addMonths(KC.calc.senkaLine.currentSlot(new Date()).month, -1);
    const wikiUrl = server
      ? KC.senkaLineSource.wikiPageUrl(server, latestMonth)
      : KC.senkaLineSource.WIKI_INDEX_URL;

    // ⚠️ 这里必须**按服务器分开统计**。
    //    早先只报「已采集 N 个月」是把全部服务器混在一起的，于是"6/7/8 月都在"
    //    看起来没问题，实际可能分属不同镇守府 —— 而首页卡片只比对当前服务器，
    //    结果就是卡片只显示一个月，用户完全摸不着头脑。别再合并统计。
    const own = server ? D.monthsOf(server) : [];
    const foreignRows = list.filter(function (x) { return x.serverCode !== server; });

    const rows = [
      ['当前服务器', server ? (serverName + '（' + server + '）') : '未设定 —— 请先在上方「游戏服务器」里选择'],
      ['本服务器已采集', own.length
        ? own.length + ' 个月（' + own.join('、') + '）'
        : '尚未采集']
    ];

    if (foreignRows.length) {
      const grouped = {};
      foreignRows.forEach(function (x) {
        if (!grouped[x.serverCode]) {
          grouped[x.serverCode] = { name: x.serverName || x.serverCode, months: [] };
        }
        grouped[x.serverCode].months.push(x.month);
      });
      rows.push(['其它服务器的数据', Object.keys(grouped).map(function (k) {
        return grouped[k].name + ' ' + grouped[k].months.length + ' 个月（' +
          grouped[k].months.join('、') + '）';
      }).join('；')]);
    }

    // 本服务器一条都没有、别的服务器却有 —— 极可能服务器选错了，必须显式提醒
    const serverWarn = (!own.length && foreignRows.length)
      ? '<p class="form-hint">⚠️ 本机已有 ' + foreignRows.length +
        ' 个月的数据，但<strong>没有一个月属于当前服务器</strong>。' +
        '首页「战果线同期对比」只比对当前服务器，因此不会显示它们 —— ' +
        '请确认「游戏服务器」选的是不是你实际所在的镇守府。</p>'
      : '';

    const detail = list.length
      ? '<div class="table-wrap"><table class="data-table">' +
          '<thead><tr><th>服务器</th><th>月份</th><th class="num">采样行</th>' +
            '<th>导入时间</th><th class="actions">操作</th></tr></thead><tbody>' +
          list.map(function (x) {
            return '<tr>' +
              '<td>' + U.escapeHtml(x.serverName || x.serverCode) +
                (x.serverCode === server ? '' :
                  '<span class="chip-flag" title="不属于当前设定的服务器，首页卡片不会使用它">非当前</span>') +
              '</td>' +
              '<td class="cell-date">' + U.escapeHtml(x.month) + '</td>' +
              '<td class="num">' + x.count + '</td>' +
              '<td>' + U.escapeHtml(x.importedAt ? fmtDateTime(x.importedAt) : '—') + '</td>' +
              '<td class="actions">' +
                '<button type="button" class="btn btn-ghost btn-sm"' +
                  ' data-act="delete-senka-line"' +
                  ' data-server="' + U.escapeHtml(x.serverCode) + '"' +
                  ' data-month="' + U.escapeHtml(x.month) + '">删除</button>' +
              '</td>' +
            '</tr>';
          }).join('') +
        '</tbody></table></div>'
      : '';

    const warnText = list.reduce(function (acc, x) {
      return acc.concat((x.warnings || []).map(function (w) { return x.month + '：' + w; }));
    }, []);
    const warnHtml = warnText.length
      ? '<p class="form-hint">采集时记录的疑点（仅供参考，不影响计算）：<br>' +
        U.escapeHtml(warnText.join('\n')).replace(/\n/g, '<br>') + '</p>'
      : '';

    return '<div class="panel">' +
      '<div class="panel-head"><h2>战果线数据</h2>' +
        '<span class="panel-count">首页「战果线同期对比」的数据来源</span></div>' +

      '<p class="panel-desc">数据来自 wiki 的 <code>時系列各順位戦果値</code> 页，' +
        '每页是一个「镇守府 × 月份」，记录 1 / 5 / 20 / 100 / 500 位在当月每天两次采样的战果线。' +
        '该站有访问保护，程序无法自行获取，需要你在浏览器里跑一次提取脚本再粘回来。</p>' +

      (usable ? '' :
        '<p class="form-hint">⚠️ 本机轻量存储不可用，导入的数据只存在于本次会话，关闭页面即丢失。</p>') +

      '<div class="table-wrap"><table class="data-table detail-table"><tbody>' +
        rows.map(function (r) {
          return '<tr><td>' + U.escapeHtml(r[0]) + '</td><td>' + U.escapeHtml(r[1]) + '</td></tr>';
        }).join('') +
      '</tbody></table></div>' +

      serverWarn +

      detail + warnHtml +

      '<div class="senka-step">' +
        '<div class="senka-step-head">' +
          '<strong>1 · 在 wiki 页面上执行提取脚本</strong>' +
          '<a class="senka-link" href="' + U.escapeHtml(wikiUrl) +
            '" target="_blank" rel="noopener">打开对应页面</a>' +
          '<button type="button" class="btn btn-ghost btn-sm" data-act="copy-senka-snippet">' +
            '复制提取脚本</button>' +
        '</div>' +
        '<p class="form-hint">打开页面后按 <code>F12</code> 切到 Console，粘贴脚本回车 —— ' +
          '脚本会<strong>自动把结果复制到剪贴板</strong>，直接粘到下面第 2 步的输入框即可。' +
          '自动复制失败时，手动选中它返回的内容复制（展开下方可查看脚本原文）。</p>' +
        '<details class="senka-details"><summary>查看脚本内容</summary>' +
          '<pre class="senka-snippet">' + U.escapeHtml(KC.senkaLineSource.EXTRACT_SNIPPET) + '</pre>' +
        '</details>' +
      '</div>' +

      '<div class="senka-step">' +
        '<div class="senka-step-head"><strong>2 · 粘贴 JSON 并导入</strong></div>' +
        '<div class="field">' +
          '<textarea data-act="senka-line-input" rows="4" spellcheck="false"' +
            ' placeholder="把提取脚本返回的 JSON 粘贴到这里，然后点下面的「解析并导入」…"></textarea>' +
        '</div>' +
        '<div class="panel-foot">' +
          '<button type="button" class="btn btn-primary btn-sm" data-act="import-senka-line">' +
            '解析并导入</button>' +
          (list.length
            ? '<button type="button" class="btn btn-ghost btn-sm" data-act="clear-senka-line">' +
                '清除全部 ' + list.length + ' 个月</button>'
            : '') +
        '</div>' +
      '</div>' +

      '<p class="form-hint">数据保存在「本机轻量存储」里，<strong>不参与导入导出</strong>，' +
        '也不影响任何战果统计；换浏览器或清理站点数据后会一并丢失，需要重新采集。</p>' +
      '</div>';
  }

  function dataPanel() {
    const st = KC.store.state;
    const settings = KC.store.getSettings();

    const rows = [
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
      '<p class="panel-desc">Kancolle Senka Planner —— 可完全本地运行的《艦隊これくしょん》战果记录、规划与统计工具。' +
        '无需服务器、无需数据库，双击 <code>index.html</code> 即可离线使用。</p>' +
      '<div class="table-wrap"><table class="data-table detail-table"><tbody>' +
        '<tr><td>程序版本</td><td>' + U.escapeHtml(KC.VERSION || '未知') + '</td></tr>' +
        '<tr><td>数据结构版本</td><td>v' +
          U.escapeHtml(String(KC.schema.dataVersion(KC.store.state.config))) + '</td></tr>' +
        '<tr><td>GitHub 仓库</td><td><a href="https://github.com/HyperKitakami/kc-senka-planner" target="_blank">https://github.com/HyperKitakami/kc-senka-planner</a></td></tr>' +
      '</tbody></table></div>' +
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
      poiPanel() +
      senkaLinePanel() +
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

  /**
   * 清除全部 poi 快照。
   *
   * 这是**破坏性操作**且不可撤销（快照是本工具自己存的，删了只能重新同步 poi），
   * 所以要显式确认；且必须说清它**只影响 poi 快照**，不动任何业务数据。
   */
  async function clearPoiSnapshot() {
    const months = KC.poiData.snapshotMonths();
    if (!months.length) return;

    const ok = await KC.confirmDialog({
      title: '清除 poi 快照',
      message: '将删除本机保存的 ' + months.length + ' 个月 poi 快照（' +
        months.join('、') + '）。\n\n' +
        '影响：\n' +
        '  · 「分析 → 战果线对比」将没有数据可画\n' +
        '  · 「战果任务 → poi EO 同步」将无法比对\n' +
        '  · 已写入的每日记录与任务完成状态**不受影响**\n\n' +
        '删除后需要重新到「战果记录」页选择 poi 数据文件才能恢复（且只能恢复 poi 当前月）。',
      okText: '清除快照',
      danger: true
    });
    if (!ok) return;

    const n = KC.poiData.clearAll();
    KC.toast('已清除 ' + n + ' 个月的 poi 快照');
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

  /* -------------------------------------------------- 战果线数据（wiki） */

  /** 复制提取脚本。剪贴板不可用（非安全上下文 / 权限被拒）时给可操作的回退提示。 */
  async function copySenkaSnippet() {
    let done = false;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard &&
          typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(KC.senkaLineSource.EXTRACT_SNIPPET);
        done = true;
      }
    } catch (err) { done = false; }
    if (done) KC.toast('提取脚本已复制，去 wiki 页面粘到 Console 里执行');
    else KC.toast('无法自动复制，请展开「查看脚本内容」手动选中复制', 'error');
  }

  /**
   * 解析并导入粘进来的 JSON。
   *
   * 两处必须让用户看清楚：
   *   · 归到哪台服务器 —— 以**数据来源**为准（页面标题能识别出来），
   *     与设置不一致时明确告知会归到哪一边，避免把 A 镇守府的线记到 B 上；
   *   · 同月已有数据时会被覆盖。
   * 采集时的可疑点（行数不符 / 数值非单调）只提示、不阻断 —— 剔除与否由用户判断。
   */
  async function importSenkaLine() {
    const ta = KC.dom.qs('[data-act="senka-line-input"]', pageState.container);
    const raw = ta ? String(ta.value || '') : '';
    if (!raw.trim()) { KC.toast('请先把提取到的 JSON 粘贴进来', 'error'); return; }

    const res = KC.senkaLineSource.parse(raw);
    if (!res.ok) { KC.toast(res.error, 'error'); return; }
    const d = res.data;

    const fromSetting = KC.store.getSettings().server || '';
    const code = d.serverCode || fromSetting;
    if (!code) {
      KC.toast('识别不出服务器，请先在上方「游戏服务器」里选择后再导入', 'error');
      return;
    }
    const name = d.serverName || KC.schema.serverName(code) || code;

    if (d.serverCode && fromSetting && d.serverCode !== fromSetting) {
      const go = await KC.confirmDialog({
        title: '服务器与设置不一致',
        message: '这份数据来自「' + name + '」，但设置里选的是「' +
          KC.schema.serverName(fromSetting) + '」。\n\n' +
          '导入后会归到「' + name + '」名下，不会改动你的服务器设置。',
        okText: '按数据来源导入'
      });
      if (!go) return;
    }

    const exist = KC.senkaLineData.read(code, d.month);
    const ok = await KC.confirmDialog({
      title: '导入战果线数据',
      message: '服务器：' + name + '\n月份：' + d.month + '\n采样行：' + d.rows.length + ' 行' +
        (d.warnings.length
          ? '\n\n⚠️ 有 ' + d.warnings.length + ' 处可疑（仍可导入）：\n  · ' +
            d.warnings.join('\n  · ')
          : '') +
        (exist ? '\n\n该月已有数据（导入于 ' + fmtDateTime(exist.importedAt) + '），将被覆盖。' : ''),
      okText: '导入'
    });
    if (!ok) return;

    const saved = KC.senkaLineData.save(code, d.month, d, { source: d.source });
    if (!saved.ok) { KC.toast('导入失败：' + saved.error, 'error'); return; }
    if (ta) ta.value = '';
    KC.toast(saved.persisted
      ? '已导入 ' + d.month + ' 的战果线数据（' + d.rows.length + ' 行）'
      : '已导入，但本机轻量存储不可用，关闭页面后会丢失');
    render();
  }

  async function deleteSenkaLine(serverCode, month) {
    const ok = await KC.confirmDialog({
      title: '删除战果线数据',
      message: '将删除 ' + month + ' 的战果线数据。\n\n' +
        '影响：首页「战果线同期对比」会少一个月可对比。\n' +
        '其它数据不受影响；删除后重新采集即可恢复。',
      okText: '删除',
      danger: true
    });
    if (!ok) return;
    KC.senkaLineData.remove(serverCode, month);
    KC.toast('已删除 ' + month + ' 的战果线数据');
    render();
  }

  async function clearSenkaLine() {
    const list = KC.senkaLineData.list();
    if (!list.length) return;
    const ok = await KC.confirmDialog({
      title: '清除全部战果线数据',
      message: '将删除本机保存的 ' + list.length + ' 个月战果线数据（' +
        list.map(function (x) { return x.month; }).join('、') + '）。\n\n' +
        '影响：首页「战果线同期对比」将没有数据可展示。\n' +
        '每日记录、任务、归档等业务数据**不受影响**；删除后需要重新采集。',
      okText: '清除全部',
      danger: true
    });
    if (!ok) return;
    const n = KC.senkaLineData.clearAll().length;
    KC.toast('已清除 ' + n + ' 个月战果线数据');
    render();
  }

  function handleClick(e) {
    const btn = KC.dom.closestFrom(e.target, '[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;

    if (act === 'set-theme') setTheme(btn.dataset.theme);
    else if (act === 'set-mode') setPlanningMode(btn.dataset.mode);
    else if (act === 'set-export-remind') setExportRemindMode(btn.dataset.mode);
    else if (act === 'reset-export-remind') resetExportRemind();
    else if (act === 'clear-poi-snapshot') clearPoiSnapshot();
    else if (act === 'copy-senka-snippet') copySenkaSnippet();
    else if (act === 'import-senka-line') importSenkaLine();
    else if (act === 'delete-senka-line') deleteSenkaLine(btn.dataset.server, btn.dataset.month);
    else if (act === 'clear-senka-line') clearSenkaLine();
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
