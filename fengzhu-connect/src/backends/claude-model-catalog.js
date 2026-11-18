'use strict';

// A session's model is evidence that Desktop used it, not a guarantee that it
// is still in the current account's full model menu. Only recent, unarchived
// sessions contribute; neither session identifiers nor paths leave this module.
const RECENT_DESKTOP_MODEL_MS = 30 * 86_400_000;
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const MODEL_ID = /^claude-([a-z][a-z0-9]*)-(\d+)(?:-(\d+))?(?:\[(\d+[mk])\])?$/i;

function desktopModelName(value) {
  const match = MODEL_ID.exec(String(value || ''));
  if (!match) return '';
  const name = match[1][0].toUpperCase() + match[1].slice(1).toLowerCase();
  return `${name} ${match[2]}${match[3] ? `.${match[3]}` : ''}${match[4] ? ` (${match[4].toUpperCase()})` : ''}`;
}

function observedDesktopModels(sessions, now = Date.now()) {
  const found = new Map();
  for (const session of sessions || []) {
    const value = String(session?.model || '');
    const name = desktopModelName(value);
    const updated = Number(session?.updatedAt) || 0;
    if (!name || session.archived || !updated || now - updated > RECENT_DESKTOP_MODEL_MS || updated > now + 86_400_000) continue;
    const key = value.toLowerCase();
    const existing = found.get(key) || { value, label: `${name} · 桌面会话`, efforts: [], source: 'desktop-session', lastSeenAt: updated };
    existing.lastSeenAt = Math.max(existing.lastSeenAt, updated);
    const effort = String(session.effort || '').toLowerCase();
    if (EFFORTS.has(effort) && !existing.efforts.includes(effort)) existing.efforts.push(effort);
    found.set(key, existing);
  }
  return [...found.values()].sort((a, b) => a.value.localeCompare(b.value));
}

function mergeObservedDesktopModels(previous, fresh, complete, now = Date.now()) {
  if (complete) return fresh;
  // A malformed or concurrently written unrelated session must not hide a
  // valid new model, nor make an older observation live beyond its 30-day TTL.
  const retained = (previous || []).filter(model => model.lastSeenAt > 0 && now - model.lastSeenAt <= RECENT_DESKTOP_MODEL_MS);
  const byId = new Map(retained.map(model => [model.value.toLowerCase(), model]));
  for (const model of fresh) byId.set(model.value.toLowerCase(), model);
  return [...byId.values()].sort((a, b) => a.value.localeCompare(b.value));
}

function comparableModelLabel(value) {
  return String(value || '').split(' · ')[0].replace(/\s*\(\d+[mk]\)\s*/ig, '').replace(/\s+/g, '').toLowerCase();
}

function mergeClaudeModels(probed, observed) {
  const base = (Array.isArray(probed) ? probed : []).map(({ value, label, description, efforts }) => ({
    value, label, description, efforts: Array.isArray(efforts) ? efforts : [], source: 'claude-code',
  }));
  const ids = new Set(base.map(model => String(model.value || '').toLowerCase()));
  const labels = new Set(base.filter(model => model.value !== 'default').map(model => comparableModelLabel(model.label)));
  for (const model of observed || []) {
    const id = String(model.value || '').toLowerCase(), label = comparableModelLabel(model.label);
    if (!id || ids.has(id) || labels.has(label)) continue;
    base.push({ value: model.value, label: model.label, efforts: model.efforts, source: 'desktop-session' }); ids.add(id); labels.add(label);
  }
  return base;
}

module.exports = { observedDesktopModels, mergeObservedDesktopModels, mergeClaudeModels, desktopModelName, RECENT_DESKTOP_MODEL_MS };
