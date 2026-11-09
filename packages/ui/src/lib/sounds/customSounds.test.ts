import { describe, expect, test } from 'bun:test';
import {
  MAX_CUSTOM_SOUND_BYTES,
  MAX_CUSTOM_SOUND_SECONDS,
  MAX_CUSTOM_SOUND_TOTAL_BYTES,
  assignBuiltinVoice,
  assignCustomFile,
  createSoundFileStore,
  measureDecodedBuffer,
  type SoundFileStore,
} from './customSounds';
import type { SoundSource } from './settings';

type StoredRecord = {
  id: string;
  name: string;
  mime: string;
  size: number;
  bytes: ArrayBuffer;
  peak: number;
  duration: number;
  createdAt: number;
};

const seedRecord = (id: string, size: number, createdAt: number): StoredRecord => ({
  id, name: id, mime: 'audio/mpeg', size, bytes: new ArrayBuffer(1), peak: 1, duration: 1, createdAt,
});

/** The parts of an IDBRequest the file store reads and sets. */
type FakeRequest<T> = {
  result: T | undefined;
  error: Error | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onupgradeneeded: (() => void) | null;
  onblocked: (() => void) | null;
};

const createRequest = <T>(): FakeRequest<T> => ({
  result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null,
});

type FakeTransaction = {
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  error: Error | null;
  pending: number;
};

/** What the browser calls on a connection when it closes it or another tab upgrades the database. */
type FakeDatabaseHandlers = { onclose: (() => void) | null; onversionchange: (() => void) | null };

/** A minimal IndexedDB: one object store keyed by `id`, with the calls the file store makes. */
const createFakeIndexedDB = ({ failOpen = false, failPut = false }: { failOpen?: boolean; failPut?: boolean } = {}) => {
  const records = new Map<string, StoredRecord>();
  const handlers: FakeDatabaseHandlers = { onclose: null, onversionchange: null };
  let closed = 0;
  const database = Object.assign(handlers, {
    createObjectStore: () => ({}),
    close: () => { closed += 1; },
    transaction: () => {
      const transaction: FakeTransaction = { oncomplete: null, onerror: null, onabort: null, error: null, pending: 0 };
      const respond = <T>(compute: () => T, fail = false) => {
        const request = createRequest<T>();
        transaction.pending += 1;
        setTimeout(() => {
          if (fail) {
            request.error = new Error('write refused');
            request.onerror?.();
            // A refused write aborts its transaction.
            transaction.error = request.error;
            transaction.onabort?.();
          } else {
            request.result = compute();
            request.onsuccess?.();
          }
          transaction.pending -= 1;
          setTimeout(() => { if (transaction.pending === 0 && !fail) transaction.oncomplete?.(); }, 0);
        }, 0);
        return request;
      };
      return Object.assign(transaction, {
        objectStore: () => ({
          get: (id: string) => respond(() => (records.has(id) ? structuredClone(records.get(id)) : undefined)),
          getAll: () => respond(() => [...records.values()].map((record) => structuredClone(record))),
          put: (record: StoredRecord) => respond(() => { records.set(record.id, structuredClone(record)); return record.id; }, failPut),
          delete: (id: string) => respond(() => { records.delete(id); return undefined; }),
        }),
      });
    },
  });
  let opens = 0;
  const factory = {
    open: () => {
      const request = createRequest<typeof database>();
      opens += 1;
      setTimeout(() => {
        if (failOpen) {
          request.onerror?.();
          return;
        }
        request.result = database;
        request.onupgradeneeded?.();
        request.onsuccess?.();
      }, 0);
      return request;
    },
  };
  // SAFETY: the fake implements the IDBFactory, database, transaction and store calls the file store makes.
  return { factory: factory as never, records, database, opens: () => opens, closed: () => closed };
};
const file = (size: number, name = 'ding.mp3') => ({
  name,
  type: 'audio/mpeg',
  size,
  arrayBuffer: async () => new ArrayBuffer(size),
});

const createStore = (options: { indexedDB?: IDBFactory | undefined; duration?: number; decodeFails?: boolean; now?: () => number } = {}) => {
  const decoded: number[] = [];
  let ids = 0;
  const store = createSoundFileStore({
    indexedDB: 'indexedDB' in options ? options.indexedDB : createFakeIndexedDB().factory,
    decode: async (bytes) => {
      decoded.push(bytes.byteLength);
      if (options.decodeFails) throw new Error('not audio');
      return { duration: options.duration ?? 1.5, peak: 0.5 };
    },
    now: options.now ?? (() => 1_000_000),
    newId: () => `id${++ids}`,
  });
  return { store, decoded };
};

