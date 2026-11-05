'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, atomic } = require('./account-operations');
const { peekTranscriptState, transcriptPath } = require('./backends/claude-desktop');
const { readBackgroundTasks } = require('./backends/claude-background-tasks');
function scheduleCount(appRoot, accountDir) {
  let count = 0;
  for (const directory of [accountDir, accountDir.replace(/claude-code-sessions([\\/])/, 'local-agent-mode-sessions$1')]) {
    const file = path.join(directory, 'scheduled-tasks.json');
    if (!fs.existsSync(file)) continue;
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new Error('schedule_unknown');
    const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!Array.isArray(data.scheduledTasks)) throw new Error('schedule_unknown');
    // Schedule schemas differ across Desktop versions. Until their next-run
    // rules have been verified, enabled schedules block switching altogether.
    count += data.scheduledTasks.filter(t => t && t.enabled !== false && t.disabled !== true && t.paused !== true).length;
  }
  return count;
}
function activitySnapshot(connector, active, now = Date.now(), peek = peekTranscriptState) {
  const live = connector._claudeLive;
  const snapshot = { pid: process.pid, active, at: now,
    known: !!live && live.verified === true && !live.unattributed && now - live.at <= 15000,
    tasks_running: 0, approval_pending: 0, messages_queued: 0, settings_pending: 0, schedule_pending: 0 };
  const knownSessions = new Set();
  for (const [id, meta] of connector.claudeThreads || []) {
    if (meta.sessionId) knownSessions.add(meta.sessionId);
    const liveSession = live?.ids?.has(meta.sessionId) === true;
    const connectorRunning = connector.claude?.isRunning?.(id) === true;
    // Windows may leave mtime unchanged while Desktop keeps the transcript
    // open. For shutdown safety, always read the current tail of each live
    // session, including archived sessions; cached UI completion is not proof.
    let terminal = false, background = false;
    if (liveSession) {
      try {
        const file = meta.transcriptFile || transcriptPath(meta.workdir, meta.sessionId, connector.claudeDesktop?.projectsRoot);
        const current = file && peek(file);
        if (!current?.lastEvent) snapshot.known = false;
        terminal = current?.lastEvent === 'end_turn';
        if (file) {
          const tasks = readBackgroundTasks(file);
          if (!tasks.known) snapshot.known = false;
          background = tasks.count > 0;
        }
      } catch { snapshot.known = false; }
    }
    const running = connectorRunning || (liveSession && (!terminal || background));
    if (running) snapshot.tasks_running++;
    // Old profiles/deleted Desktop sessions stay in the history index. Their
    // cached queue/prompt is not a pending operation in the current Desktop.
    const current = connector._claudeActiveDesktopIds?.has(id) ?? true;
    if (!current && !liveSession && !connectorRunning) continue;
    // A turn that ended on a question ('blocked') holds nothing open.
    if (meta.waitingCategory === 'prompt' || meta.waitingDetail) snapshot.approval_pending++;
    if (meta.pendingDesktopSettings && Object.keys(meta.pendingDesktopSettings).length) snapshot.settings_pending++;
    snapshot.messages_queued += (meta.desktopQueue || []).filter(r => !r.internal && !['completed', 'cancelled', 'sent', 'failed', 'stopped', 'killed', 'error'].includes(r.state || r.status)).length;
  }
  for (const id of live?.ids || []) if (!knownSessions.has(id)) snapshot.known = false;
  for (const queue of connector._claudeQueues?.values?.() || []) snapshot.messages_queued += queue.length;
  snapshot.approval_pending += connector.pendingClaudeWorkspaceTrust?.size || 0;
  return snapshot;
}
function publishActivity(connector, root = ROOT) {
  const profile = require('./backends/claude-profile-lock').registeredProfile(connector.claudeDesktop?.root || '');
  if (!profile) return null;
  const snapshot = activitySnapshot(connector, profile.alias);
  try { snapshot.schedule_pending = scheduleCount(connector.claudeDesktop.root, profile.accountDir); } catch { snapshot.known = false; }
  atomic(path.join(root, 'activity.json'), snapshot); return snapshot;
}
module.exports = { scheduleCount, activitySnapshot, publishActivity };
