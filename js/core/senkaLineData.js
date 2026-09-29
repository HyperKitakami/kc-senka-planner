/* ==========================================================================
   core/senkaLineData.js — 战果线数据的本机存储（IO 外壳）
   纯解析在 core/senkaLineSource.js，槽位取值在 calc/senkaLine.js。

   为什么放在**本机轻量存储**（localLayer）而不是 IndexedDB：
     docs/03_data.md §1.6 把「外部工具的临时采集结果」明确列为本层的适用对象，
     与 poi 快照同一先例。收益是「不参与导入导出」成为**结构性保证**——
     db.js 只遍历 KC.schema.STORES 里的 IndexedDB 仓库，localStorage 物理上不可能
     被带进导出文件。代价（已知并接受）：清站点数据即全丢，所以 UI 必须提示，
     且必须提供「重新采集」的入口。重建成本低正是本层适用的前提。

   ⚠️ 与 poiData.js 同一个坑：localLayer 的 keys()/prune() 按**完整键名**做
      indexOf(k, p) === 0 匹配，传裸的 SNAP_PREFIX 永远匹配不到，必须拼上命名空间前缀。
      这里统一由 nsPrefix() 计算，避免各处手写。

   键名：kc-senka-planner:senkaLine:{服务器编号}:{YYYY-MM}
   ========================================================================== */
