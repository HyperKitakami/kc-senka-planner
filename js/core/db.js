/* ==========================================================================
   core/db.js — IndexedDB 封装（Local First，无服务器）
   ========================================================================== */
(function (KC) {
  'use strict';

  const DB_NAME = 'kc-senka-planner';
  const DB_VERSION = KC.schema.SCHEMA_VERSION;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise(function (resolve, reject) {
      if (!('indexedDB' in window)) {
        reject(new Error('当前浏览器不支持 IndexedDB，无法保存数据。'));
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = function () {
        const db = request.result;
        const defs = KC.schema.STORES;
        Object.keys(defs).forEach(function (name) {
          if (db.objectStoreNames.contains(name)) return;
          const def = defs[name];
          const store = db.createObjectStore(name, { keyPath: def.keyPath });
          (def.indexes || []).forEach(function (ix) {
            store.createIndex(ix.name, ix.keyPath, ix.options || {});
          });
        });
      };

      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error('打开数据库失败。')); };
      request.onblocked = function () {
        reject(new Error('数据库被其它标签页占用，请关闭其它页面后重试。'));
      };
    });

    return dbPromise;
  }

  /** 在单个对象仓库上执行一次事务，返回 IDBRequest 的结果 */
  function run(storeName, mode, executor) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        let tx;
        try {
          tx = db.transaction(storeName, mode);
        } catch (err) {
          reject(err);
          return;
        }
        const store = tx.objectStore(storeName);
        let request;
        try {
          request = executor(store);
        } catch (err) {
          reject(err);
          return;
        }
        tx.oncomplete = function () { resolve(request ? request.result : undefined); };
        tx.onerror = function () { reject(tx.error || new Error('数据库事务失败。')); };
        tx.onabort = function () { reject(tx.error || new Error('数据库事务被中止。')); };
      });
    });
  }

  function getAll(storeName) { return run(storeName, 'readonly', function (s) { return s.getAll(); }); }
  function get(storeName, key) { return run(storeName, 'readonly', function (s) { return s.get(key); }); }
  function put(storeName, value) { return run(storeName, 'readwrite', function (s) { return s.put(value); }); }
  function del(storeName, key) { return run(storeName, 'readwrite', function (s) { return s.delete(key); }); }
  function clear(storeName) { return run(storeName, 'readwrite', function (s) { return s.clear(); }); }

  /** 批量写入（同一事务） */
  function putMany(storeName, values) {
    if (!values || !values.length) return Promise.resolve(0);
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        values.forEach(function (v) { store.put(v); });
        tx.oncomplete = function () { resolve(values.length); };
        tx.onerror = function () { reject(tx.error || new Error('批量写入失败。')); };
        tx.onabort = function () { reject(tx.error || new Error('批量写入被中止。')); };
      });
    });
  }

  /** 参与导入导出的业务仓库（排除本地备份等本机便利性数据） */
  function storeNames() {
    const transient = KC.schema.TRANSIENT_STORES || [];
    return Object.keys(KC.schema.STORES).filter(function (name) {
      return transient.indexOf(name) < 0;
    });
  }

  /** 导出全部数据（含 schemaVersion） */
  function exportAll() {
    const names = storeNames();
    return Promise.all(names.map(getAll)).then(function (results) {
      const data = {};
      names.forEach(function (name, i) { data[name] = results[i] || []; });
      return {
        app: 'kc-senka-planner',
        schemaVersion: KC.schema.SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        data: data
      };
    });
  }

  /** 用给定数据整体替换所有仓库（同一事务，失败自动回滚） */
  function replaceAll(payload) {
    const names = storeNames();
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(names, 'readwrite');
        names.forEach(function (name) {
          const store = tx.objectStore(name);
          store.clear();
          (payload.data[name] || []).forEach(function (item) { store.put(item); });
        });
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { reject(tx.error || new Error('导入写入失败。')); };
        tx.onabort = function () { reject(tx.error || new Error('导入写入被中止，数据未变更。')); };
      });
    });
  }

  /* ---------------------------------------------------------- 合并导入 */

  /**
   * 参与合并的仓库。
   * config（程序元数据）与 settings（用户偏好）在合并时不参与，
   * 避免"导入数据"顺手改掉本机的外观与规划偏好。
   */
  const MERGE_STORES = [
    'dailyRecords', 'taskTemplates', 'taskRecords', 'monthlyContexts', 'archives'
  ];

  /** 各仓库的「逻辑主键」——用于判断两边是不是同一条数据 */
  function logicalKey(storeName, item) {
    if (storeName === 'taskRecords') return String(item.templateId) + '\u0000' + String(item.periodId);
    if (storeName === 'monthlyContexts' || storeName === 'archives') return String(item.month);
    if (storeName === 'dailyRecords') return String(item.date);
    return String(item.id);
  }

  /**
   * 冲突时以文件为准的覆盖写法。
   * TaskRecord 的主键是随机 id，同一逻辑记录在两边可能 id 不同，
   * 因此必须沿用本机主键，否则会留下重复记录。
   */
  function mergeRecord(storeName, localItem, incomingItem) {
    if (storeName === 'taskRecords' && localItem && localItem.id) {
      return Object.assign({}, incomingItem, { id: localItem.id });
    }
    return incomingItem;
  }

  /** 纯计算：给定本机数据与文件数据，算出需要写入哪些记录 */
  function computeMerge(localData, incomingData, policy) {
    const puts = [];
    const stats = { added: 0, updated: 0, kept: 0 };

    MERGE_STORES.forEach(function (name) {
      const localByKey = {};
      (localData[name] || []).forEach(function (item) {
        localByKey[logicalKey(name, item)] = item;
      });
      (incomingData[name] || []).forEach(function (item) {
        const key = logicalKey(name, item);
        const existing = localByKey[key];
        if (existing === undefined) {
          puts.push({ name: name, item: item });
          stats.added++;
        } else if (policy === 'file') {
          puts.push({ name: name, item: mergeRecord(name, existing, item) });
          stats.updated++;
        } else {
          stats.kept++;
        }
      });
    });

    return { puts: puts, stats: stats };
  }

  /**
   * 合并导入：只新增与更新，不删除本机已有数据。
   * 读取与写入在同一个事务内完成，失败整体回滚。
   * @param {object} payload 已通过 migrate 校验的导出数据
   * @param {'file'|'local'} policy 冲突策略：file = 以文件为准，local = 以本机为准
   * @returns {Promise<{added:number, updated:number, kept:number}>}
   */
  function mergeAll(payload, policy) {
    const names = MERGE_STORES;
    const incoming = (payload && payload.data) || {};
    let stats = { added: 0, updated: 0, kept: 0 };

    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(names, 'readwrite');
        const localData = {};
        let remaining = names.length;

        names.forEach(function (name) {
          const req = tx.objectStore(name).getAll();
          req.onsuccess = function () {
            localData[name] = req.result || [];
            remaining--;
            if (remaining > 0) return;
            // 本机数据已全部读出，此时事务仍然活跃，立即写入
            const computed = computeMerge(localData, incoming, policy);
            stats = computed.stats;
            computed.puts.forEach(function (p) {
              tx.objectStore(p.name).put(p.item);
            });
          };
        });

        tx.oncomplete = function () { resolve(stats); };
        tx.onerror = function () { reject(tx.error || new Error('合并写入失败。')); };
        tx.onabort = function () { reject(tx.error || new Error('合并写入被中止，数据未变更。')); };
      });
    });
  }

  /** 预演合并结果（只读，不写入任何数据） */
  function previewMerge(payload, policy) {
    const incoming = (payload && payload.data) || {};
    return Promise.all(MERGE_STORES.map(function (name) { return getAll(name); }))
      .then(function (list) {
        const localData = {};
        MERGE_STORES.forEach(function (name, i) { localData[name] = list[i] || []; });
        return computeMerge(localData, incoming, policy).stats;
      });
  }

  KC.db = {
    open: open,
    getAll: getAll,
    get: get,
    put: put,
    putMany: putMany,
    del: del,
    clear: clear,
    exportAll: exportAll,
    replaceAll: replaceAll,
    MERGE_STORES: MERGE_STORES,
    computeMerge: computeMerge,
    mergeAll: mergeAll,
    previewMerge: previewMerge
  };
})(window.KC = window.KC || {});
