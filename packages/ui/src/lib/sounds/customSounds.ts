import { z } from 'zod';
import type { SoundEventId } from './events';
import type { SoundSource } from './settings';
import type { BuiltinVoiceId } from './voices';

/**
 * Custom sound files, kept on this device in IndexedDB. A file never leaves
 * the device, and its bytes cannot live in localStorage: that is a shared 5 MB
 * budget, base64 grows a file by a third, and in VS Code every write is
 * copied into every webview as a StorageEvent. IndexedDB fires none.
 */

export const MAX_CUSTOM_SOUND_BYTES = 1024 * 1024;
export const MAX_CUSTOM_SOUND_TOTAL_BYTES = 8 * 1024 * 1024;
export const MAX_CUSTOM_SOUND_SECONDS = 10;
/** A sweep leaves younger records alone: another window may be about to point an event at one. */
const SWEEP_MIN_AGE_MS = 60_000;

const DATABASE = 'openchamber-sounds';
const DATABASE_VERSION = 1;
const STORE = 'files';

export type CustomSoundError = 'too-large' | 'total-full' | 'unsupported' | 'too-long' | 'storage-unavailable';

type AddCustomSoundResult =
  | { ok: true; id: string; name: string }
  | { ok: false; error: CustomSoundError };

const customSoundRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  mime: z.string(),
  size: z.number(),
  bytes: z.instanceof(ArrayBuffer),
  /** Largest sample magnitude, 0 to 1, so playback can level files against each other. */
  peak: z.number(),
  duration: z.number(),
  createdAt: z.number(),
});

type CustomSoundRecord = z.infer<typeof customSoundRecordSchema>;

/** Every record the store holds; a damaged one is left out. */
const storedRecordsSchema = z.array(z.unknown()).transform((entries) => entries.flatMap((entry) => {
  const record = customSoundRecordSchema.safeParse(entry);
  return record.success ? [record.data] : [];
})).catch([]);

type DecodedInfo = { duration: number; peak: number };

type SoundFileDeps = {
  indexedDB: IDBFactory | undefined;
  /** Decodes without a running context; rejects for anything that is not audio. */
  decode: (bytes: ArrayBuffer) => Promise<DecodedInfo>;
  now: () => number;
  newId: () => string;
};

const requestResult = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

export const createSoundFileStore = (deps: SoundFileDeps) => {
  let databasePromise: Promise<IDBDatabase | null> | null = null;
  let connection: IDBDatabase | null = null;
  const removedListeners = new Set<(id: string) => void>();
  const notifyRemoved = (id: string) => {
    for (const listener of removedListeners) listener(id);
  };

  // A refused open (private mode, a locked-down webview) resolves to null and
  // never throws into the UI.
  const openDatabase = (): Promise<IDBDatabase | null> => {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise<IDBDatabase | null>((resolve) => {
      if (!deps.indexedDB) {
        resolve(null);
        return;
      }
      let request: IDBOpenDBRequest;
      try {
        request = deps.indexedDB.open(DATABASE, DATABASE_VERSION);
      } catch {
        resolve(null);
        return;
      }
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE, { keyPath: 'id' });
      };
      request.onsuccess = () => {
        const database = request.result;
        connection = database;
        // A connection the browser closes (storage cleared, another tab upgrading) must not be reused.
        const drop = () => {
          if (connection !== database) return;
          connection = null;
          databasePromise = null;
        };
        database.onclose = drop;
        database.onversionchange = () => {
          database.close();
          drop();
        };
        resolve(database);
      };
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
    return databasePromise;
  };

  /** Runs `work` in one transaction and resolves once it has committed. */
  const inTransaction = async <T>(
    mode: IDBTransactionMode,
    work: (store: IDBObjectStore) => Promise<T>,
  ): Promise<T | null> => {
    const database = await openDatabase();
    if (!database) return null;
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(STORE, mode);
    } catch (error) {
      // A closing connection refuses transactions: the next call opens a new one.
      connection = null;
      databasePromise = null;
      throw error;
    }
    const committed = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    // When `work` throws, nothing awaits `committed`, and its rejection would go unhandled.
    committed.catch(() => undefined);
    let result: T;
    try {
      result = await work(transaction.objectStore(STORE));
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // Already finished.
      }
      throw error;
    }
    await committed;
    return result;
  };

  const add = async (
    file: Pick<File, 'name' | 'type' | 'size' | 'arrayBuffer'>,
    options: { replacing?: string } = {},
  ): Promise<AddCustomSoundResult> => {
    if (file.size > MAX_CUSTOM_SOUND_BYTES) return { ok: false, error: 'too-large' };
    let bytes: ArrayBuffer;
    let info: DecodedInfo;
    try {
      bytes = await file.arrayBuffer();
      info = await deps.decode(bytes);
    } catch {
      return { ok: false, error: 'unsupported' };
    }
    if (info.duration > MAX_CUSTOM_SOUND_SECONDS) return { ok: false, error: 'too-long' };

    try {
      const record: CustomSoundRecord = {
        id: deps.newId(),
        name: file.name,
        mime: file.type,
        size: bytes.byteLength,
        bytes,
        peak: info.peak,
        duration: info.duration,
        createdAt: deps.now(),
      };
      const outcome = await inTransaction('readwrite', async (store) => {
        const stored = storedRecordsSchema.parse(await requestResult(store.getAll()));
        // The file this one replaces goes away right after, so it does not count.
        const kept = stored.filter((entry) => entry.id !== options.replacing);
        if (kept.reduce((total, entry) => total + entry.size, 0) + record.size > MAX_CUSTOM_SOUND_TOTAL_BYTES) return 'total-full' as const;
        await requestResult(store.put(record));
        return 'stored' as const;
      });
      if (outcome === 'total-full') return { ok: false, error: 'total-full' };
      if (outcome === null) return { ok: false, error: 'storage-unavailable' };
      return { ok: true, id: record.id, name: record.name };
    } catch {
      return { ok: false, error: 'storage-unavailable' };
    }
  };

  const readRecord = async (id: string): Promise<CustomSoundRecord | null | undefined> => {
    try {
      const raw = await inTransaction('readonly', (store) => requestResult(store.get(id)));
      // `null`: storage is unavailable. `undefined`: it works and holds no such file.
      if (raw === null) return null;
      const record = customSoundRecordSchema.safeParse(raw);
      return record.success ? record.data : undefined;
    } catch {
      return null;
    }
  };

  return {
    add,
    /** The bytes, level and length in seconds of a file, or null when it is missing or storage is unavailable. */
    read: async (id: string): Promise<{ bytes: ArrayBuffer; peak: number; duration: number } | null> => {
      const record = await readRecord(id);
      return record ? { bytes: record.bytes, peak: record.peak, duration: record.duration } : null;
    },
    /** True only when storage works and holds no such file; unreadable storage is not "missing". */
    isMissing: async (id: string): Promise<boolean> => (await readRecord(id)) === undefined,
    remove: async (id: string): Promise<void> => {
      notifyRemoved(id);
      try {
        await inTransaction('readwrite', (store) => requestResult(store.delete(id)));
      } catch {
        // A file left behind is swept the next time the page opens.
      }
    },
    /** Deletes files no event points at. */
    sweep: async (referenced: ReadonlySet<string>): Promise<void> => {
      try {
        const swept: string[] = [];
        await inTransaction('readwrite', async (store) => {
          const stored = storedRecordsSchema.parse(await requestResult(store.getAll()));
          for (const entry of stored) {
            if (!referenced.has(entry.id) && deps.now() - entry.createdAt > SWEEP_MIN_AGE_MS) {
              store.delete(entry.id);
              swept.push(entry.id);
            }
          }
        });
        for (const id of swept) notifyRemoved(id);
      } catch {
        // The next visit tries again.
      }
    },
    /** Calls `listener` with the id of every file that is deleted; returns the function that stops it. */
    onRemoved: (listener: (id: string) => void): (() => void) => {
      removedListeners.add(listener);
      return () => {
        removedListeners.delete(listener);
      };
    },
  };
};

