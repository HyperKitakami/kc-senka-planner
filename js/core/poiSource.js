/* ==========================================================================
   core/poiSource.js — poi 插件数据源（纯解析，无 IO）

   职责边界（⚠️ 本模块**只做纯计算**）：不读文件、不碰 DOM、不碰 localStorage。
     输入 = poi 战果数据的 JSON 对象（或字符串）
     输出 = 结构化的解析结果
   文件读取（File System Access API）、快照落盘由上层负责。

   数据来源：poi ＋ poi-plugin-achievement
     · Windows 默认路径  %APPDATA%/poi/achieve/achieve.json
     · 格式：**扁平**，约 52 个顶层键，所有数据都在顶层（**没有 r5his 嵌套**）

   ── 字段模型（实测核对，勿凭命名臆测）────────────────────────────
     myhis     {dateNo: 战果}  本提督**月度累计总战果**快照（含 EO/任务）
     exphis    {dateNo: exp}   本提督**经验值**采样（每日出击战果的算料）
     tmpexp/tmpno              尚未落库的当前采样点（exp / dateNo）
     mysenka   number          当前累计总战果（≈ myhis 最新值）
     myno/mylastno             本提督当前 / 上次结算的 dateNo

     rNlast (N=5/20/501)        服务器**战果线**（已结算）；
     rN     (N=5/20/501)        同上的实时值（秒级刷新）。
                               ⚠️ 数值上 r5 > r20 > r100 > r501 —— 排名越靠前线越高。
                               ⚠️ **r100 / r100last 都不存在**（实测），二群线只能从
                                  r100his 的最新条目取。所以取值优先级是：
                                  ① rN（实时） → ② rNlast → ③ rNhis 末值
     r5his / r20his / r100his / r501his
                               **战果线**的月度累计历史 {dateNo: value}，不是提督数据
                               （也是 r100 的唯一数据来源）

     rankuex   string[]        **未完成**的 EO 海域列表（来自 selectors.es）
     ignoreex  {code:bool}     用户手动忽略的海域，不参与统计
     extraSenkalist number[]   三态人工标记 0=已完成/1=未完成/2=进行中；
                               ⚠️ 与血条完成**无关**，本模块不使用
     extraSenka 相关：zcleartslist / zId / zValue / zName
                               额外战果（EO 之外）的清单

   ── 两个易错点 ──────────────────────────────────────────────
     1. **myhis 跨月污染**：myhis 的键是 dateNo（月初重置），若直接整体差分，
        会把上月的脏键算进来 —— 实测 myhis[62] = 437 会让某天出现 −1880。
        所以 myhisDelta 必须先按 dateNo 上界截断，且**只认单调不减的区间**。
     2. **dateNo 双基**：每日数据 与 月度累计 用的是**同一套** 12 小时编号
        （单位 0 起点 = 每月 1 日 02:00 北京），日 = floor(no/2)+1。
        但 `myno`（429）远大于 `2*31-1`（61），说明它走的是**跨月连续计数**，
        不能直接当当月号用。本模块只用文件里带的键自身，不自行推算月份。
   ========================================================================== */
