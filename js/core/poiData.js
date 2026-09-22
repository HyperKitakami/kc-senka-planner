/* ==========================================================================
   core/poiData.js — poi 数据接入（文件读取 + 快照落盘）

   与 core/poiSource.js 的分工：
     · poiSource.js  = **纯解析**，不碰文件、不碰 localStorage（可单测）
     · poiData.js    = **IO 外壳**，负责取到 JSON、落快照、按月份取数

   ── 为什么要快照 ─────────────────────────────────────────────
   poi-plugin-achievement **不保存历史**：achieve.json 里的 myhis / exphis /
   rNhis 都是**当月**数据，下个月会被覆盖。所以「本月的每日战果」「上月的
   战果线」这类跨月数据，只能靠本工具自己存下来。

   快照落在 **本机轻量存储**（KC.localLayer，localStorage）而不是 IndexedDB：
     · 它不参与导入导出（db.js 只遍历 STORES，物理上带不进去）
     · 它不参与战果统计
     · 不升 schemaVersion
   这与导出提醒状态（js/ui/export.js）的做法一致。代价：换浏览器 / 清站点数据
   即全丢，UI 必须明说。

   ── 键设计（前缀 kc-senka-planner: 由 localLayer 补）────────────────
     poiSnapshot:<YYYY-MM>  单月快照。**一文件一月一键**，方便按需读单月、
                            也方便 prune 掉过期月份。
     poiSourceMeta          采集元信息（最近一次同步时间 / 来源文件名 /
                            所选月份的账目）。**不存文件句柄**——句柄是
                            IndexedDB 对象，且用户已选择「手动选择文件」。

   ⚠️ 本模块**绝不抛异常**（localLayer 本身也不抛）。读不到就返回 null，
      调用方负责提示「本机临时层不可用」。
   ========================================================================== */
