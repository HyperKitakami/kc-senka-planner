/* ==========================================================================
   main.js — 程序入口
   启动顺序：初始化数据层 → 启动路由 → 渲染导航
   ========================================================================== */
(function (KC) {
  'use strict';

  const SAVE_LABEL = {
    idle:   '就绪',
    saving: '保存中…',
    saved:  '已保存',
    error:  '保存失败'
  };

  function renderSaveIndicator(status) {
    const el = document.getElementById('save-indicator');
    if (!el) return;
    const state = (status && status.status) || 'idle';
    el.textContent = SAVE_LABEL[state] || SAVE_LABEL.idle;
    el.className = 'save-indicator is-' + state;
    if (state === 'error' && status.message) {
      el.title = status.message;
    } else {
      el.title = status && status.at ? '最后保存：' + new Date(status.at).toLocaleTimeString('zh-CN') : '';
    }
  }

  function showFatal(message) {
    const main = document.getElementById('main');
    if (!main) return;
    main.innerHTML =
      '<div class="page-head"><h1>初始化失败</h1></div>' +
      '<div class="panel"><p>' + KC.utils.escapeHtml(message) + '</p>' +
      '<p class="form-hint">数据默认保存在本机浏览器中，请确认未处于隐私/无痕模式，并允许本站使用本地存储。</p></div>';
  }

  async function boot() {
    const navEl = document.getElementById('nav');

    KC.store.subscribe(function (type, payload) {
      if (type === 'save-status') renderSaveIndicator(payload);
    });

    try {
      await KC.store.init();
    } catch (err) {
      console.error('[main] 初始化失败', err);
      showFatal(err.message);
      return;
    }

    renderSaveIndicator(KC.store.getSaveStatus());

    // 应用外观主题（读取 Settings.theme，并订阅后续变更）
    KC.theme.init();

    KC.router.start(function (pageId) {
      KC.nav.renderNav(navEl, pageId, function (id) { KC.router.navigate(id); });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window.KC = window.KC || {});
