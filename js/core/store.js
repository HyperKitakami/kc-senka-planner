/* ==========================================================================
   core/store.js — 内存状态 + 自动保存 + 订阅
   依据 docs/03_data.md §1.2（保存事实，不保存计算结果）与 docs/06 §三。

   设计：
     · 所有事实数据在内存中维护，任何变更立即写入 IndexedDB（自动保存）
     · 变更后广播 'change'，页面据此实时重算并重绘
     · 统计结果一律不落库，由 calc/* 运行时计算
   ========================================================================== */
(function (KC) {
  'use strict';

  const listeners = new Set();

  const state = {
    ready: false,
    config: null,
    settings: null,
    dailyRecords: [],
    taskTemplates: [],
    taskRecords: [],
    monthlyContexts: [],
    archives: []
  };

  let saveStatus = { status: 'idle', at: null, message: '' };

  function emit(type, payload) {
    listeners.forEach(function (fn) {
      try { fn(type, payload, state); } catch (err) { console.error('[store] 订阅回调异常', err); }
    });
  }

  function subscribe(fn) {
    listeners.add(fn);
    return function () { listeners.delete(fn); };
  }

  function setSaveStatus(status, message) {
    saveStatus = { status: status, at: Date.now(), message: message || '' };
    emit('save-status', saveStatus);
  }

  function getSaveStatus() { return saveStatus; }

  /* ---------------------------------------------------------------- 载入 */

  function loadAll() {
    return Promise.all([
      KC.db.getAll('config'),
      KC.db.getAll('settings'),
      KC.db.getAll('dailyRecords'),
      KC.db.getAll('taskTemplates'),
      KC.db.getAll('taskRecords'),
      KC.db.getAll('monthlyContexts'),
      KC.db.getAll('archives')
    ]).then(function (r) {
      state.config = r[0][0] || null;
      state.settings = r[1][0] || null;
      state.dailyRecords = r[2] || [];
      state.taskTemplates = r[3] || [];
      state.taskRecords = r[4] || [];
      state.monthlyContexts = r[5] || [];
      state.archives = r[6] || [];
    });
  }

  async function init() {
    await KC.db.open();
    await loadAll();

    const writes = [];

    if (!state.config) {
      state.config = KC.schema.createConfig();
      writes.push(KC.db.put('config', state.config));
    }
    if (!state.settings) {
      state.settings = Object.assign({}, KC.schema.DEFAULT_SETTINGS);
      writes.push(KC.db.put('settings', state.settings));
    } else {
      // 合并后新增的默认项，保证旧数据也具备最新设置字段
      const merged = Object.assign({}, KC.schema.DEFAULT_SETTINGS, state.settings);
      if (Object.keys(merged).length !== Object.keys(state.settings).length) {
        state.settings = merged;
        writes.push(KC.db.put('settings', state.settings));
      }
    }
    // 首次运行时写入内置任务模板
    if (!state.taskTemplates.length && KC.defaultTasks) {
      state.taskTemplates = KC.defaultTasks.createDefaultTemplates();
      writes.push(KC.db.putMany('taskTemplates', state.taskTemplates));
    }

    if (writes.length) await Promise.all(writes);

    state.ready = true;
    emit('ready');
    emit('change');
  }

  /* ------------------------------------------------------------ 写入工具 */

  function touchConfig() {
    if (!state.config) return Promise.resolve();
    state.config.updatedAt = new Date().toISOString();
    return KC.db.put('config', state.config);
  }

  /** 单条写入：自动保存 + 状态提示 */
  async function persist(storeName, value) {
    setSaveStatus('saving');
    try {
      await KC.db.put(storeName, value);
      await touchConfig();
      setSaveStatus('saved');
    } catch (err) {
      setSaveStatus('error', err.message);
      throw err;
    }
  }

  function upsert(list, item, key) {
    const idx = list.findIndex(function (x) { return x[key] === item[key]; });
    if (idx >= 0) list[idx] = item;
    else list.push(item);
    return list;
  }

  /* ---------------------------------------------------------- DailyRecord */

  function listDailyRecords() {
    return state.dailyRecords.slice().sort(function (a, b) {
      return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
    });
  }

  function getDailyRecord(date) {
    return state.dailyRecords.find(function (r) { return r.date === date; }) || null;
  }

  function normalizeDailyRecord(input) {
    const date = String((input && input.date) || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error('日期格式不正确，应为 YYYY-MM-DD。');
    }
    const raw = Number(input && input.sortieSenka);
    if (!isFinite(raw) || raw < 0) {
      throw new Error('当日出击战果必须是不小于 0 的数字。');
    }
    return {
      date: date,
      sortieSenka: KC.utils.round2(raw),
      note: String((input && input.note) || '').trim()
    };
  }

  async function saveDailyRecord(input) {
    const record = normalizeDailyRecord(input);
    await persist('dailyRecords', record);
    upsert(state.dailyRecords, record, 'date');
    emit('change');
    return record;
  }

  async function deleteDailyRecord(date) {
    setSaveStatus('saving');
    try {
      await KC.db.del('dailyRecords', date);
      await touchConfig();
      setSaveStatus('saved');
    } catch (err) {
      setSaveStatus('error', err.message);
      throw err;
    }
    state.dailyRecords = state.dailyRecords.filter(function (r) { return r.date !== date; });
    emit('change');
  }

  /* ------------------------------------------------------- MonthlyContext */

  function getMonthlyContext(month) {
    return state.monthlyContexts.find(function (m) { return m.month === month; }) || null;
  }

  async function saveMonthlyContext(month, patch) {
    const existing = getMonthlyContext(month) || KC.schema.createMonthlyContext(month);
    const next = Object.assign({}, existing, patch, { month: month });
    await persist('monthlyContexts', next);
    upsert(state.monthlyContexts, next, 'month');
    emit('change');
    return next;
  }

  /* -------------------------------------------------------- TaskTemplate */

  function listTaskTemplates() {
    const order = { EO: 0, EX: 1, EVENT: 2, USER: 3 };
    return state.taskTemplates.slice().sort(function (a, b) {
      const ga = order[a.taskGroup] === undefined ? 9 : order[a.taskGroup];
      const gb = order[b.taskGroup] === undefined ? 9 : order[b.taskGroup];
      if (ga !== gb) return ga - gb;
      return (Number(a.senkaValue) || 0) - (Number(b.senkaValue) || 0);
    });
  }

  function getTaskTemplate(id) {
    return state.taskTemplates.find(function (t) { return t.id === id; }) || null;
  }

  function normalizeTaskTemplate(input, existing) {
    const name = String((input && input.name) || '').trim();
    if (!name) throw new Error('任务名称不能为空。');

    const senkaValue = Number(input && input.senkaValue);
    if (!isFinite(senkaValue) || senkaValue < 0) {
      throw new Error('战果值必须是不小于 0 的数字。');
    }

    const resetCycle = KC.schema.RESET_CYCLES.indexOf(input && input.resetCycle) >= 0
      ? input.resetCycle : 'MONTHLY';
    const taskGroup = KC.schema.TASK_GROUPS.indexOf(input && input.taskGroup) >= 0
      ? input.taskGroup : 'USER';

    const next = {
      id: (existing && existing.id) || KC.utils.uid('tpl'),
      name: name,
      taskGroup: taskGroup,
      senkaValue: KC.utils.round2(senkaValue),
      resetCycle: resetCycle,
      enabled: input && input.enabled !== undefined ? !!input.enabled : true,
      isSystem: !!(existing && existing.isSystem),
      defaultInPlan: !!(input && input.defaultInPlan)
    };
    if (resetCycle === 'YEARLY') {
      next.resetMonth = KC.utils.clamp(Number(input.resetMonth) || 1, 1, 12);
    }
    if (resetCycle === 'EVENT') {
      next.eventPeriodId = String((input && input.eventPeriodId) || '').trim();
    }
    return next;
  }

  /**
   * 新增或修改任务模板。
   * 系统任务不可编辑，仅允许调整「是否启用」（docs/05_glossary.md §四）。
   */
  async function saveTaskTemplate(input) {
    const existing = input && input.id ? getTaskTemplate(input.id) : null;
    if (input && input.id && !existing) throw new Error('任务模板不存在。');

    let next;
    if (existing && existing.isSystem) {
      next = Object.assign({}, existing, {
        enabled: input.enabled !== undefined ? !!input.enabled : existing.enabled
      });
    } else {
      next = normalizeTaskTemplate(input, existing);
    }

    await persist('taskTemplates', next);
    upsert(state.taskTemplates, next, 'id');
    emit('change');
    return next;
  }

  /** 启用 / 停用任务 */
  async function setTaskEnabled(id, enabled) {
    const existing = getTaskTemplate(id);
    if (!existing) throw new Error('任务模板不存在。');
    const next = Object.assign({}, existing, { enabled: !!enabled });
    await persist('taskTemplates', next);
    upsert(state.taskTemplates, next, 'id');
    emit('change');
    return next;
  }

  /** 删除任务模板（仅限用户任务；历史 TaskRecord 依原则不自动删除） */
  async function deleteTaskTemplate(id) {
    const existing = getTaskTemplate(id);
    if (!existing) throw new Error('任务模板不存在。');
    if (existing.isSystem) throw new Error('系统任务不可删除，只能停用。');

    setSaveStatus('saving');
    try {
      await KC.db.del('taskTemplates', id);
      await touchConfig();
      setSaveStatus('saved');
    } catch (err) {
      setSaveStatus('error', err.message);
      throw err;
    }
    state.taskTemplates = state.taskTemplates.filter(function (t) { return t.id !== id; });
    emit('change');
  }

  /* ---------------------------------------------------------- TaskRecord */

  function getTaskRecord(templateId, periodId) {
    return state.taskRecords.find(function (r) {
      return r.templateId === templateId && r.periodId === periodId;
    }) || null;
  }

  function listTaskRecords() {
    return state.taskRecords.slice();
  }

  /**
   * 设置某任务在指定周期内的完成状态。
   * 只保存"已完成"的记录；取消完成即删除对应记录（absence = 未完成），
   * 程序不通过"重置任务"改变状态（docs/04_calculation.md §4.5）。
   */
  async function setTaskCompleted(templateId, periodId, completed) {
    const existing = getTaskRecord(templateId, periodId);

    if (!completed) {
      if (!existing) return null;
      setSaveStatus('saving');
      try {
        await KC.db.del('taskRecords', existing.id);
        await touchConfig();
        setSaveStatus('saved');
      } catch (err) {
        setSaveStatus('error', err.message);
        throw err;
      }
      state.taskRecords = state.taskRecords.filter(function (r) { return r.id !== existing.id; });
      emit('change');
      return null;
    }

    const next = {
      id: existing ? existing.id : KC.utils.uid('tr'),
      templateId: templateId,
      periodId: periodId,
      completed: true,
      completedAt: new Date().toISOString()
    };
    await persist('taskRecords', next);
    upsert(state.taskRecords, next, 'id');
    emit('change');
    return next;
  }

  /* ----------------------------------------------------------- 规划池 */

  function getPlanningPool(month) {
    const ctx = getMonthlyContext(month);
    return ctx && Array.isArray(ctx.planningPool) ? ctx.planningPool.slice() : [];
  }

  /**
   * 生效的规划池。
   * 该月尚无 MonthlyContext 时，回退为「默认纳入规划池」的启用任务，
   * 使用户第一次进入某月即有合理的初始选择；一旦用户改动过，
   * 便以 MonthlyContext 中保存的选择为准（规划池仅保存当前选择）。
   */
  function getEffectivePlanningPool(month) {
    const ctx = getMonthlyContext(month);
    if (ctx && Array.isArray(ctx.planningPool)) return ctx.planningPool.slice();
    return state.taskTemplates
      .filter(function (t) { return t.enabled !== false && t.defaultInPlan; })
      .map(function (t) { return t.id; });
  }

  async function setPlanningPool(month, ids) {
    const unique = [];
    (ids || []).forEach(function (id) { if (unique.indexOf(id) < 0) unique.push(id); });
    return saveMonthlyContext(month, { planningPool: unique });
  }

  async function togglePlanning(month, templateId) {
    const pool = getPlanningPool(month);
    const idx = pool.indexOf(templateId);
    if (idx >= 0) pool.splice(idx, 1);
    else pool.push(templateId);
    return setPlanningPool(month, pool);
  }

  /* ------------------------------------------------------------ Archive */

  function listArchives() {
    return state.archives.slice().sort(function (a, b) {
      return a.month < b.month ? 1 : a.month > b.month ? -1 : 0;
    });
  }

  function getArchive(month) {
    return state.archives.find(function (a) { return a.month === month; }) || null;
  }

  /**
   * 归档记录规范化。
   * 说明：lineDiff（与奖励线差值）由 finalSenka − rewardLine 自动得出，
   * 属于 docs/03_data.md 中 Archive 的字段之一，随归档一起保存为快照。
   */
  function normalizeArchive(input) {
    const month = String((input && input.month) || '').trim();
    if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('月份格式不正确，应为 YYYY-MM。');

    const finalRaw = Number(input && input.finalSenka);
    if (!isFinite(finalRaw) || finalRaw < 0) throw new Error('最终战果必须是不小于 0 的数字。');
    const finalSenka = KC.utils.round2(finalRaw);

    let rank = null;
    const rankRaw = input && input.rank;
    if (rankRaw !== null && rankRaw !== undefined && String(rankRaw).trim() !== '') {
      const r = Number(rankRaw);
      if (!isFinite(r) || r < 1) throw new Error('排名必须是不小于 1 的整数。');
      rank = Math.round(r);
    }

    const tierKeys = KC.schema.REWARD_TIERS.map(function (t) { return t.key; });
    const rewardTier = tierKeys.indexOf(input && input.rewardTier) >= 0 ? input.rewardTier : null;

    let rewardLine = null;
    const lineRaw = input && input.rewardLine;
    if (lineRaw !== null && lineRaw !== undefined && String(lineRaw).trim() !== '') {
      const l = Number(lineRaw);
      if (!isFinite(l) || l < 0) throw new Error('官方奖励线必须是不小于 0 的数字。');
      rewardLine = KC.utils.round2(l);
    }

    const rewards = (Array.isArray(input && input.rewards) ? input.rewards : [])
      .map(function (s) { return String(s || '').trim(); })
      .filter(Boolean);

    const rewardAtRaw = String((input && input.rewardAt) || '').trim();
    const rewardAt = /^\d{4}-\d{2}-\d{2}$/.test(rewardAtRaw) ? rewardAtRaw : null;

    return {
      month: month,
      finalSenka: finalSenka,
      rank: rank,
      rewardTier: rewardTier,
      // 「人事」仅对联合区间有意义
      rewardFirst: !!(input && input.rewardFirst) && rewardTier === 'combined',
      rewardLine: rewardLine,
      lineDiff: rewardLine === null ? null : KC.utils.round2(finalSenka - rewardLine),
      rewards: rewards,
      rewardAt: rewardAt,
      note: String((input && input.note) || '').trim(),
      updatedAt: new Date().toISOString()
    };
  }

  async function saveArchive(input) {
    const record = normalizeArchive(input);
    await persist('archives', record);
    upsert(state.archives, record, 'month');
    emit('change');
    return record;
  }

  async function deleteArchive(month) {
    setSaveStatus('saving');
    try {
      await KC.db.del('archives', month);
      await touchConfig();
      setSaveStatus('saved');
    } catch (err) {
      setSaveStatus('error', err.message);
      throw err;
    }
    state.archives = state.archives.filter(function (a) { return a.month !== month; });
    emit('change');
  }

  /* ------------------------------------------------------------ Settings */

  function getSettings() {
    return Object.assign({}, KC.schema.DEFAULT_SETTINGS, state.settings || {});
  }

  async function saveSettings(patch) {
    const next = Object.assign({}, getSettings(), patch, { key: KC.schema.SETTINGS_KEY });
    await persist('settings', next);
    state.settings = next;
    emit('change');
    return next;
  }

  /* ------------------------------------------------------------ 本地备份 */

  function defaultBackupName() {
    const d = new Date();
    return '备份 ' + KC.utils.toDateKey(d) + ' ' +
      KC.utils.pad2(d.getHours()) + ':' + KC.utils.pad2(d.getMinutes());
  }

  function listBackups() {
    return KC.db.getAll('backups').then(function (list) {
      return (list || []).slice().sort(function (a, b) {
        return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
      });
    });
  }

  function getBackup(id) {
    return KC.db.get('backups', id);
  }

  /** 新建一份完整数据快照（多个备份并存，可随时恢复） */
  async function createBackup(name, note) {
    const payload = await KC.db.exportAll();
    const json = JSON.stringify(payload);
    const record = {
      id: KC.utils.uid('bk'),
      name: String(name || '').trim() || defaultBackupName(),
      note: String(note || '').trim(),
      createdAt: new Date().toISOString(),
      size: json.length,
      payload: payload
    };
    await KC.db.put('backups', record);
    return record;
  }

  async function deleteBackup(id) {
    await KC.db.del('backups', id);
    return true;
  }

  /** 从本地备份恢复：走与导入完全相同的「校验 → 迁移 → 整体替换」流程 */
  async function restoreBackup(id) {
    const record = await KC.db.get('backups', id);
    if (!record) throw new Error('备份不存在，可能已被删除。');
    await importAll(record.payload);
    return true;
  }

  /** 清空全部业务数据（保留用户设置与本地备份），并重新写入内置任务模板 */
  async function clearBusinessData() {
    setSaveStatus('saving');
    try {
      const names = ['dailyRecords', 'taskTemplates', 'taskRecords', 'monthlyContexts', 'archives'];
      for (let i = 0; i < names.length; i++) {
        await KC.db.clear(names[i]);
      }
      await loadAll();
      state.config = KC.schema.createConfig();
      await KC.db.put('config', state.config);
      state.taskTemplates = KC.defaultTasks.createDefaultTemplates();
      await KC.db.putMany('taskTemplates', state.taskTemplates);
      setSaveStatus('saved');
    } catch (err) {
      setSaveStatus('error', err.message);
      throw err;
    }
    emit('change');
    return true;
  }

  /* ------------------------------------------------------------ 导入导出 */

  async function exportAll() {
    const payload = await KC.db.exportAll();
    // 记录导出时间，便于用户判断备份是否过期
    await saveSettings({ lastExportAt: new Date().toISOString() });
    return payload;
  }

  /** 导入：先校验/迁移，再整体替换，最后重新载入内存 */
  async function importAll(payload) {
    const result = KC.schema.migrate(payload);
    if (!result.ok) throw new Error(result.error);
    setSaveStatus('saving');
    try {
      await KC.db.replaceAll(result.data);
      await loadAll();
      await touchConfig();
      setSaveStatus('saved');
    } catch (err) {
      setSaveStatus('error', err.message);
      throw err;
    }
    emit('change');
    return true;
  }

  /**
   * 合并导入：只新增与更新，不删除本机已有数据；不触碰 config 与用户设置。
   * @param {'file'|'local'} policy 冲突策略：file = 以文件为准，local = 以本机为准
   * @returns {Promise<{added:number, updated:number, kept:number}>}
   */
  async function mergeImport(payload, policy) {
    const result = KC.schema.migrate(payload);
    if (!result.ok) throw new Error(result.error);

    setSaveStatus('saving');
    let stats;
    try {
      stats = await KC.db.mergeAll(result.data, policy === 'local' ? 'local' : 'file');
      await loadAll();
      await touchConfig();
      setSaveStatus('saved');
    } catch (err) {
      setSaveStatus('error', err.message);
      throw err;
    }
    emit('change');
    return stats;
  }

  KC.store = {
    state: state,
    init: init,
    subscribe: subscribe,
    getSaveStatus: getSaveStatus,
    // DailyRecord
    listDailyRecords: listDailyRecords,
    getDailyRecord: getDailyRecord,
    saveDailyRecord: saveDailyRecord,
    deleteDailyRecord: deleteDailyRecord,
    // MonthlyContext
    getMonthlyContext: getMonthlyContext,
    saveMonthlyContext: saveMonthlyContext,
    // TaskTemplate
    listTaskTemplates: listTaskTemplates,
    getTaskTemplate: getTaskTemplate,
    saveTaskTemplate: saveTaskTemplate,
    setTaskEnabled: setTaskEnabled,
    deleteTaskTemplate: deleteTaskTemplate,
    // TaskRecord
    listTaskRecords: listTaskRecords,
    getTaskRecord: getTaskRecord,
    setTaskCompleted: setTaskCompleted,
    // 规划池
    getPlanningPool: getPlanningPool,
    getEffectivePlanningPool: getEffectivePlanningPool,
    setPlanningPool: setPlanningPool,
    togglePlanning: togglePlanning,
    // Archive
    listArchives: listArchives,
    getArchive: getArchive,
    saveArchive: saveArchive,
    deleteArchive: deleteArchive,
    // Settings
    getSettings: getSettings,
    saveSettings: saveSettings,
    // 本地备份
    listBackups: listBackups,
    getBackup: getBackup,
    createBackup: createBackup,
    deleteBackup: deleteBackup,
    restoreBackup: restoreBackup,
    clearBusinessData: clearBusinessData,
    // 导入导出
    exportAll: exportAll,
    importAll: importAll,
    mergeImport: mergeImport
  };
})(window.KC = window.KC || {});
