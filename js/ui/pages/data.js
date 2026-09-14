/* ==========================================================================
   ui/pages/data.js — 数据管理页
   依据 docs/02_ui.md §4.7、docs/01_requirements.md §六、docs/03_data.md §九、
        docs/06_data_strategy.md §四 / §五。

   职责（原则上不放置业务功能）：
     · 自动保存状态、存储引擎与数据量概览
     · 导出全部数据（JSON，含 schemaVersion）
     · 导入数据：先校验版本 → 依次迁移 → 显式确认 → 整体替换；失败不静默、不改动现有数据
     · 本地备份：建立多份快照、随时恢复
     · 清空业务数据（保留用户设置与本地备份）
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

  function downloadJson(filename, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
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
    const cfg = KC.store.state.config || {};

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
        '库 kc-senka-planner · v' + (cfg.schemaVersion || KC.schema.SCHEMA_VERSION), '') +
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
        '<span class="panel-count">数据结构版本 v' + (cfg.schemaVersion || KC.schema.SCHEMA_VERSION) +
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
          '<p class="page-sub">数据默认保存在本机浏览器（IndexedDB）。建议定期「导出数据」到文件，避免浏览器清理缓存造成丢失。</p>' +
        '</div>' +
      '</div>' +
      statusCards() +
      overviewPanel() +
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

  async function doExport() {
    try {
      const payload = await KC.store.exportAll();
      const d = new Date();
      const name = 'kc-senka-planner_' + U.toDateKey(d) + '_' +
        U.pad2(d.getHours()) + U.pad2(d.getMinutes()) + '.json';
      downloadJson(name, payload);
      KC.toast('已导出 ' + name, 'ok');
    } catch (err) {
      KC.toast('导出失败：' + err.message, 'error');
    }
  }

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

  /* -------------------------------------------------------------- 事件 */

  function handleClick(e) {
    const btn = KC.dom.closestFrom(e.target, '[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;

    if (act === 'export') doExport();
    else if (act === 'create-backup') doCreateBackup();
    else if (act === 'restore-backup') doRestoreBackup(btn.dataset.id);
    else if (act === 'delete-backup') doDeleteBackup(btn.dataset.id);
    else if (act === 'clear-data') doClearData();
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
