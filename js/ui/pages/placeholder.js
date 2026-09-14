/* ==========================================================================
   ui/pages/placeholder.js — 未实现页面的占位
   依据 docs/02_ui.md §九：新增页面不应影响现有导航结构与页面职责。
   ========================================================================== */
(function (KC) {
  'use strict';

  KC.pages = KC.pages || {};

  /**
   * 生成一个占位页面对象。
   * @param {{title: string, icon?: string, desc?: string}} opts
   */
  function createPlaceholder(opts) {
    opts = opts || {};
    return {
      mount: function (container) {
        container.innerHTML =
          '<div class="page-head"><h1>' + KC.utils.escapeHtml(opts.title || '页面') + '</h1></div>' +
          '<div class="panel empty-panel">' +
            '<div class="empty-icon">' + (opts.icon || '◌') + '</div>' +
            '<p class="empty-title">' + KC.utils.escapeHtml(opts.title || '页面') + ' 尚未实现</p>' +
            '<p class="empty-desc">' + KC.utils.escapeHtml(opts.desc || '该页面将在后续版本中构建。') + '</p>' +
          '</div>';
      },
      unmount: function () {}
    };
  }

  KC.pages.placeholder = createPlaceholder;
})(window.KC = window.KC || {});
