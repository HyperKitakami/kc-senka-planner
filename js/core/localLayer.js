/* ==========================================================================
   core/localLayer.js — 本机轻量存储（Local Layer）

   ⚠️ 本层刻意置于持久数据模型之外 —— 它不参与导入导出、不参与战果统计，
   因此不复用 IndexedDB：

     1. 「不参与导入导出」是结构性保证，不是靠代码排除：db.js 的 exportAll /
        replaceAll / mergeAll 只遍历 KC.schema.STORES 里的 IndexedDB 仓库，
        localStorage 物理上不可能被带进导出文件，一行排除逻辑都不用写。
     2. 不升 schemaVersion 即可新增键。实测确证：不升版本号往已有 IndexedDB 库里
        加仓库会抛 NotFoundError: One of the specified object stores was not found。
     3. 容量足够。实测写入约 4 MB 后触顶 QuotaExceededError（上限约 5 MB），
        而本层的数据全是 KB 级。

   代价（已知并接受）：项目因此有了第二个存储引擎，且换浏览器 / 清站点数据即全丢，
   所以各调用方必须在 UI 上明确告知用户（易失性风险的对策）。

   所有 API **绝不抛异常**（隐私模式下连读 localStorage 属性都可能抛）：
   不可用时降级为内存 Map，并由调用方提示"本机临时层不可用，数据不会被保留"。

   键名一律带前缀 kc-senka-planner: —— 实测 file:// 下 location.origin === 'file://'，
   所有 file:// 页面共享同一个 storage，必须靠前缀隔离。
   ========================================================================== */
