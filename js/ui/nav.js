/* ==========================================================================
   ui/nav.js — 左侧导航
   依据 docs/02_ui.md §三：导航顺序按日常使用频率设计。
   ========================================================================== */
(function (KC) {
  'use strict';

  const NAV_ITEMS = [
    { id: 'dashboard', label: '首页',     icon: '◈' },
    { id: 'records',   label: '战果记录', icon: '✎' },
    { id: 'planning',  label: '战果规划', icon: '◎' },
    { id: 'tasks',     label: '战果任务', icon: '☰' },
    { id: 'analysis',  label: '数据分析', icon: '▤' },
    { id: 'archive',   label: '历史归档', icon: '▣' },
    { id: 'data',      label: '数据管理', icon: '⇅' },
    { id: 'settings',  label: '设置',     icon: '⚙' }
  ];

  function renderNav(container, activeId, onNavigate) {
    KC.dom.clear(container);
    NAV_ITEMS.forEach(function (item) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'nav-item' + (item.id === activeId ? ' active' : '');
      btn.dataset.page = item.id;
      btn.innerHTML =
        '<span class="nav-icon" aria-hidden="true">' + item.icon + '</span>' +
        '<span class="nav-label">' + KC.utils.escapeHtml(item.label) + '</span>';
      btn.addEventListener('click', function () { onNavigate(item.id); });
      container.appendChild(btn);
    });
  }

  KC.nav = { NAV_ITEMS: NAV_ITEMS, renderNav: renderNav };
})(window.KC = window.KC || {});
