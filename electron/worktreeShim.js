// electron/worktreeShim.js
//
// CommonJS shim so the Electron main process can load the ESM
// `src/agent/worktree.js` module without going through Vite. The shim
// re-exports the public surface the IPC handlers need.

const path = require('path');
const url = require('url');

// Use createRequire to load the ESM file from a CJS context. Node ≥ 22
// supports this via dynamic import().
let mod = null;
async function load() {
  if (mod) return mod;
  mod = await import(url.pathToFileURL(path.join(__dirname, '..', 'src', 'agent', 'worktree.js')).href);
  return mod;
}

// The IPC handlers are async; we expose async wrappers. The renderer's
// IPC surface is async, so this is a clean fit.
module.exports = {
  async openBackgroundTask(args) {
    const m = await load();
    return m.openBackgroundTask(args);
  },
  async finalizeTask(args) {
    const m = await load();
    return m.finalizeTask(args);
  },
  async listTasks(projectRoot) {
    const m = await load();
    return m.listTasks(projectRoot);
  },
  async pruneStaleEntries(projectRoot) {
    const m = await load();
    return m.pruneStaleEntries(projectRoot);
  },
};
