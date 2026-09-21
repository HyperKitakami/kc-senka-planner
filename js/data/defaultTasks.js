/* ==========================================================================
   data/defaultTasks.js — 内置任务模板（系统任务）
   依据 docs/05_glossary.md「Task Group / EO」与 docs/06_data_strategy.md §1.3。

   说明：
     · 仅内置文档中明确给出战果值的任务，避免臆造游戏数据。
     · 系统任务默认不可编辑、不可删除，允许启用/停用（docs/05_glossary.md §四）。
     · 周期类型 MONTHLY：EO 海域血条每月末日 23:00 复活，每月可获取一次。
     · 任务模板只描述任务本身，不保存任何完成状态（完成状态存于 TaskRecord）。

   EX 预设任务（季常 / 年常「任务战果」）：
     · `poiName` 是 poi 插件 `achieve.json` 里 `zName` 的写法，**只用于 poi 同步匹配**，
       不写进模板（与 EO 用 `name` 对 `rankuex` 的做法不同 —— EX 的
       本工具展示名与 poi 内名并不一致，必须分开存）。
     · 季常（QUARTERLY）可经 poi 的 `zcleartslist` 自动同步；
       年常（YEARLY）在 poi 数据里没有对应字段 ⇒ `poiName: null`，不同步。
     · `steps` 逐个海域节点，全部达成后任务自动标记完成（docs/04_calculation.md §六）。
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

  /**
   * 由「海域 + 条件」生成一个进度节点。
   * label 里带上胜利条件与次数，展开进度面板时不用再回想任务条件。
   * @param {string} code 节点代号（同时作为海域显示名，如 '2-4'）
   * @param {string} rank 胜利条件：'A胜' / 'S胜'
   * @param {number} need 需要次数
   */
  function step(code, rank, need) {
    return {
      code: code,
      label: code + ' ' + rank,
      requiredCount: need
    };
  }

  /** 同 `step`，但节点需要额外标注编成条件（如「1CVL/CL/CLT/CT+3DD/DE+任意」） */
  function stepWith(code, rank, need, fleet) {
    const s = step(code, rank, need);
    s.label = s.label + '（' + fleet + '）';
    return s;
  }

  /**
   * EX 预设任务（固定「任务战果」类）。
   *
   * 数据来源：游戏内固定任务（Bq* 季常 / By* 年常）与 poi 的季度任务战果清单。
   * 除 `poiName` 外各字段都会写进 TaskTemplate。
   */
  const EX_TASKS = [
    /* ----------------------------------------------------------- 季常 */
    {
      code: 'bq2',
      name: 'Z作战前',
      poiName: 'Z作战前',
      fullName: 'Bq2 戦果拡張任務！「Z作戦」前段作戦',
      senka: 350,
      resetCycle: 'QUARTERLY',
      steps: [
        step('2-4', 'A胜', 1),
        step('6-1', 'A胜', 1),
        step('6-3', 'A胜', 1),
        step('6-4', 'S胜', 1)
      ]
    },
    {
      code: 'bq7',
      name: '三川',
      poiName: '三川',
      fullName: 'Bq7 新編成「三川艦隊」、鉄底海峡に突入せよ！',
      senka: 200,
      resetCycle: 'QUARTERLY',
      steps: [
        stepWith('5-1', 'S胜', 1, '鸟海/青叶/衣笠/加古/古鹰/天龙/夕张 7选4'),
        stepWith('5-3', 'S胜', 1, '鸟海/青叶/衣笠/加古/古鹰/天龙/夕张 7选4'),
        stepWith('5-4', 'S胜', 1, '鸟海/青叶/衣笠/加古/古鹰/天龙/夕张 7选4')
      ]
    },
    {
      code: 'bq8',
      name: '泊地警戒',
      poiName: '泊地警戒',
      fullName: 'Bq8 泊地周辺海域の安全確保を徹底せよ！',
      senka: 300,
      resetCycle: 'QUARTERLY',
      steps: [
        step('1-5', 'S胜', 3),
        step('7-1', 'S胜', 3),
        step('7-1-P1', 'S胜', 3),
        step('7-2-P2', 'S胜', 3)
      ]
    },
    {
      code: 'bq10',
      name: 'Z作戦後',
      poiName: 'Z作戦後',
      fullName: 'Bq10 戦果拡張任務！「Z作戦」後段作戦',
      senka: 400,
      resetCycle: 'QUARTERLY',
      steps: [
        step('7-2-P2', 'S胜', 1),
        step('5-5', 'S胜', 1),
        step('6-2', 'S胜', 1),
        step('6-5', 'S胜', 1)
      ]
    },
    {
      code: 'bq11',
      name: '海上警備',
      poiName: '海上警備',
      fullName: 'Bq11 南西諸島方面「海上警備行動」発令！',
      senka: 80,
      resetCycle: 'QUARTERLY',
      steps: [
        stepWith('1-4', 'S胜', 1, '1CVL/CL/CLT/CT+3DD/DE+任意'),
        stepWith('2-1', 'S胜', 1, '1CVL/CL/CLT/CT+3DD/DE+任意'),
        stepWith('2-2', 'S胜', 1, '1CVL/CL/CLT/CT+3DD/DE+任意'),
        stepWith('2-3', 'S胜', 1, '1CVL/CL/CLT/CT+3DD/DE+任意')
      ]
    },
    {
      code: 'bq12',
      name: '西方',
      poiName: '西方',
      fullName: 'Bq12 発令！「西方海域作戦」',
      senka: 330,
      resetCycle: 'QUARTERLY',
      steps: [
        step('4-1', 'S胜', 1),
        step('4-2', 'S胜', 1),
        step('4-3', 'S胜', 1),
        step('4-4', 'S胜', 1),
        step('4-5', 'S胜', 1)
      ]
    },
    {
      code: 'bq13',
      name: '六水戦',
      poiName: '六水戦',
      fullName: 'Bq13 拡張「六水戦」、最前線へ！',
      senka: 390,
      resetCycle: 'QUARTERLY',
      steps: [
        stepWith('5-1', 'S胜', 1, '夕张改二(特/丁)旗舰+[(睦月/如月/弥生/望月/菊月/卯月 6选2)或由良改二]+任意'),
        stepWith('5-4', 'S胜', 1, '夕张改二(特/丁)旗舰+[(睦月/如月/弥生/望月/菊月/卯月 6选2)或由良改二]+任意'),
        stepWith('6-4', 'S胜', 1, '夕张改二(特/丁)旗舰+[(睦月/如月/弥生/望月/菊月/卯月 6选2)或由良改二]+任意'),
        stepWith('6-5', 'S胜', 1, '夕张改二(特/丁)旗舰+[(睦月/如月/弥生/望月/菊月/卯月 6选2)或由良改二]+任意')
      ]
    },

    /* ----------------------------------------------------------- 年常 */
    // poi 数据里没有年常的完成标记 ⇒ poiName: null（不同步，只能手动勾选）
    {
      code: 'by9',
      name: 'AL',
      poiName: null,
      fullName: 'By9 AL作戦',
      senka: 480,
      resetCycle: 'YEARLY',
      resetMonth: 6,
      steps: [
        stepWith('3-1', 'S胜', 1, '2CVL+任意'),
        stepWith('3-3', 'S胜', 1, '2CVL+任意'),
        stepWith('3-4', 'S胜', 1, '2CVL+任意'),
        stepWith('3-5', 'S胜', 1, '2CVL+任意')
      ]
    },
    {
      code: 'by10',
      name: '机动',
      poiName: null,
      fullName: 'By10 機動部隊決戦',
      senka: 600,
      resetCycle: 'YEARLY',
      resetMonth: 6,
      steps: [
        step('5-2', 'S胜', 1),
        step('5-5', 'S胜', 1),
        step('6-4', 'A胜', 1),
        step('6-5', 'S胜', 1)
      ]
    }
  ];

  function eoTemplates() {
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

  function exTemplates() {
    return EX_TASKS.map(function (t) {
      const item = {
        id: 'sys-ex-' + t.code,
        name: t.name,
        // 游戏内完整任务名（日文原文）。UI 用它做悬停提示，`name` 仍作主显示。
        fullName: t.fullName,
        taskGroup: 'EX',
        senkaValue: t.senka,
        resetCycle: t.resetCycle,
        enabled: true,
        isSystem: true,
        // EX 是「额外的固定任务」，不是人人都会打 ⇒ 默认不进规划池
        defaultInPlan: false,
        steps: t.steps.map(function (s) {
          return { code: s.code, label: s.label, requiredCount: s.requiredCount };
        })
      };
      if (t.resetCycle === 'YEARLY') item.resetMonth = t.resetMonth;
      // 只有季常有 poi 对应项（年常为 null）—— 没有就不写这个键
      if (t.poiName) item.poiName = t.poiName;
      return item;
    });
  }

  function createDefaultTemplates() {
    return eoTemplates().concat(exTemplates());
  }

  /**
   * 内置模板里**允许在升级时补写进老库**的字段（字段名白名单）。
   *
   * 为什么需要单独一份名单：老库里已存在的内置任务不能整体覆盖 ——
   * 用户可能停用过、也可能调过战果值或节点配置。但**纯展示性**字段是程序升级新加的，
   * 老库根本没有，不补就永远是旧的（典型例子：EX 预设任务新增的 `fullName`，
   * 老库只有简称，UI 便一直显示简略名）。
   *
   * ⛔ 绝不能进这份名单的字段：`enabled`（用户可停用）、`senkaValue`、
   * `steps`（节点配置）、`defaultInPlan`、`resetCycle` / `resetMonth`（影响周期与统计）。
   * 只放"用户改不了、改了也不该由用户改"的展示字段。
   */
  const PATCHABLE_FIELDS = ['fullName'];

  /**
   * 把内置模板补装进已有的模板列表（不修改入参，返回**新数组**）。
   *
   * 为什么需要它：`createDefaultTemplates()` 只在**首次运行**（或清空数据后）写入。
   * 已经用过的库不会因为程序升级而拿到新增的内置任务 —— 例如新增的 EX 预设任务。
   *
   * 做两件事（都是按 id 幂等）：
   *   ① **追加**库里没有的内置任务；
   *   ② 给**已存在**的内置任务**补缺失的展示字段**（见 `PATCHABLE_FIELDS`）。
   *      只补「键不存在或为空」的，已有值一律不动；用户改过的字段不在名单里，天然不会被碰。
   *
   * @param {Array} existing 现有任务模板
   * @returns {{list: Array, changedIds: Object}}
   *   `list` 是补装后的新数组；**无任何变化时 `list === existing`**（调用方据此跳过写库），
   *   此时 `changedIds` 为空对象。有变化则 `changedIds` 是「被改动的 id -> true」，
   *   调用方**只写回这些 id**（不要整表重写）。
   */
  function mergeSystemTemplates(existing) {
    const list = Array.isArray(existing) ? existing.slice() : [];
    const byId = {};
    list.forEach(function (t, i) {
      if (t && t.id) byId[t.id] = i;
    });

    const defaults = createDefaultTemplates();
    const changedIds = {};
    let added = 0;

    // ② 补写已存在内置任务的缺失展示字段
    defaults.forEach(function (def) {
      if (!(def.id in byId)) return;              // 缺失的走 ①
      const idx = byId[def.id];
      const cur = list[idx];
      if (!cur || cur.isSystem !== true) return;  // 只补内置任务，用户自建任务一概不碰
      let next = null;
      PATCHABLE_FIELDS.forEach(function (f) {
        const mine = def[f];
        if (mine === undefined || mine === null || mine === '') return;
        const have = cur[f];
        if (have !== undefined && have !== null && have !== '') return;  // 已有值不动
        if (!next) next = Object.assign({}, cur);
        next[f] = mine;
      });
      if (next) {
        list[idx] = next;
        changedIds[def.id] = true;
      }
    });

    // ① 追加库里完全没有的内置任务
    defaults.forEach(function (def) {
      if (def.id in byId) return;
      list.push(def);
      changedIds[def.id] = true;
      added++;
    });

    if (!added && !Object.keys(changedIds).length) {
      return { list: existing, changedIds: {} };   // 无变化 ⇒ 原数组引用
    }
    return { list: list, changedIds: changedIds };
  }

  KC.defaultTasks = {
    EO_TASKS: EO_TASKS,
    EX_TASKS: EX_TASKS,
    PATCHABLE_FIELDS: PATCHABLE_FIELDS,
    createDefaultTemplates: createDefaultTemplates,
    mergeSystemTemplates: mergeSystemTemplates
  };
})(window.KC = window.KC || {});
