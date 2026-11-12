/**
 * NovaOS AI — IndexedDB key/value storage engine.
 * IndexedDB is the durable store; localStorage is only a small compatibility cache.
 */
export const NovaStorage = {
  dbName: 'NovaOS_IndexedDB_v4',
  storeName: 'kv_store',
  dbInstance: null,
  memoryCache: Object.create(null),
  lastWriteError: null,

  async init() {
    if (typeof window === 'undefined' || !window.indexedDB) return false;
    return new Promise((resolve) => {
      let request;
      try {
        request = window.indexedDB.open(this.dbName, 1);
      } catch {
        resolve(false);
        return;
      }
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(this.storeName)) db.createObjectStore(this.storeName);
      };
      request.onsuccess = async (event) => {
        this.dbInstance = event.target.result;
        this.dbInstance.onversionchange = () => {
          this.dbInstance?.close();
          this.dbInstance = null;
        };
        try {
          await this.hydrateAll();
          resolve(true);
        } catch {
          resolve(false);
        }
      };
      request.onerror = request.onblocked = () => resolve(false);
    });
  },

  async hydrateAll() {
    if (!this.dbInstance) return;
    return new Promise((resolve, reject) => {
      let transaction;
      try {
        transaction = this.dbInstance.transaction(this.storeName, 'readonly');
        const cursorRequest = transaction.objectStore(this.storeName).openCursor();
        cursorRequest.onsuccess = (event) => {
          const cursor = event.target.result;
          if (!cursor) return;
          this.memoryCache[cursor.key] = cursor.value;
          cursor.continue();
        };
        cursorRequest.onerror = () => reject(cursorRequest.error || new Error('Storage read failed'));
        transaction.oncomplete = () => resolve();
        transaction.onerror = transaction.onabort = () => reject(transaction.error || new Error('Storage transaction failed'));
      } catch (error) {
        reject(error);
      }
    });
  },

  get(key, defaultValue) {
    if (Object.prototype.hasOwnProperty.call(this.memoryCache, key)) return this.memoryCache[key];
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) {
        const parsed = JSON.parse(raw);
        this.memoryCache[key] = parsed;
        return parsed;
      }
    } catch { /* localStorage may be unavailable or full */ }
    return defaultValue;
  },

  async set(key, value) {
    let serialized;
    try {
      serialized = JSON.stringify(value);
    } catch {
      throw new TypeError('NovaStorage values must be JSON serializable.');
    }
    this.memoryCache[key] = value;
    try {
      if (serialized.length <= 180000) localStorage.setItem(key, serialized);
      else localStorage.removeItem(key);
    } catch { /* IndexedDB remains the durable fallback */ }
    if (!this.dbInstance) return false;

    return new Promise((resolve, reject) => {
      try {
        const transaction = this.dbInstance.transaction(this.storeName, 'readwrite');
        transaction.objectStore(this.storeName).put(value, key);
        transaction.oncomplete = () => resolve(true);
        transaction.onerror = transaction.onabort = () => {
          this.lastWriteError = transaction.error || new Error('IndexedDB write failed');
          reject(this.lastWriteError);
        };
      } catch (error) {
        this.lastWriteError = error;
        reject(error);
      }
    });
  },

  getUsageBytes() {
    try {
      return new Blob([JSON.stringify(this.memoryCache)]).size;
    } catch {
      return 0;
    }
  }
};
