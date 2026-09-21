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
    // 任务进度节点（可选字段）：无有效步骤时不写这个键，
    // 使"缺失 = 无节点任务"的语义保持干净（见 schema.js 任务进度说明）。
    // 系统任务走的是另一条分支（仅允许改 enabled），因此不会被这里覆盖进度配置。
    const steps = KC.schema.normalizeSteps(input && input.steps);
    if (steps) next.steps = steps;
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

  /** 清洗进度对象：丢弃非正整数的条目；无有效条目时返回 null（不写这个键） */
  function normalizeStepProgress(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const out = {};
    let n = 0;
    Object.keys(raw).forEach(function (code) {
      const v = Math.round(Number(raw[code]));
      if (!isFinite(v) || v <= 0) return;
      out[code] = v;
      n++;
    });
    return n ? out : null;
  }

  /**
   * 取某任务在**当前周期**内的记录，用于读取进度。
   *
   * 为什么需要这个包装：进度只作为"当前状态"保存，跟随任务周期刷新。
   * 若这条记录挂的周期已经不是任务的当前周期（例如浏览器关了一周再打开，
   * 日常任务已经进入新的一期），则整条记录视同不存在 —— 进度不沿用，
   * 任务回到"未完成 / 未开始"。旧的周期记录仍留在库里，历史归属统计照旧。
   *
   * 调用方必须给出该任务的**当前** period id；补录历史周期时不要用它
   * （补录场景要的就是那条挂在历史周期上的记录本体）。
   */
  function getCurrentTaskRecord(templateId, currentPeriodId) {
    const record = getTaskRecord(templateId, currentPeriodId);
    if (!record) return null;
    const progress = record.stepProgress;
    if (!progress || typeof progress !== 'object' || !Object.keys(progress).length) return record;
    const template = getTaskTemplate(templateId);
    const cycle = template && template.resetCycle;
    // 长期任务没有"周期刷新"这回事，进度一直有效
    if (!cycle || cycle === 'NONE') return record;
    const period = KC.periods.taskPeriod(cycle, new Date(), {
      eventPeriodId: template.eventPeriodId,
      resetMonth: template.resetMonth
    });
    return period && period.id === currentPeriodId ? record : null;
  }

  /**
   * 归一化为 ISO 字符串。接受 Date / ISO 字符串 / 时间戳，非法值回退当前时刻。
   * 不用 `instanceof Date` 判断，避免跨执行环境的 Date 无法识别。
   */
  function toIso(value) {
    if (value === undefined || value === null || value === '') return new Date().toISOString();
    const d = value instanceof Date ? value : new Date(value);
    return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  }

  /**
   * 判断「取消完成」是否应当连带重置进度记录。
   *
   * 规则（用户口径第 2 条）：**任务已完成、且此刻节点全部达成** 时，
   * 取消完成意味着"这一轮从头再来"，进度一并清零（记录被删除）。
   * 其余情况（无节点 / 节点未全达成）取消完成只把 completed 置 false，进度原样保留 ——
   * 因为那些进度还代表用户实际打过的东西，不该被顺手抹掉。
   *
   * @returns {boolean} true 表示取消完成会同时清掉进度
   */
  function willResetProgressOnUncomplete(templateId, periodId) {
    const existing = getTaskRecord(templateId, periodId);
    if (!existing || !existing.completed) return false;
    const template = getTaskTemplate(templateId);
    if (!template || !template.steps || !template.steps.length) return false;
    return KC.schema.taskCompletedBySteps(template, existing.stepProgress) === true;
  }

  /**
   * 设置某任务在指定周期内的完成状态。
   *
   * 四种情形：
   *   1) 置为已完成 —— 写入 / 更新记录，completed = true；已有进度原样保留。
   *   2) 取消完成，且**进度全满**（willResetProgressOnUncomplete）—— 删除记录，
   *      进度一并清零。语义是"这一轮重来"；UI 会先弹确认再走到这里。
   *   3) 取消完成，有进度但**未全满** —— 不删记录，只把 completed 置为 false，进度保留。
   *   4) 取消完成，且**没有进度** —— 删除记录（absence = 未完成），与旧行为一致。
   *
   * periodId 由调用方显式给出，因此可以补录任意历史周期（docs/04_calculation.md §十五）。
   * completedAt 用于战果归属判定（§4.6）：正常勾选传当前时刻；
   * 补录历史周期时传一个落在目标归属月内的近似时刻，否则会被算到当前月。
   * @param {string} templateId
   * @param {string} periodId
   * @param {boolean} completed
   * @param {Date|string} [completedAt]
   */
  async function setTaskCompleted(templateId, periodId, completed, completedAt) {
    const existing = getTaskRecord(templateId, periodId);

    if (!completed) {
      if (!existing) return null;
      // 有进度且未全满 ⇒ 保留进度，只关掉完成位
      if (normalizeStepProgress(existing.stepProgress) &&
          !willResetProgressOnUncomplete(templateId, periodId)) {
        const kept = Object.assign({}, existing, { completed: false });
        await persist('taskRecords', kept);
        upsert(state.taskRecords, kept, 'id');
        emit('change');
        return kept;
      }
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
      completedAt: toIso(completedAt)
    };
    const progress = normalizeStepProgress(existing && existing.stepProgress);
    if (progress) next.stepProgress = progress;
    await persist('taskRecords', next);
    upsert(state.taskRecords, next, 'id');
    emit('change');
    return next;
  }

  /**
   * 批量把若干任务置为已完成 / 取消完成（poi EO 同步用）。
   *
   * 为什么单独开一个方法而不是循环调 setTaskCompleted：
   *   ① 逐条调用会 emit N 次 change ⇒ 任务页重绘 N 次（列表很长时明显卡顿）；
   *   ② 逐条失败到一半会留下"改了一半"的状态，用户无法判断是否重试。
   *   这里按「先全部写库、再一次性合并进内存、最后只广播一次」执行：
   *   任何一条写库失败都不改内存、不广播，调用方拿到 failed 列表后提示即可。
   *
   * ⚠️ 只写 completed=true（同步方向是"poi 说完成了 ⇒ 我们也勾上"）。
   *   反向（poi 说没完成 ⇒ 取消我们的勾选）**不做**，因为 poi 的 rankuex 只反映
   *   "当前血条在不在"，而战果归属有 21:00 边界 —— 自动取消会把已经计入历史
   *   归属的战果凭空抹掉，风险太大。UI 只把这类差异列出来提示用户手动作决定。
   *
   * @param {Array<{templateId:string, periodId:string, completedAt?:Date|string}>} items
   * @returns {Promise<{ok:number, failed:Array<{item:object, error:string}>}>}
   */
  async function setTasksCompletedBatch(items) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return { ok: 0, failed: [] };

    const failed = [];
    const nexts = [];

    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      const templateId = String(it && it.templateId || '');
      const periodId = String(it && it.periodId || '');
      if (!templateId || !periodId) {
        failed.push({ item: it, error: '缺少 templateId 或 periodId。' });
        continue;
      }
      const existing = getTaskRecord(templateId, periodId);
      const next = {
        id: existing ? existing.id : KC.utils.uid('tr'),
        templateId: templateId,
        periodId: periodId,
        completed: true,
        completedAt: toIso(it.completedAt)
      };
      // 保留已有进度：批量勾选不该把用户已经记下的节点进度抹掉
      const progress = normalizeStepProgress(existing && existing.stepProgress);
      if (progress) next.stepProgress = progress;

      try {
        await KC.db.put('taskRecords', next);
        nexts.push(next);
      } catch (err) {
        failed.push({ item: it, error: err.message });
      }
    }

    if (nexts.length) {
      nexts.forEach(function (n) { upsert(state.taskRecords, n, 'id'); });
      try {
        await touchConfig();
      } catch (err) { /* 配置时间戳失败不影响已完成的任务记录 */ }
      emit('change');
    }
    return { ok: nexts.length, failed: failed };
  }

  /**
   * 设置某任务在指定周期内、某个节点的已达成次数。
   *
   * 只对"任务有对应节点"的调用有意义；次数会被收敛到 0 ～ requiredCount 之间。
   * 完成状态按下述规则联动（用户口径「读法 A」）：
   *   · 全部节点达成 → completed 自动置为 true（无论用户是否勾过）
   *   · 节点未全达成 → **不回退**已经为 true 的 completed（需用户显式取消）
   * 因此这是一个"单调推进"的写入：进度可以往回改，完成状态不会因此丢失。
   *
   * @param {string} templateId
   * @param {string} periodId
   * @param {string} code 节点 code
   * @param {number} count 已达成次数（0 表示清掉该节点）
   * @param {Date|string} [at] 首次使任务变为完成时写进 completedAt 的时刻
   * @returns {Promise<{record: object|null, completed: boolean}>}
   */
  async function setTaskStepProgress(templateId, periodId, code, count, at) {
    const template = getTaskTemplate(templateId);
    if (!template) throw new Error('任务模板不存在。');
    const steps = (template.steps || []);
    const step = steps.filter(function (s) { return s.code === code; })[0];
    if (!step) throw new Error('该任务没有这个进度节点。');

    const need = Math.max(1, Math.round(Number(step.requiredCount)) || 1);
    const n = Math.round(Number(count));
    const nextCount = !isFinite(n) || n <= 0 ? 0 : Math.min(n, need);

    const existing = getTaskRecord(templateId, periodId);
    const progress = Object.assign({}, normalizeStepProgress(existing && existing.stepProgress) || {});
    if (nextCount > 0) progress[code] = nextCount;
    else delete progress[code];

    const bySteps = KC.schema.taskCompletedBySteps(template, progress);
    const completed = bySteps === null ? !!(existing && existing.completed) : (bySteps || !!(existing && existing.completed));
    const hasData = Object.keys(progress).length > 0 || completed;

    if (!hasData) {
      if (!existing) return { record: null, completed: false };
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
      return { record: null, completed: false };
    }

    const next = {
      id: existing ? existing.id : KC.utils.uid('tr'),
      templateId: templateId,
      periodId: periodId,
      completed: completed,
      completedAt: existing && existing.completedAt
        ? existing.completedAt
        : toIso(at)
    };
    if (Object.keys(progress).length) next.stepProgress = progress;
    await persist('taskRecords', next);
    upsert(state.taskRecords, next, 'id');
    emit('change');
    return { record: next, completed: completed };
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
    getCurrentTaskRecord: getCurrentTaskRecord,
    setTaskCompleted: setTaskCompleted,
    setTasksCompletedBatch: setTasksCompletedBatch,
    setTaskStepProgress: setTaskStepProgress,
    willResetProgressOnUncomplete: willResetProgressOnUncomplete,
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
