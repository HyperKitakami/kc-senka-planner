/* ==========================================================================
   calc/reminder.js — 导出提醒：周期 id 计算 + 提醒状态判定
   依据 docs/07_implementation.md §3.2 / §3.3。

   本模块是**纯函数模块，不做任何 IO**：
     · 不读设置 —— settings / lastExportAt / "上次已提醒的周期 id" 全部由调用方传入；
     · 不读写本机轻量存储 —— 提醒状态的落库在 js/ui/export.js。
   所有函数都显式接收 now，便于测试注入。

   口径（两套周期，不得混用）：
     · 'month'   → 出击战果归属月（KC.periods.currentAttributionMonth，末日 21:00 切换）
     · 'quarter' → 季度任务归属季（任务口径末日 13:00 归属，再定位到季度）
   ========================================================================== */
(function (KC) {
  'use strict';

  const U = KC.utils;

  const MODES = ['month', 'quarter', 'off'];
  const DEFAULT_MODE = 'month';

  /** 设置页用的三选一（文案与口径说明的唯一来源） */
  const MODE_OPTIONS = [
    { value: 'month', label: '每月',
      hint: '按「出击战果归属月」：本月末日 21:00 之后即算进入下一个月。' },
    { value: 'quarter', label: '每季度',
      hint: '按「季度任务归属季」：季度以 3 / 6 / 9 / 12 月起算（冬季度跨年），' +
        '末日 13:00 之后按任务口径归属。' },
    { value: 'off', label: '关闭',
      hint: '不在首页显示导出提醒。数据仍只存在本机，建议自行定期导出。' }
  ];

  /** 周期差上限：超过一律按 24 计（防异常输入，例如 lastExportAt 被改成了 1970 年） */
  const MAX_OVERDUE = 24;

  const NOTICE_TEXT = '本地备份与主数据存在同一处，浏览器清理站点数据时会一并丢失' +
    ' —— 本地备份不算导出，导出到文件才是真正的备份。';

  const PRIMARY_LABEL = '立即导出';

  /* ------------------------------------------------------------ 周期 id */

  /**
   * 归一化提醒周期。非法值回退默认（'month'）：
   * 这是个防丢数据的功能，宁可多提醒一次，也不要因为设置被写坏而静默不提醒。
   */
  function normalizeMode(mode) {
    return MODES.indexOf(mode) >= 0 ? mode : DEFAULT_MODE;
  }

  /**
   * 季度锚点 = 当前「任务归属月」的 15 日 12:00。
   *
   * 为什么不直接拿 now 去算季度：在季度首月 1 日 04:00 之前、或季度末月末日 13:00
   * 之后的边界窗口里，now 会落到相邻季度。取任务归属月的月中正午作锚点可以完全
   * 避开这些边界 —— 这正是 js/calc/tasks.js 的 periodForMonth() 已经在用的手法。
   */
  function quarterAnchor(now) {
    const month = KC.periods.currentTaskAttributionMonth(now);
    const p = String(month).split('-').map(Number);
    return new Date(p[0], p[1] - 1, 15, 12, 0, 0, 0);
  }

  /**
   * 季度周期 id（'YYYY-Qn'）。
   * 交给 periods.taskPeriod 生成，**不要自己用 quarterIndex() 拼字符串**：
   * 冬季度跨年（QUARTER_START_MONTH[4] = 12），2027-01 属于 '2026-Q4'，
   * 自己拼很容易在跨年处出错。
   */
  function quarterCycleId(now) {
    return KC.periods.taskPeriod('QUARTERLY', quarterAnchor(now)).id;
  }

  /**
   * 当前所处周期的 id。
   * @param {'month'|'quarter'|'off'} mode
   * @param {Date} [now]
   * @returns {string|null} 'off' 时返回 null
   */
  function remindCycleId(mode, now) {
    const m = normalizeMode(mode);
    if (m === 'off') return null;
    const at = now || new Date();
    return m === 'quarter' ? quarterCycleId(at) : KC.periods.currentAttributionMonth(at);
  }

  /** 'YYYY-MM' → 线性月序号（年 × 12 + 月 − 1）；无法解析返回 null */
  function monthIndex(monthKey) {
    const m = /^(\d{4})-(\d{2})$/.exec(String(monthKey || ''));
    if (!m) return null;
    return Number(m[1]) * 12 + (Number(m[2]) - 1);
  }

  /** 'YYYY-Qn' → 线性季序号（年 × 4 + 季 − 1）：'2026-Q4' → 8107、'2027-Q1' → 8108 */
  function quarterIndex(cycleId) {
    const m = /^(\d{4})-Q([1-4])$/.exec(String(cycleId || ''));
    if (!m) return null;
    return Number(m[1]) * 4 + (Number(m[2]) - 1);
  }

  /** 周期 id → 线性序号（用于算"跨了几个周期"） */
  function cycleIndex(mode, cycleId) {
    return mode === 'quarter' ? quarterIndex(cycleId) : monthIndex(cycleId);
  }

  /* --------------------------------------------------------- 提醒判定 */

  /** 解析时间戳；空值或非法返回 null */
  function parseAt(value) {
    if (!value) return null;
    const d = value instanceof Date ? value : new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }

  function formatAt(d) {
    return U.toDateKey(d) + ' ' + U.pad2(d.getHours()) + ':' + U.pad2(d.getMinutes());
  }

  function hidden(mode, cycleId) {
    return {
      show: false, level: 'info', mode: mode, cycleId: cycleId,
      overdueCycles: null, title: '', text: '', primaryLabel: ''
    };
  }

  /**
   * 提醒状态判定（纯函数，全部输入显式传入）。
   *
   * 判定流程（docs/07_implementation.md §3.3）：
   *   1. mode === 'off' → 不显示
   *   2. 本周期已提醒过（remindedCycleId === cycleId）→ 不显示
   *   3. 从未导出（或 lastExportAt 非法）→ 显示，level 'info'
   *   4. 否则算跨了几个周期 overdueCycles；**0 表示本周期内已导出过 → 不显示**
   *   5. overdueCycles >= 2 → 'warn'，否则 'info'
   *
   * @param {object} settings 用户设置（只读 exportRemindMode）
   * @param {string|null} lastExportAt 最近一次导出时间（ISO 字符串）
   * @param {string|null} remindedCycleId 本机层记录的"上次已提醒 / 已导出的周期 id"
   * @param {Date} [now]
   * @returns {{show:boolean, level:'info'|'warn', mode:string, cycleId:string|null,
   *            overdueCycles:number|null, title:string, text:string, primaryLabel:string}}
   */
  function exportReminderState(settings, lastExportAt, remindedCycleId, now) {
    const at = now || new Date();
    const mode = normalizeMode(settings && settings.exportRemindMode);
    const cycleId = remindCycleId(mode, at);

    if (mode === 'off' || !cycleId) return hidden(mode, cycleId);
    if (remindedCycleId && String(remindedCycleId) === cycleId) return hidden(mode, cycleId);

    const last = parseAt(lastExportAt);
    if (!last) {
      return {
        show: true, level: 'info', mode: mode, cycleId: cycleId, overdueCycles: null,
        title: '还没导出过任何数据，建议先导一份备份',
        text: NOTICE_TEXT,
        primaryLabel: PRIMARY_LABEL
      };
    }

    // lastExportAt 也要按**同一个口径**映射成周期 id，再算序号之差
    const from = cycleIndex(mode, cycleId);
    const to = cycleIndex(mode, remindCycleId(mode, last));
    if (from === null || to === null) return hidden(mode, cycleId);

    let overdueCycles = from - to;
    if (!isFinite(overdueCycles) || overdueCycles <= 0) return hidden(mode, cycleId); // 时间倒流 / 本周期已导出
    if (overdueCycles > MAX_OVERDUE) overdueCycles = MAX_OVERDUE;

    const unit = mode === 'quarter' ? '季度' : '战果月';
    return {
      show: true,
      level: overdueCycles >= 2 ? 'warn' : 'info',
      mode: mode,
      cycleId: cycleId,
      overdueCycles: overdueCycles,
      title: '距上次导出已过去 ' + overdueCycles + ' 个' + unit +
        '（上次：' + formatAt(last) + '）',
      text: NOTICE_TEXT,
      primaryLabel: PRIMARY_LABEL
    };
  }

  KC.calc = KC.calc || {};
  KC.calc.reminder = {
    MODES: MODES,
    MODE_OPTIONS: MODE_OPTIONS,
    DEFAULT_MODE: DEFAULT_MODE,
    MAX_OVERDUE: MAX_OVERDUE,
    NOTICE_TEXT: NOTICE_TEXT,
    normalizeMode: normalizeMode,
    quarterAnchor: quarterAnchor,
    remindCycleId: remindCycleId,
    monthIndex: monthIndex,
    quarterIndex: quarterIndex,
    exportReminderState: exportReminderState
  };
})(window.KC = window.KC || {});
