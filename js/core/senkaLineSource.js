/* ==========================================================================
   core/senkaLineSource.js — wikiwiki 战果线数据源（纯解析，无 IO）

   职责边界（⚠️ 本模块**只做纯计算**）：不读文件、不碰 DOM、不碰 localStorage。
     输入 = 用户从 wikiwiki 页面粘回的 JSON（文本或已解析对象）
     输出 = 结构化的解析结果
   落盘与读取由 core/senkaLineData.js 负责，槽位取值由 calc/senkaLine.js 负责。

   ── 数据来源 ────────────────────────────────────────────────────────────
     wikiwiki「情報倉庫/時系列各順位戦果値」子页，一个「服务器 × 月份」一页：
       https://wikiwiki.jp/kancolle/情報倉庫/時系列各順位戦果値/{服务器名} ({YYYY}年{M}月)
     表头：時刻(JST) | 1位 | 5位 | 20位 | 100位 | 500位

   ── 时刻口径（务必理解，否则槽位会整体错位）─────────────────────────────
     · 站点标注 JST：每天 03:00 / 15:00 两次采样
     · 换成北京时间（项目统一口径）即 02:00 / 14:00
     · poi 的 dateNo 是 12 小时一槽、0 起点 = 每月 1 日 02:00（北京）
     ⇒ 站点第 n 行（0 起）与 poi 的 dateNo = n **完全对应**，无需插值：
          slot = 2 × (日 − 1) + (03:00 槽取 0，15:00 槽取 1)

   ── 为什么必须有提取脚本 ────────────────────────────────────────────────
     站点有 Cloudflare 保护：普通 HTTP 请求返回 403 挑战页，无头浏览器也过不去；
     而服务端代理取回的**数字会被篡改**（实测同一行数值完全对不上），绝不能用于数值提取。
     因此唯一可靠路径是：在用户已通过验证的浏览器会话里执行提取脚本。

   ⚠️ EXTRACT_SNIPPET 与 parse() 是同一份**线格式契约**的两端：
      改任何一边都必须同步改另一边，故刻意放在同一文件里。
   ========================================================================== */
