/* ==========================================================================
   calc/senkaLine.js — 战果线槽位与取值计算（全部纯函数，不碰 IO）

   依据：docs/03_data.md §7.2「战果排名与演习每日更新两次，北京时间 02:00 与 14:00
   （实际统计时刻为 01:00 与 13:00）」。

   ── 槽位模型 ────────────────────────────────────────────────────────────
     一个战果月从「1 日 02:00（北京）」起算，每 12 小时一个槽，一天两槽：
       槽 0 = 1 日 02:00   （站点标注 JST 03:00）
       槽 1 = 1 日 14:00   （站点标注 JST 15:00）
       槽 2 = 2 日 02:00   …
     本月的最后一槽 = 天数 × 2 − 1。

   ⚠️ **「取当前槽」必须向下取整，绝不向上取整。**
      例：2 日 09:00 → 槽 2（= 2 日 02:00 的采样）；
      14:00 那一槽此刻尚未发布，不能取。所以：
        slot = floor((now − 本月1日 02:00) / 12 小时)
      这正是站点「每天 03:00 / 15:00 两次采样」与 poi「dateNo 12 小时一槽」
      天然对齐的原因，三边无需插值。

   ⚠️ 本月 1 日 02:00 **之前**属于上个月的最后一槽（战果月尚未翻页），
      此时应回溯到上月末槽，不能把槽号 clamp 成 0。
   ========================================================================== */
