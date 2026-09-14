/* ==========================================================================
   ui/dom.js — 轻量 DOM 辅助
   ========================================================================== */
(function (KC) {
  'use strict';

  function qs(selector, root) { return (root || document).querySelector(selector); }
  function qsa(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }
  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }
  /** 从事件目标向上查找带 data-* 属性的元素 */
  function closestFrom(target, selector) {
    if (!target || typeof target.closest !== 'function') return null;
    return target.closest(selector);
  }

  KC.dom = { qs: qs, qsa: qsa, clear: clear, closestFrom: closestFrom };
})(window.KC = window.KC || {});
