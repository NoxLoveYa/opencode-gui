import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { createTrackedItemsInterest } from './interest';
import { trackedItemKey, trackedItemRecordSchema, type TrackedItem, type TrackedItemState } from './model';

type Request = { path: string; body: { connectionId: string; visible: boolean; items?: TrackedItem[] } };

const pull = (number: number): TrackedItem => ({ provider: 'github', instance: 'github.com', kind: 'pull', owner: 'acme', repo: 'app', number });

function setup() {
  let listener: Parameters<Parameters<typeof createTrackedItemsInterest>[0]['subscribe']>[0] | null = null;
  let visibilityListener: (() => void) | null = null;
  let visible = true;
  const posts: Request[] = [];
  const applied: Array<{ records: Array<{ key: string; record: TrackedItemState; continuous?: true }>; source: string }> = [];
  let respond: (path: string) => Response = () => Response.json({ states: [] });
  const interest = createTrackedItemsInterest({
    subscribe: (next) => { listener = next; },
    post: async (request) => { posts.push({ path: request.path, body: { ...request.body } }); return respond(request.path); },
    apply: (records, source) => { applied.push({ records, source }); },
    isVisible: () => visible,
    onVisibilityChange: (next) => { visibilityListener = next; },
  });
  return {
    interest,
    posts,
    applied,
    ready: (connectionId: string) => listener?.({ type: 'event-stream-ready', connectionId }),
    push: (records: Array<{ key: string; record: TrackedItemState; continuous?: true }>) => listener?.({ type: 'tracked-items-changed', records }),
    setVisible: (value: boolean) => { visible = value; visibilityListener?.(); },
    respondWith: (next: (path: string) => Response) => { respond = next; },
  };
}

const settle = async (ms = 200) => {
  jest.advanceTimersByTime(ms);
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
};

describe('tracked items interest', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('items on screen fill the cap before a background follower declared earlier', async () => {
    const { interest, posts, ready } = setup();
    interest.declare(Symbol('cleanup'), Array.from({ length: 300 }, (_, index) => pull(1000 + index)), { background: true });
    interest.declare(Symbol('panel'), [pull(1)]);
    ready('c1');
    await settle(0);
    expect(posts[0].body.items).toHaveLength(300);
    expect(posts[0].body.items?.some((item) => item.kind === 'pull' && item.number === 1)).toBe(true);
  });

  test('sends the union once the connection is known, once per change, and again after a reconnect', async () => {
    const { interest, posts, ready } = setup();
    const sidebar = Symbol('sidebar');
    const panel = Symbol('panel');
    interest.declare(sidebar, [pull(1), pull(2)]);
    interest.declare(panel, [pull(2)]);
    await settle();
    expect(posts).toHaveLength(0);

    ready('c1');
    await settle(0);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ path: '/api/tracked-items/interest', body: { connectionId: 'c1', visible: true } });
    expect(posts[0].body.items).toHaveLength(2);

    interest.declare(panel, [pull(2)]);
    await settle();
    expect(posts).toHaveLength(1);

    ready('c2');
    await settle(0);
    expect(posts.map((post) => post.body.connectionId)).toEqual(['c1', 'c2']);
  });

  test('hands over the answer to what is shown as an answer, also after a reconnect, and a pushed change as a push', async () => {
    const { interest, ready, push, applied, respondWith } = setup();
    const item = pull(7);
    const record = trackedItemRecordSchema.parse({ key: trackedItemKey(item), item, state: null, fetchedAt: 1 });
    if (!record) throw new Error('fixture must parse');
    respondWith(() => Response.json({ states: [{ key: record.key, item, state: null, fetchedAt: 1 }] }));
    interest.declare(Symbol('row'), [item]);
    ready('c1');
    await settle(0);
    expect(applied.map((entry) => entry.source)).toEqual(['answer']);

    push([record]);
    expect(applied.map((entry) => entry.source)).toEqual(['answer', 'push']);

    // The new connection knows nothing: the set is sent again and the answer is an answer, not news.
    ready('c2');
    await settle(0);
    expect(applied.map((entry) => entry.source)).toEqual(['answer', 'push', 'answer']);
  });

  test('keeps the server\'s continuous mark on a pushed record and never invents one on an answer', async () => {
    const { interest, ready, push, applied, respondWith } = setup();
    const item = pull(7);
    const record = trackedItemRecordSchema.parse({ key: trackedItemKey(item), item, state: null, fetchedAt: 1 });
    if (!record) throw new Error('fixture must parse');
    respondWith(() => Response.json({ states: [{ key: record.key, item, state: null, fetchedAt: 1, continuous: true }] }));
    interest.declare(Symbol('row'), [item]);
    ready('c1');
    await settle(0);
    // Whatever the answer carries, an answer is the state of the moment: the source says so.
    expect(applied[0].source).toBe('answer');

    push([{ ...record, continuous: true }]);
    expect(applied[1]).toMatchObject({ source: 'push', records: [{ continuous: true }] });
  });

  test('tells the server when nothing is shown any more and when the window flips', async () => {
    const { interest, posts, ready, setVisible } = setup();
    const token = Symbol('row');
    interest.declare(token, [pull(1)]);
    ready('c1');
    await settle(0);
    interest.release(token);
    await settle();
    expect(posts[1].body.items).toEqual([]);

    setVisible(false);
    await settle(0);
    expect(posts[2]).toEqual({ path: '/api/tracked-items/presence', body: { connectionId: 'c1', visible: false } });
  });

  test('keeps the set within what the server accepts, the surfaces declared first in full', async () => {
    const { interest, posts, ready } = setup();
    const sidebar = Symbol('sidebar');
    interest.declare(sidebar, [pull(1), pull(2)]);
    interest.declare(Symbol('board'), Array.from({ length: 400 }, (_, index) => pull(index + 3)));
    ready('c1');
    await settle(0);
    const sent = posts[0].body.items ?? [];
    expect(sent).toHaveLength(300);
    expect(sent.slice(0, 2)).toEqual([pull(1), pull(2)]);

    // The sidebar's set changes after the board declared: it keeps its place.
    interest.declare(sidebar, [pull(1), pull(2), pull(1000)]);
    await settle();
    const resent = posts[1].body.items ?? [];
    expect(resent).toHaveLength(300);
    expect(resent.slice(0, 3)).toEqual([pull(1), pull(2), pull(1000)]);
  });

  test('retries a failed send later and waits for the next connection after a 409', async () => {
    const { interest, posts, ready, respondWith } = setup();
    respondWith(() => new Response('down', { status: 503 }));
    interest.declare(Symbol('row'), [pull(1)]);
    ready('c1');
    await settle(0);
    expect(posts).toHaveLength(1);
    respondWith(() => Response.json({ states: [] }));
    await settle(30_000);
    expect(posts).toHaveLength(2);

    respondWith(() => new Response('gone', { status: 409 }));
    interest.declare(Symbol('other'), [pull(9)]);
    await settle();
    expect(posts).toHaveLength(3);
    await settle(60_000);
    expect(posts).toHaveLength(3);
  });
});
