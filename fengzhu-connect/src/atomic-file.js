const fs = require('node:fs');

// Writes a whole file through a temporary one and a rename. Windows refuses
// the rename (EPERM/EBUSY/EACCES) while another process, a reader or the
// antivirus, has the target open: retry briefly, then write it in place.
function writeFileAtomic(target, text, options = {}) {
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, options);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { fs.renameSync(temporary, target); return; }
    catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) { try { fs.rmSync(temporary, { force: true }); } catch {} throw error; }
      const until = Date.now() + 60 * (attempt + 1); while (Date.now() < until) { /* short synchronous wait */ }
    }
  }
  try { fs.writeFileSync(target, text, options); } finally { try { fs.rmSync(temporary, { force: true }); } catch {} }
}

module.exports = { writeFileAtomic };