(function (KC) {
  'use strict';

  const SNAP_PREFIX = 'poiSnapshot:';
  const META_KEY = 'poiSourceMeta';

  /**
   * localLayer 的键是**完整键名**（自带 'kc-senka-planner:' 前缀），而 keys()/prune()
   * 是按「传入前缀」做 indexOf(k, p) === 0 匹配的 —— 传裸的 SNAP_PREFIX 永远匹配不到，
   * 必须拼上命名空间前缀。这里统一算一次，避免各处手写。
   */
  function nsPrefix() {
    return KC.localLayer.PREFIX + SNAP_PREFIX;
  }

  /** 快照里保留的原始字段（其余字段丢掉，避免把整个 52 键文件塞进 localStorage） */
  const KEEP_KEYS = [
    'myhis', 'exphis', 'mysenka', 'tmpexp', 'tmpno',
    'lastmonth', 'myno', 'mylastno',
    'r5', 'r20', 'r501', 'r5last', 'r20last', 'r501last',
    'r5his', 'r20his', 'r100his', 'r501his',
    'rankuex', 'ignoreex',
    'zcleartslist', 'zId', 'zValue', 'zName', 'extraSenkalist',
    'targetsenka'
  ];

  /* ------------------------------------------------------------- 快照读写 */

  function monthKey(year, month) {
    return year + '-' + KC.utils.pad2(month);
  }

  /** 快照键名（不含 localLayer 的命名空间前缀） */
  function snapshotName(monthKeyStr) {
    return SNAP_PREFIX + String(monthKeyStr);
  }

  /**
   * 从原始 JSON 里挑出要保留的字段（浅拷贝；对象字段按引用带过去，
   * 调用方不得再修改 raw）。
   */
  function pickFields(raw) {
    const out = {};
    KEEP_KEYS.forEach(function (k) {
      if (raw && raw[k] !== undefined) out[k] = raw[k];
    });
    return out;
  }

  /**
   * 写入某月快照。**会覆盖同月旧快照**（poi 当月数据是持续增长的，
   * 后一次同步必然比前一次新）。
   *
   * @param {string} monthKeyStr 'YYYY-MM'
   * @param {object} raw poi 原始 JSON
   * @param {object} [extra] 额外元信息（如 { syncedAt, fileName, source }）
   * @returns {boolean} 是否已真正持久化（false = 本机层不可用，只在本次会话有效）
   */
  function saveSnapshot(monthKeyStr, raw, extra) {
    const det = KC.poiSource.detect(raw);
    if (!det.ok) return false;

    const payload = {
      month: String(monthKeyStr),
      syncedAt: (extra && extra.syncedAt) || new Date().toISOString(),
      fileName: (extra && extra.fileName) || '',
      source: (extra && extra.source) || '',
      data: pickFields(raw)
    };

    const ok = KC.localLayer.write(snapshotName(monthKeyStr), payload);
    saveMeta({
      lastSyncedAt: payload.syncedAt,
      lastFileName: payload.fileName,
      lastMonth: payload.month
    });
    return ok;
  }

  /** 读某月快照；不存在返回 null */
  function readSnapshot(monthKeyStr) {
    return KC.localLayer.read(snapshotName(monthKeyStr), null);
  }

  /** 列出已有快照的月份（升序） */
  function snapshotMonths() {
    const ns = nsPrefix();
    return KC.localLayer.keys(ns).map(function (k) {
      return k.slice(ns.length);
    }).filter(function (m) {
      return /^\d{4}-\d{2}$/.test(m);
    }).sort();
  }

  /** 删除某月快照 */
  function removeSnapshot(monthKeyStr) {
    return KC.localLayer.remove(snapshotName(monthKeyStr));
  }

  /** 清空全部 poi 快照 + 元信息（设置页的「清除 poi 快照」用它） */
  function clearAll() {
    const removed = KC.localLayer.prune(nsPrefix(), []);
    KC.localLayer.remove(META_KEY);
    return removed.length;
  }

  /* --------------------------------------------------------- 采集元信息 */

  function readMeta() {
    return KC.localLayer.read(META_KEY, null) || {};
  }

  function saveMeta(patch) {
    const cur = readMeta();
    const next = {};
    Object.keys(cur).forEach(function (k) { next[k] = cur[k]; });
    Object.keys(patch || {}).forEach(function (k) {
      if (patch[k] !== undefined) next[k] = patch[k];
    });
    return KC.localLayer.write(META_KEY, next);
  }

  /* ------------------------------------------------------------ 文件读取 */

  /** 是否支持「选择文件后记住句柄」（Chrome / Edge；Firefox / Safari 无） */
  function canPickFile() {
    return typeof window !== 'undefined' &&
      typeof window.showOpenFilePicker === 'function';
  }

  /**
   * 让用户手动选一个 JSON 文件并读出文本。
   *
   * ⚠️ **优先用 <input type="file">，不用 File System Access API**。
   *
   * 原因：poi 的 achieve.json 位于 `%APPDATA%\poi\achieve\`，而 Chrome / Edge 把
   * `%APPDATA%` 之类视为**敏感 / 系统目录**。此时 showOpenFilePicker 会直接弹出
   * 「无法打开文件，因为含有系统文件」并抛 **AbortError**（见 MDN 的 Exceptions：
   * "或者如果用户代理认为任何选定的文件过于敏感或危险"）。
   *
   * 要命的是这个 AbortError 与「用户按 Esc 取消」**在 JS 层面完全无法区分**
   * （`name` 都是 'AbortError'、`code` 都是 20），所以旧实现里那句
   * "AbortError ⇒ 用户取消 ⇒ 静默返回" 会把系统拦截也一并吞掉，
   * 既没有报错、也没走到 input 兜底 —— 用户按完就毫无反应。
   *
   * 而 <input type="file"> 走的是浏览器**原生文件对话框**，不受该限制：
   * 任何用户选得到的文件都能读。因此这里**默认直接走 input**，
   * 只有 input 在当前环境创建失败时，才退回 showOpenFilePicker。
   *
   * ⚠️ 为什么不自动找 %APPDATA% 路径：页面跑在 file:// 下，浏览器沙箱不允许
   * 读取任意本地路径，只能由用户主动选。UI 会给出参考路径。
   *
   * @returns {Promise<{ok:boolean, text?:string, fileName?:string, error?:string}>}
   *   用户取消时返回 { ok:false, cancelled:true }（不当作错误提示）
   */
  async function pickFile() {
    const viaInput = await pickViaInput();
    // input 路径能真正跑起来（无论用户选了还是取消了）就以它为准
    if (viaInput.ok || viaInput.cancelled || !canPickFile()) return viaInput;
    // 只有「input 根本创建不出来」才考虑 API 路线
    return pickViaApi();
  }

  /**
   * 备选路线：File System Access API。仅在 <input> 不可用时才会被调用。
   * ⚠️ 对敏感目录（%APPDATA% 等）会失败；此处把失败**如实暴露**成错误，
   * 不再把 AbortError 一律当成"用户取消"。
   */
  async function pickViaApi() {
    try {
      const handles = await window.showOpenFilePicker({
        types: [{ description: 'poi 战果数据', accept: { 'application/json': ['.json'] } }],
        multiple: false
      });
      const handle = handles && handles[0];
      if (!handle) return { ok: false, cancelled: true };
      const file = await handle.getFile();
      const text = await file.text();
      return { ok: true, text: text, fileName: file.name || handle.name || '' };
    } catch (err) {
      if (err && err.name === 'AbortError') {
        // 无法区分「用户取消」与「系统文件被拦截」，给出可操作的提示更好
        return {
          ok: false,
          error: '文件选择被中止。若系统提示「含有系统文件」，' +
            '请把 achieve.json 复制到普通目录（如桌面）后再选择。'
        };
      }
      return { ok: false, error: (err && err.message) || '文件选择失败。' };
    }
  }

  /**
   * <input type="file"> —— **主路径**。
   *
   * 走浏览器原生文件对话框，不像 File System Access API 那样受
   * 「敏感 / 系统目录」限制，因此可以正常选中 %APPDATA% 下的 achieve.json。
   */
  function pickViaInput() {
    return new Promise(function (resolve) {
      let input;
      try {
        input = document.createElement('input');
      } catch (err) {
        resolve({ ok: false, error: '当前环境无法弹出文件选择框。' });
        return;
      }
      input.type = 'file';
      input.accept = '.json,application/json';
      input.style.display = 'none';
      input.setAttribute('data-role', 'poi-file-input');

      let settled = false;
      function done(result) {
        if (settled) return;
        settled = true;
        if (input.parentNode) input.parentNode.removeChild(input);
        resolve(result);
      }

      input.addEventListener('change', function () {
        const file = input.files && input.files[0];
        if (!file) { done({ ok: false, cancelled: true }); return; }
        const reader = new FileReader();
        reader.onload = function () {
          done({ ok: true, text: String(reader.result || ''), fileName: file.name || '' });
        };
        reader.onerror = function () {
          done({ ok: false, error: '读取文件失败。' });
        };
        reader.readAsText(file);
      });

      // 用户取消时 change 不触发；靠 window 的 focus 回来兜底判超时
      document.body.appendChild(input);
      input.click();
      setTimeout(function () { done({ ok: false, cancelled: true }); }, 120000);
    });
  }

  /** 解析文本 → 原始对象（失败返回 null） */
  function parseText(text) {
    try {
      const obj = JSON.parse(String(text || ''));
      return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : null;
    } catch (err) {
      return null;
    }
  }

  /**
   * 一步到位：读文件 → 解析 → 判定。UI 主要用这个。
   * @returns {Promise<{ok:boolean, cancelled?:boolean, error?:string,
   *                    raw?:object, fileName?:string, format?:string}>}
   */
  async function pickAndParse() {
    const picked = await pickFile();
    if (!picked.ok) return picked;

    const raw = parseText(picked.text);
    if (!raw) {
      return {
        ok: false,
        fileName: picked.fileName,
        error: '这个文件不是合法的 poi 数据（无法解析为 JSON 对象）。'
      };
    }
    const det = KC.poiSource.detect(raw);
    if (!det.ok) {
      return { ok: false, fileName: picked.fileName, error: det.error };
    }
    return { ok: true, raw: raw, fileName: picked.fileName, format: det.format };
  }

  /* ------------------------------------------------- 按月取数（快照优先） */

  /**
   * 取某月的「每日仅出击 + 演习战果」建议值。
   *
   * ⚠️ **live 优先于快照**：liveRaw 是用户本次刚同步进来的数据，必然比快照新；
   * 快照是跨月补录 / 重开页面后的回退来源。两者都没有才返回 null。
   *
   * @param {string} monthKeyStr 'YYYY-MM'
   * @param {object} [liveRaw] 当前会话里刚同步的原始数据（可选）
   * @returns {{source:string, days:number, series:Array}|null}
   *   source: 'live' | 'snapshot' | null
   */
  function dailyAdvice(monthKeyStr, liveRaw) {
    const days = monthDays(monthKeyStr);
    if (liveRaw) {
      const det = KC.poiSource.detect(liveRaw);
      if (det.ok) {
        return {
          source: 'live',
          syncedAt: '',
          days: days,
          series: KC.poiSource.dailySeries(liveRaw, days, { mode: 'sortie' })
        };
      }
    }
    const snap = readSnapshot(monthKeyStr);
    if (snap && snap.data) {
      return {
        source: 'snapshot',
        syncedAt: snap.syncedAt || '',
        days: days,
        series: KC.poiSource.dailySeries(snap.data, days, { mode: 'sortie' })
      };
    }
    return null;
  }

  /** 取某月的战果线历史（来自快照） */
  function rankLinesOf(monthKeyStr) {
    const snap = readSnapshot(monthKeyStr);
    if (!snap || !snap.data) return null;
    const days = monthDays(monthKeyStr);
    return {
      syncedAt: snap.syncedAt || '',
      series: KC.poiSource.rankLineSeries(snap.data, KC.poiSource.unitCeiling(days))
    };
  }

  /** 取某月的 EO 完成状态（来自快照） */
  function eoStatusOf(monthKeyStr, templates) {
    const snap = readSnapshot(monthKeyStr);
    if (!snap || !snap.data) return null;
    return KC.poiSource.eoStatus(snap.data, templates);
  }

  /** 'YYYY-MM' → 天数 */
  function monthDays(monthKeyStr) {
    const m = /^(\d{4})-(\d{2})$/.exec(String(monthKeyStr || ''));
    if (!m) return 30;
    // ⚠️ utils.daysInMonth 收的是 monthKey 字符串，不是 (year, month) 两个数
    return KC.utils.daysInMonth(m[1] + '-' + m[2]);
  }

  /* --------------------------------------------- 战果线对比图（分析页用） */

  /**
   * 组装「战果线对比」折线图的数据。
   *
   * 四条线来自 poi 快照的战果线历史（联合 / 一群 / 二群 / 三群），
   * 第五条是**自己的累计出击战果**（运行时计算，不落库）。
   *
   * ⚠️ 自己的累计值有**两个来源**，按「谁更可信」排序：
   *   1. 该月快照里的 `myhis`（poi 原生的「总战果」日值）—— 权威口径
   *   2. 本工具 DailyRecord 的当月逐日累计 —— 快照缺失时的回退
   * 之所以不直接用 DailyRecord：记录页可能还没录，而快照是 poi 的原始事实。
   *
   * @param {string} monthKeyStr 'YYYY-MM'
   * @param {Array} [dailyRecords] 该月的 DailyRecord（用于回退，可省略）
   * @returns {{days:number, labels:string[], lines:Array, source:string}|null}
   *   null = 该月没有 poi 快照（调用方给空态提示）
   */
  function chartData(monthKeyStr, dailyRecords) {
    const snap = readSnapshot(monthKeyStr);
    if (!snap || !snap.data) return null;

    const days = monthDays(monthKeyStr);
    const ps = KC.poiSource;
    const ceiling = ps.unitCeiling(days);

    // 四条战果线：按 poi 已定义的顺序（联合 / 一群 / 二群 / 三群）
    const byDay = {};
    const seriesMap = ps.rankLineSeries(snap.data, ceiling);
    ps.RANK_LINES.forEach(function (def) {
      const arr = seriesMap[def.key] || [];
      byDay[def.key] = {};
      arr.forEach(function (p) { byDay[def.key][p.day] = p.value; });
    });

    // 自己的累计：优先 poi 快照的 myhis，其次 DailyRecord 累计
    let mySource = '';
    let myValues = null;
    const mySeries = ps.byDayLatest(snap.data.myhis, ceiling);
    if (mySeries.length) {
      const map = {};
      mySeries.forEach(function (p) { map[p.day] = p.value; });
      myValues = daysRange(days).map(function (d) {
        return (d in map) ? map[d] : null;
      });
      myValues[0] = 0;   // 月初起点，让折线从 0 起
      mySource = 'poi';
    } else {
      const records = Array.isArray(dailyRecords) ? dailyRecords : [];
      const sum = {};
      records.forEach(function (r) {
        if (String(r.date || '').slice(0, 7) !== String(monthKeyStr)) return;
        const d = Number(String(r.date).slice(8));
        if (!isFinite(d) || d < 1 || d > days) return;
        sum[d] = (sum[d] || 0) + Number(r.sortieSenka || 0);
      });
      if (Object.keys(sum).length) {
        let acc = 0;
        myValues = daysRange(days).map(function (d) {
          if (!(d in sum)) return null;
          acc += sum[d];
          return KC.utils.round2(acc);
        });
        myValues[0] = 0;
        mySource = 'records';
      }
    }

    const lines = ps.RANK_LINES.map(function (def) {
      return {
        key: def.key,
        label: def.label,
        rank: def.rank,
        values: daysRange(days).map(function (d) {
          return (d in byDay[def.key]) ? byDay[def.key][d] : null;
        })
      };
    });

    if (myValues) {
      lines.push({ key: 'my', label: '我的累计', rank: 0, values: myValues });
    }

    return {
      days: days,
      month: String(monthKeyStr),
      syncedAt: snap.syncedAt || '',
      source: mySource,
      labels: daysRange(days).map(function (d) { return String(d); }),
      lines: lines
    };
  }

  /** [1, 2, …, days] */
  function daysRange(days) {
    const out = [];
    for (let d = 1; d <= days; d++) out.push(d);
    return out;
  }

  /* ----------------------------------------------- EO 完成状态批量同步 */

  /**
   * 把 poi 的 EO 完成状态与本工具的任务记录做**差异对比**，供任务页批量勾选。
   *
   * 口径（零配置）：
   *   · poi 侧 `rankuex` 是「**未完成**」的海域代号列表（如 ['3-5','6-5']），
   *     代号与内置 EO 任务模板的 `name` 完全一致 ⇒ 已完成 = 全集 − rankuex。
   *   · 只比对 `taskGroup === 'EO'` 且 `enabled !== false` 的任务模板。
   *   · `done`   = poi 认为已完成、但本工具还没勾 → 待勾选
   *   · `undone` = poi 认为未完成、但本工具已勾 → 待取消
   *   · `same`   = 两边一致，不动。
   *
   * ⚠️ **不自动写入**：poi 的 `rankuex` 只反映"当前血条在不在"，而战果归属有
   *   21:00 边界与季常失效规则 —— 是否要按 poi 改本工具的状态由用户决定，
   *   本函数只负责把差异算出来给 UI 展示（用户批量确认后才写）。
   *
   * @param {string} monthKeyStr 'YYYY-MM'（要同步的归属月）
   * @param {Array} templates 任务模板（KC.store.state.taskTemplates）
   * @param {Array} records   任务记录（KC.store.state.taskRecords）
   * @param {Function} readRecord KC.calc.tasks.readRecord
   * @param {Date} [now]
   * @returns {null|{month:string, syncedAt:string, done:Array, undone:Array, same:Array,
   *                 unknown:Array, counts:{done:number,undone:number,same:number}}}
   *   null = 该月没有 poi 快照
   */
  function eoDiff(monthKeyStr, templates, records, readRecord, now) {
    const snap = readSnapshot(monthKeyStr);
    if (!snap || !snap.data) return null;

    const at = now || new Date();
    const list = Array.isArray(templates) ? templates : [];
    const recs = Array.isArray(records) ? records : [];
    const uncleared = Array.isArray(snap.data.rankuex)
      ? snap.data.rankuex.map(String) : [];

    const eoTemplates = list.filter(function (t) {
      return t && t.taskGroup === 'EO' && t.enabled !== false;
    });

    const done = [], undone = [], same = [], unknown = [];

    eoTemplates.forEach(function (t) {
      const code = String(t.name || t.code || '');
      const period = KC.calc.tasks.periodForMonth(t, monthKeyStr, at);
      if (!period || !period.id) { unknown.push({ template: t, code: code }); return; }

      const rec = typeof readRecord === 'function'
        ? readRecord([], recs, t, period.id, at)
        : null;
      const mine = !!(rec && rec.completed);
      const poiDone = uncleared.indexOf(code) < 0;

      const row = {
        template: t,
        code: code,
        period: period,
        mine: mine,
        poiDone: poiDone,
        senka: Number(t.senkaValue) || 0
      };
      if (poiDone && !mine) done.push(row);
      else if (!poiDone && mine) undone.push(row);
      else same.push(row);
    });

    // poi 里有但我们没有对应模板的代号（用户删了系统任务 / 自定义过）——只提示，不处理
    uncleared.forEach(function (code) {
      const has = eoTemplates.some(function (t) {
        return String(t.name || t.code || '') === code;
      });
      if (!has && KC.poiSource.EO_SENKA[code] !== undefined) unknown.push({ code: code });
    });

    return {
      month: String(monthKeyStr),
      syncedAt: snap.syncedAt || '',
      done: done,
      undone: undone,
      same: same,
      unknown: unknown,
      counts: { done: done.length, undone: undone.length, same: same.length }
    };
  }

  /**
   * 把 poi 的**季常任务战果**完成状态与本工具的任务记录做差异对比。
   *
   * 数据来源：poi 的 `zName` / `zValue` / `zcleartslist`（同序的三张表），
   * ⛔ `zcleartslist[i]` 是第 i 项的**完成时刻**（ISO 时间戳），**`0` = 未完成**
   * —— 早期把它当成"已完成清单"（`=== 0` 即完成）是**反的**，会让全部季常都被判成已完成。
   * **只有季常**能这么同步 —— 年常在 poi 数据里没有对应字段（`poiName: null`），
   * 因此只比对带 `poiName` 且 `resetCycle === 'QUARTERLY'` 的 EX 模板。
   *
   * ⚠️ **口径范围**：poi 每个战果月会把 `zcleartslist` 重置为全 0（它只用来算当月战果增量），
   * 所以这里判定的是「**当前战果月内**是否完成」，**不覆盖本季更早的月份**。
   * 换言之：poi 说"未完成"不等于"本季没做"，UI 必须把这个范围讲清楚；
   * 好在同步只做正向勾选，漏判只会少勾、不会勾错。
   *
   * 与 `eoDiff` 的关键差别：poi 这里给的是**完成时刻清单**（而 `rankuex` 是未完成清单），
   * 且清单本身就是我们关心的全集，所以「poi 里有、模板里没有」的名字直接忽略，
   * 不会进 `unknown`（poi 的清单纯手工维护，可能含本工具不打算跟踪的任务）。
   *
   * ⚠️ **不自动写入**：季常战果有末日 13:00 归属边界与"季度第三月 13:00 后失效"规则，
   * 是否按 poi 改状态由用户决定 —— 本函数只算差异。**也不自动取消**（只正向勾选），
   * 理由同 eoDiff：会抹掉已计入历史的战果。
   *
   * @param {string} monthKeyStr 'YYYY-MM'（要同步的归属月）
   * @param {Array} templates 任务模板（KC.store.state.taskTemplates）
   * @param {Array} records   任务记录（KC.store.state.taskRecords）
   * @param {Function} readRecord KC.calc.tasks.readRecord
   * @param {Date} [now]
   * @returns {null|{month:string, syncedAt:string, done:Array, undone:Array, same:Array,
   *                 unknown:Array, counts:{done:number,undone:number,same:number}}}
   *   null = 该月没有 poi 快照
   */
  function exDiff(monthKeyStr, templates, records, readRecord, now) {
    const snap = readSnapshot(monthKeyStr);
    if (!snap || !snap.data) return null;

    const at = now || new Date();
    const list = Array.isArray(templates) ? templates : [];
    const recs = Array.isArray(records) ? records : [];

    // 只有季常可同步：年常在 poi 侧无字段 ⇒ 模板 poiName 为 null
    const exTemplates = list.filter(function (t) {
      return t && t.taskGroup === 'EX' && t.enabled !== false &&
        t.resetCycle === 'QUARTERLY' && t.poiName;
    });

    const quest = KC.poiSource.extraQuestStatus(snap.data);
    const byName = {};
    quest.list.forEach(function (q) { byName[q.name] = q; });

    const done = [], undone = [], same = [], unknown = [];

    exTemplates.forEach(function (t) {
      const poiName = String(t.poiName);
      const period = KC.calc.tasks.periodForMonth(t, monthKeyStr, at);
      if (!period || !period.id) { unknown.push({ template: t, name: poiName }); return; }

      const rec = typeof readRecord === 'function'
        ? readRecord([], recs, t, period.id, at)
        : null;
      const mine = !!(rec && rec.completed);

      // 快照里没这一项 ⇒ 无法判定，只提示、不猜
      const q = byName[poiName];
      if (!q) { unknown.push({ template: t, name: poiName }); return; }
      const poiDone = !!q.done;

      const row = {
        template: t,
        // 展示用：UI 用 fullName 显示完整任务名、name 作悬停简称（与卡片一致）
        taskGroup: 'EX',
        name: t.name,
        fullName: t.fullName || '',
        poiName: poiName,
        period: period,
        mine: mine,
        poiDone: poiDone,
        // poi 侧的完成时刻（0 = 未完成）——UI 可用来提示"本战果月内完成"
        clearedAt: q.clearedAt,
        senka: Number(t.senkaValue) || 0
      };
      if (poiDone && !mine) done.push(row);
      else if (!poiDone && mine) undone.push(row);
      else same.push(row);
    });

    return {
      month: String(monthKeyStr),
      syncedAt: snap.syncedAt || '',
      done: done,
      undone: undone,
      same: same,
      unknown: unknown,
      counts: { done: done.length, undone: undone.length, same: same.length }
    };
  }

  KC.poiData = {
    SNAP_PREFIX: SNAP_PREFIX,
    META_KEY: META_KEY,
    KEEP_KEYS: KEEP_KEYS,

    // 快照
    snapshotName: snapshotName,
    saveSnapshot: saveSnapshot,
    readSnapshot: readSnapshot,
    snapshotMonths: snapshotMonths,
    removeSnapshot: removeSnapshot,
    clearAll: clearAll,

    // 元信息
    readMeta: readMeta,
    saveMeta: saveMeta,

    // 文件
    canPickFile: canPickFile,
    pickFile: pickFile,
    pickAndParse: pickAndParse,
    parseText: parseText,

    // 按月取数
    dailyAdvice: dailyAdvice,
    rankLinesOf: rankLinesOf,
    eoStatusOf: eoStatusOf,
    monthDays: monthDays,
    chartData: chartData,
    eoDiff: eoDiff,
    exDiff: exDiff
  };
})(window.KC = window.KC || {});