(function (KC) {
  'use strict';

  const U = KC.utils;

  /** 槽长（毫秒） */
  const SLOT_MS = 12 * 3600 * 1000;
  /** 战果月的起算小时（北京时间，每月 1 日） */
  const ORIGIN_HOUR = 2;
  /** 一天的槽数 */
  const SLOTS_PER_DAY = 2;

  /** 一天两槽，槽 0 = 前半日（北京 02:00），槽 1 = 后半日（北京 14:00） */
  const SLOT_LABEL_HALF = ['前半日', '后半日'];

  /** 某月第一槽的起始时刻（北京时间 1 日 02:00） */
  function slotOrigin(monthKey) {
    const p = String(monthKey).split('-').map(Number);
    return new Date(p[0], p[1] - 1, 1, ORIGIN_HOUR, 0, 0, 0);
  }

  /** 某月最后一槽的槽号（天数 × 2 − 1） */
  function lastSlotOf(monthKey) {
    return U.daysInMonth(monthKey) * SLOTS_PER_DAY - 1;
  }

  /** 某槽对应的采样时刻（北京时间） */
  function slotTimeOf(monthKey, slot) {
    const n = Math.max(0, Math.round(Number(slot) || 0));
    return new Date(slotOrigin(monthKey).getTime() + n * SLOT_MS);
  }

  /** 槽号 → { day, half }；half = 0 前半日（02:00），1 后半日（14:00） */
  function slotParts(slot) {
    const n = Math.max(0, Math.round(Number(slot) || 0));
    return { day: Math.floor(n / SLOTS_PER_DAY) + 1, half: n % SLOTS_PER_DAY };
  }

  /**
   * 「当前槽」= 最近一个**已发布**的采样槽。
   *
   * @param {Date} [now] 便于测试注入
   * @returns {{month:string, slot:number, rolled:boolean}}
   *   rolled=true 表示此刻还在上月最后一槽（本月 1 日 02:00 之前）
   */
  function currentSlot(now) {
    now = now || new Date();
    const monthKey = now.getFullYear() + '-' + U.pad2(now.getMonth() + 1);
    const elapsed = now.getTime() - slotOrigin(monthKey).getTime();
    if (elapsed < 0) {
      const prev = U.addMonths(monthKey, -1);
      return { month: prev, slot: lastSlotOf(prev), rolled: true };
    }
    return { month: monthKey, slot: Math.floor(elapsed / SLOT_MS), rolled: false };
  }

  /** 槽位文案：'31 日 后半日（北京 14:00）' */
  function slotLabel(monthKey, slot) {
    const p = slotParts(slot);
    const at = slotTimeOf(monthKey, slot);
    return p.day + ' 日 ' + SLOT_LABEL_HALF[p.half] +
      '（北京 ' + U.pad2(at.getHours()) + ':00）';
  }

  /** 精确取某槽的行；没有返回 null */
  function rowAtSlot(rows, slot) {
    const n = Number(slot);
    if (!Array.isArray(rows)) return null;
    for (let i = 0; i < rows.length; i++) {
      if (Number(rows[i].slot) === n) return rows[i];
    }
    return null;
  }

  /**
   * 取「不晚于指定槽」的最近一行 —— 用于该槽尚未发布时的回退。
   * @returns {{row:object, usedSlot:number, exact:boolean}|null}
   */
  function pickAtOrBefore(rows, slot) {
    if (!Array.isArray(rows) || !rows.length) return null;
    const want = Number(slot);
    let best = null;
    rows.forEach(function (r) {
      const n = Number(r.slot);
      if (!isFinite(n) || n > want) return;
      if (!best || n > Number(best.slot)) best = r;
    });
    if (!best) return null;
    return { row: best, usedSlot: Number(best.slot), exact: Number(best.slot) === want };
  }

  /** 某月末槽的那一行（= 「该月最终」）。数据被截断时它并不是真正的月末采样。 */
  function pickMonthEnd(rows, monthKey) {
    if (!Array.isArray(rows) || !rows.length) return null;
    let last = null;
    rows.forEach(function (r) {
      const n = Number(r.slot);
      if (!isFinite(n)) return;
      if (!last || n > Number(last.slot)) last = r;
    });
    if (!last) return null;
    const want = lastSlotOf(monthKey);
    return {
      row: last,
      usedSlot: Number(last.slot),
      exact: Number(last.slot) === want,
      /** 数据是否真的覆盖到月末最后一槽；false 说明采集时该月还没结束 */
      isTrueMonthEnd: Number(last.slot) === want
    };
  }

  /** 该月数据是否覆盖到月末最后一槽 */
  function coversMonthEnd(rows, monthKey) {
    const end = pickMonthEnd(rows, monthKey);
    return !!(end && end.isTrueMonthEnd);
  }

  /**
   * 取对比用的「前 n 个月」。
   *
   * wiki 的当月页**在当月不存在**（实测：2026-09-29 时 9 月页不存在），
   * 所以「前 n 个月」只能从**已结束月**里取，即当前槽所在月的往前数。
   *
   * 某个已结束月若还没采集到数据：**跳过**而不是留空洞 ——
   * 留空洞会被误读成「那个月战果线特别低」。跳过时向前多看几个月凑满 n 个，
   * 但有上限，避免为了凑数把远古月份翻出来。
   *
   * @param {Date} now
   * @param {number} n 想要几个月（默认 3）
   * @param {string[]} monthsAvailable 本地已有数据的月份
   * @param {number} [maxLookback] 最多向前看几个月（默认 n × 3）
   * @returns {{months:string[], gaps:string[], partial:boolean}}
   *   months 降序；gaps 是因缺数据被跳过的月份；partial=true 表示没凑满 n 个
   */
  function compareMonths(now, n, monthsAvailable, maxLookback) {
    const want = Math.max(1, Math.round(Number(n) || 3));
    const limit = Math.max(want, Math.round(Number(maxLookback) || want * 3));
    const have = {};
    (monthsAvailable || []).forEach(function (m) { have[m] = true; });

    const base = currentSlot(now).month;
    const months = [];
    const gaps = [];
    for (let i = 1; i <= limit && months.length < want; i++) {
      const m = U.addMonths(base, -i);
      if (have[m]) months.push(m); else gaps.push(m);
    }
    return { months: months, gaps: gaps, partial: months.length < want };
  }

  KC.calc = KC.calc || {};
  KC.calc.senkaLine = {
    SLOT_MS: SLOT_MS,
    ORIGIN_HOUR: ORIGIN_HOUR,
    SLOTS_PER_DAY: SLOTS_PER_DAY,
    SLOT_LABEL_HALF: SLOT_LABEL_HALF,
    slotOrigin: slotOrigin,
    lastSlotOf: lastSlotOf,
    slotTimeOf: slotTimeOf,
    slotParts: slotParts,
    slotLabel: slotLabel,
    currentSlot: currentSlot,
    rowAtSlot: rowAtSlot,
    pickAtOrBefore: pickAtOrBefore,
    pickMonthEnd: pickMonthEnd,
    coversMonthEnd: coversMonthEnd,
    compareMonths: compareMonths
  };
})(window.KC = window.KC || {});

/* --------------------------------------------------------------------------
   注：为什么本卡片不用 poi 的战果线
     · poi 的三群线是 r501（第 501 名），wiki 是 500 位 —— **口径不同**，
       混在同一条对比线上不干净；poi 且没有 1 位（人事）线。
     · poi 的线历史是 poi 自己按槽累积的，跨月会被覆盖，只有同步过的月份才有。
     ⇒ 历史线统一走 wiki；poi 只负责「当月实时值」这类 wiki 给不了的数据。
   -------------------------------------------------------------------------- */
