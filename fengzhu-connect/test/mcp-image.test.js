const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { AttachmentStore, validateUploadPath } = require('../src/attachment-store');
const { configureToolPolicy } = require('../src/mcp-install');

function fixture() {
  const threadId = `mcp-test-${process.pid}-${Date.now()}`;
  const directory = path.join(os.tmpdir(), 'FengzhuAgentBridge', 'uploads', threadId);
  fs.mkdirSync(directory, { recursive: true });
  const image = path.join(directory, 'phone.png');
  fs.writeFileSync(image, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('kh-link-test'),
  ]));
  const registry = path.join(os.tmpdir(), `kh-link-mcp-${process.pid}-${Date.now()}.dat`);
  const store = new AttachmentStore(registry);
  const entry = store.register({ id: 'image-1', threadId, name: 'phone.png', path: image, mimeType: 'image/png' });
  return { threadId, directory, image, registry, store, entry };
}

test('attachment registry is DPAPI protected and restricted to the KH Link upload root', () => {
  const item = fixture();
  try {
    assert.notEqual(fs.readFileSync(item.registry, 'utf8').includes(item.image), true);
    const image = item.store.readImage('image-1');
    assert.equal(image.mimeType, 'image/png');
    assert.equal(image.threadId, item.threadId);
    assert.throws(() => validateUploadPath(path.join(os.tmpdir(), 'outside.png')), /outside/i);
  } finally {
    fs.rmSync(item.directory, { recursive: true, force: true });
    fs.rmSync(item.registry, { force: true });
  }
});

test('MCP stdio server exposes the uploaded image as standard image content', () => {
  const item = fixture();
  try {
    const messages = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_image', arguments: { attachment_id: 'image-1' } } },
    ];
    const run = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'mcp-image-server.js')], {
      input: `${messages.map(JSON.stringify).join('\n')}\n`, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, KH_LINK_ATTACHMENT_STORE: item.registry },
    });
    assert.equal(run.status, 0, run.stderr);
    const responses = run.stdout.trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(responses[0].result.serverInfo.name, 'kh-link-image-bridge');
    assert.match(responses[0].result.instructions, /read_image/);
    assert.equal(responses[1].result.tools[0].name, 'read_image');
    assert.equal(responses[1].result.tools[0].annotations.readOnlyHint, true);
    const content = responses[2].result.content;
    assert.equal(content[0].type, 'image');
    assert.equal(content.find((part) => part.type === 'image').mimeType, 'image/png');
    assert.equal(responses[2].result.isError, false);
  } finally {
    fs.rmSync(item.directory, { recursive: true, force: true });
    fs.rmSync(item.registry, { force: true });
  }
});

test('MCP installer applies a narrow automatic approval policy without duplicating settings', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-link-mcp-config-'));
  const config = path.join(directory, 'config.toml');
  fs.writeFileSync(config, [
    'model = "test"',
    '',
    '[mcp_servers.kh_link]',
    'command = "node"',
    'args = ["server.js"]',
    '',
    '[desktop]',
    'followUpQueueMode = "queue"',
    '',
  ].join('\n'));
  try {
    configureToolPolicy(config);
    configureToolPolicy(config);
    const value = fs.readFileSync(config, 'utf8');
    assert.equal((value.match(/enabled_tools = \["read_image"\]/g) || []).length, 1);
    assert.equal((value.match(/default_tools_approval_mode = "approve"/g) || []).length, 1);
    assert.equal((value.match(/\[mcp_servers\.kh_link\.tools\.read_image\]/g) || []).length, 1);
    assert.equal((value.match(/approval_mode = "approve"/g) || []).length, 2);
    assert.match(value, /\[desktop\]\nfollowUpQueueMode = "queue"/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