(function (KC) {
  'use strict';

  const U = KC.utils;

  /**
   * 五个位次列。
   * `short` / `tier` 是与奖励区间对照用的文案（1 位=人事线，5/20/100/500 位
   * 分别对应联合 / 一群 / 二群 / 三群），划分与 schema.REWARD_TIERS 一致。
   * 刻意只在这里定义一次，UI 与计算层都从这里取，避免两处各写一份而漂移。
   */
  const RANKS = [
    { key: 'r1',   label: '1位',   short: '人事线', rank: 1,   tier: '第 1 名（人事）' },
    { key: 'r5',   label: '5位',   short: '联合',   rank: 5,   tier: '联合（1～5 名）' },
    { key: 'r20',  label: '20位',  short: '一群',   rank: 20,  tier: '一群（6～20 名）' },
    { key: 'r100', label: '100位', short: '二群',   rank: 100, tier: '二群（21～100 名）' },
    { key: 'r500', label: '500位', short: '三群',   rank: 500, tier: '三群（101～500 名）' }
  ];
  const RANK_KEYS = RANKS.map(function (r) { return r.key; });
  const RANK_LABELS = RANKS.map(function (r) { return r.label; });

  /** 采样行时刻：'YYYY/MM/DD HH:MM'（JST） */
  const ROW_TIME_RE = /^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})$/;
  /** 页面路径 / 标题里的「服务器名 (YYYY年M月)」 */
  const PAGE_REF_RE = /([^\/()（）]+?)\s*[（(]\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*[)）]/;
  /** JST 的两个采样小时 → 槽内偏移 */
  const SAMPLE_HOURS = { 3: 0, 15: 1 };

  /**
   * 浏览器提取脚本（在 wikiwiki 子页的 Console 里执行，返回 JSON 文本）。
   *
   * 设计取舍：
   *   · 按**表头文字**自发现 `<table>`，不依赖 CSS 类名 —— 站点改版时更抗摔。
   *   · 表头比对时剥掉全部空白（站点表头里可能混入全角空格与换行）。
   *   · 行时刻**保留原样空格**交给 parse()，故只 trim 不压缩空白。
   *   · 一并带上 page / title，供 parse() best-effort 推断服务器与月份。
   *
   * 用 String.raw 以免 `\d`、`\s` 在字符串字面量里被吃掉反斜杠。
   * ⚠️ 片段内不得出现反引号与 `${`。
   */
  const EXTRACT_SNIPPET = String.raw`(() => {
  const WANT = ['1位', '5位', '20位', '100位', '500位'];
  const flat = (s) => (s || '').replace(/[\s\u3000]+/g, '');
  const tbl = [...document.querySelectorAll('table')].find((t) => {
    const head = [...t.querySelectorAll('tr')].slice(0, 3)
      .flatMap((tr) => [...tr.children].map((td) => flat(td.textContent)));
    return WANT.every((w) => head.some((c) => c.indexOf(w) >= 0));
  });
  if (!tbl) return '未找到战果值表格：请确认打开的是「時系列各順位戦果値」子页';

  const cells = (tr) => [...tr.children].map((td) => (td.textContent || '').trim());
  const rows = [...tbl.querySelectorAll('tr')].map(cells)
    .filter((c) => /^\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}$/.test(c[0] || ''))
    .map((c) => ({
      t: c[0],
      r1: Number(c[1]), r5: Number(c[2]), r20: Number(c[3]),
      r100: Number(c[4]), r500: Number(c[5])
    }));
  if (!rows.length) return '表格存在，但没有解析出任何数据行';

  const json = JSON.stringify({
    page: decodeURIComponent(location.pathname),
    title: document.title,
    rows: rows
  });

  // 自动复制到剪贴板。优先用 DevTools 的 copy()：
  // 它是控制台内置的同步方法，不受安全上下文与用户手势限制，最可靠。
  let copied = false;
  if (typeof copy === 'function') {
    try { copy(json); copied = true; } catch (e) { copied = false; }
  }
  // 退路：标准异步剪贴板 API（需要 https 与页面有焦点）
  if (!copied && typeof navigator !== 'undefined' &&
      navigator.clipboard && navigator.clipboard.writeText) {
    try {
      navigator.clipboard.writeText(json).catch(() => {});
      copied = true;
    } catch (e) { copied = false; }
  }

  console.log(copied
    ? '已复制 ' + rows.length + ' 行到剪贴板，直接粘到工具的输入框即可。'
    : '自动复制失败：请手动选中下面返回的结果再复制（共 ' + rows.length + ' 行）。');
  return json;
})()`;

  /* ------------------------------------------------------------ 输入解码 */

  /** JSON.parse 的哨兵：用来区分「解析失败」与「合法地解析出 null」 */
  const PARSE_FAIL = {};

  function tryParse(text) {
    try { return JSON.parse(text); } catch (err) { return PARSE_FAIL; }
  }

  /** 成对的外层引号 —— 从控制台复制时很容易被带上 */
  const QUOTE_PAIRS = [['"', '"'], ["'", "'"], ['\u201c', '\u201d'], ['\u300c', '\u300d']];

  /** 若文本首尾是一对成对引号，剥掉一层并 trim；否则原样返回 */
  function stripOuterQuotes(text) {
    for (let i = 0; i < QUOTE_PAIRS.length; i++) {
      const open = QUOTE_PAIRS[i][0];
      const close = QUOTE_PAIRS[i][1];
      if (text.length >= 2 && text.charAt(0) === open && text.charAt(text.length - 1) === close) {
        return text.slice(1, -1).trim();
      }
    }
    return text;
  }

  /**
   * 解析用户粘进来的文本。
   *
   * ⚠️ 必须做两级兜底，否则从控制台复制必然失败：
   *    在浏览器控制台里对表达式求值，若结果是字符串，**显示时会连带外层引号**
   *    （Chrome 在内容含双引号时还会改用单引号包裹），用户选中复制得到的
   *    就是 `'{"page":…}'` 这种形态，直接 JSON.parse 一定抛错。
   *
   * 依次尝试：① 原文 → ② 剥一层成对引号 → ③ 再解一次
   * （③ 应对整体被多包了一层引号的 JSON 字符串）。
   *
   * @returns {{value?:*, error?:string}}
   */
  function decodeText(text) {
    const raw = String(text).trim();
    if (!raw) return { error: '内容为空。' };

    let value = tryParse(raw);
    if (value === PARSE_FAIL) {
      const stripped = stripOuterQuotes(raw);
      if (stripped !== raw) value = tryParse(stripped);
    }
    if (value === PARSE_FAIL) {
      return {
        error: '不是合法的 JSON。请确认粘进来的是提取脚本返回的完整内容' +
          '（从 { 开始到 } 结束），并且没有连带控制台显示时包在外面的引号。'
      };
    }
    if (typeof value === 'string') {
      const again = tryParse(value.trim());
      if (again !== PARSE_FAIL) value = again;
    }
    return { value: value };
  }

  function fail(error) {
    return { ok: false, error: error };
  }

  /**
   * 从页面路径 / 标题里抽出「服务器名 + 月份」。
   * 例：'.../横須賀鎮守府 (2026年8月)' → { serverName: '横須賀鎮守府', month: '2026-08' }
   * 抽不到时字段为 null（不报错 —— 裸数组输入本来就没有这些信息）。
   */
  function parsePageRef(text) {
    const m = PAGE_REF_RE.exec(String(text || ''));
    if (!m) return { serverName: null, month: null };
    return {
      serverName: m[1].trim(),
      month: m[2] + '-' + U.pad2(Number(m[3]))
    };
  }

  /**
   * 日文服务器名 → 服务器编号（'01'～'20'）。
   * 依据 schema.SERVERS 的 wikiName；找不到返回 null。
   */
  function serverCodeOfWikiName(name) {
    const want = String(name || '').trim();
    if (!want) return null;
    const hit = (KC.schema.SERVERS || []).filter(function (s) {
      return s.wikiName === want || s.name === want;
    })[0];
    return hit ? hit.code : null;
  }

  function isMonthKey(v) { return /^\d{4}-\d{2}$/.test(String(v || '')); }

  /** wiki 索引页（列出全部服务器与月份） */
  const WIKI_INDEX_URL =
    'https://wikiwiki.jp/kancolle/' + encodeURIComponent('情報倉庫/時系列各順位戦果値');

  /**
   * 某服务器某月子页的地址 —— 供设置页给一个「点开就是那一页」的链接。
   *
   * ⚠️ **当月的子页在当月不存在**（实测：2026-09-29 时 9 月页不存在），
   *    所以调用方只应传**已结束月份**，否则会点到一个「ページが存在しません」。
   * 服务器没有 wikiName（或参数不合法）时回退到索引页。
   */
  function wikiPageUrl(serverCode, monthKey) {
    const hit = (KC.schema.SERVERS || []).filter(function (s) {
      return s.code === String(serverCode);
    })[0];
    if (!hit || !hit.wikiName || !isMonthKey(monthKey)) return WIKI_INDEX_URL;
    const p = String(monthKey).split('-');
    return WIKI_INDEX_URL + '/' +
      encodeURIComponent(hit.wikiName + ' (' + p[0] + '年' + Number(p[1]) + '月)');
  }

  /**
   * 解析用户粘回的内容。
   *
   * 接受三种输入：
   *   ① 提取脚本产出的对象 `{ page, title, rows }`
   *   ② 裸数组 `[{ t, r1, r5, r20, r100, r500 }]`
   *   ③ 以上两者的 JSON 文本
   *
   * 校验分两级：
   *   · **错误**（ok:false）= 结构不可用（不是 JSON、没有行、时刻格式不对、月份混用）
   *   · **警告**（warnings）= 数据可用但可疑（行数不符、槽位缺口、数值非单调）
   * 刻意不把"数值非单调"升级为错误：站点本身偶有回填，而纯解析层无权替用户决定丢弃。
   *
   * @returns {{ok:boolean, error?:string, data?:object}}
   */
  function parse(input) {
    let obj = input;
    if (typeof input === 'string') {
      // 交给 decodeText 做「剥离控制台外层引号」等兜底，见其注释
      const dec = decodeText(input);
      if (dec.error) return fail(dec.error);
      obj = dec.value;
    }

    let rawRows;
    let pageRef = { serverName: null, month: null };
    let title = '';
    let page = '';

    if (Array.isArray(obj)) {
      rawRows = obj;
    } else if (obj && typeof obj === 'object') {
      rawRows = obj.rows;
      page = String(obj.page || '');
      title = String(obj.title || '');
      pageRef = parsePageRef(page + ' ' + title);
    } else {
      return fail('无法识别的数据格式：应为数组，或含 rows 的对象。');
    }

    if (!Array.isArray(rawRows)) return fail('数据里没有 rows 数组。');
    if (!rawRows.length) return fail('数据里没有任何采样行。');

    const rows = [];
    const badTimes = [];
    const badValues = [];

    rawRows.forEach(function (raw, i) {
      const r = raw || {};
      const t = String(r.t || '').trim();
      const m = ROW_TIME_RE.exec(t);
      if (!m) { badTimes.push(i + 1); return; }

      const day = Number(m[3]);
      const hour = Number(m[4]);
      const half = SAMPLE_HOURS[hour];
      // 采样小时不在 {03, 15} 说明站点改了口径，槽位算法不再成立 —— 视为错误而非警告
      if (half === undefined) { badTimes.push(i + 1); return; }

      const row = {
        slot: 2 * (day - 1) + half,
        day: day,
        half: half,
        t: t
      };
      let valueBad = false;
      RANK_KEYS.forEach(function (k) {
        const v = Number(r[k]);
        if (r[k] === null || r[k] === undefined || r[k] === '' || !isFinite(v)) {
          valueBad = true;
          row[k] = null;
        } else {
          row[k] = v;
        }
      });
      if (valueBad) badValues.push(i + 1);
      rows.push(row);
    });

    if (badTimes.length) {
      return fail('第 ' + badTimes.slice(0, 5).join('、') +
        (badTimes.length > 5 ? ' 等 ' : ' ') + '行时刻无法识别（应为「YYYY/MM/DD 03:00 或 15:00」）。');
    }
    if (badValues.length) {
      return fail('第 ' + badValues.slice(0, 5).join('、') +
        (badValues.length > 5 ? ' 等 ' : ' ') + '行的战果值不是有效数字。');
    }

    // 月份：页面信息优先，其次取**原始顺序**的首行年月（站点按时间顺序列出）
    const firstTime = ROW_TIME_RE.exec(rows[0].t);
    const month = pageRef.month || (firstTime[1] + '-' + firstTime[2]);
    if (!isMonthKey(month)) return fail('无法确定月份。');

    // ⚠️ 同月校验必须在**去重之前**做：
    //    次月 1 日 03:00 的槽号是 0，与本月 1 日 03:00 完全**撞车**。
    //    若先按槽号去重，跨月的那一行会被当成"重复"悄悄丢掉，用户根本不会察觉自己粘错了内容。
    const crossMonth = rows.filter(function (r) {
      const mm = ROW_TIME_RE.exec(r.t);
      return (mm[1] + '-' + mm[2]) !== month;
    });
    if (crossMonth.length) {
      return fail('数据里混有多个年月（本月 ' + month + '，另有 ' +
        crossMonth.length + ' 行属于其它月份），请一次只粘一个月份。');
    }

    if (pageRef.month && pageRef.month !== month) {
      return fail('页面标注的月份（' + pageRef.month + '）与数据行的月份（' + month + '）不一致。');
    }

    // 排序 + 去重：槽号相撞说明同一时刻被重复列出，保留先出现的
    rows.sort(function (a, b) { return a.slot - b.slot; });
    const seen = {};
    const deduped = [];
    rows.forEach(function (r) {
      if (seen[r.slot]) return;
      seen[r.slot] = true;
      deduped.push(r);
    });

    const serverCode = serverCodeOfWikiName(pageRef.serverName);
    const warnings = [];
    const expected = U.daysInMonth(month) * 2;

    if (deduped.length !== rawRows.length) {
      warnings.push('有 ' + (rawRows.length - deduped.length) + ' 行重复的采样时刻已被去重。');
    }
    if (deduped.length !== expected) {
      warnings.push('共 ' + deduped.length + ' 行，与 ' + month + ' 应有的 ' +
        expected + ' 行不一致，可能有缺失或删改。');
    }
    if (deduped[0].slot !== 0) {
      warnings.push('首行是第 ' + deduped[0].slot + ' 槽，缺少月初的采样。');
    }
    const lastSlot = deduped[deduped.length - 1].slot;
    if (lastSlot !== expected - 1) {
      warnings.push('末行是第 ' + lastSlot + ' 槽，不是该月最后一槽（' + (expected - 1) +
        '）；「月末值」将取末行，并非真正的月末采样。');
    }
    if (pageRef.serverName && !serverCode) {
      warnings.push('未能从页面标题识别服务器「' + pageRef.serverName +
        '」，导入时请手动选择服务器。');
    }

    // 单调性：战果线在一个战果月内只会上升（实测站点确实单调），下降即可疑
    RANK_KEYS.forEach(function (k) {
      for (let i = 1; i < deduped.length; i++) {
        const prev = deduped[i - 1][k];
        const cur = deduped[i][k];
        if (prev === null || cur === null) continue;
        if (cur < prev) {
          warnings.push(RANK_LABELS[RANK_KEYS.indexOf(k)] + ' 在第 ' + deduped[i].slot +
            ' 槽出现下降（' + prev + ' → ' + cur + '），数据可能被改动。');
          break;   // 每条线只报第一处，避免刷屏
        }
      }
    });

    return {
      ok: true,
      data: {
        month: month,
        serverName: pageRef.serverName,
        serverCode: serverCode,
        source: { page: page, title: title },
        rows: deduped,
        warnings: warnings,
        stats: {
          count: deduped.length,
          expectedCount: expected,
          firstSlot: deduped[0].slot,
          lastSlot: lastSlot
        }
      }
    };
  }

  KC.senkaLineSource = {
    RANKS: RANKS,
    RANK_KEYS: RANK_KEYS,
    RANK_LABELS: RANK_LABELS,
    SAMPLE_HOURS: SAMPLE_HOURS,
    EXTRACT_SNIPPET: EXTRACT_SNIPPET,
    WIKI_INDEX_URL: WIKI_INDEX_URL,
    wikiPageUrl: wikiPageUrl,
    decodeText: decodeText,
    stripOuterQuotes: stripOuterQuotes,
    parse: parse,
    parsePageRef: parsePageRef,
    serverCodeOfWikiName: serverCodeOfWikiName,
    isMonthKey: isMonthKey
  };
})(window.KC = window.KC || {});
