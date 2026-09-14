/* ==========================================================================
   ui/feedback.js — Toast 提示与确认弹窗
   依据 docs/02_ui.md §七：删除、覆盖等重要操作应提供确认提示。
   ========================================================================== */
(function (KC) {
  'use strict';

  const U = KC.utils;
  let toastTimer = null;

  function toast(message, type) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = message;
    el.className = 'toast show' + (type ? ' toast-' + type : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = 'toast'; }, 2400);
  }

  /**
   * 确认弹窗。
   * @param {{title?, message?, okText?, cancelText?, danger?, requireText?}} options
   *   requireText：要求用户原样输入指定文字后才能确认（用于清空等高风险操作）
   * @returns {Promise<boolean>}
   */
  function confirmDialog(options) {
    options = options || {};
    return new Promise(function (resolve) {
      const root = document.getElementById('modal-root');
      const needText = options.requireText ? String(options.requireText) : '';

      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      backdrop.innerHTML =
        '<div class="modal" role="dialog" aria-modal="true">' +
          '<h3 class="modal-title">' + U.escapeHtml(options.title || '请确认') + '</h3>' +
          '<p class="modal-text">' + U.escapeHtml(options.message || '') + '</p>' +
          (needText
            ? '<div class="modal-field">' +
                '<label class="field-label" for="modal-confirm-input">' +
                  '请输入「' + U.escapeHtml(needText) + '」以确认</label>' +
                '<input type="text" id="modal-confirm-input" autocomplete="off" spellcheck="false">' +
              '</div>'
            : '') +
          '<div class="modal-actions">' +
            '<button type="button" class="btn btn-ghost" data-act="cancel">' +
              U.escapeHtml(options.cancelText || '取消') + '</button>' +
            '<button type="button" class="btn ' + (options.danger ? 'btn-danger' : 'btn-primary') +
              '" data-act="ok"' + (needText ? ' disabled' : '') + '>' +
              U.escapeHtml(options.okText || '确定') + '</button>' +
          '</div>' +
        '</div>';

      const okBtn = backdrop.querySelector('[data-act="ok"]');
      const input = backdrop.querySelector('#modal-confirm-input');

      let done = false;
      function close(result) {
        if (done) return;
        done = true;
        document.removeEventListener('keydown', onKey);
        backdrop.remove();
        resolve(result);
      }
      function onKey(e) {
        if (e.key === 'Escape') { close(false); return; }
        if (e.key === 'Enter') {
          if (needText && (!input || input.value.trim() !== needText)) return;
          close(true);
        }
      }

      if (input) {
        input.addEventListener('input', function () {
          okBtn.disabled = input.value.trim() !== needText;
        });
      }

      backdrop.addEventListener('click', function (e) {
        if (e.target === backdrop) { close(false); return; }
        const btn = KC.dom.closestFrom(e.target, '[data-act]');
        if (!btn) return;
        if (btn.dataset.act === 'cancel') close(false);
        if (btn.dataset.act === 'ok') close(true);
      });
      document.addEventListener('keydown', onKey);

      root.appendChild(backdrop);
      if (input) input.focus();
      else if (okBtn) okBtn.focus();
    });
  }

  /**
   * 若目标月份已归档，按 docs/06_data_strategy.md §4.2 要求用户显式确认，
   * 避免补录 / 修改无声地影响已归档月份的结果。
   * 战果记录 / 战果任务 / 战果规划三页共用。
   * @param {string} month 'YYYY-MM'
   * @param {string} action 动作描述，如「修改该月任务完成状态」
   * @returns {Promise<boolean>} 未归档或用户确认时返回 true
   */
  function confirmArchivedMonth(month, action) {
    const archive = KC.store.getArchive(month);
    if (!archive) return Promise.resolve(true);
    return confirmDialog({
      title: '该月份已归档',
      message: U.monthLabel(month) + ' 已有归档记录（最终战果 ' +
        U.formatNumber(archive.finalSenka) + '）。\n' +
        action + '会改变该月的实时计算结果，但不会自动更新归档快照。确定继续吗？',
      okText: '继续',
      danger: true
    });
  }

  KC.toast = toast;
  KC.confirmDialog = confirmDialog;
  KC.confirmArchivedMonth = confirmArchivedMonth;
})(window.KC = window.KC || {});
