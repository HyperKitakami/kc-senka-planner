/* ==========================================================================
   ui/router.js — 基于 hash 的页面路由
   依据 docs/02_ui.md §二：左侧导航负责页面切换，主工作区展示当前页面。
   ========================================================================== */
(function (KC) {
  'use strict';

  const DEFAULT_PAGE = 'dashboard';

  /** 尚未实现的页面：给出占位说明（docs/02_ui.md §四） */
  /**
   * 尚未实现的页面占位。
   * docs/02_ui.md §三 列出的 8 个页面均已实现，此表保留以便未来新增页面时使用。
   */
  const PLACEHOLDERS = {};

  let currentPage = null;
  let currentId = null;
  let routeListener = null;

  function parseHash() {
    const raw = String(location.hash || '').replace(/^#\/?/, '');
    const id = raw.split('/')[0];
    return id || DEFAULT_PAGE;
  }

  function resolve(id) {
    if (KC.pages && KC.pages[id]) return KC.pages[id];
    if (PLACEHOLDERS[id]) return KC.pages.placeholder(PLACEHOLDERS[id]);
    return KC.pages.placeholder({ title: '未找到页面', desc: '该页面不存在，请从左侧导航重新选择。' });
  }

  function render() {
    const id = parseHash();
    const main = document.getElementById('main');
    if (!main) return;

    if (currentPage && typeof currentPage.unmount === 'function') {
      try { currentPage.unmount(); } catch (err) { console.error('[router] unmount 失败', err); }
    }
    KC.dom.clear(main);

    currentPage = resolve(id);
    currentId = id;
    try {
      currentPage.mount(main);
    } catch (err) {
      console.error('[router] mount 失败', err);
      main.innerHTML = '<div class="panel"><h2>页面加载失败</h2><p>' +
        KC.utils.escapeHtml(err.message) + '</p></div>';
    }

    if (routeListener) routeListener(id);
  }

  function navigate(id) {
    const target = '#/' + id;
    if (location.hash === target) { render(); return; }
    location.hash = target;
  }

  function start(onRouteChange) {
    routeListener = onRouteChange;
    window.addEventListener('hashchange', render);
    render();
  }

  KC.router = {
    start: start,
    navigate: navigate,
    render: render,
    currentId: function () { return currentId; }
  };
})(window.KC = window.KC || {});
