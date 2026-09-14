/* ==========================================================================
   data/defaultTasks.js — 内置任务模板（系统任务）
   依据 docs/05_glossary.md「Task Group / EO」与 docs/06_data_strategy.md §1.3。

   说明：
     · 仅内置文档中明确给出战果值的 EO 任务，避免臆造游戏数据。
     · 系统任务默认不可编辑、不可删除，允许启用/停用（docs/05_glossary.md §四）。
     · 周期类型 MONTHLY：EO 海域血条每月末日 23:00 复活，每月可获取一次。
     · 任务模板只描述任务本身，不保存任何完成状态（完成状态存于 TaskRecord）。
   ========================================================================== */
(function (KC) {
  'use strict';

  /** EO 海域：名称 -> 战果值 */
  const EO_TASKS = [
    { code: '1-5', name: '1-5', senka: 75 },
    { code: '1-6', name: '1-6', senka: 75 },
    { code: '2-5', name: '2-5', senka: 100 },
    { code: '3-5', name: '3-5', senka: 150 },
    { code: '7-5', name: '7-5', senka: 170 },
    { code: '4-5', name: '4-5', senka: 180 },
    { code: '5-5', name: '5-5', senka: 200 },
    { code: '5-6', name: '5-6', senka: 225 },
    { code: '6-5', name: '6-5', senka: 250 }
  ];

  function createDefaultTemplates() {
    return EO_TASKS.map(function (t) {
      return {
        id: 'sys-eo-' + t.code,
        name: t.name,
        taskGroup: 'EO',
        senkaValue: t.senka,
        resetCycle: 'MONTHLY',
        enabled: true,
        isSystem: true,
        defaultInPlan: true
      };
    });
  }

  KC.defaultTasks = {
    EO_TASKS: EO_TASKS,
    createDefaultTemplates: createDefaultTemplates
  };
})(window.KC = window.KC || {});
