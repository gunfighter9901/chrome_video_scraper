// core/opfs.mjs
// Origin Private File System helpers. Used by the offscreen document (and modules/FSBlob.mjs)
// to keep download payloads on disk instead of in the JS heap.
// All OPFS state lives in a single temp directory; nothing is persisted between sessions.

const DIR_NAME = 'uv-tmp';

function storage() {
  return (typeof navigator !== 'undefined' && navigator.storage) || null;
}

export function opfsAvailable() {
  try {
    return !!(storage() && typeof navigator.storage.getDirectory === 'function');
  } catch {
    return false;
  }
}

async function rootDir() {
  if (!opfsAvailable()) throw new Error('OPFS unavailable');
  return navigator.storage.getDirectory();
}

async function tempDir(create = true) {
  const root = await rootDir();
  return root.getDirectoryHandle(DIR_NAME, { create });
}

let counter = 0;
export function nextName(prefix = 'file') {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}

/**
 * Create a writable OPFS file.
 * @returns {Promise<{name:string, writable:FileSystemWritableFileStream, write:(d:any)=>Promise<void>,
 *   close:()=>Promise<void>, getFile:()=>Promise<File>, remove:()=>Promise<void>}>}
 */
export async function createWritable(name) {
  const dir = await tempDir(true);
  const fileName = name || nextName();
  const handle = await dir.getFileHandle(fileName, { create: true });
  const writable = await handle.createWritable();
  let closed = false;
  return {
    name: fileName,
    writable,
    async write(data) { await writable.write(data); },
    async close() {
      if (closed) return;
      closed = true;
      await writable.close();
    },
    async getFile() { return handle.getFile(); },
    async remove() {
      try { if (!closed) { closed = true; await writable.close(); } } catch {}
      try { await dir.removeEntry(fileName); } catch {}
    },
  };
}

export async function writeFileFromBlob(name, blob) {
  const w = await createWritable(name);
  try {
    await w.write(blob);
  } finally {
    await w.close();
  }
  return w;
}

export async function getFile(name) {
  const dir = await tempDir(false);
  const handle = await dir.getFileHandle(name);
  return handle.getFile();
}

export async function removeFile(name) {
  try {
    const dir = await tempDir(false);
    await dir.removeEntry(name);
  } catch {}
}

export async function cleanupAll() {
  try {
    const root = await rootDir();
    await root.removeEntry(DIR_NAME, { recursive: true });
  } catch {}
}

export async function usage() {
  try {
    if (storage() && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      return { usage: est.usage || 0, quota: est.quota || 0 };
    }
  } catch {}
  return { usage: 0, quota: 0 };
}

export const OPFS_DIR_NAME = DIR_NAME;