(function (KC) {
  'use strict';

  /** 每单位战果换算系数：文档口径 (Δexp / 50000 * 35) —— 与 poi 插件一致 */
  const EXP_PER_SENKA = 50000 / 35;

  /** 战果线定义：从高排名（严）到低排名（松） */
  const RANK_LINES = [
    { key: 'r5', label: '联合', rank: 5 },
    { key: 'r20', label: '一群', rank: 20 },
    { key: 'r100', label: '二群', rank: 100 },
    { key: 'r501', label: '三群', rank: 501 }
  ];

  /** EO 海域 → 战果值。与 data/defaultTasks.js 的 EO_TASKS 保持一致 */
  const EO_SENKA = {
    '1-5': 75, '1-6': 75, '2-5': 100, '3-5': 150, '7-5': 170,
    '4-5': 180, '5-5': 200, '5-6': 225, '6-5': 250
  };

  /** extraSenkalist 三态 */
  const QUEST_STATE = { DONE: 0, TODO: 1, DOING: 2 };

  /* ------------------------------------------------------------- 工具函数 */

  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  function num(v, dflt) {
    const n = (typeof v === 'number') ? v : Number(v);
    return isFinite(n) ? n : (dflt === undefined ? 0 : dflt);
  }

  /** 「字符串 / 对象」双入口；失败返回 null */
  function asObject(raw) {
    if (isObj(raw)) return raw;
    if (typeof raw === 'string') {
      try {
        const o = JSON.parse(raw);
        return isObj(o) ? o : null;
      } catch (err) { return null; }
    }
    return null;
  }

  /** 取对象里全部**数值键**，升序 */
  function numericKeys(o) {
    return Object.keys(isObj(o) ? o : {})
      .map(Number)
      .filter(function (n) { return isFinite(n); })
      .sort(function (a, b) { return a - b; });
  }

  /* -------------------------------------------------------- §1 格式识别 */

  /**
   * 识别 poi 战果文件并归一化。
   * @param {object|string} raw
   * @returns {{ok, format, version, acct, lastmonth, data, error}}
   *   format: 'flat'（当前版本，数据在顶层）| 'legacy'（旧版嵌套在 r5his 里）
   *   data: 战果数据对象（两种格式统一）
   */
  function detect(raw) {
    const out = {
      ok: false, format: null, version: 0, acct: '',
      lastmonth: '', data: null, error: ''
    };
    const root = asObject(raw);
    if (!root) { out.error = '不是合法的 JSON 对象'; return out; }

    // 当前格式：扁平，顶层带 myhis / mysenka / exphis
    if ('myhis' in root || 'mysenka' in root || 'exphis' in root) {
      out.format = 'flat';
      out.data = root;
      out.version = num(root.version, 1);
      out.lastmonth = String(root.lastmonth === undefined ? '' : root.lastmonth);
      out.acct = String(root.account || '');
      out.ok = true;
      return out;
    }

    // 旧格式兜底：数据嵌在 r5his 里
    if (isObj(root.r5his) && ('mysenka' in root.r5his || 'myhis' in root.r5his)) {
      out.format = 'legacy';
      out.data = root.r5his;
      out.version = num(root.version, 2);
      out.lastmonth = String(root.lastmonth === undefined ? '' : root.lastmonth);
      out.acct = 'r5his';
      out.ok = true;
      return out;
    }

    out.error = '未识别到战果数据（顶层缺少 myhis / mysenka / exphis）';
    return out;
  }

  /* ---------------------------------------------------- §2 dateNo 解码 */

  /**
   * dateNo → {day, endHour}。
   *
   * 单位 0 的**末时刻** = 每月 1 日 18:00 北京（= 1 日 09:00 UTC）。
   * 每 12 小时一单位：
   *   no=2k    → (k+1) 日 06:00~18:00
   *   no=2k+1  → (k+1) 日 18:00~(k+2) 日 06:00
   * 故 日 = floor(no/2)+1；偶数号止于 18:00、奇数号止于次日 06:00。
   *
   * @returns {{day:number, endHour:number, no:number}}
   */
  function decodeDateNo(no) {
    const n = Math.max(0, Math.floor(num(no, 0)));
    return {
      no: n,
      day: Math.floor(n / 2) + 1,
      endHour: (n % 2 === 0) ? 18 : 6
    };
  }

  /** 某日的两次采样号 [下午, 次日上午] */
  function dateNosOfDay(day) {
    const d = Math.max(1, Math.floor(num(day, 1)));
    return [2 * (d - 1), 2 * (d - 1) + 1];
  }

  /** 当月 dateNo 上界（含）：daysInMonth 日对应的最后一个采样号 */
  function unitCeiling(daysInMonth) {
    return 2 * Math.max(1, Math.floor(num(daysInMonth, 30))) - 1;
  }

  /* ------------------------------------------------ §3 每日战果两条算法 */

  /**
   * 【算法 A】每日**仅出击 + 演习**战果 —— 记录页的「建议值」来源。
   *
   * 用**经验增量**换算：战果 = Δexp / 50000 * 35（与 poi 插件一致）。
   *
   * ── 差分口径（实测反推，勿凭直觉改）──────────────────────
   * exphis 每 12 小时一个采样：偶数号 = 当日 18:00 收尾值，奇数号 = 次日 06:00 起点值。
   * 实测大量奇数号与前一偶数号**完全相同**（no=15/19/23/25/27/37 的 delta 为 0），
   * 即「过夜无变化」，所以奇数号不含新增量。
   *
   * 真正代表「第 day 日新增经验」的是**相邻两个偶数号之差**：
   *     第 day 日 = exphis[2*day] − exphis[2*(day−1)]
   * （day=1 时基准为 0，即从 0 起算为 1 日累计。）
   *
   * ✅ 双重验证（本机 2026-09 数据）：
   *     · 1~21 日累计 = 1156.77
   *     · 与 myhis 同日有数据的日子逐日吻合（day2: 73.2 vs 73；day3: 12.8 vs 13）
   *     · mysenka(2317) − 1156.77 = 1160 ≈ EO(700) + 任务/排名衰减
   *
   * ⚠️ 曾经写错过：用 (2(d−1), 2(d−1)+1) 配对，得到 217.88，只有真值的 1/5。
   *
   * @param {object} exphis {dateNo: exp}
   * @param {object} [tmp] {no, exp} 未落库的当前采样（可选）
   * @param {number} maxNo 上界（含），通常 = unitCeiling(daysInMonth)
   * @returns {Object<number, number>} {day: 战果}，只含两端都有数据的日
   */
  function senkaOfDay(exphis, tmp, maxNo) {
    const out = {};
    const his = isObj(exphis) ? exphis : {};
    const cur = isObj(tmp) ? tmp : null;
    const limit = Math.max(0, Math.floor(num(maxNo, 0)));

    function expAt(no) {
      if (cur && num(cur.no, -1) === no) return num(cur.exp, 0);
      return (no in his) ? num(his[no], 0) : null;
    }

    // 第 day 日需要 no=2*day 这一采样，故要求 2*day <= limit。
    // （若只写 days = floor((limit+1)/2)，limit=1 时会误算 day1，而它读的 no=2 已越界。）
    const days = Math.floor(limit / 2);
    for (let day = 1; day <= days; day++) {
      const a = 2 * (day - 1);
      const b = 2 * day;
      const va = expAt(a);
      const vb = expAt(b);
      if (va === null || vb === null) continue;
      const d = vb - va;
      if (!isFinite(d) || d < 0) continue;   // 经验回退（换装/异常）不计
      out[day] = Math.round((d / EXP_PER_SENKA) * 100) / 100;
    }
    return out;
  }

  /**
   * 【算法 B】每日**总战果**（含 EO / 任务），来自 myhis 逐键差分。
   *
   * 口径与算法 A 对齐：先按日聚合取**当日最新采样**（含奇数号），再做相邻差。
   * 这样 day13 若有 no=24 与 no=25 两条，取较晚的 no=25 —— 与 byDayLatest 一致。
   * ⚠️ 不要在这里另写一份「只取偶数号」的聚合，否则两条口径会跑偏
   *    （实测会把 day13 的值算成 100 而非 200）。
   *
   * ⚠️ 跨月截断：myhis 的键在月初重置，若某键的值**小于前一个**，
   * 说明已跨月（混入上月残留键），此后全部丢弃。
   * 实测 myhis[40]=2317 → myhis[41]=2317 → myhis[62]=437；
   * 若不截断，第 32 日会得到 437−2317 = −1880。
   *
   * @param {object} myhis {dateNo: 累计战果}
   * @param {number} maxNo 上界（含）
   * @returns {Object<number, number>} {day: 战果}
   */
  function myhisDelta(myhis, maxNo) {
    const out = {};
    const m = isObj(myhis) ? myhis : {};
    const limit = Math.max(0, Math.floor(num(maxNo, 0)));

    // 1) 取有效前缀（跨月值回退处截断）
    const keys = numericKeys(m).filter(function (n) { return n <= limit; });
    const filtered = {};
    let prevRaw = null;
    for (let i = 0; i < keys.length; i++) {
      const v = num(m[keys[i]], 0);
      if (prevRaw !== null && v < prevRaw) break;   // 跨月 → 丢弃此后所有
      prevRaw = v;
      filtered[keys[i]] = v;
    }

    // 2) 按日聚合（当日最新采样），与 byDayLatest 同一实现
    const daily = byDayLatest(filtered);

    // 3) 相邻差
    let prev = 0;
    daily.forEach(function (s) {
      out[s.day] = Math.max(0, s.value - prev);
      prev = s.value;
    });
    return out;
  }

  /**
   * 序列的**有效末点**：先按跨月规则截断，再取该前缀内 dateNo 最大的键。
   *
   * ⚠️ 「最后一个键」不等于「最大键」：myhis 实测有 myhis[62]=437 这种
   * 上月残留（值远小于 myhis[40]=2317）。若直接取最大键，会拿到 437。
   *
   * ⚠️ 也**不能只看偶数号**：实测 myhis[41]（day21 06:00）= 2317 与 no=40 同值，
   * 但 r5his[41] = 6038 > r5his[40] = 5995、r100his[41] = 4010 > r100his[40] = 3994。
   * 奇数号是「同一天更晚的采样」，有值时应视为该日的最新值。
   *
   * @param {object} series {dateNo: value}
   * @returns {{no:number, value:number, day:number}} 空序列返回 no=-1
   */
  function seriesTail(series) {
    const m = isObj(series) ? series : {};
    const keys = numericKeys(m);
    let best = null;
    let prevRaw = null;
    for (let i = 0; i < keys.length; i++) {
      const v = num(m[keys[i]], 0);
      if (prevRaw !== null && v < prevRaw) break;   // 跨月 → 截断
      prevRaw = v;
      best = { no: keys[i], value: v, day: decodeDateNo(keys[i]).day };
    }
    return best || { no: -1, value: 0, day: 0 };
  }

  /**
   * 把 {dateNo: value} 压成**按日**的「当日最新值」序列。
   * 同一天有多个采样（奇数号 = 更晚）时取 dateNo 最大的那个。
   *
   * 例：myhis 的 no=24 与 no=25 都属于 day13 → 取 no=25。
   *
   * @param {object} series {dateNo: value}
   * @param {number} [maxNo] 上界（含）
   * @returns {Array<{day:number, no:number, value:number}>} 按 day 升序
   */
  function byDayLatest(series, maxNo) {
    const m = isObj(series) ? series : {};
    const limit = (maxNo === undefined) ? Infinity : Math.max(0, Math.floor(num(maxNo, 0)));
    const map = {};
    const order = [];
    numericKeys(m).forEach(function (n) {
      if (n > limit) return;
      const day = decodeDateNo(n).day;
      if (!(day in map)) { order.push(day); map[day] = null; }
      const v = num(m[n], 0);
      if (map[day] === null || n > map[day].no) map[day] = { day: day, no: n, value: v };
    });
    return order.sort(function (a, b) { return a - b; }).map(function (d) { return map[d]; });
  }

  /** myhis 的当月累计总量（到有效末点） */
  function myhisTotal(myhis, maxNo) {
    const m = isObj(myhis) ? myhis : {};
    const limit = (maxNo === undefined) ? Infinity : Math.max(0, Math.floor(num(maxNo, 0)));
    const filtered = {};
    numericKeys(m).forEach(function (n) { if (n <= limit) filtered[n] = m[n]; });
    return seriesTail(filtered).value;
  }

  /** myhis 最后一个**有效**采样点（跨月脏键已剔除） */
  function myhisLatest(myhis) {
    return seriesTail(myhis);
  }

  /* ------------------------------------------------------ §4 EO 完成状态 */

  /**
   * EO 海域完成状态。
   *
   * 依据 poi 的 `unclearedExListSelector`：`rankuex` 是**未完成**的列表，
   * 故「已完成 = EO_SENKA 全集 − rankuex」。`ignoreex[code] === true` 表示
   * 用户手动忽略该海域，不参与统计。
   *
   * ⚠️ 不使用 `extraSenkalist` —— 实测它是三态人工标记（0=已完成/1=未完成/2=进行中），
   * 与血条完成无关，本机全为 1。曾把「非 0 = 已完成」当结论，是错的。
   *
   * @param {object} raw
   * @param {Array} [templates] 可选 KC.defaultTasks.EO_TASKS，用于对齐战果值/名称
   * @returns {{list:Array, doneCount:number, doneSenka:number, totalSenka:number}}
   */
  function eoStatus(raw, templates) {
    const root = isObj(raw) ? raw : {};
    const uncleared = Array.isArray(root.rankuex) ? root.rankuex.map(String) : [];
    const ignored = isObj(root.ignoreex) ? root.ignoreex : {};

    const values = {};
    const names = {};
    if (Array.isArray(templates) && templates.length) {
      templates.forEach(function (t) {
        const code = String(t.code || t.name);
        values[code] = num(t.senkaValue, 0);
        names[code] = String(t.name || t.code);
      });
    }
    Object.keys(EO_SENKA).forEach(function (code) {
      if (!(code in values)) { values[code] = EO_SENKA[code]; names[code] = code; }
    });

    const list = [];
    let doneSenka = 0;
    let doneCount = 0;
    let totalSenka = 0;

    Object.keys(values).forEach(function (code) {
      const isIgnored = ignored[code] === true || ignored[code] === 1 || ignored[code] === 'true';
      const done = uncleared.indexOf(code) < 0;
      const senka = values[code];
      list.push({
        code: code,
        name: names[code],
        senka: senka,
        done: done,
        ignored: isIgnored,
        counted: !isIgnored && done
      });
      if (isIgnored) return;
      totalSenka += senka;
      if (done) { doneSenka += senka; doneCount++; }
    });

    list.sort(function (a, b) {
      const pa = a.code.split('-').map(Number);
      const pb = b.code.split('-').map(Number);
      return (pa[0] - pb[0]) || (pa[1] - pb[1]);
    });

    return {
      list: list,
      doneCount: doneCount,
      doneSenka: doneSenka,
      totalSenka: totalSenka,
      uncleared: uncleared.slice()
    };
  }

  /* ------------------------------------------------------- §5 战果线 */

  /**
   * 服务器战果线（前 N 名的战果阈值）。
   *
   * 取值优先级：① `rN`（实时，秒级刷新）→ ② `rNlast`（已结算）
   *             → ③ `rNhis` 的**最新条目**（月度快照）
   *
   * ⚠️ 第三级是必需的：实测**没有 `r100` / `r100last`**，二群线只能从
   * `r100his` 末值取（= 3994）。少了这一级，二群线会直接消失。
   *
   * @param {object} raw
   * @returns {Array<{key,label,rank,value,realtime,lastValue,hisValue,source,hasData}>}
   *   按线的**数值从高到低**排序（= 排名从严到松）
   */
  function rankLines(raw) {
    const root = isObj(raw) ? raw : {};
    const out = RANK_LINES.map(function (def) {
      const rt = (def.key in root) ? num(root[def.key], null) : null;
      const last = (def.key + 'last' in root) ? num(root[def.key + 'last'], null) : null;
      const his = isObj(root[def.key + 'his']) ? root[def.key + 'his'] : null;
      const hisValue = his ? seriesTail(his).value : null;

      let value = null, source = 'none';
      if (rt !== null) { value = rt; source = 'realtime'; }
      else if (last !== null) { value = last; source = 'last'; }
      else if (hisValue !== null) { value = hisValue; source = 'his'; }

      return {
        key: def.key,
        label: def.label,
        rank: def.rank,
        value: value,
        realtime: rt,
        lastValue: last,
        hisValue: hisValue,
        source: source,
        hasData: value !== null
      };
    });
    return out.filter(function (x) { return x.hasData; })
      .sort(function (a, b) { return b.value - a.value; });
  }

  /**
   * 战果线的月度历史（rNhis = {dateNo: value}），供「战果线趋势」图使用。
   * 按日聚合，取当日最新采样（含奇数号）—— 与 seriesTail 同一口径。
   * @returns {{r5:Array, r20:Array, r100:Array, r501:Array}} 每个是 [{day, value}]
   */
  function rankLineSeries(raw, maxNo) {
    const root = isObj(raw) ? raw : {};
    const out = {};
    RANK_LINES.forEach(function (def) {
      const his = isObj(root[def.key + 'his']) ? root[def.key + 'his'] : {};
      out[def.key] = byDayLatest(his, maxNo).map(function (x) {
        return { day: x.day, value: x.value };
      });
    });
    return out;
  }

  /* --------------------------------------------------- §6 账户一览 */

  /** 一次性汇总 */
  function summary(raw) {
    const det = detect(raw);
    const root = isObj(raw) ? raw : {};
    const data = det.ok ? det.data : {};
    const total = myhisTotal(data.myhis);
    return {
      ok: det.ok,
      format: det.format,
      version: det.version,
      acct: det.acct,
      lastmonth: det.lastmonth,
      mySenka: num(data.mysenka, 0),
      myhisTotal: total,
      latest: myhisLatest(data.myhis),
      myno: num(root.myno, 0),
      lines: rankLines(raw),
      eo: eoStatus(raw),
      targetSenka: num(root.targetsenka, 0),
      error: det.error
    };
  }

  /* ------------------------------------------------ §7 每日序列（给 UI） */

  /**
   * 生成某月 1..daysInMonth 的每日序列。
   *
   * 注意：poi 文件里的键**不带月份**，本函数只按 dateNo 截断，
   * 调用方需自行确认「文件里的数据确实是本月」（建议配合快照的时间戳）。
   *
   * @param {object} raw
   * @param {number} daysInMonth 28~31（不知年月时可直接传天数）
   * @param {object} [opts] { mode:'sortie'|'total', currentDay:number }
   * @returns {Array<{day:number, value:number, hasData:boolean}>}
   */
  function dailySeries(raw, daysInMonth, opts) {
    const o = opts || {};
    const mode = o.mode === 'total' ? 'total' : 'sortie';
    const days = Math.max(1, Math.floor(num(daysInMonth, 30)));
    const limit = unitCeiling(days);
    const root = isObj(raw) ? raw : {};
    const det = detect(root);
    const data = det.ok ? det.data : {};

    const map = (mode === 'total')
      ? myhisDelta(data.myhis, limit)
      : senkaOfDay(data.exphis, root.tmpexp, limit);

    const curDay = (o.currentDay === undefined) ? 0 : Math.floor(num(o.currentDay, 0));
    const out = [];
    for (let d = 1; d <= days; d++) {
      const has = (d in map);
      out.push({
        day: d,
        value: has ? map[d] : 0,
        hasData: has,
        // 超出当前日期且无数据 = 未来日（UI 可置灰）
        future: (curDay > 0 && d > curDay && !has)
      });
    }
    return out;
  }

  /** 序列累计（到 upto 日，含；默认全月） */
  function cumulative(series, upto) {
    const s = Array.isArray(series) ? series : [];
    const end = (upto === undefined) ? s.length : Math.max(0, Math.floor(num(upto, 0)));
    let sum = 0;
    for (let i = 0; i < end && i < s.length; i++) sum += num(s[i].value, 0);
    return Math.round(sum * 100) / 100;
  }

  /* --------------------------------------------------------- §8 任务状态 */

  /**
   * poi 侧的「额外战果 / 任务类」完成状态。
   *
   * zcleartslist[i] === 0 表示第 i 项已完成（poi 语义：0 = 已完成，非 0 = 推进中）。
   * zName / zValue / zId 与之同序。
   *
   * ⚠️ 这是 poi 里手工维护的**季度任务战果**清单（Z作战、三川、泊地…），
   * 与项目里的「季常任务」并不一一对应，功能 3 只把它作为**弱提示**，
   * 不做自动写入。本函数只负责把它结构化出来。
   */
  function extraQuestStatus(raw) {
    const root = isObj(raw) ? raw : {};
    const names = Array.isArray(root.zName) ? root.zName : [];
    const values = Array.isArray(root.zValue) ? root.zValue : [];
    const cleared = Array.isArray(root.zcleartslist) ? root.zcleartslist : [];
    const ids = Array.isArray(root.zId) ? root.zId : [];
    const marks = Array.isArray(root.extraSenkalist) ? root.extraSenkalist : [];

    const list = [];
    for (let i = 0; i < names.length; i++) {
      const mark = num(marks[i], QUEST_STATE.TODO);
      list.push({
        index: i,
        id: num(ids[i], 0),
        name: String(names[i]),
        senka: num(values[i], 0),
        done: num(cleared[i], 1) === 0,
        state: mark,
        doing: mark === QUEST_STATE.DOING
      });
    }
    return {
      list: list,
      doneSenka: list.reduce(function (a, x) { return a + (x.done ? x.senka : 0); }, 0),
      totalSenka: list.reduce(function (a, x) { return a + x.senka; }, 0)
    };
  }

  KC.poiSource = {
    // 常量
    RANK_LINES: RANK_LINES,
    EO_SENKA: EO_SENKA,
    QUEST_STATE: QUEST_STATE,
    EXP_PER_SENKA: EXP_PER_SENKA,

    // 解析
    detect: detect,
    decodeDateNo: decodeDateNo,
    dateNosOfDay: dateNosOfDay,
    unitCeiling: unitCeiling,
    senkaOfDay: senkaOfDay,
    myhisDelta: myhisDelta,
    seriesTail: seriesTail,
    byDayLatest: byDayLatest,
    myhisTotal: myhisTotal,
    myhisLatest: myhisLatest,
    eoStatus: eoStatus,
    rankLines: rankLines,
    rankLineSeries: rankLineSeries,
    extraQuestStatus: extraQuestStatus,
    summary: summary,
    dailySeries: dailySeries,
    cumulative: cumulative
  };
})(window.KC = window.KC || {});
