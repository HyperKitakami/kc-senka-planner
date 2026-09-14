/* ==========================================================================
   ui/theme.js — 外观主题
   依据 docs/02_ui.md §4.8、docs/03_data.md Settings（外观设置）。

   实现方式：只在 <html> 上切换 data-theme，具体配色全部由 css/style.css
   的 CSS 变量覆盖完成——所以图表颜色（运行时读 CSS 变量）也会自动跟随。
   ========================================================================== */
(function (KC) {
  'use strict';

  const THEMES = ['light', 'dark'];

  function normalize(theme) {
    return THEMES.indexOf(theme) >= 0 ? theme : 'light';
  }

  /** 应用主题；同时同步 color-scheme，让表单控件与滚动条跟随 */
  function apply(theme) {
    const value = normalize(theme);
    document.documentElement.setAttribute('data-theme', value);
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.setAttribute('content', value);
  }

  function current() {
    return normalize(KC.store.getSettings().theme);
  }

  /** 启动时应用一次，并订阅设置变化（设置页切换后立即生效） */
  function init() {
    apply(current());
    KC.store.subscribe(function (type) {
      if (type === 'change') apply(current());
    });
  }

  KC.theme = {
    THEMES: THEMES,
    normalize: normalize,
    apply: apply,
    current: current,
    init: init
  };
})(window.KC = window.KC || {});
