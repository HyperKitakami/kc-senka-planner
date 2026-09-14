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
      'calendar'
    ],
    dashboardHidden: [],
    /** 默认预测方式（docs/04_calculation.md §十一）：
     *  recent = 最近 N 天平均；period = 当前周期平均 */
    predictionMode: 'recent',
    predictionDays: 7,
    /** 规划展示口径：actual（实际统计）| combined（综合进度，仅运行时计算） */
    planningMode: 'actual',
    /** 战果记录页的录入模式：list（表单 + 表格）| calendar（月历快速录入） */
    recordsMode: 'list',
    /**
     * 所在游戏服务器编号（'01'～'20'），null 表示未设定。
     * 仅用于自动生成「人事表」图片地址，不影响任何业务数据。
     */
    server: null,
    /** 最近一次导出数据的时间（仅作提醒，便于用户判断备份是否过期） */
    lastExportAt: null
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