describe('custom sound files', () => {
  test('stores a valid file and reads it back', async () => {
    const database = createFakeIndexedDB();
    const { store } = createStore({ indexedDB: database.factory });
    const result = await store.add(file(200 * 1024));
    expect(result).toEqual({ ok: true, id: 'id1', name: 'ding.mp3' });
    const read = await store.read('id1');
    expect(read?.bytes.byteLength).toBe(200 * 1024);
    expect(read?.peak).toBe(0.5);
  });

  test('rejects a file over the size limit without decoding it', async () => {
    const { store, decoded } = createStore();
    expect(await store.add(file(MAX_CUSTOM_SOUND_BYTES + 1))).toEqual({ ok: false, error: 'too-large' });
    expect(decoded).toEqual([]);
  });

  test('rejects something that is not audio', async () => {
    const { store } = createStore({ decodeFails: true });
    expect(await store.add(file(1000, 'notes.txt'))).toEqual({ ok: false, error: 'unsupported' });
  });

  test('rejects a sound over ten seconds', async () => {
    const { store } = createStore({ duration: 10.5 });
    expect(await store.add(file(1000))).toEqual({ ok: false, error: 'too-long' });
    expect(await createStore({ duration: 10 }).store.add(file(1000))).toMatchObject({ ok: true });
  });

  test('rejects a file that would pass the total limit and stores nothing', async () => {
    const database = createFakeIndexedDB();
    const filler = 7 * 1024 * 1024 + 900 * 1024;
    database.records.set('old', seedRecord('old', filler, 0));
    const { store } = createStore({ indexedDB: database.factory });
    expect(await store.add(file(MAX_CUSTOM_SOUND_TOTAL_BYTES - filler + 1))).toEqual({ ok: false, error: 'total-full' });
    expect([...database.records.keys()]).toEqual(['old']);
    expect(await store.add(file(MAX_CUSTOM_SOUND_TOTAL_BYTES - filler))).toMatchObject({ ok: true });
  });

  test('a file that replaces another does not count the replaced one against the total', async () => {
    const database = createFakeIndexedDB();
    database.records.set('old', seedRecord('old', 7 * 1024 * 1024 + 512 * 1024, 0));
    const { store } = createStore({ indexedDB: database.factory });
    expect(await store.add(file(MAX_CUSTOM_SOUND_BYTES))).toEqual({ ok: false, error: 'total-full' });
    expect(await store.add(file(MAX_CUSTOM_SOUND_BYTES), { replacing: 'old' })).toMatchObject({ ok: true });
    // A different file in the way still counts.
    expect(await store.add(file(MAX_CUSTOM_SOUND_BYTES), { replacing: 'id1' })).toEqual({ ok: false, error: 'total-full' });
  });

  test('reports unavailable storage instead of throwing', async () => {
    expect(await createStore({ indexedDB: undefined }).store.add(file(1000))).toEqual({ ok: false, error: 'storage-unavailable' });
    expect(await createStore({ indexedDB: createFakeIndexedDB({ failOpen: true }).factory }).store.add(file(1000)))
      .toEqual({ ok: false, error: 'storage-unavailable' });
    expect(await createStore({ indexedDB: createFakeIndexedDB({ failPut: true }).factory }).store.add(file(1000)))
      .toEqual({ ok: false, error: 'storage-unavailable' });
  });

  test('a missing record reads as null and is "missing" only while storage works', async () => {
    const { store } = createStore();
    expect(await store.read('nope')).toBeNull();
    expect(await store.isMissing('nope')).toBe(true);
    await store.add(file(10));
    expect(await store.isMissing('id1')).toBe(false);
    const unavailable = createStore({ indexedDB: undefined }).store;
    expect(await unavailable.read('x')).toBeNull();
    expect(await unavailable.isMissing('x')).toBe(false);
  });

  test('sweeps files no event references, leaving young ones alone', async () => {
    const database = createFakeIndexedDB();
    const now = 10 * 60_000;
    for (const [id, createdAt] of [['kept', 0], ['stale', 0], ['young', now - 1000]] as const) {
      database.records.set(id, seedRecord(id, 1, createdAt));
    }
    const { store } = createStore({ indexedDB: database.factory, now: () => now });
    await store.sweep(new Set(['kept']));
    expect([...database.records.keys()].sort()).toEqual(['kept', 'young']);
  });

  test('tells listeners which files were removed or swept', async () => {
    const database = createFakeIndexedDB();
    const now = 10 * 60_000;
    for (const id of ['a', 'b', 'c']) database.records.set(id, seedRecord(id, 1, 0));
    const { store } = createStore({ indexedDB: database.factory, now: () => now });
    const removed: string[] = [];
    const stop = store.onRemoved((id) => { removed.push(id); });
    await store.remove('a');
    await store.sweep(new Set(['b']));
    expect(removed).toEqual(['a', 'c']);
    stop();
    await store.remove('b');
    expect(removed).toEqual(['a', 'c']);
  });

  test('opens a new connection after the browser closes the old one', async () => {
    const database = createFakeIndexedDB();
    const { store } = createStore({ indexedDB: database.factory });
    await store.add(file(10));
    expect(database.opens()).toBe(1);
    database.database.onclose?.();
    expect(await store.read('id1')).not.toBeNull();
    expect(database.opens()).toBe(2);
    // Another tab upgrading the database closes this connection too.
    database.database.onversionchange?.();
    expect(database.closed()).toBe(1);
    await store.read('id1');
    expect(database.opens()).toBe(3);
  });

  test('a refused write is reported and leaves no unhandled rejection behind', async () => {
    const database = createFakeIndexedDB({ failPut: true });
    const { store } = createStore({ indexedDB: database.factory });
    expect(await store.add(file(10))).toEqual({ ok: false, error: 'storage-unavailable' });
    // The runner fails the run on a rejection nobody handled; give one time to surface.
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
});

describe('measuring a decoded sound', () => {
  const buffer = (duration: number, samples: number[]) => {
    const reads = { count: 0 };
    return {
      reads,
      value: {
        duration,
        numberOfChannels: 1,
        getChannelData: () => {
          reads.count += 1;
          return Float32Array.from(samples);
        },
      },
    };
  };

  test('finds the loudest sample of a sound inside the length limit', () => {
    const { value } = buffer(2, [0.1, -0.7, 0.3]);
    expect(measureDecodedBuffer(value)).toEqual({ duration: 2, peak: Math.fround(0.7) });
  });

  test('never scans the samples of a sound over the length limit', () => {
    const long = buffer(MAX_CUSTOM_SOUND_SECONDS + 1, [0.9]);
    expect(measureDecodedBuffer(long.value)).toEqual({ duration: MAX_CUSTOM_SOUND_SECONDS + 1, peak: 0 });
    expect(long.reads.count).toBe(0);
  });
});

describe('assigning sounds to events', () => {
  const createDeps = (addResult: Awaited<ReturnType<SoundFileStore['add']>>, previous: SoundSource) => {
    const log: string[] = [];
    let source = previous;
    return {
      log,
      current: () => source,
      deps: {
        files: {
          add: async (...[, options]: Parameters<SoundFileStore['add']>) => {
            log.push(options?.replacing ? `add replacing ${options.replacing}` : 'add');
            return addResult;
          },
          remove: async (id: string) => { log.push(`remove ${id}`); },
        },
        source: {
          get: () => source,
          set: (_event: string, next: SoundSource) => { log.push(`set ${next.kind}`); source = next; },
        },
      },
    };
  };

  test('stores the file, points the event at it, then deletes the file it replaced', async () => {
    const { deps, log, current } = createDeps({ ok: true, id: 'new', name: 'new.mp3' }, { kind: 'custom', fileId: 'old', name: 'old.mp3' });
    await assignCustomFile('typing', file(10), deps);
    expect(log).toEqual(['add replacing old', 'set custom', 'remove old']);
    expect(current()).toEqual({ kind: 'custom', fileId: 'new', name: 'new.mp3' });
  });

  test('a failed store leaves the previous sound in place and deletes nothing', async () => {
    const previous: SoundSource = { kind: 'custom', fileId: 'old', name: 'old.mp3' };
    const { deps, log, current } = createDeps({ ok: false, error: 'too-large' }, previous);
    expect(await assignCustomFile('typing', file(10), deps)).toEqual({ ok: false, error: 'too-large' });
    expect(log).toEqual(['add replacing old']);
    expect(current()).toEqual(previous);
  });

  test('replacing a built-in voice with a file deletes nothing', async () => {
    const { deps, log } = createDeps({ ok: true, id: 'new', name: 'new.mp3' }, { kind: 'builtin', voice: 'pop' });
    await assignCustomFile('typing', file(10), deps);
    expect(log).toEqual(['add', 'set custom']);
  });

  test('picking a built-in voice sets it, then deletes the old file', async () => {
    const { deps, log, current } = createDeps({ ok: true, id: 'x', name: 'x' }, { kind: 'custom', fileId: 'old', name: 'old.mp3' });
    await assignBuiltinVoice('typing', 'tick', deps);
    expect(log).toEqual(['set builtin', 'remove old']);
    expect(current()).toEqual({ kind: 'builtin', voice: 'tick' });
  });
});
