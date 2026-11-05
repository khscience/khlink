const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// Install the bundled helper as an application runtime, not an executable in
// the source checkout. A Windows development sandbox can label the checkout
// Low Integrity: an exe launched there also runs Low and UIA only returns an
// empty MSAA window for the normal-integrity Desktop. Do not change workspace
// ACLs, request elevation, or weaken Windows UI isolation.
function installDesktopAdapter(source, runtimeRoot = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'khLink', 'runtime',
)) {
  const bytes = fs.readFileSync(source);
  const digest = value => crypto.createHash('sha256').update(value).digest('hex');
  const hash = digest(bytes);
  const directory = path.join(runtimeRoot, 'desktop-adapter', hash);
  const destination = path.join(directory, 'khlink-desktop-adapter.exe');
  fs.mkdirSync(directory, { recursive: true });
  if (fs.existsSync(destination)) {
    if (digest(fs.readFileSync(destination)) !== hash) throw new Error('桌面组件校验失败，请重新安装 khLink');
    return destination;
  }
  const temporary = path.join(directory, `${process.pid}-${crypto.randomUUID()}.tmp`);
  try {
    // Write a new installed file; copying Windows security descriptors from
    // the development tree would recreate the same integrity-level problem.
    fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o700 });
    if (digest(fs.readFileSync(temporary)) !== hash) throw new Error('桌面组件安装校验失败');
    try { fs.renameSync(temporary, destination); }
    catch (error) {
      // Another connector may have installed this exact version concurrently.
      if (!fs.existsSync(destination) || digest(fs.readFileSync(destination)) !== hash) throw error;
    }
    return destination;
  } finally { fs.rmSync(temporary, { force: true }); }
}

module.exports = { installDesktopAdapter };
