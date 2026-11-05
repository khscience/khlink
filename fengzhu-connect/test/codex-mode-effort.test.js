const test = require('node:test');
const assert = require('node:assert/strict');
const { threadSettingsUpdateParams, modeSettings } = require('../src/connector');

test('a settings change keeps the chosen effort inside the collaboration mode', () => {
  const update = threadSettingsUpdateParams('t1', { model: 'gpt-6-astra', effort: 'high' },
    { model: 'gpt-6-astra', effort: 'high', collaborationMode: 'default' });
  assert.equal(update.effort, 'high');
  assert.deepEqual(update.collaborationMode, { mode: 'default', settings: { model: 'gpt-6-astra', reasoning_effort: 'high' } });
});

test('without a known effort the mode settings carry only the model', () => {
  const update = threadSettingsUpdateParams('t1', { model: 'gpt-6.1-sol' }, { collaborationMode: 'plan' });
  assert.deepEqual(update.collaborationMode, { mode: 'plan', settings: { model: 'gpt-6.1-sol' } });
});

test('new turns put the effort in the mode settings as well', () => {
  assert.deepEqual(modeSettings('gpt-6.1-sol', 'xhigh'), { model: 'gpt-6.1-sol', reasoning_effort: 'xhigh' });
  assert.deepEqual(modeSettings('gpt-6.1-sol', null), { model: 'gpt-6.1-sol' });
});

test('turning fast mode off sends the standard speed instead of nothing', () => {
  assert.equal(threadSettingsUpdateParams('t1', {}, { serviceTier: null }).serviceTier, 'default');
  assert.equal(threadSettingsUpdateParams('t1', {}, { serviceTier: 'fast' }).serviceTier, 'fast');
  assert.equal('serviceTier' in threadSettingsUpdateParams('t1', {}, { model: 'm' }), false);
});