(function (KC) {
  'use strict';

  const PREFIX = 'kc-senka-planner:';
  /** 探针键：available() 用它写一次再读回，用完立即删除 */
  const PROBE_KEY = PREFIX + '__probe';

  /** 降级存储：localStorage 不可用（或写入失败）时改用它，仅本次会话有效 */
  const memory = new Map();

  let probed = false;
  let usable = false;
  let warned = false;

  /* -------------------------------------------------------------- 内部 */

  /** 取 localStorage；不可访问（含隐私模式下读属性即抛）返回 null */
  function storage() {
    try {
      return (typeof window !== 'undefined' && window.localStorage) ? window.localStorage : null;
    } catch (err) {
      return null;
    }
  }

  function key(name) {
    return PREFIX + String(name);
  }

  function warnOnce() {
    if (warned) return;
    warned = true;
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[localLayer] localStorage 不可用，已降级为内存存储：' +
        '本次会话内仍可读写，但关闭页面后不会保留。');
    }
  }

  /** 枚举两个层里的全部键（去重；localStorage 不可用时只剩内存层） */
  function allKeys() {
    const out = [];
    const seen = Object.create(null);
    function push(k) {
      if (!k || seen[k]) return;
      seen[k] = true;
      out.push(k);
    }
    if (available()) {
      const s = storage();
      try {
        for (let i = 0; i < s.length; i++) push(s.key(i));
      } catch (err) { /* 枚举失败不影响内存层 */ }
    }
    memory.forEach(function (value, k) { push(k); });
    return out;
  }

  /** 取原始字符串（先 localStorage，再内存层） */
  function rawValue(k) {
    if (available()) {
      try {
        const v = storage().getItem(k);
        if (v !== null && v !== undefined) return v;
      } catch (err) { /* 落到内存层 */ }
    }
    return memory.has(k) ? memory.get(k) : null;
  }

  /** 按完整键名删除（两个层都删） */
  function removeKey(k) {
    memory.delete(k);
    if (!available()) return;
    try { storage().removeItem(k); } catch (err) { /* 删不掉也不影响内存层 */ }
  }

  /* ------------------------------------------------------------ 对外 API */

  /**
   * 探测可用性（结果缓存）。写一次探针键并读回，失败即视为不可用。
   * @returns {boolean}
   */
  function available() {
    if (probed) return usable;
    probed = true;
    usable = false;
    const s = storage();
    if (s) {
      try {
        s.setItem(PROBE_KEY, '1');
        usable = s.getItem(PROBE_KEY) === '1';
      } catch (err) {
        usable = false;
      }
      try { s.removeItem(PROBE_KEY); } catch (err) { /* 清理失败不影响可用性判定 */ }
    }
    if (!usable) warnOnce();
    return usable;
  }

  /**
   * 读 + JSON.parse。不存在 / 非法 JSON / 不可用 → fallback（不抛）。
   * @param {string} name 键名（不带命名空间前缀）
   * @param {*} fallback
   */
  function read(name, fallback) {
    const raw = rawValue(key(name));
    if (raw === null || raw === undefined) return fallback;
    try {
      return JSON.parse(raw);
    } catch (err) {
      return fallback;
    }
  }

  /**
   * 写 + JSON.stringify。**绝不抛异常**。
   * @returns {boolean} 只有真正落到 localStorage 才是 true；
   *   不可用 / 配额满 / 值不可序列化 → 落内存层并返回 false，
   *   调用方据此在 UI 上提示"不会被保留"。
   */
  function write(name, value) {
    const k = key(name);
    let raw;
    try {
      raw = JSON.stringify(value);
    } catch (err) {
      return false;
    }
    if (raw === undefined) return false;   // undefined / 函数等不可序列化的值

    if (available()) {
      try {
        storage().setItem(k, raw);
        memory.delete(k);                  // 已持久化，内存副本不再需要
        return true;
      } catch (err) {
        // 配额满（QuotaExceededError）等：不抛，降级到内存
      }
    }
    memory.set(k, raw);
    return false;
  }

  /** 删除（两个层都删）。@returns {boolean} 是否已从 localStorage 删除 */
  function remove(name) {
    const k = key(name);
    memory.delete(k);
    if (!available()) return true;
    try {
      storage().removeItem(k);
      return true;
    } catch (err) {
      return false;
    }
  }

  /**
   * 命名空间（或更细的前缀）下的键列表，按名称排序。
   * @param {string} [prefix] 默认整个命名空间 'kc-senka-planner:'
   * @returns {string[]} 完整键名
   */
  function keys(prefix) {
    const p = prefix === undefined ? PREFIX : String(prefix);
    return allKeys().filter(function (k) {
      return k !== PROBE_KEY && k.indexOf(p) === 0;
    }).sort();
  }

  /**
   * 懒清理：删掉同前缀下不在 keepKeys 里的键（本层唯一的清理入口，
   * 保留哪些键由各单元自己决定）。
   *
   * keepKeys 既接受**完整键名**，也接受**去掉前缀后的后缀**（可选带一个 ':'），
   * 因此下面两种写法等价：
   *   prune('kc-senka-planner:taskProgress', ['2026-09', '2026-10'])
   *   prune('kc-senka-planner:taskProgress:', ['2026-09', '2026-10'])
   *
   * @returns {string[]} 被删除的完整键名（便于测试与日志）
   */
  function prune(prefix, keepKeys) {
    const p = String(prefix === undefined ? PREFIX : prefix);
    const keep = (keepKeys || []).map(String);
    const removed = [];
    keys(p).forEach(function (k) {
      const suffix = k.slice(p.length).replace(/^:/, '');
      if (keep.indexOf(k) >= 0 || keep.indexOf(suffix) >= 0) return;
      removeKey(k);
      removed.push(k);
    });
    return removed;
  }

  /**
   * 估算占用字节数（按 localStorage 的 UTF-16 存储口径，字符数 × 2）。
   * 只统计命名空间内的键，供设置页展示。
   */
  function usage() {
    let bytes = 0;
    keys().forEach(function (k) {
      const raw = rawValue(k);
      bytes += (k.length + String(raw === null ? '' : raw).length) * 2;
    });
    return bytes;
  }

  KC.localLayer = {
    PREFIX: PREFIX,
    available: available,
    read: read,
    write: write,
    remove: remove,
    keys: keys,
    prune: prune,
    usage: usage
  };
})(window.KC = window.KC || {});
