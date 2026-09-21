/* ==========================================================================
   ui/export.js — 导出动作共用件 + 导出提醒状态的本机层读写
   依据 docs/07_implementation.md §3.1 / §3.4 / §3.6。

   这里放两件事：

     1. exportData()：从 pages/data.js 提出来的共用导出动作
        （首页提醒条与「数据管理」页共用；行为与改动前的 doExport 完全一致）。

     2. 提醒状态的读写：只存"上次已提醒 / 已导出的周期 id"，
        落在本机轻量存储 kc-senka-planner:exportRemind → { cycleId }。
        它是**纯 UI 状态，不该进导出文件**，所以不放 settings；
        又因为 calc/reminder.js 被约定为"纯函数、无 IO"，IO 只能放在这里。
   ========================================================================== */
(function (KC) {
  'use strict';

  const U = KC.utils;

  /** 本机轻量存储中的键名（命名空间前缀 kc-senka-planner: 由 localLayer 补） */
  const REMIND_KEY = 'exportRemind';

  /* -------------------------------------------------------------- 导出 */

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

  /** 导出文件名：kc-senka-planner_YYYY-MM-DD_HHMM.json */
  function exportFileName(now) {
    const d = now || new Date();
    return 'kc-senka-planner_' + U.toDateKey(d) + '_' +
      U.pad2(d.getHours()) + U.pad2(d.getMinutes()) + '.json';
  }

  /**
   * 导出全部业务数据并下载（含 toast）。失败只提示、不抛。
   * KC.store.exportAll() 会顺带更新 settings.lastExportAt。
   * @returns {Promise<string|null>} 成功返回文件名，失败返回 null
   */
  async function exportData() {
    try {
      const payload = await KC.store.exportAll();
      const name = exportFileName(new Date());
      downloadJson(name, payload);
      KC.toast('已导出 ' + name, 'ok');
      return name;
    } catch (err) {
      KC.toast('导出失败：' + err.message, 'error');
      return null;
    }
  }

  /* -------------------------------------------------- 提醒状态（本机层） */

  /** 上次已提醒（或已导出）的周期 id；没有记录返回 null */
  function remindedCycleId() {
    const rec = KC.localLayer.read(REMIND_KEY, null);
    return (rec && rec.cycleId) ? String(rec.cycleId) : null;
  }

  /**
   * 记下"本周期已处理"：点过「本周期不再提醒」，或刚刚导出成功。
   * @returns {boolean} 是否已持久化（false = 本机层不可用，只在本次会话内有效）
   */
  function markReminded(cycleId) {
    if (!cycleId) return false;
    return KC.localLayer.write(REMIND_KEY, {
      cycleId: String(cycleId),
      at: new Date().toISOString()
    });
  }

  /** 清掉记录：设置页的「恢复本周期提醒」用它 */
  function clearReminded() {
    return KC.localLayer.remove(REMIND_KEY);
  }

  /**
   * 组装提醒条状态：设置 + 上次导出时间 + 本机层记录 → 交给纯函数判定。
   * @param {Date} [now] 便于测试注入
   */
  function reminderState(now) {
    const at = now || new Date();
    const settings = KC.store.getSettings();
    return KC.calc.reminder.exportReminderState(
      settings, settings.lastExportAt || null, remindedCycleId(), at);
  }

  KC.ui = KC.ui || {};
  KC.ui.export = {
    REMIND_KEY: REMIND_KEY,
    exportData: exportData,
    exportFileName: exportFileName,
    remindedCycleId: remindedCycleId,
    markReminded: markReminded,
    clearReminded: clearReminded,
    reminderState: reminderState
  };
})(window.KC = window.KC || {});
