const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { findCodexBinary } = require('./codex-client');

function configureToolPolicy(configFile) {
  const source = fs.readFileSync(configFile, 'utf8');
  const lines = source.split(/\r?\n/);
  const section = '[mcp_servers.kh_link]';
  const start = lines.findIndex((line) => line.trim() === section);
  if (start < 0) throw new Error('Codex did not create the kh_link MCP configuration');
  let end = lines.findIndex((line, index) => index > start && /^\s*\[/.test(line));
  if (end < 0) end = lines.length;
  const filtered = lines.slice(start + 1, end).filter((line) => !/^\s*(enabled_tools|default_tools_approval_mode)\s*=/.test(line));
  lines.splice(start + 1, end - start - 1,
    'enabled_tools = ["read_image"]',
    'default_tools_approval_mode = "approve"',
    ...filtered,
  );

  const toolSection = '[mcp_servers.kh_link.tools.read_image]';
  const toolStart = lines.findIndex((line) => line.trim() === toolSection);
  if (toolStart < 0) {
    if (lines.at(-1)?.trim()) lines.push('');
    lines.push(toolSection, 'approval_mode = "approve"');
  } else {
    let toolEnd = lines.findIndex((line, index) => index > toolStart && /^\s*\[/.test(line));
    if (toolEnd < 0) toolEnd = lines.length;
    const toolLines = lines.slice(toolStart + 1, toolEnd).filter((line) => !/^\s*approval_mode\s*=/.test(line));
    lines.splice(toolStart + 1, toolEnd - toolStart - 1, 'approval_mode = "approve"', ...toolLines);
  }
  fs.writeFileSync(configFile, lines.join('\n'), 'utf8');
}

function installMcp(config = {}) {
  const codex = findCodexBinary(config.codexBin);
  const server = path.join(__dirname, 'mcp-image-server.js');
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const configFile = path.join(codexHome, 'config.toml');
  const backup = `${configFile}.kh-link-${Date.now()}.bak`;
  if (fs.existsSync(configFile)) fs.copyFileSync(configFile, backup);
  try {
    let exists = false;
    try {
      execFileSync(codex, ['mcp', 'get', 'kh_link'], { encoding: 'utf8', windowsHide: true, timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
      exists = true;
    } catch {}
    if (exists) execFileSync(codex, ['mcp', 'remove', 'kh_link'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    execFileSync(codex, ['mcp', 'add', 'kh_link', '--', process.execPath, server], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    configureToolPolicy(configFile);
    const detail = execFileSync(codex, ['mcp', 'get', 'kh_link'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    return { installed: true, name: 'kh_link', server, detail: detail.trim(), backup: fs.existsSync(backup) ? backup : null };
  } catch (error) {
    if (fs.existsSync(backup)) fs.copyFileSync(backup, configFile);
    throw new Error(`Cannot install khLink MCP: ${error.stderr?.toString().trim() || error.message}`);
  }
}

module.exports = { installMcp, configureToolPolicy };
