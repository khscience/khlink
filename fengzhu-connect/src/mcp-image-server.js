#!/usr/bin/env node
const readline = require('node:readline');
const { AttachmentStore } = require('./attachment-store');

const store = new AttachmentStore();
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value });
}

function error(id, message, code = -32603) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

input.on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === 'initialize') {
    result(message.id, {
      protocolVersion: message.params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'kh-link-image-bridge', version: '0.1.0' },
      instructions: 'Use read_image only when a khLink message provides an opaque attachment ID. The tool is read-only and returns the uploaded image without exposing its local path.',
    });
    return;
  }
  if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') return;
  if (message.method === 'ping') { result(message.id, {}); return; }
  if (message.method === 'tools/list') {
    result(message.id, { tools: [{
      name: 'read_image',
      description: 'Read one image uploaded from the khLink mobile app. Use the opaque attachment_id shown in the user message.',
      inputSchema: {
        type: 'object',
        properties: { attachment_id: { type: 'string', description: 'Opaque khLink attachment identifier' } },
        required: ['attachment_id'],
        additionalProperties: false,
      },
      annotations: {
        title: 'Read khLink image',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    }] });
    return;
  }
  if (message.method === 'tools/call') {
    if (message.params?.name !== 'read_image') { error(message.id, 'Unknown khLink MCP tool', -32602); return; }
    try {
      const image = store.readImage(message.params?.arguments?.attachment_id);
      result(message.id, {
        content: [
          { type: 'image', data: image.data.toString('base64'), mimeType: image.mimeType },
          { type: 'text', text: `khLink image: ${image.name}` },
        ],
        isError: false,
      });
    } catch (cause) {
      result(message.id, { content: [{ type: 'text', text: cause.message }], isError: true });
    }
    return;
  }
  if (message.id !== undefined) error(message.id, `Unsupported method: ${message.method}`, -32601);
});
