'use strict';
const fs = require('node:fs');
const TOOL = 'mcp__ccd_turn__wrap_up';
// A side session Claude proposes on its own: the desktop shows it as a
// "New session" card with Do it here / Start (Claude Desktop 3.x).
const START_SESSION_TOOL = 'mcp__ccd_session__start_session';
const clean = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
// The desktop's own buttons that run an app action instead of replying.
const APP_ACTIONS = { commit: '提交', create_pr: '创建 PR', merge: '合并', fix_ci: '修复 CI', address_comments: '处理评审意见',
  resolve_conflicts: '解决冲突', verify: '验证', archive: '归档', new_session: '新开会话' };

function wrapUpItem(block, base) {
  if (block?.name === START_SESSION_TOOL) return sessionCardItem(block, base);
  if (block?.name !== TOOL) return null;
  const input = block.input || {};
  const recap = clean(input.recap, 16000);
  const ask = clean(input.ask, 4000);
  const actions = (Array.isArray(input.actions) ? input.actions : []).slice(0, 8).map(action => {
    const label = clean(action?.label, 100) || APP_ACTIONS[action?.action] || '';
    // A button's label is the reply the desktop sends; an explicit message
    // (older desktops) wins. Never change a reply's meaning by truncating it.
    const message = typeof action?.message !== 'string' ? label
      : action.message.length <= 16000 && action.message.trim() ? action.message : '';
    return { label, message };
  }).filter(action => action.label && action.message);
  if (!recap && !ask && !actions.length) return null;
  return { ...base, type: 'claudeWrapUp', tool: TOOL, status: 'inProgress',
    text: [recap, ask, ...actions.map(action => `• ${action.label}`), '也可以直接在输入框回复。'].filter(Boolean).join('\n\n'),
    nextStep: { recap, ask, actions, blocked: input.blocked === true } };
}

// Only a proposal Claude makes itself becomes a card; an offer the desktop is
// waiting on is a prompt, and a start or a proposal being started is not.
function sessionCardItem(block, base) {
  const input = block.input || {};
  if (input.initiation !== 'own_initiative' || input.proposal_id) return null;
  const title = clean(input.title, 200);
  if (!title) return null;
  const brief = clean(input.prompt, 16000);
  const recap = brief.length > 600 ? `${brief.slice(0, 600)}…` : brief;
  const actions = [
    { label: '新开会话', message: `开始“${title}”这个新会话` },
    { label: '在这里做', message: `“${title}”就在这里做` },
  ];
  return { ...base, type: 'claudeWrapUp', tool: START_SESSION_TOOL, status: 'inProgress',
    text: [`建议新开会话：${title}`, recap].filter(Boolean).join('\n\n'),
    nextStep: { title: 'Claude 建议新开会话', recap, ask: title, actions, blocked: false } };
}

// Upgrade on opening a thread, with bounded memory and stable ids/order.
function needsWrapUpHistoryRebuild(file, oldSchema) {
  // Schema 7 shows files sent with SendUserFile; 8 the task list; 9 the
  // proposed-session cards and label-only next-step buttons.
  const markers = [...(oldSchema < 9 ? [TOOL, START_SESSION_TOOL] : [TOOL]), ...(oldSchema < 5 ? ['"type":"image"'] : []), ...(oldSchema < 7 ? ['"name":"SendUserFile"'] : []), ...(oldSchema < 8 ? ['"name":"mcp__ccd_turn__update_plan"'] : []),
    // 10: desktop events (side sessions, cross-session messages, scheduled
    // tasks) that earlier connectors showed as the user's messages.
    ...(oldSchema < 10 ? ['<side-sessions-event>', '<cross-session-message ', '<scheduled-task ', '<ci-monitor-event>'] : [])];
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024); let carry = '';
    for (;;) {
      const n = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!n) return false;
      const text = carry + buffer.toString('utf8', 0, n);
      if (markers.some(marker => text.includes(marker))) return true;
      carry = text.slice(-128);
    }
  } finally { fs.closeSync(fd); }
}
module.exports = { TOOL, START_SESSION_TOOL, wrapUpItem, needsWrapUpHistoryRebuild };
