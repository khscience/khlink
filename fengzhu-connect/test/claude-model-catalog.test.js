'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { observedDesktopModels, mergeObservedDesktopModels, mergeClaudeModels, RECENT_DESKTOP_MODEL_MS } = require('../src/backends/claude-model-catalog');

test('recent desktop models augment the independently probed catalogue without guessing entitlements', () => {
  const now = 1_900_000_000_000;
  const desktop = observedDesktopModels([
    { model: 'claude-fable-5-2', effort: 'medium', updatedAt: now - 10_000 },
    { model: 'claude-fable-5-2', effort: 'high', updatedAt: now - 20_000 },
    { model: 'claude-opus-5-5', effort: 'medium', updatedAt: now - 5_000 },
    { model: 'claude-ancient-1-0', updatedAt: now - RECENT_DESKTOP_MODEL_MS - 1 },
    { model: 'claude-archived-1-0', updatedAt: now, archived: true },
    { model: 'claude-evil-5-2\n/model opus', updatedAt: now },
  ], now);
  const list = mergeClaudeModels([
    { value: 'default', label: '默认 · Opus 5.5', efforts: ['medium'] },
    { value: 'opus', label: 'Opus 5.5', efforts: ['medium'] },
    { value: 'claude-fable-5-1[1m]', label: 'Fable 5.1', efforts: ['high'] },
  ], desktop);
  assert.deepEqual(list.map(m => m.value), ['default', 'opus', 'claude-fable-5-1[1m]', 'claude-fable-5-2']);
  assert.deepEqual(list[3], { value: 'claude-fable-5-2', label: 'Fable 5.2 · 桌面会话', efforts: ['medium', 'high'], source: 'desktop-session' });
  assert.equal(JSON.stringify(list).includes('sessionId'), false);
});

test('unknown models are derived from observed ids, not hard-coded release names', () => {
  const now = 1_900_000_000_000;
  const models = observedDesktopModels([{ model: 'claude-example-9-3[1m]', effort: 'unrecognized', updatedAt: now }], now);
  assert.deepEqual(models, [{ value: 'claude-example-9-3[1m]', label: 'Example 9.3 (1M) · 桌面会话', efforts: [], source: 'desktop-session', lastSeenAt: now }]);
});

test('partial scans add valid observations while retaining only recent prior evidence', () => {
  const now = 1_900_000_000_000;
  const old = observedDesktopModels([{ model: 'claude-alpha-1-0', updatedAt: now - 1000 }], now);
  const fresh = observedDesktopModels([{ model: 'claude-beta-2-0', updatedAt: now }], now);
  assert.deepEqual(mergeObservedDesktopModels(old, fresh, false, now).map(m => m.value), ['claude-alpha-1-0', 'claude-beta-2-0']);
  assert.deepEqual(mergeObservedDesktopModels(old, fresh, true, now).map(m => m.value), ['claude-beta-2-0']);
  assert.deepEqual(mergeObservedDesktopModels(old, [], false, now + RECENT_DESKTOP_MODEL_MS).map(m => m.value), []);
});
