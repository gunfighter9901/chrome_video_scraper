import {IndexedDBManager} from './network/IndexedDBManager.mjs';
import {EnvUtils} from './utils/EnvUtils.mjs';
import {opfsAvailable, createWritable, removeFile} from '../core/opfs.mjs';

const BrowserCanAutoOffloadBlobs = EnvUtils.isChrome();
const HasOpfs = opfsAvailable();
const UseCache = !HasOpfs && !BrowserCanAutoOffloadBlobs && window.caches;
const UseIndexedDB = !HasOpfs && !BrowserCanAutoOffloadBlobs && !UseCache && IndexedDBManager.isSupported();

/**
 * Blob store used by the transmuxer to hold per-fragment data.
 *
 * Preference order:
 *   1. OPFS (disk-backed, low memory) — used on Chromium so large downloads never live in the heap.
 *   2. Cache API (orphaned cache) — non-Chromium with support.
 *   3. IndexedDB — other supporting browsers.
 *   4. In-memory Map — last resort.
 */
export class FSBlob {
  constructor() {
    this.blobStore = new Map();
    this.blobStorePromises = new Map();
    this.opfsNames = new Map();
    this.prefix = `b${Math.random().toString(36).slice(2, 8)}-`;

    if (HasOpfs) {
      this.useOpfs = true;
    } else if (UseCache) {
      this.cache = true;
      this.setupPromise = this.setupOrphanedCache();
    } else if (UseIndexedDB) {
      this.indexedDBManager = new IndexedDBManager();
      this.setupPromise = this.indexedDBManager.setup();
    }

    this.blobIndex = 0;
  }

  async setupOrphanedCache() {
    const cacheName = 'blob-cache-' + Date.now() + '-' + Math.random();
    const cache = await window.caches.open(cacheName);
    // Orphan it!
    await window.caches.delete(cacheName);
    // Store the cache reference for later use
    this.cache = cache;
  }

  async saveBlobInIndexedDBAsync(identifier, blob) {
    try {
      await this.setupPromise;
    } catch (e) {
      // IndexedDB is not supported
      console.warn('IndexedDB is not supported, falling back to memory storage');
      this.indexedDBManager = null;
      this.setupPromise = false;
      this.blobStorePromises.clear();
      return false;
    }
    // Store file
    await this.indexedDBManager.setFile(identifier, blob);
    // Get file
    const file = await this.indexedDBManager.getFile(identifier);

    if (EnvUtils.isFirefox()) {
      // Delete file to orphan it
      await this.indexedDBManager.deleteFile(identifier);
    }

    this.blobStore.set(identifier, file);
    return true;
  }

  async saveBlobUsingCache(identifier, blob) {
    try {
      await this.setupPromise;
    } catch (e) {
      console.warn('Cache API is not supported, falling back to memory storage');
      this.cache = null;
      this.setupPromise = false;
      this.blobStorePromises.clear();
      return false;
    }

    const response = new Response(blob);
    const identifierURL = this.getIdentifierURL(identifier);

    await this.cache.put(identifierURL, response);

    const match = await this.cache.match(identifierURL);

    const blobResponse = await match?.blob();

    this.blobStore.set(identifier, blobResponse);
  }

  async saveBlobOpfsAsync(identifier, blob) {
    const fileName = `${this.prefix}${identifier}`;
    const writer = await createWritable(fileName);
    try {
      await writer.write(blob);
      await writer.close();
      const file = await writer.getFile();
      this.opfsNames.set(identifier, fileName);
      this.blobStore.set(identifier, file);
      return file;
    } catch (e) {
      console.warn('OPFS blob write failed, falling back to memory storage', e);
      this.useOpfs = false;
      this.blobStore.set(identifier, blob);
      return blob;
    }
  }

  getIdentifierURL(identifier) {
    return 'https://faststream.online/blob-cache?identifier=' + encodeURIComponent(identifier);
  }

  nextIdentifier() {
    return `blob${this.blobIndex++}`;
  }

  async saveBlobAsync(blob, identifier) {
    if (!identifier) {
      identifier = this.nextIdentifier();
    }
    let promise;
    if (this.useOpfs) {
      promise = this.saveBlobOpfsAsync(identifier, blob);
    } else if (this.cache) {
      promise = this.saveBlobUsingCache(identifier, blob);
    } else if (this.indexedDBManager) {
      promise = this.saveBlobInIndexedDBAsync(identifier, blob);
    } else {
      this.blobStore.set(identifier, blob);
      promise = Promise.resolve(blob);
    }
    this.blobStorePromises.set(identifier, promise);

    await promise;

    return identifier;
  }

  saveBlob(blob) {
    const identifier = this.nextIdentifier();
    // Intentionally not awaited: callers receive the identifier synchronously.
    this.saveBlobAsync(blob, identifier).catch(() => {});
    return identifier;
  }

  createBlob(data) {
    const blob = new Blob([data], {type: 'application/octet-stream'});
    return this.saveBlob(blob);
  }

  async deleteBlob(identifier) {
    this.blobStore.delete(identifier);

    if (this.blobStorePromises.has(identifier)) {
      try { await this.blobStorePromises.get(identifier); } catch {}
    }

    this.blobStore.delete(identifier);
    this.blobStorePromises.delete(identifier);
    if (this.useOpfs) {
      const fileName = this.opfsNames.get(identifier);
      this.opfsNames.delete(identifier);
      if (fileName) await removeFile(fileName);
    } else if (this.cache) {
      const identifierURL = this.getIdentifierURL(identifier);
      await this.cache.delete(identifierURL);
    } else if (this.indexedDBManager) {
      await this.indexedDBManager.deleteFile(identifier);
    }

    return true;
  }

  getBlob(identifier) {
    // May return a Blob/File or a Promise (OPFS/cache/IndexedDB writes are async).
    return this.blobStore.get(identifier) || this.blobStorePromises.get(identifier);
  }

  async clear() {
    this.blobStore.clear();
    this.blobStorePromises.clear();
    this.opfsNames.clear();
    if (this.useOpfs) {
      // Files are cleaned up wholesale when the offscreen document starts.
    } else if (this.cache) {
      this.cache = true;
      this.setupPromise = this.setupOrphanedCache();
      await this.setupPromise;
    } else if (this.indexedDBManager) {
      await this.indexedDBManager.clearStorage();
    }
  }

  close() {
    return this.indexedDBManager?.close();
  }
}