(function (KC) {
  'use strict';

  const SNAP_PREFIX = 'senkaLine:';

  function nsPrefix() {
    return KC.localLayer.PREFIX + SNAP_PREFIX;
  }

  function isServerCode(v) { return /^\d{2}$/.test(String(v || '')); }
  function isMonthKey(v) { return /^\d{4}-\d{2}$/.test(String(v || '')); }

  /** 快照键名（不含 localLayer 的命名空间前缀） */
  function snapshotName(serverCode, month) {
    return SNAP_PREFIX + String(serverCode) + ':' + String(month);
  }

  /** 从完整键名反解出 { serverCode, month }；不匹配返回 null */
  function parseKey(fullKey) {
    const m = /^(\d{2}):(\d{4}-\d{2})$/.exec(String(fullKey).slice(nsPrefix().length));
    return m ? { serverCode: m[1], month: m[2] } : null;
  }

  /**
   * 写入某「服务器 × 月份」的战果线数据。**会覆盖同键旧数据**
   * （站点数据是定稿后基本不变的，重采必然比旧数据新或至少一样新）。
   *
   * @param {string} serverCode '01'～'20'
   * @param {string} monthKey 'YYYY-MM'
   * @param {object} parsed KC.senkaLineSource.parse() 的 data
   * @param {object} [extra] 额外元信息，如 { source: {page,title} }
   * @returns {{ok:boolean, error?:string, persisted?:boolean}}
   *   ok=false 仅用于参数或数据本身不合法；本机层不可用时 ok=true 但 persisted=false，
   *   由调用方在 UI 上提示「本机临时层不可用，数据不会被保留」。
   */
  function save(serverCode, monthKey, parsed, extra) {
    if (!isServerCode(serverCode)) return { ok: false, error: '服务器编号不合法。' };
    if (!isMonthKey(monthKey)) return { ok: false, error: '月份格式不合法。' };
    if (!parsed || !Array.isArray(parsed.rows) || !parsed.rows.length) {
      return { ok: false, error: '没有可保存的数据行。' };
    }
    if (parsed.month && parsed.month !== monthKey) {
      return { ok: false, error: '月份与数据内容不一致（' + parsed.month + ' ≠ ' + monthKey + '）。' };
    }

    const src = (extra && extra.source) || parsed.source || {};
    const payload = {
      server: String(serverCode),
      serverName: KC.schema.serverName(serverCode) || '',
      month: String(monthKey),
      importedAt: (extra && extra.importedAt) || new Date().toISOString(),
      source: { page: String(src.page || ''), title: String(src.title || '') },
      /** 导入时的可疑点留档，便于日后排查，不参与任何计算 */
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings.slice() : [],
      rows: parsed.rows
    };

    const persisted = KC.localLayer.write(snapshotName(serverCode, monthKey), payload);
    return { ok: true, persisted: persisted };
  }

  /** 读某「服务器 × 月份」。不存在 / 本机层不可用返回 null */
  function read(serverCode, monthKey) {
    if (!isServerCode(serverCode) || !isMonthKey(monthKey)) return null;
    return KC.localLayer.read(snapshotName(serverCode, monthKey), null);
  }

  /** 某服务器已有的月份（升序） */
  function monthsOf(serverCode) {
    if (!isServerCode(serverCode)) return [];
    return KC.localLayer.keys(nsPrefix()).map(parseKey)
      .filter(function (x) { return x && x.serverCode === String(serverCode); })
      .map(function (x) { return x.month; })
      .sort();
  }

  /** 已有数据的服务器编号（升序） */
  function serverCodes() {
    const seen = {};
    KC.localLayer.keys(nsPrefix()).forEach(function (k) {
      const x = parseKey(k);
      if (x) seen[x.serverCode] = true;
    });
    return Object.keys(seen).sort();
  }

  /**
   * 全部已存数据的摘要（按服务器、月份升序）。
   * 只读元信息，不返回 rows —— 设置页列表用得到。
   * @returns {Array<{serverCode, serverName, month, importedAt, count, source, warnings}>}
   */
  function list() {
    const out = [];
    serverCodes().forEach(function (code) {
      monthsOf(code).forEach(function (month) {
        const snap = read(code, month);
        if (!snap) return;
        out.push({
          serverCode: code,
          serverName: snap.serverName || KC.schema.serverName(code) || '',
          month: month,
          importedAt: snap.importedAt || '',
          count: Array.isArray(snap.rows) ? snap.rows.length : 0,
          source: snap.source || { page: '', title: '' },
          warnings: Array.isArray(snap.warnings) ? snap.warnings : []
        });
      });
    });
    return out;
  }

  /** 删除某「服务器 × 月份」。@returns {boolean} 是否已删除 */
  function remove(serverCode, monthKey) {
    if (!isServerCode(serverCode) || !isMonthKey(monthKey)) return false;
    return KC.localLayer.remove(snapshotName(serverCode, monthKey));
  }

  /** 删除某服务器的全部月份。@returns {string[]} 被删除的月份 */
  function removeServer(serverCode) {
    const removed = monthsOf(serverCode);
    removed.forEach(function (m) { remove(serverCode, m); });
    return removed;
  }

  /** 清空全部战果线数据。@returns {string[]} 被删除的完整键名 */
  function clearAll() {
    return KC.localLayer.prune(nsPrefix(), []);
  }

  /** 本层占用字节数（UTF-16 口径），设置页展示用 */
  function usage() {
    let bytes = 0;
    KC.localLayer.keys(nsPrefix()).forEach(function (k) {
      bytes += k.length * 2;
    });
    return bytes;
  }

  /**
   * 组装「战果线同期对比」卡片的数据（供首页使用）。
   *
   * 口径：
   *   · 取「最近 n 个**已结束**月」—— wiki 当月页在当月不存在（实测），当月取不到；
   *   · 每个月取两个值：**同槽值**（与当前进度同槽，槽未发布时回退上一次）
   *     与**月末值**（该月最后一槽）；
   *   · 缺数据的月份由 calc.senkaLine.compareMonths 跳过，不画空列。
   *
   * @param {string} serverCode 服务器编号（Settings.server）
   * @param {Date} [now]
   * @param {{months?:number, maxLookback?:number}} [opts]
   * @returns {object} 始终返回对象（无数据时 months 为空数组），便于 UI 分支
   */
  function compareModel(serverCode, now, opts) {
    opts = opts || {};
    const at = now || new Date();
    const cur = KC.calc.senkaLine.currentSlot(at);
    const saved = monthsOf(serverCode);
    const pick = KC.calc.senkaLine.compareMonths(at, opts.months || 3, saved, opts.maxLookback);

    const items = pick.months.map(function (month) {
      const snap = read(serverCode, month);
      const rows = (snap && snap.rows) || [];
      const same = KC.calc.senkaLine.pickAtOrBefore(rows, cur.slot);
      const end = KC.calc.senkaLine.pickMonthEnd(rows, month);
      return {
        month: month,
        rowCount: rows.length,
        importedAt: (snap && snap.importedAt) || '',
        warnings: (snap && snap.warnings) || [],
        same: same,
        end: end,
        /** 同槽取的日期文案（如 '29 日 前半日'），槽回退到月末时与 usedSlot 一致 */
        sameLabel: same ? KC.calc.senkaLine.slotLabel(month, same.usedSlot) : ''
      };
    });

    /**
     * 诊断：被跳过的月份里，哪些**其实本地已经有、只是记在别的服务器名下**。
     *
     * 这是最容易让人误判成"没数据"的一种情形 —— 因为设置页的「已采集」汇总是
     * 跨全部服务器的，而卡片只认当前服务器（docs/02_ui.md §4.1.1）。
     * 把这个信息交给 UI，卡片才能给出「请检查服务器设置」这类可操作的提示，
     * 而不是干巴巴一句"本地没有这些月份的数据"。
     */
    const allCodes = serverCodes();
    const foreign = [];
    pick.gaps.forEach(function (month) {
      const owners = allCodes.filter(function (code) {
        return code !== String(serverCode) && monthsOf(code).indexOf(month) >= 0;
      });
      if (!owners.length) return;
      foreign.push({
        month: month,
        owners: owners.map(function (code) {
          return { code: code, name: KC.schema.serverName(code) || code };
        })
      });
    });

    return {
      serverCode: String(serverCode || ''),
      serverName: KC.schema.serverName(serverCode) || '',
      hasServer: isServerCode(serverCode),
      /** 当前对齐的进度点 */
      current: {
        month: cur.month,
        slot: cur.slot,
        rolled: cur.rolled,
        label: KC.calc.senkaLine.slotLabel(cur.month, cur.slot)
      },
      months: items,
      gaps: pick.gaps,
      /** 属于其它服务器的被跳过月份，见上方注释 */
      foreign: foreign,
      partial: pick.partial,
      /** 本服务器已采集的月份（升序） */
      savedMonths: saved,
      /** 本服务器已采集的月数 */
      savedCount: saved.length,
      /** 本机全部服务器加起来采集了多少个月 */
      savedCountAll: allCodes.reduce(function (n, code) { return n + monthsOf(code).length; }, 0)
    };
  }

  KC.senkaLineData = {
    SNAP_PREFIX: SNAP_PREFIX,
    snapshotName: snapshotName,
    compareModel: compareModel,
    save: save,
    read: read,
    monthsOf: monthsOf,
    serverCodes: serverCodes,
    list: list,
    remove: remove,
    removeServer: removeServer,
    clearAll: clearAll,
    usage: usage
  };
})(window.KC = window.KC || {});
