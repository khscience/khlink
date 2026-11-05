// Child-process errors include command lines, temp paths and sometimes prompt
// excerpts. Only stable adapter codes may leave this boundary for phone/logs.
function parseDesktopResult(error, stdout) {
  let result;
  try { result = JSON.parse(String(stdout || '').trim().split(/\r?\n/).pop()); } catch { /* no structured result */ }
  if (result && typeof result.ok === 'boolean' &&
      (result.reason == null || /^[a-z][a-z0-9_]*(?::[^\r\n]{0,300})?$/.test(result.reason))) {
    return result;
  }
  if (error?.code === 'ENOENT' || error?.code === 'EACCES' || error?.code === 'EPERM') {
    return { ok: false, reason: 'adapter_start_failed', delivery: 'not_sent' };
  }
  // A timeout or missing result can occur after Send was clicked. Never retry
  // or label it not_sent just because the PowerShell process failed.
  return { ok: false, reason: error?.killed ? 'adapter_timeout' : 'adapter_failed', delivery: 'uncertain' };
}

const ADAPTER_ERRORS = {
  adapter_missing: '电脑端 Claude 控制组件缺失，消息没有发出。请修复或更新 khLink 连接器后重试。',
  adapter_init_failed: '电脑端 Claude 控制组件初始化失败，消息尚未发送。请更新或修复 khLink 连接器后重试。',
  adapter_start_failed: '电脑端 Claude 控制组件未能启动，消息尚未发送。请检查 khLink 连接器。',
  adapter_timeout: '电脑端 Claude 操作超时，发送结果尚未确认，请先检查对话，勿重复发送。',
  adapter_failed: '电脑端 Claude 控制组件没有返回有效结果，请先检查对话，勿重复发送。',
};

module.exports = { parseDesktopResult, ADAPTER_ERRORS };
