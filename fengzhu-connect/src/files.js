const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function validateLocalPath(value) {
  const input = String(value || '');
  if (!/^[a-zA-Z]:[\\/]/.test(input) || input.startsWith('\\\\') || input.startsWith('\\\\.\\') || input.startsWith('\\\\?\\UNC')) {
    throw new Error('只能打开本机磁盘上的文件');
  }
  // Windows opens `auth.json::$DATA`, `auth.json.` and `auth.json ` as
  // `auth.json`, so such spellings would slip past the name checks below.
  if (input.slice(2).includes(':')) throw new Error('不支持这种写法的路径（文件数据流）');
  if (input.split(/[\\/]+/).some((part) => part !== '.' && part !== '..' && /[. ]$/.test(part))) {
    throw new Error('不支持以点或空格结尾的路径');
  }
  // Links and junctions (e.g. ~/.codex or Downloads moved to another drive)
  // are followed: assertReadable checks the file they really lead to.
  return path.resolve(input);
}

// Files the phone must never read: sign-in tokens, API keys, private keys and
// browser secrets, plus KH Link's own keys. Listing a folder still works;
// only reading such a file is refused.
const SECRET_DIRS = new Set(['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.secrets', '.cc-switch', '.password-store']);
const SECRET_FILES = new Set(['auth.json', '.credentials.json', 'credentials.json', 'credentials', '.git-credentials', '.netrc', '.npmrc', '.pypirc',
  'models.json', 'cookies', 'login data', 'web data', 'local state', '.vault-token']);
const SECRET_EXTENSIONS = new Set(['.pem', '.key', '.jks', '.keystore', '.p12', '.pfx', '.ppk', '.kdbx']);
// Whole areas, matched against the lower-case, /-joined path.
const SECRET_AREAS = [
  /\/appdata\/roaming\/(fengzhuagentbridge|claude)\//, // khLink's keys; the Claude app's sign-in data
  /\/appdata\/local\/packages\/claude_[^/]*\/localcache\/roaming\/claude\//, // the same, Store install
  /\/appdata\/(roaming|local)\/microsoft\/(credentials|protect|crypto|systemcertificates|vault)\//, // DPAPI keys, credential vault
  /\/\.config\/gh\//, // GitHub CLI tokens
  /\/\.codex\/config\.toml\/$/, // may hold MCP server keys
];

function isSecretPath(resolved) {
  const parts = resolved.toLowerCase().split(/[\\/]+/).filter(Boolean);
  const name = parts[parts.length - 1] || '';
  if (parts.slice(0, -1).some((part) => SECRET_DIRS.has(part))) return true;
  if (SECRET_FILES.has(name) || SECRET_EXTENSIONS.has(path.extname(name))) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)/.test(name) || /^\.env(\..+)?$/.test(name)) return true;
  // ~/.claude.json (and its backups) holds account and MCP settings; any *credential*.json.
  if (name.startsWith('.claude.json') || /credential.*\.json$/.test(name) || /^secrets?\.(json|ya?ml|toml)$/.test(name)) return true;
  const joined = `/${parts.join('/')}/`;
  if (/\/fengzhuagentbridge\/logs\//.test(joined)) return false;
  return SECRET_AREAS.some((area) => area.test(joined));
}

// Checked on the path as asked and on the file it really is: an 8.3 short
// name (CLAUDE~1\CREDEN~1.JSO) or another alias resolves to the long name.
function assertReadable(resolved) {
  if (isSecretPath(resolved)) throw new Error('这个文件可能含有密钥或登录凭据，不能从手机读取');
  let real;
  // Never fall back to the unresolved path: opening it can follow a junction
  // into a protected directory even when canonicalisation failed.
  try { real = fs.realpathSync.native(resolved); }
  catch { throw new Error('无法确认文件的真实路径，已拒绝读取'); }
  if (isSecretPath(real)) throw new Error('这个文件可能含有密钥或登录凭据，不能从手机读取');
  return real;
}

function drives() {
  try {
    const out = execFileSync('cmd.exe', ['/d', '/s', '/c', 'wmic logicaldisk get name,drivetype /format:csv'], { encoding: 'utf8', windowsHide: true, timeout: 5_000 });
    return out.split(/\r?\n/).map((line) => line.trim().split(',')).filter((p) => p.length >= 3 && ['2','3'].includes(p[p.length - 2]))
      .map((p) => ({ name: p[p.length - 1], path: `${p[p.length - 1]}\\`, directory: true, size: 0, modifiedAt: 0 }));
  } catch { return ['C','D','E','F','G','H','I'].map((d) => `${d}:\\`).filter(fs.existsSync)
    .map((p) => ({ name: p.slice(0,2), path: p, directory: true, size: 0, modifiedAt: 0 })); }
}

function list(input, cursor = 0, limit = 100) {
  if (!input) return { items: drives(), nextCursor: null };
  const target = validateLocalPath(input);
  const directory = fs.opendirSync(target); const page = []; let seen = 0; let entry;
  try {
    while ((entry = directory.readSync()) !== null && page.length < limit + 1) {
      if (seen++ < cursor) continue;
      page.push(entry);
    }
  } finally { directory.closeSync(); }
  const hasMore = page.length > limit; if (hasMore) page.pop();
  const items = page.map((entry) => {
    const fullPath = path.join(target, entry.name); let stat = null;
    try { stat = fs.lstatSync(fullPath); } catch {}
    return { name: entry.name, path: fullPath, directory: entry.isDirectory(), link: entry.isSymbolicLink(), size: stat?.size || 0, modifiedAt: stat?.mtimeMs || 0 };
  });
  return { path: target, items, nextCursor: hasMore ? cursor + items.length : null };
}

function inbox(threadId) {
  const safe = String(threadId || 'unbound').replace(/[^a-zA-Z0-9._-]/g, '_');
  const dir = path.join(os.homedir(), 'FengzhuAgentBridgeUploads', safe); fs.mkdirSync(dir, { recursive: true }); return dir;
}

module.exports = { validateLocalPath, assertReadable, isSecretPath, list, inbox };
