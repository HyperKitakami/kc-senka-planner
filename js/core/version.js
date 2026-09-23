/* ==========================================================================
   core/version.js — 程序版本号（唯一代码载体）

   本项目没有 package.json、没有构建步骤，所以版本号需要手工维护。
   维护规则：**四个落点成对更新，发布时缺一不可** ——
     · 本文件的 VERSION
     · CHANGELOG.md 的「当前版本」（以及开发历史表里补一行）
     · README.md 的「版本」一节（最容易漏）
     · git tag（annotated）

   ⚠️ 版本号与数据结构版本是两回事，不要混：
     · 本文件 = 程序版本（给人看的，语义化版本）；
     · KC.schema.SCHEMA_VERSION = 数据结构版本（给迁移链看的，导出文件里存的是它）。
   程序版本变了而数据结构没变时，**不要**动 SCHEMA_VERSION，否则会平白触发一次迁移。
   ========================================================================== */

(function (KC) {
  'use strict';

  /** 程序版本，形如 v0.3.0（与 CHANGELOG.md 的「当前版本」、README.md 的「版本」、git tag 保持一致）。 */
  var VERSION = 'v0.3.3';

  /** 去掉前导 v 的版本号，便于需要纯数字形式的场合。 */
  var VERSION_NUM = VERSION.replace(/^v/, '');

  KC.VERSION = VERSION;
  KC.VERSION_NUM = VERSION_NUM;
})(window.KC = window.KC || {});
