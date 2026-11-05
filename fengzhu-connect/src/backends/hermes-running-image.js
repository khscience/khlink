'use strict';

// /queue and /steer are text-only Hermes commands. Preserve image blocks by
// submitting the original ACP prompt to the gateway's durable queue instead.
async function sendRunningImage(acp, sessionId, blocks, { action, mode } = {}) {
  if (action === 'turn.steer' || mode === 'steer') {
    throw Object.assign(new Error('Hermes 运行中暂不支持立即发送图片，请选择排队'), { delivery: 'not_sent' });
  }
  // ACP resolves after the queued turn ends, not on admission. Do not claim
  // that the gateway accepted it before there is a result.
  const result = await acp.prompt(sessionId, blocks);
  if (result?.stopReason === 'cancelled' || result?.stopReason === 'refusal') {
    throw new Error('Hermes 未确认图片消息，请检查对话后再重试');
  }
  return { accepted: true, queued: false, backend: 'hermes' };
}

module.exports = { sendRunningImage };
