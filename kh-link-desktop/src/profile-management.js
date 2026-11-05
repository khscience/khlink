(function(root) {
  'use strict';
  const $ = id => document.getElementById(id);
  const messages = {
    claude_not_installed: '未检测到官方 Claude Desktop 商店版。请先安装官方 Claude，再继续登录；待登录目录会保留。',
    component_failed: '本地账号组件暂时无法执行，目录和登记均已保留，请检查后重试。',
    helper_timeout: '本地处理尚未结束，请稍后刷新。不会强制结束官方 Claude；中断后可继续添加。',
    onboarding_exit_required: '请保存工作并从托盘正常退出 Claude，再点击继续。不会强制退出，也不需要退出 Codex。',
    onboarding_pending: '请先完成待登录账号的添加，或点击“返回添加前”。',
    onboarding_no_code: '请在官方 Claude 登录并打开 Code 页，然后正常退出 Claude，再点击“完成添加”。',
    onboarding_ambiguous: '发现多个 Code 账号目录，无法确认本次登录，请在电脑检查。',
    onboarding_directory: '账号或共享目录不可用，尚未覆盖原目录，请检查本机目录。',
    onboarding_busy: '正在处理另一个账号，请稍后重试。',
    onboarding_missing: '待登录账号未登记或已移除。',
    onboarding_shared_conflict: '会话或置顶同步未完成，数据已保留，请检查后重试。',
    version_changed: 'Claude Desktop 已更新，请先核对新版本的数据兼容性。',
    launch_failed: '账号目录已保留，但官方 Claude 未能启动。请手动打开，或从待登录账号继续。',
    locked: '电脑已锁屏，请解锁后再继续。',
    registry_current: '当前 Claude 账号不能移除，请先切换到其他账号。',
    registry_busy: '正在切换或恢复账号，请稍后重试。',
    registry_writing: '正在修改账号列表，请稍后重试。',
    registry_missing: '该账号未登记或已移除。',
    registry_restore_missing: '该账号不在已移除列表中。',
    registry_directory: '账号数据目录不可用，请检查后再恢复。',
    registry_invalid: '账号登记暂时无法确认，尚未修改，请检查本机数据目录。',
    busy: '正在处理账号，请稍后重试。',
  };
  let pending = null, previousFocus = null;
  function close(confirmed = false) {
    $('profile-action-dialog').classList.add('hidden');
    const resolve = pending; pending = null;
    previousFocus?.focus?.(); previousFocus = null;
    resolve?.(confirmed);
  }
  function confirm(action, name, backend) {
    if (pending) return Promise.resolve(false);
    previousFocus = document.activeElement;
    const remove = action === 'remove';
    $('profile-action-title').textContent = remove ? '从 khLink 移除账号？' : '恢复这个账号？';
    $('profile-action-target').textContent = `${backend === 'claude' ? 'Claude' : 'Codex'} · ${name}`;
    $('profile-action-hint').textContent = remove
      ? '账号将从电脑和手机的管理列表中移除。账号数据、登录状态和对话会保留，已经打开的官方窗口继续运行。以后可在“已移除账号”中恢复。'
      : '将账号重新加入电脑和手机的管理列表。不会启动官方软件、登录账号或切换当前账号。';
    $('profile-action-confirm').textContent = remove ? '移除账号' : '恢复账号';
    $('profile-action-confirm').classList.toggle('remove-confirm', remove);
    $('profile-action-dialog').classList.remove('hidden');
    $('profile-action-cancel').focus();
    return new Promise(resolve => { pending = resolve; });
  }
  function renderRemoved(backend, rows, restore, busy) {
    const section = $(backend + '-removed'), list = $(backend + '-removed-list');
    section.classList.toggle('hidden', !rows?.length);
    $(backend + '-removed-count').textContent = String(rows?.length || 0);
    list.replaceChildren();
    for (const row of rows || []) {
      const line = root.KhProfiles.element('div', 'removed-account');
      const name = root.KhProfiles.element('span', 'removed-account-name', row.name); name.title = row.name;
      const button = root.KhProfiles.element('button', 'profile-restore', '恢复');
      button.type = 'button'; button.disabled = !!busy;
      button.setAttribute('aria-label', `恢复 ${row.name} 到账号列表`);
      button.addEventListener('click', () => restore(row));
      line.append(name, button); list.append(line);
    }
  }
  root.KhAccountManagement = { confirm, renderRemoved, isOpen: () => !!pending, errorText: error => messages[String(error)] || String(error) };
  document.addEventListener('DOMContentLoaded', () => {
    $('profile-action-cancel').addEventListener('click', () => close(false));
    $('profile-action-close').addEventListener('click', () => close(false));
    $('profile-action-confirm').addEventListener('click', () => close(true));
    document.addEventListener('keydown', event => {
      if (!pending) return;
      if (event.key === 'Escape') { event.preventDefault?.(); close(false); }
      if (event.key === 'Tab') {
        const controls = [$('profile-action-close'), $('profile-action-cancel'), $('profile-action-confirm')];
        const index = controls.indexOf(document.activeElement);
        const next = event.shiftKey ? (index + controls.length - 1) % controls.length : (index + 1) % controls.length;
        event.preventDefault?.(); controls[next].focus();
      }
    });
  });
})(typeof window === 'undefined' ? globalThis : window);
