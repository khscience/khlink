const { StringDecoder } = require('node:string_decoder');

const MAX_RPC_BYTES = 32 * 1024 * 1024;

// Inspect each chunk once. Concatenating/splitting the entire unfinished line
// on every stdout chunk made a large history reply quadratic, starving every
// other RPC and eventually throwing `Invalid string length`.
class JsonLineReader {
  constructor({ onLine, onOverflow = () => {}, maxBytes = MAX_RPC_BYTES }) {
    this.onLine = onLine; this.onOverflow = onOverflow; this.maxBytes = maxBytes;
    this.decoder = new StringDecoder('utf8');
    this.reset();
  }

  reset() { this.parts = []; this.bytes = 0; this.prefix = ''; this.discarding = false; }

  push(chunk) {
    const text = Buffer.isBuffer(chunk) ? this.decoder.write(chunk) : String(chunk);
    let start = 0;
    while (start < text.length) {
      const newline = text.indexOf('\n', start);
      const end = newline < 0 ? text.length : newline;
      const part = text.slice(start, end);
      if (!this.discarding) {
        if (this.prefix.length < 4096) this.prefix += part.slice(0, 4096 - this.prefix.length);
        this.bytes += Buffer.byteLength(part, 'utf8');
        if (this.bytes > this.maxBytes) {
          const info = { prefix: this.prefix, bytes: this.bytes, maxBytes: this.maxBytes };
          this.parts = []; this.prefix = ''; this.bytes = 0; this.discarding = true;
          this.onOverflow(info);
        } else if (part) this.parts.push(part);
      }
      if (newline < 0) return;
      const line = this.discarding ? null : this.parts.join('').replace(/\r$/, '');
      this.reset();
      if (line?.trim()) this.onLine(line);
      start = newline + 1;
    }
  }
}

// A reply ID normally precedes result. Read only scalar properties of the
// actual RPC object; a nested tool/user item called `id` is never a request ID.
function rpcIdFromPrefix(prefix, wrapped = false) {
  let depth = 0; let targetDepth = wrapped ? null : 1;
  for (let i = 0; i < prefix.length; i++) {
    const char = prefix[i];
    if (char === '{' || char === '[') { depth++; continue; }
    if (char === '}' || char === ']') { depth--; continue; }
    if (char !== '"') continue;
    let end = i + 1;
    for (; end < prefix.length; end++) {
      if (prefix[end] === '\\') { end++; continue; }
      if (prefix[end] === '"') break;
    }
    if (end >= prefix.length) break;
    let key; try { key = JSON.parse(prefix.slice(i, end + 1)); } catch { return undefined; }
    const rest = prefix.slice(end + 1);
    const colon = rest.match(/^\s*:\s*/);
    if (colon) {
      const valueAt = end + 1 + colon[0].length;
      if (wrapped && depth === 1 && key === 'message' && prefix[valueAt] === '{') targetDepth = 2;
      if (depth === targetDepth && key === 'id') {
        const literal = prefix.slice(valueAt).match(/^("(?:[^"\\]|\\.)*"|-?\d+)(?=\s*[,}])/);
        if (literal) { try { return JSON.parse(literal[1]); } catch { return undefined; } }
      }
    }
    i = end;
  }
  return undefined;
}

function oversizedRpcError(id, delivery = 'uncertain') {
  return { jsonrpc: '2.0', id, error: { code: -32097, message: 'Codex response exceeded the history page limit',
    data: { code: 'rpc_response_too_large', delivery } } };
}

function isReadOnlyRpc(method) { return /\/(?:read|list)$/.test(method) || method === 'initialize'; }

module.exports = { JsonLineReader, MAX_RPC_BYTES, rpcIdFromPrefix, oversizedRpcError, isReadOnlyRpc };