export type SoundFileStore = ReturnType<typeof createSoundFileStore>;

/**
 * Duration and loudest sample of a decoded buffer. A buffer over the length
 * limit is rejected anyway, so its samples are never scanned: a long
 * low-bitrate file passes the byte limit and decodes to millions of samples.
 */
export const measureDecodedBuffer = (
  buffer: Pick<AudioBuffer, 'duration' | 'numberOfChannels' | 'getChannelData'>,
): DecodedInfo => {
  if (buffer.duration > MAX_CUSTOM_SOUND_SECONDS) return { duration: buffer.duration, peak: 0 };
  let peak = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    for (const sample of buffer.getChannelData(channel)) peak = Math.max(peak, Math.abs(sample));
  }
  return { duration: buffer.duration, peak };
};

const decodeWithOfflineContext = async (bytes: ArrayBuffer): Promise<DecodedInfo> => {
  // SAFETY: Safari before 14.1 names the constructor webkitOfflineAudioContext; the cast only reads that optional property.
  const Offline = globalThis.OfflineAudioContext ?? (globalThis as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  if (!Offline) throw new Error('Web Audio is not available');
  // The decoder takes ownership of its input, so it gets a copy.
  return measureDecodedBuffer(await new Offline(1, 1, 44100).decodeAudioData(bytes.slice(0)));
};

export const soundFiles: SoundFileStore = createSoundFileStore({
  indexedDB: globalThis.indexedDB,
  decode: decodeWithOfflineContext,
  now: Date.now,
  newId: () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
});

type SourceAccess = {
  get: (eventId: SoundEventId) => SoundSource;
  set: (eventId: SoundEventId, source: SoundSource) => void;
};

type AssignDeps = { files: Pick<SoundFileStore, 'add' | 'remove'>; source: SourceAccess };

/**
 * Points an event at a file the user picked. The file is stored first, then
 * the event is pointed at it, then the file it replaced is deleted: a failed
 * store leaves the previous sound in place and no write can leave an event
 * pointing at nothing.
 */
export const assignCustomFile = async (
  eventId: SoundEventId,
  file: Pick<File, 'name' | 'type' | 'size' | 'arrayBuffer'>,
  { files, source }: AssignDeps,
): Promise<AddCustomSoundResult> => {
  const replaced = source.get(eventId);
  const added = await files.add(file, { replacing: replaced.kind === 'custom' ? replaced.fileId : undefined });
  if (!added.ok) return added;
  const previous = source.get(eventId);
  source.set(eventId, { kind: 'custom', fileId: added.id, name: added.name });
  if (previous.kind === 'custom') await files.remove(previous.fileId);
  return added;
};

/** Points an event back at a built-in voice, then deletes the file it used. */
export const assignBuiltinVoice = async (
  eventId: SoundEventId,
  voice: BuiltinVoiceId,
  { files, source }: AssignDeps,
): Promise<void> => {
  const previous = source.get(eventId);
  source.set(eventId, { kind: 'builtin', voice });
  if (previous.kind === 'custom') await files.remove(previous.fileId);
};
