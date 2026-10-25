/* ==========================================================================
   ui/pages/data.js — 数据管理页
   依据 docs/02_ui.md §4.8、docs/01_requirements.md §六、docs/03_data.md §九、
        docs/06_data_strategy.md §四 / §五。

   职责（原则上不放置业务功能）：
     · 自动保存状态、存储引擎与数据量概览
     · poi 数据快照：展示 / 清除（本机轻量存储，不参与导入导出）
     · 战果线数据：wiki 采集、导入、单条删除与全部清除（同上）
     · 导出全部数据（JSON，含 schemaVersion）—— 动作本身在 js/ui/export.js，
       与首页的导出提醒条共用同一份实现
     · 导入数据：先校验版本 → 依次迁移 → 显式确认 → 整体替换；失败不静默、不改动现有数据
     · 本地备份：建立多份快照、随时恢复
     · 清空业务数据（保留用户设置与本地备份）

   ⚠️ 「poi 数据快照」与「战果线数据」原先是设置页的面板，现迁到本页：
      它们维护的是本机附加数据（和导出 / 备份同类），不是程序配置。
   ========================================================================== */
(function (KC) {
  'use strict';

  const U = KC.utils;

  KC.pages = KC.pages || {};

  const SAVE_LABEL = {
    idle: '就绪',
    saving: '保存中…',
    saved: '已保存',
    error: '保存失败'
  };

  const STORE_LABEL = {
    config: '配置',
    dailyRecords: '每日记录',
    taskTemplates: '任务模板',
    taskRecords: '任务记录',
    monthlyContexts: '月度上下文',
    archives: '月度归档',
    settings: '用户设置',
    backups: '本地备份'
  };

  const CLEAR_CONFIRM_TEXT = '清空数据';

  const pageState = {
    container: null,
    backups: null,          // null = 尚未加载
    storage: null,
    importState: null,      // { error } | { info, raw }
    importBackup: true,
    importMode: 'replace',  // replace = 整体替换；merge = 合并导入
    mergePolicy: 'file',    // 合并冲突策略：file = 以文件为准；local = 以本机为准
    mergeStats: null,       // 合并预演结果 { added, updated, kept }
    backupName: ''
  };

  let unsubscribe = null;
  let handlers = null;

  /* ------------------------------------------------------------ 小工具 */

  function formatBytes(n) {
    if (!isFinite(n) || n <= 0) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  function formatDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return U.toDateKey(d) + ' ' + U.pad2(d.getHours()) + ':' + U.pad2(d.getMinutes());
  }

  function slot(id) {
    return pageState.container ? pageState.container.querySelector('#' + id) : null;
  }

  /* ---------------------------------------------------------- 异步加载 */

  async function refreshBackups() {
    try {
      pageState.backups = await KC.store.listBackups();
    } catch (err) {
      pageState.backups = [];
      console.error('[data] 读取备份列表失败', err);
    }
    render();
  }

  async function refreshStorage() {
    if (!navigator.storage || typeof navigator.storage.estimate !== 'function') {
      pageState.storage = null;
      return;
    }
    try {
      const est = await navigator.storage.estimate();
      pageState.storage = { usage: est.usage, quota: est.quota };
    } catch (err) {
      pageState.storage = null;
    }
    render();
  }

  /* ------------------------------------------------------------ 渲染 */

  function statusCards() {
    const st = KC.store.getSaveStatus();
    const state = st.status || 'idle';

    const counts = {
      dailyRecords: KC.store.state.dailyRecords.length,
      taskTemplates: KC.store.state.taskTemplates.length,
      taskRecords: KC.store.state.taskRecords.length,
      monthlyContexts: KC.store.state.monthlyContexts.length,
      archives: KC.store.state.archives.length
    };
    const total = Object.keys(counts).reduce(function (s, k) { return s + counts[k]; }, 0);

    const storage = pageState.storage;

    return '<div class="card-grid">' +
      KC.ui.statCard('自动保存', SAVE_LABEL[state] || SAVE_LABEL.idle,
        st.at ? '最后保存 ' + formatDateTime(new Date(st.at).toISOString()) : '尚未写入',
        state === 'error' ? 'purple' : 'green') +
      KC.ui.statCard('存储引擎', 'IndexedDB',
        '库 kc-senka-planner · v' + KC.schema.dataVersion(KC.store.state.config), '') +
      KC.ui.statCard('已用空间',
        storage ? formatBytes(storage.usage) : '不可用',
        storage ? '配额 ' + formatBytes(storage.quota) : '浏览器未提供容量信息', '') +
      KC.ui.statCard('数据量', total + ' 条',
        '每日 ' + counts.dailyRecords + ' · 任务记录 ' + counts.taskRecords, 'gold') +
      '</div>';
  }

  function overviewPanel() {
    const cfg = KC.store.state.config || {};
    const st = KC.store.state;

    const rows = [
      ['config', Array.isArray(st.config) ? 0 : (st.config ? 1 : 0)],
      ['settings', st.settings ? 1 : 0],
      ['dailyRecords', st.dailyRecords.length],
      ['taskTemplates', st.taskTemplates.length],
      ['taskRecords', st.taskRecords.length],
      ['monthlyContexts', st.monthlyContexts.length],
      ['archives', st.archives.length]
    ];

    return '<div class="panel">' +
      '<div class="panel-head"><h2>数据概览</h2>' +
        '<span class="panel-count">数据结构版本 v' +
        KC.schema.dataVersion(KC.store.state.config) +
        ' · 创建于 ' + formatDateTime(cfg.createdAt) + '</span></div>' +
      '<div class="table-wrap"><table class="data-table detail-table">' +
        '<thead><tr><th>数据表</th><th class="num">条数</th></tr></thead>' +
        '<tbody>' + rows.map(function (r) {
          return '<tr><td>' + U.escapeHtml(STORE_LABEL[r[0]] || r[0]) + '</td>' +
            '<td class="num">' + r[1] + '</td></tr>';
        }).join('') + '</tbody>' +
      '</table></div>' +
      '</div>';
  }

  /**
   * poi 数据快照（战果记录 / 任务页 / 分析页的 poi 功能都依赖它）。
   *
   * 快照存在「本机轻量存储」（localStorage），**不参与导入导出**，
   * 因此这里必须给出一个独立的清除入口 —— 否则用户在「数据管理」里清空数据后，
   * 快照仍留在本机，会让人误以为 poi 数据也被清掉了。
   *
   * ⚠️ 这两块（poi 快照 / 战果线数据）原先挂在「设置」页，现在迁到这里：
   *    它们和管理主数据一样属于「本机附加数据的维护」，放在设置页里既不合文档
   *    对设置页的定位（程序配置），也让「清空 / 清除」入口分散在两处。
   */
  function poiPanel() {
    const P = KC.poiData;
    const months = P.snapshotMonths();
    const meta = P.readMeta();
    const bytes = KC.localLayer.usage();
    const usable = KC.localLayer.available();

    const rows = [
      ['快照月份', months.length ? months.join('、') : '尚无快照'],
      ['最近同步', meta.lastSyncedAt ? formatDateTime(meta.lastSyncedAt) : '尚未同步过'],
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
   * 「战果线数据」面板（wiki 采集，docs/02_ui.md §4.8）。
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
      ['当前服务器', server
        ? (serverName + '（' + server + '）')
        : '未设定 —— 请先到「设置 → 游戏服务器」里选择'],
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
        '请确认「设置 → 游戏服务器」选的是不是你实际所在的镇守府。</p>'
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
              '<td>' + U.escapeHtml(x.importedAt ? formatDateTime(x.importedAt) : '—') + '</td>' +
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

  function exportPanel() {
    const lastExport = KC.store.getSettings().lastExportAt;
    return '<div class="panel">' +
      '<div class="panel-head"><h2>导出数据</h2>' +
        '<span class="panel-count">JSON · 含 schemaVersion</span></div>' +
      '<p class="panel-desc">把全部业务数据导出为一个 JSON 文件，便于长期保存、跨设备迁移。' +
        '本地备份属于本机数据，不会包含在导出文件内。</p>' +
      '<div class="panel-foot">' +
        '<button type="button" class="btn btn-primary" data-act="export">导出全部数据</button>' +
      '</div>' +
      '<p class="form-hint">最近导出：' + (lastExport ? formatDateTime(lastExport) : '尚未导出过，建议立即导出一份') + '</p>' +
      '</div>';
  }

  function importPreview() {
    const st = pageState.importState;
    const isMerge = pageState.importMode === 'merge';

    if (!st) {
      return '<div class="empty-inline">尚未选择文件。</div>';
    }
    if (st.error) {
      return '<div class="alert alert-error">' +
        '<strong>无法导入：</strong>' + U.escapeHtml(st.error) +
        '<br><span class="muted">原有数据未做任何改动，请保留该文件并检查后重试。</span></div>';
    }

    const info = st.info;
    const rows = Object.keys(info.counts).map(function (name) {
      return '<tr><td>' + U.escapeHtml(STORE_LABEL[name] || name) + '</td>' +
        '<td class="num">' + info.counts[name] + '</td></tr>';
    }).join('');

    const mergeBlock = isMerge
      ? (pageState.mergeStats
        ? '<div class="merge-stats">' +
            '<span class="merge-add">新增 <em>' + pageState.mergeStats.added + '</em> 条</span>' +
            '<span class="merge-upd">更新 <em>' + pageState.mergeStats.updated + '</em> 条</span>' +
            '<span class="merge-keep">保留本机 <em>' + pageState.mergeStats.kept + '</em> 条</span>' +
          '</div>' +
          '<p class="form-hint">合并导入只新增与更新，<strong>不会删除</strong>本机已有数据；' +
            '程序配置与用户设置不受影响。注意：文件里删掉的记录不会从本机删除。</p>'
        : '<div class="empty-inline">正在预演合并结果…</div>')
      : '';

    return '<div class="import-preview">' +
      '<div class="mini-stats">' +
        '<span><em>' + info.originalVersion + '</em> 文件版本</span>' +
        '<span><em>' + info.total + '</em> 条数据</span>' +
        '<span>导出时间 ' + U.escapeHtml(formatDateTime(info.exportedAt)) + '</span>' +
      '</div>' +
      (info.needsMigration
        ? '<div class="alert alert-warn">文件版本 v' + info.originalVersion +
          ' 低于当前程序版本 v' + info.currentVersion + '，导入时将按版本顺序自动迁移。</div>'
        : '<div class="alert alert-ok">文件版本与当前程序一致（v' + info.currentVersion + '）。</div>') +
      mergeBlock +
      '<div class="table-wrap"><table class="data-table detail-table">' +
        '<tbody>' + rows + '</tbody></table></div>' +
      '<div class="panel-foot">' +
        '<button type="button" class="btn btn-ghost btn-sm" data-act="cancel-import">取消</button>' +
        (isMerge
          ? '<button type="button" class="btn btn-primary" data-act="confirm-import">合并导入</button>'
          : '<button type="button" class="btn btn-danger" data-act="confirm-import">导入并覆盖现有数据</button>') +
      '</div>' +
      '</div>';
  }

  function importPanel() {
    const isMerge = pageState.importMode === 'merge';

    return '<div class="panel">' +
      '<div class="panel-head"><h2>导入数据</h2>' +
        '<span class="panel-count">' + (isMerge ? '只新增与更新' : '会覆盖现有数据') + '</span></div>' +
      '<p class="panel-desc">选择此前导出的 JSON 文件。程序会先校验版本并依次迁移；' +
        '校验或迁移失败时不会改动任何现有数据，也不会静默覆盖。</p>' +

      '<div class="mode-row">' +
        '<span class="field-label">导入方式</span>' +
        '<div class="segmented">' +
          '<button type="button" data-act="import-mode" data-mode="replace"' +
            (isMerge ? '' : ' class="active"') + '>整体替换</button>' +
          '<button type="button" data-act="import-mode" data-mode="merge"' +
            (isMerge ? ' class="active"' : '') + '>合并导入</button>' +
        '</div>' +
        (isMerge
          ? '<span class="field-label mode-gap">冲突时</span>' +
            '<div class="segmented">' +
              '<button type="button" data-act="merge-policy" data-policy="file"' +
                (pageState.mergePolicy === 'file' ? ' class="active"' : '') + '>以文件为准</button>' +
              '<button type="button" data-act="merge-policy" data-policy="local"' +
                (pageState.mergePolicy === 'local' ? ' class="active"' : '') + '>以本机为准</button>' +
            '</div>'
          : '') +
      '</div>' +

      '<p class="panel-desc mode-desc">' + (isMerge
        ? '合并导入：按记录逐条比对，本机没有的新增、已有的按上面的策略处理；' +
          '<strong>不会删除本机已有数据</strong>，也不会改动程序配置与用户设置。'
        : '整体替换：用文件内容替换全部业务数据，恢复后与导出那一刻完全一致。') + '</p>' +

      '<div class="form-row">' +
        '<label class="field field-grow">' +
          '<span class="field-label">数据文件</span>' +
          '<input type="file" accept=".json,application/json" data-act="import-file">' +
        '</label>' +
        '<label class="check"><input type="checkbox" data-act="import-backup"' +
          (pageState.importBackup ? ' checked' : '') + '> 导入前自动创建本地备份</label>' +
      '</div>' +
      '<div id="import-preview">' + importPreview() + '</div>' +
      '</div>';
  }

  function backupsPanel() {
    const list = pageState.backups;

    const body = (list === null)
      ? '<div class="empty-inline">正在读取备份…</div>'
      : (!list.length
        ? '<div class="empty-inline">还没有本地备份。建议在导入或大幅修改数据前先建一份。</div>'
        : '<div class="table-wrap"><table class="data-table detail-table">' +
            '<thead><tr><th>名称</th><th>创建时间</th><th class="num">大小</th><th class="actions">操作</th></tr></thead>' +
            '<tbody>' + list.map(function (b) {
              return '<tr>' +
                '<td>' + U.escapeHtml(b.name) + '</td>' +
                '<td>' + U.escapeHtml(formatDateTime(b.createdAt)) + '</td>' +
                '<td class="num">' + U.escapeHtml(formatBytes(b.size)) + '</td>' +
                '<td class="actions">' +
                  '<button type="button" class="btn btn-ghost btn-sm" data-act="restore-backup" data-id="' +
                    U.escapeHtml(b.id) + '">恢复</button>' +
                  '<button type="button" class="btn btn-ghost btn-sm btn-danger-text" data-act="delete-backup" data-id="' +
                    U.escapeHtml(b.id) + '">删除</button>' +
                '</td></tr>';
            }).join('') + '</tbody></table></div>');

    return '<div class="panel">' +
      '<div class="panel-head"><h2>本地备份</h2>' +
        '<span class="panel-count">' + (list ? list.length : '—') + ' 份</span></div>' +
      '<p class="panel-desc">在本机保存多份数据快照，可随时恢复。' +
        '<strong>注意：本地备份与主数据存放在同一处，浏览器清除站点数据时会一并丢失</strong>，' +
        '请同时使用「导出数据」保存到文件。</p>' +
      '<div class="form-row">' +
        '<label class="field field-grow">' +
          '<span class="field-label">备份名称（可选）</span>' +
          '<input type="text" data-act="backup-name" maxlength="40" placeholder="留空则自动命名" value="' +
            U.escapeHtml(pageState.backupName) + '">' +
        '</label>' +
        '<div class="form-actions">' +
          '<button type="button" class="btn btn-primary" data-act="create-backup">新建备份</button>' +
        '</div>' +
      '</div>' +
      body +
      '</div>';
  }

  function dangerPanel() {
    return '<div class="panel">' +
      '<div class="panel-head"><h2>危险操作</h2></div>' +
      '<p class="panel-desc">清空全部业务数据（每日记录、任务模板与任务记录、月度上下文、月度归档）。' +
        '用户设置与本地备份会保留，因此清空后仍可从备份恢复。</p>' +
      '<div class="panel-foot">' +
        '<button type="button" class="btn btn-danger" data-act="clear-data">清空业务数据</button>' +
      '</div>' +
      '</div>';
  }

  function render() {
    const host = pageState.container;
    if (!host) return;

    host.innerHTML =
      '<div class="page-head">' +
        '<div>' +
          '<h1>数据管理</h1>' +
          '<p class="page-sub">数据默认保存在本机浏览器（IndexedDB）。建议定期「导出数据」到文件，避免浏览器清理缓存造成丢失。' +
            'poi 快照与战果线数据存在本机轻量存储里，同样不参与导入导出。</p>' +
        '</div>' +
      '</div>' +
      statusCards() +
      overviewPanel() +
      poiPanel() +
      senkaLinePanel() +
      exportPanel() +
      importPanel() +
      backupsPanel() +
      dangerPanel();
  }

  /* -------------------------------------------------------------- 导入 */

  function analyzeImport(raw) {
    const result = KC.schema.migrate(raw);
    if (!result.ok) return { error: result.error };

    const data = result.data.data || {};
    const transient = KC.schema.TRANSIENT_STORES || [];
    const counts = {};
    Object.keys(KC.schema.STORES).forEach(function (name) {
      if (transient.indexOf(name) >= 0) return;
      counts[name] = Array.isArray(data[name]) ? data[name].length : 0;
    });

    const original = Number(raw.schemaVersion);
    return {
      info: {
        originalVersion: original,
        currentVersion: KC.schema.SCHEMA_VERSION,
        needsMigration: original !== KC.schema.SCHEMA_VERSION,
        exportedAt: raw.exportedAt || null,
        counts: counts,
        total: Object.keys(counts).reduce(function (s, k) { return s + counts[k]; }, 0)
      },
      raw: raw
    };
  }

  /** 合并模式下的预演（只读，不写入任何数据） */
  async function refreshMergePreview() {
    const st = pageState.importState;
    if (pageState.importMode !== 'merge' || !st || !st.raw) {
      pageState.mergeStats = null;
      render();
      return;
    }
    pageState.mergeStats = null;
    render();
    try {
      pageState.mergeStats = await KC.db.previewMerge(st.raw, pageState.mergePolicy);
    } catch (err) {
      pageState.mergeStats = null;
      console.error('[data] 合并预演失败', err);
    }
    render();
  }

  /** 导入状态 / 导入方式变化后的统一收尾 */
  function afterImportStateChange() {
    const st = pageState.importState;
    if (pageState.importMode === 'merge' && st && st.raw) {
      refreshMergePreview();
    } else {
      pageState.mergeStats = null;
      render();
    }
  }

  function handleFileChange(input) {
    const file = input.files && input.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function () {
      pageState.mergeStats = null;
      let raw;
      try {
        raw = JSON.parse(String(reader.result));
      } catch (err) {
        pageState.importState = { error: '文件不是有效的 JSON（' + err.message + '）。' };
        render();
        return;
      }
      pageState.importState = analyzeImport(raw);
      afterImportStateChange();
    };
    reader.onerror = function () {
      pageState.importState = { error: '读取文件失败。' };
      afterImportStateChange();
    };
    reader.readAsText(file);
  }

  async function doImport() {
    const st = pageState.importState;
    if (!st || !st.raw) return;
    const isMerge = pageState.importMode === 'merge';

    const ok = await KC.confirmDialog({
      title: isMerge ? '合并导入数据' : '导入数据',
      message: isMerge
        ? '合并导入只会新增与更新记录，不会删除本机已有数据，也不会改动程序配置与用户设置。确定继续吗？'
        : '导入会用文件中的内容整体替换当前全部业务数据，此操作不可撤销。确定继续吗？',
      okText: isMerge ? '合并导入' : '导入并覆盖',
      danger: !isMerge
    });
    if (!ok) return;

    try {
      if (pageState.importBackup) {
        const bk = await KC.store.createBackup('导入前自动备份');
        KC.toast('已创建备份：' + bk.name, 'ok');
      }
      if (isMerge) {
        const stats = await KC.store.mergeImport(st.raw, pageState.mergePolicy);
        KC.toast('合并完成：新增 ' + stats.added + ' · 更新 ' + stats.updated +
          ' · 保留 ' + stats.kept, 'ok');
      } else {
        await KC.store.importAll(st.raw);
        KC.toast('导入完成', 'ok');
      }
      pageState.importState = null;
      pageState.mergeStats = null;
      await refreshBackups();
    } catch (err) {
      KC.toast('导入失败：' + err.message, 'error');
    }
  }

  /* -------------------------------------------------------------- 操作 */

  async function doCreateBackup() {
    try {
      const record = await KC.store.createBackup(pageState.backupName);
      pageState.backupName = '';
      KC.toast('已创建备份：' + record.name, 'ok');
      await refreshBackups();
    } catch (err) {
      KC.toast('创建备份失败：' + err.message, 'error');
    }
  }

  async function doRestoreBackup(id) {
    const list = pageState.backups || [];
    const record = list.find(function (b) { return b.id === id; });
    const ok = await KC.confirmDialog({
      title: '恢复备份',
      message: '将用备份「' + ((record && record.name) || id) +
        '」的内容整体替换当前全部业务数据。此操作不可撤销，确定继续吗？',
      okText: '恢复并覆盖',
      danger: true
    });
    if (!ok) return;
    try {
      await KC.store.restoreBackup(id);
      KC.toast('已从备份恢复', 'ok');
    } catch (err) {
      KC.toast('恢复失败：' + err.message, 'error');
    }
  }

  async function doDeleteBackup(id) {
    const list = pageState.backups || [];
    const record = list.find(function (b) { return b.id === id; });
    const ok = await KC.confirmDialog({
      title: '删除备份',
      message: '确定删除备份「' + ((record && record.name) || id) + '」吗？此操作不可撤销。',
      okText: '删除',
      danger: true
    });
    if (!ok) return;
    try {
      await KC.store.deleteBackup(id);
      KC.toast('已删除备份', 'ok');
      await refreshBackups();
    } catch (err) {
      KC.toast('删除失败：' + err.message, 'error');
    }
  }

  async function doClearData() {
    const ok = await KC.confirmDialog({
      title: '清空业务数据',
      message: '将删除全部每日记录、任务模板与任务记录、月度上下文与月度归档。' +
        '用户设置与本地备份会保留。此操作不可撤销。',
      okText: '确认清空',
      danger: true,
      requireText: CLEAR_CONFIRM_TEXT
    });
    if (!ok) return;
    try {
      await KC.store.clearBusinessData();
      KC.toast('已清空业务数据', 'ok');
      await refreshBackups();
    } catch (err) {
      KC.toast('清空失败：' + err.message, 'error');
    }
  }

  /* ---------------------------------------------- poi 快照 / 战果线数据 */

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
      KC.toast('识别不出服务器，请先到「设置 → 游戏服务器」里选择后再导入', 'error');
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
        (exist ? '\n\n该月已有数据（导入于 ' + formatDateTime(exist.importedAt) + '），将被覆盖。' : ''),
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

  /* -------------------------------------------------------------- 事件 */

  function handleClick(e) {
    const btn = KC.dom.closestFrom(e.target, '[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;

    if (act === 'export') KC.ui.export.exportData();
    else if (act === 'create-backup') doCreateBackup();
    else if (act === 'restore-backup') doRestoreBackup(btn.dataset.id);
    else if (act === 'delete-backup') doDeleteBackup(btn.dataset.id);
    else if (act === 'clear-data') doClearData();
    else if (act === 'clear-poi-snapshot') clearPoiSnapshot();
    else if (act === 'copy-senka-snippet') copySenkaSnippet();
    else if (act === 'import-senka-line') importSenkaLine();
    else if (act === 'delete-senka-line') deleteSenkaLine(btn.dataset.server, btn.dataset.month);
    else if (act === 'clear-senka-line') clearSenkaLine();
    else if (act === 'confirm-import') doImport();
    else if (act === 'cancel-import') {
      pageState.importState = null;
      pageState.mergeStats = null;
      render();
    }
    else if (act === 'import-mode') {
      pageState.importMode = btn.dataset.mode === 'merge' ? 'merge' : 'replace';
      afterImportStateChange();
    }
    else if (act === 'merge-policy') {
      pageState.mergePolicy = btn.dataset.policy === 'local' ? 'local' : 'file';
      afterImportStateChange();
    }
  }

  function handleChange(e) {
    const el = e.target;
    if (!el || !el.dataset) return;
    const act = el.dataset.act;

    if (act === 'import-file') handleFileChange(el);
    else if (act === 'import-backup') pageState.importBackup = el.checked;
  }

  function handleInput(e) {
    const el = e.target;
    if (!el || !el.dataset) return;
    if (el.dataset.act === 'backup-name') pageState.backupName = el.value;
  }

  /* -------------------------------------------------------------- 生命周期 */

  KC.pages.data = {
    mount: function (container) {
      pageState.container = container;
      pageState.importState = null;
      pageState.importMode = 'replace';
      pageState.mergePolicy = 'file';
      pageState.mergeStats = null;
      pageState.backupName = '';
      pageState.importBackup = true;

      handlers = { click: handleClick, change: handleChange, input: handleInput };
      container.addEventListener('click', handlers.click);
      container.addEventListener('change', handlers.change);
      container.addEventListener('input', handlers.input);

      unsubscribe = KC.store.subscribe(function (type) {
        if (type === 'change' || type === 'save-status') render();
      });

      render();
      refreshBackups();
      refreshStorage();
    },
    unmount: function () {
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
      if (handlers && pageState.container) {
        pageState.container.removeEventListener('click', handlers.click);
        pageState.container.removeEventListener('change', handlers.change);
        pageState.container.removeEventListener('input', handlers.input);
      }
      handlers = null;
      pageState.container = null;
      pageState.importState = null;
      pageState.mergeStats = null;
      pageState.backups = null;
      pageState.storage = null;
    }
  };
})(window.KC = window.KC || {});
