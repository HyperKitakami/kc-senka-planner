/* ==========================================================================
   core/schema.js — 数据结构定义、版本号与迁移链
   依据 docs/03_data.md §1.5 与 docs/06_data_strategy.md §5。

   原则：
     · 所有导出数据必须包含 schemaVersion
     · 迁移必须按版本顺序依次执行，不得跳跃
     · 迁移失败必须阻断导入并给出可读错误，不得静默覆盖
   ========================================================================== */
(function (KC) {
  'use strict';

  /** 当前程序支持的数据结构版本 */
  const SCHEMA_VERSION = 2;

  /** IndexedDB 对象仓库定义（keyPath 及索引） */
  const STORES = {
    config:          { keyPath: 'key' },
    dailyRecords:    { keyPath: 'date' },
    taskTemplates:   { keyPath: 'id' },
    taskRecords:     { keyPath: 'id', indexes: [
                        { name: 'byTemplate', keyPath: 'templateId' },
                        { name: 'byPeriod', keyPath: 'periodId' }
                      ] },
    monthlyContexts: { keyPath: 'month' },
    archives:        { keyPath: 'month' },
    settings:        { keyPath: 'key' },
    /** 本地备份快照（v2 新增） */
    backups:         { keyPath: 'id' }
  };

  /**
   * 不参与导入导出的仓库。
   * 本地备份属于"本机便利性数据"而非业务数据：
   *   · 导出时不带上，避免"备份里套备份"；
   *   · 导入时不覆盖，避免导入一份文件就把本机快照清掉。
   */
  const TRANSIENT_STORES = ['backups'];

  const CONFIG_KEY = 'app';
  const SETTINGS_KEY = 'user';

  /**
   * 游戏服务器（共 20 个）。
   * 编号即「人事表」图片文件名末尾的 2 位数字。
   * 来源：舰娘百科「服务器」条目。
   */
  const SERVERS = [
    { code: '01', name: '横须贺镇守府' },
    { code: '02', name: '吴镇守府' },
    { code: '03', name: '佐世保镇守府' },
    { code: '04', name: '舞鹤镇守府' },
    { code: '05', name: '大凑警备府' },
    { code: '06', name: '特鲁克泊地' },
    { code: '07', name: '林加泊地' },
    { code: '08', name: '拉包尔基地' },
    { code: '09', name: '肖特兰泊地' },
    { code: '10', name: '布因基地' },
    { code: '11', name: '塔威塔威泊地' },
    { code: '12', name: '帕劳泊地' },
    { code: '13', name: '文莱泊地' },
    { code: '14', name: '单冠湾泊地' },
    { code: '15', name: '幌筵泊地' },
    { code: '16', name: '宿毛湾泊地' },
    { code: '17', name: '鹿屋基地' },
    { code: '18', name: '岩川基地' },
    { code: '19', name: '佐伯湾泊地' },
    { code: '20', name: '柱岛泊地' }
  ];

  /** 人事表图片地址前缀（由游戏官方服务器提供，非本工具资源） */
  const RANK_IMAGE_BASE = 'https://w00g.kancolle-server.com/kcscontents/information/image/';

  /** 按编号取服务器名称；未知编号返回 null */
  function serverName(code) {
    const hit = SERVERS.filter(function (s) { return s.code === code; })[0];
    return hit ? hit.name : null;
  }

  /**
   * 自动生成某月「人事表」图片地址。
   * 文件名规则：rank + 年(2 位) + 月(2 位) + 服务器编号(2 位) + .jpg
   *   例：2017 年 4 月 · 佐世保镇守府(03) → rank170403.jpg
   *
   * 该地址完全由「归档月份 + 服务器设置」推导，属运行时计算结果，
   * 不写入数据库（docs/03_data.md §1.2 保存事实，不保存计算结果）。
   *
   * @param {string} monthKey 'YYYY-MM'
   * @param {string} serverCode '01'～'20'
   * @returns {string|null} 参数不合法（月份格式错误或未设定服务器）时返回 null
   */
  function rankImageUrl(monthKey, serverCode) {
    const month = String(monthKey || '');
    const code = String(serverCode || '');
    if (!/^\d{4}-\d{2}$/.test(month)) return null;
    if (!/^\d{2}$/.test(code)) return null;
    const p = month.split('-');
    return RANK_IMAGE_BASE + 'rank' + p[0].slice(2) + p[1] + code + '.jpg';
  }

  /**
   * 奖励区间（docs/01_requirements.md §5.2），按最终排名划分。
   * 采用标准枚举；未来新增区间只需在此追加一项，其余代码无需改动。
   */
  const REWARD_TIERS = [
    { key: 'combined', label: '联合（联合舰队基干舰队）',
      range: '1 ～ 5 名', note: '第 1 名俗称「人事」，人事表背景为其秘书舰' },
    { key: 't1', label: '一群（主力舰队第一群）', range: '6 ～ 20 名' },
    { key: 't2', label: '二群（主力舰队第二群）', range: '21 ～ 100 名' },
    { key: 't3', label: '三群（主力舰队第三群）', range: '101 ～ 500 名' },
    { key: 'tokumu', label: '特务（キリ番特务舰队群）',
      range: '第 600、700、800、880、888、900、999、1000 名', note: '奖励同三群' },
    { key: 'tasen', label: '田选（舰队名及コメント选抜游撃部队群）',
      range: '约前 3500 名中抽取 8 名', note: '奖励同三群' }
  ];

  const DEFAULT_SETTINGS = {
    key: SETTINGS_KEY,
    theme: 'light',
    /**
     * 首页卡片：顺序 + 隐藏列表（docs/02_ui.md §五「显示或隐藏卡片、调整卡片顺序」）。
     * 拆成两个字段而不是一个「可见列表」，是为了让"新增卡片"能自动补进已有配置里，
     * 不会因为用户调整过顺序就把新卡片弄丢。
     */
    dashboardOrder: [
      'currentSenka', 'target', 'remainingTarget', 'monthEndForecast',
      'todayGrowth', 'naturalDaily', 'requiredDaily', 'remainingPeriod',
      'calendar', 'trend', 'recentSummary'
    ],
    dashboardHidden: [],
    /**
     * 首页卡片尺寸：id -> 'sm' | 'md' | 'lg'（docs/02_ui.md §五「卡片大小」）。
     * 用映射而非数组：与 dashboardOrder 无关，改顺序不会连带错位；
     * 未配置的卡片在读取时落回默认尺寸，因此新增卡片无需迁移。
     */
    dashboardSizes: {},
    /** 默认预测方式（docs/04_calculation.md §十一）：
     *  recent = 最近 N 天平均；period = 当前周期平均 */
    predictionMode: 'recent',
    predictionDays: 7,
    /** 规划展示口径：actual（实际统计）| combined（综合进度，仅运行时计算） */
    planningMode: 'actual',
    /** 战果记录页的录入模式：list（表单 + 表格）| calendar（月历快速录入） */
    recordsMode: 'list',
    /**
     * 历史归档列表的单页显示数量（条）：10 | 20 | 50。
     * 仅影响显示，不改变任何业务数据；非法值在页面里落回 10。
     */
    archivePageSize: 10,
    /**
     * 「月度比较」卡片要包含的数据（docs/02_ui.md §4.6）。
     * 取值来自 KC.calc.analysis.COMPARE_METRICS 的 key：
     *   'inherited' 继承战果 / 'sortie' 出击战果 / 'eo' EO 战果 / 'task' 任务战果
     * 默认四项全选；空数组表示用户主动取消全部勾选（页面会提示至少勾一项）。
     * 仅影响该卡片的展示，不改变任何业务数据；非法值在页面里落回四项全选。
     */
    compareMetrics: ['inherited', 'sortie', 'eo', 'task'],
    /**
     * 「月度比较」横轴区间的起止月份（'YYYY-MM'），null = 未设定。
     * 两者都未设定时回退「最近 12 个月」；可自由指定，跨度上限 24 个月。
     * 归一化（含起止颠倒交换、超长截断）见 KC.calc.analysis.normalizeCompareRange。
     * 仅影响该卡片的展示，不改变任何业务数据。
     */
    compareFrom: null,
    compareTo: null,
    /**
     * 所在游戏服务器编号（'01'～'20'），null 表示未设定。
     * 仅用于自动生成「人事表」图片地址，不影响任何业务数据。
     */
    server: null,
    /** 最近一次导出数据的时间（仅作提醒，便于用户判断备份是否过期） */
    lastExportAt: null,
    /**
     * 数据导出提醒周期（docs/07_implementation.md §3.1）：
     *   'month'   按出击战果归属月（本月末日 21:00 切换）
     *   'quarter' 按季度任务归属季（任务口径末日 13:00 归属）
     *   'off'     关闭
     * 可选字段，按 planningPool 的先例不触发版本升级。
     *
     * ⚠️ 「上次已提醒 / 已导出的周期 id」**不放这里** —— 它是纯 UI 状态，
     *    存在本机轻量存储（kc-senka-planner:exportRemind），不该进导出文件。
     */
    exportRemindMode: 'month'
  };

  function createConfig() {
    const now = new Date().toISOString();
    return {
      key: CONFIG_KEY,
      schemaVersion: SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now
    };
  }

  /**
   * MonthlyContext 默认结构。
   * planningPool：规划池的当前选择（仅保存选择本身，不保存历史快照）。
   * 该字段为可选字段，读取时以运行时默认值兜底，因此不触发版本升级。
   */
  function createMonthlyContext(month) {
    return {
      month: month,
      inheritedSenka: 0,
      targetSenka: null,
      note: '',
      planningPool: []
    };
  }

  /* ------------------------------------------------- 任务进度（steps / 进度） */

  /**
   * 「任务进度」相关字段（均为**可选字段**，缺失时行为与旧数据完全一致）：
   *
   *   TaskTemplate.steps         [{ code, label, requiredCount }]
   *     · 任务需要逐个达成的节点，如 1-1 A胜 1 次 / 1-2 S胜 2 次。
   *     · 缺失或为空 ⇒ 该任务没有节点，完成状态完全由 TaskRecord.completed 决定。
   *
   *   TaskRecord.stepProgress    { [code]: 已达成次数 }
   *     · 只记录当前周期内的进度；**不参与战果归属统计，不进归档**。
   *     · 与 TaskRecord.periodId 绑定：读取时若记录的周期已不是任务当前周期，
   *       进度视为已重置（跟随任务周期刷新）。
   *
   * 之所以可以「不升 SCHEMA_VERSION」：两个字段都只在本机当前周期内使用，
   * 导入导出按记录整体携带，读取时一律走下面的工具函数兜底，
   * 因此不存在需要批量改写的存量数据（与 MonthlyContext.planningPool 同一先例）。
   */

  /** 步骤 code 的去重键（trim + 小写，避免 Node / NODE 被当成两个节点） */
  function stepCodeKey(code) {
    return String(code === undefined || code === null ? '' : code).trim().toLowerCase();
  }

  /**
   * 校正一个任务的步骤配置。
   * 过滤空 code、把 requiredCount 收敛为 >= 1 的整数、按 code 去重（保留第一个）。
   * 返回 null 表示「没有有效步骤」——调用方应视为无节点任务，而不是空数组。
   */
  function normalizeSteps(steps) {
    if (!Array.isArray(steps)) return null;
    const seen = {};
    const out = [];
    steps.forEach(function (raw) {
      const code = String((raw && raw.code) || '').trim();
      if (!code) return;
      const key = stepCodeKey(code);
      if (seen[key]) return;
      seen[key] = true;
      const n = Math.round(Number(raw && raw.requiredCount));
      out.push({
        code: code,
        label: String((raw && raw.label) || '').trim() || code,
        requiredCount: isFinite(n) && n >= 1 ? n : 1
      });
    });
    return out.length ? out : null;
  }

  /** 单个节点是否已达成：已计次数是否达到该节点的 requiredCount */
  function isStepDone(step, progress) {
    if (!step) return true;
    const need = Math.max(1, Math.round(Number(step.requiredCount)) || 1);
    const got = Math.round(Number((progress || {})[step.code]));
    return isFinite(got) && got >= need;
  }

  /**
   * 由进度推导「全部节点是否完成」。
   * @returns {boolean|null} 该任务没有节点时返回 null（交由 TaskRecord.completed 决定）
   */
  function taskCompletedBySteps(template, progress) {
    const steps = (template && template.steps) || null;
    if (!steps || !steps.length) return null;
    return steps.every(function (s) { return isStepDone(s, progress); });
  }

  /** 已达成节点数 / 总节点数（供 UI 显示 n/m） */
  function taskStepProgress(template, progress) {
    const steps = (template && template.steps) || [];
    const total = steps.length;
    let done = 0;
    steps.forEach(function (s) { if (isStepDone(s, progress)) done++; });
    return { done: done, total: total };
  }

  /**
   * 迁移链：MIGRATIONS[n] 表示 v(n-1) -> v(n) 的迁移函数。
   */
  const MIGRATIONS = {
    /**
     * v1 → v2：新增「本地备份」仓库（不参与导入导出）。
     * 业务数据结构未变，此处只补齐缺失的仓库键，
     * 保证导入后写入路径一致、不会因缺键而失败。
     */
    2: function (raw) {
      const data = (raw && raw.data) || {};
      ['config', 'dailyRecords', 'taskTemplates', 'taskRecords',
       'monthlyContexts', 'archives', 'settings'].forEach(function (name) {
        if (!Array.isArray(data[name])) data[name] = [];
      });
      raw.data = data;
      return raw;
    }
  };

  /**
   * 校验并迁移导入数据。
   * @returns {{ok: boolean, data?: object, error?: string}}
   */
  function migrate(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: '导入内容不是有效的对象。' };
    }
    const version = Number(raw.schemaVersion);
    if (!Number.isFinite(version)) {
      return { ok: false, error: '缺少 schemaVersion 字段，无法确定数据版本。' };
    }
    if (version > SCHEMA_VERSION) {
      return {
        ok: false,
        error: '数据版本 v' + version + ' 高于当前程序支持的 v' + SCHEMA_VERSION +
          '，请先升级程序后再导入。'
      };
    }
    if (!raw.data || typeof raw.data !== 'object') {
      return { ok: false, error: '导入数据缺少 data 字段。' };
    }

    let data = raw;
    for (let v = version; v < SCHEMA_VERSION; v++) {
      const step = MIGRATIONS[v + 1];
      if (typeof step !== 'function') {
        return { ok: false, error: '缺少 v' + v + ' → v' + (v + 1) + ' 的迁移步骤，导入已中止。' };
      }
      try {
        data = step(data);
      } catch (err) {
        return { ok: false, error: '迁移 v' + v + ' → v' + (v + 1) + ' 失败：' + (err && err.message) };
      }
    }

    return { ok: true, data: data };
  }

  KC.schema = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    STORES: STORES,
    TRANSIENT_STORES: TRANSIENT_STORES,
    CONFIG_KEY: CONFIG_KEY,
    SETTINGS_KEY: SETTINGS_KEY,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    /** 任务组（docs/06_data_strategy.md §1.3） */
    TASK_GROUPS: ['EO', 'EX', 'EVENT', 'USER'],
    /** 周期类型（docs/03_data.md §六） */
    RESET_CYCLES: ['NONE', 'DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY', 'EVENT'],
    /** 奖励区间枚举（docs/01_requirements.md §5.2） */
    REWARD_TIERS: REWARD_TIERS,
    /** 任务进度（可选字段）：步骤配置与判定工具 */
    normalizeSteps: normalizeSteps,
    stepCodeKey: stepCodeKey,
    isStepDone: isStepDone,
    taskCompletedBySteps: taskCompletedBySteps,
    taskStepProgress: taskStepProgress,
    /** 游戏服务器枚举（编号 + 名称） */
    SERVERS: SERVERS,
    RANK_IMAGE_BASE: RANK_IMAGE_BASE,
    serverName: serverName,
    rankImageUrl: rankImageUrl,
    MIGRATIONS: MIGRATIONS,
    createConfig: createConfig,
    createMonthlyContext: createMonthlyContext,
    migrate: migrate
  };
})(window.KC = window.KC || {});
