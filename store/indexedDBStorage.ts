// Custom IndexedDB storage adapter for Zustand persist middleware
// This allows storing large datasets that exceed localStorage quota

interface Storage {
  getItem: (name: string) => Promise<string | null>;
  setItem: (name: string, value: string) => Promise<void>;
  removeItem: (name: string) => Promise<void>;
}

function createIndexedDBStorage(): Storage {
  // Check if IndexedDB is available
  if (typeof window === 'undefined' || !window.indexedDB) {
    console.warn('IndexedDB not available, falling back to localStorage');
    return {
      getItem: (name: string) => Promise.resolve(localStorage.getItem(name)),
      setItem: (name: string, value: string) => {
        try {
          localStorage.setItem(name, value);
          return Promise.resolve();
        } catch (error) {
          return Promise.reject(error);
        }
      },
      removeItem: (name: string) => {
        localStorage.removeItem(name);
        return Promise.resolve();
      },
    };
  }

  const DB_NAME = 'sr-analytics-db';
  const STORE_NAME = 'store';
  const DB_VERSION = 1;

  let db: IDBDatabase | null = null;
  let dbPromise: Promise<IDBDatabase> | null = null;

  const getDB = (): Promise<IDBDatabase> => {
    if (db) {
      return Promise.resolve(db);
    }

    if (dbPromise) {
      return dbPromise;
    }

    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        reject(new Error('Failed to open IndexedDB'));
      };

      request.onsuccess = () => {
        db = request.result;
        resolve(db);
      };

      request.onupgradeneeded = (event) => {
        const database = (event.target as IDBOpenDBRequest).result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME);
        }
      };
    });

    return dbPromise;
  };

  return {
    getItem: async (name: string): Promise<string | null> => {
      try {
        const database = await getDB();
        return new Promise((resolve, reject) => {
          const transaction = database.transaction([STORE_NAME], 'readonly');
          const store = transaction.objectStore(STORE_NAME);
          const request = store.get(name);

          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const result = request.result;
            resolve(result ? String(result) : null);
          };
        });
      } catch (error) {
        console.error('IndexedDB getItem error:', error);
        return null;
      }
    },

    setItem: async (name: string, value: string): Promise<void> => {
      try {
        const database = await getDB();
        return new Promise((resolve, reject) => {
          // Use a separate transaction for large writes to avoid blocking
          const transaction = database.transaction([STORE_NAME], 'readwrite');
          transaction.onerror = () => reject(transaction.error);
          transaction.oncomplete = () => resolve();
          
          const store = transaction.objectStore(STORE_NAME);
          const request = store.put(value, name);

          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            // Transaction will complete asynchronously
          };
        });
      } catch (error) {
        console.error('IndexedDB setItem error:', error);
        // If IndexedDB fails, try to fall back to localStorage for metadata only
        if (value.length < 5 * 1024 * 1024) { // Only for small values (< 5MB)
          try {
            localStorage.setItem(name, value);
            return Promise.resolve();
          } catch (localError) {
            // Both failed
          }
        }
        throw error;
      }
    },

    removeItem: async (name: string): Promise<void> => {
      try {
        const database = await getDB();
        return new Promise((resolve, reject) => {
          const transaction = database.transaction([STORE_NAME], 'readwrite');
          const store = transaction.objectStore(STORE_NAME);
          const request = store.delete(name);

          request.onerror = () => reject(request.error);
          request.onsuccess = () => resolve();
        });
      } catch (error) {
        console.error('IndexedDB removeItem error:', error);
        throw error;
      }
    },
  };
}

export const indexedDBStorage = createIndexedDBStorage();

