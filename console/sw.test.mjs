// node --test tools/console/sw.test.mjs
//
// R240 — `frontend/public/sw.js`, the console's service worker, run in a vm
// with a stand-in for the worker's globals. It is outside the Angular bundle
// on purpose (the 1 MB budget), so `ng test` never loads it; this is where its
// three handlers are pinned.
//
// What matters and is easy to get backwards:
//
//   1. A `resolved` (R238) REPLACES the notification under its tag, quietly,
//      and draws nothing when there is none to replace — a notice about a
//      question the person never saw is noise, and a bare `close()` is what
//      Chrome punishes with "this site has been updated in the background".
//   2. A click reuses a window that is already on this origin — focused and
//      told the URL — and opens one only when there is none.
//   3. A push this worker does not understand draws nothing at all.
//
// R243 added the fetch handler, and the fourth thing that is easy to get
// backwards is the one that matters most:
//
//   4. Nothing under /api/ is ever answered from a cache or put in one — the
//      handler does not respondWith for it at all. The shell is precached on
//      install by the STAMPED worker and served cache-first; the worker as it
//      is in the tree, unstamped, caches nothing, which is what `ng serve`
//      relies on.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { stamp } from '../../frontend/stamp-sw.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', '..', 'frontend', 'public', 'sw.js'), 'utf8');

/** A Request as the worker sees one: the URL, the method, and the mode. */
class FakeRequest {
  constructor(url, { method = 'GET', mode = 'no-cors', cache = 'default' } = {}) {
    this.url = new URL(url, 'https://caw.example').href;
    this.method = method;
    this.mode = mode;
    this.cache = cache;
  }
}

/** A Response: `ok`, `type`, and a body to tell copies apart. */
class FakeResponse {
  constructor(body, { ok = true, type = 'basic' } = {}) {
    this.body = body;
    this.ok = ok;
    this.type = type;
  }
  clone() {
    return new FakeResponse(this.body, { ok: this.ok, type: this.type });
  }
}

/**
 * The Cache Storage: named caches of URL → response. `addAll` records the
 * requests it was given so a test can see they bypassed the HTTP cache.
 */
function cacheStorage(initial = {}) {
  const keyOf = (request) => new URL(typeof request === 'string' ? request : request.url, 'https://caw.example').href;
  const stores = new Map(
    Object.entries(initial).map(([name, urls]) => [name, new Map(urls.map((u) => [keyOf(u), new FakeResponse(keyOf(u))]))]),
  );
  const added = [];
  const open = (name) => {
    if (!stores.has(name)) {
      stores.set(name, new Map());
    }
    const store = stores.get(name);
    return {
      match: (request) => Promise.resolve(store.get(keyOf(request))),
      put: (request, response) => {
        store.set(keyOf(request), response);
        return Promise.resolve();
      },
      addAll: (requests) => {
        for (const request of requests) {
          added.push(request);
          store.set(keyOf(request), new FakeResponse(keyOf(request)));
        }
        return Promise.resolve();
      },
    };
  };
  return {
    caches: {
      open: (name) => Promise.resolve(open(name)),
      keys: () => Promise.resolve([...stores.keys()]),
      delete: (name) => Promise.resolve(stores.delete(name)),
    },
    stores,
    added,
  };
}

/**
 * A worker global scope: the listeners it registered, and what it drew.
 * `stamped` runs the worker as `npm run build` ships it — a build id and a
 * shell list written in — rather than as it is in the tree.
 */
function worker({ showing = [], windows = [], stamped = null, caches: initialCaches = {}, network = {} } = {}) {
  const listeners = {};
  const shown = [];
  const opened = [];
  const fetched = [];
  let claimed = false;
  let skipped = false;
  const self = {
    location: { origin: 'https://caw.example' },
    skipWaiting() {
      skipped = true;
    },
    addEventListener(name, listener) {
      listeners[name] = listener;
    },
    registration: {
      showNotification(title, options) {
        shown.push({ title, ...options });
        return Promise.resolve();
      },
      getNotifications({ tag }) {
        return Promise.resolve(showing.filter((one) => one.tag === tag));
      },
    },
  };
  const clients = {
    claim: () => {
      claimed = true;
      return Promise.resolve();
    },
    matchAll: () => Promise.resolve(windows),
    openWindow(url) {
      opened.push(url);
      return Promise.resolve();
    },
  };
  const storage = cacheStorage(initialCaches);
  const fetch = (request) => {
    const url = typeof request === 'string' ? new URL(request, 'https://caw.example').href : request.url;
    fetched.push(url);
    const answer = network[new URL(url).pathname];
    return Promise.resolve(answer ?? new FakeResponse('missing', { ok: false }));
  };
  const context = vm.createContext({
    self,
    clients,
    caches: storage.caches,
    fetch,
    Request: FakeRequest,
    URL,
    Object,
    Promise,
  });
  vm.runInContext(stamped ? stamp(source, stamped) : source, context);

  /** Dispatches one event and waits for whatever the handler put in `waitUntil`. */
  async function dispatch(name, event) {
    let pending = Promise.resolve();
    listeners[name]({ ...event, waitUntil: (work) => (pending = work) });
    await pending;
  }

  /**
   * One fetch through the handler: the response it answered with, or
   * `undefined` when it did not answer at all — the browser's own request
   * then, and the thing the /api/ rule is about.
   */
  async function request(url, init) {
    let answered;
    listeners.fetch({
      request: new FakeRequest(url, init),
      respondWith: (work) => (answered = work),
      waitUntil() {},
    });
    return answered ? await answered : undefined;
  }

  return {
    dispatch,
    request,
    shown,
    opened,
    fetched,
    stores: storage.stores,
    added: storage.added,
    claimed: () => claimed,
    skipped: () => skipped,
  };
}

const build = { build: 'abc123def456', shell: ['/index.html', '/main-X.js', '/styles-Y.css', '/cawdev-progress.js'] };

const push = (payload) => ({ data: { json: () => payload } });

/** Objects made inside the vm have the vm's prototypes; compare by shape. */
const plain = (value) => JSON.parse(JSON.stringify(value));

const question = {
  v: 1,
  kind: 'question',
  project: 'cawdev',
  tag: 'q:1',
  title: 'A question is waiting on cawdev',
  url: '/inbox?question=1',
};

test('a question is shown under the server\'s tag, carrying only its URL', async () => {
  const sw = worker();
  await sw.dispatch('push', push(question));

  assert.equal(sw.shown.length, 1);
  assert.equal(sw.shown[0].title, 'A question is waiting on cawdev');
  assert.equal(sw.shown[0].tag, 'q:1');
  assert.deepEqual(plain(sw.shown[0].data), { url: '/inbox?question=1' });
  // Nothing the agent wrote: the envelope has no body and none is invented.
  assert.equal(sw.shown[0].body, undefined);
});

test('an approval is shown the same way', async () => {
  const sw = worker();
  await sw.dispatch('push', push({ ...question, kind: 'approval', tag: 'a:1', url: '/inbox?approval=1' }));

  assert.equal(sw.shown[0].tag, 'a:1');
  assert.deepEqual(plain(sw.shown[0].data), { url: '/inbox?approval=1' });
});

test('a resolved replaces the one showing under its tag, quietly', async () => {
  const sw = worker({ showing: [{ tag: 'q:1' }] });
  await sw.dispatch('push', push({ ...question, kind: 'resolved', title: 'Answered by Bob on cawdev' }));

  assert.equal(sw.shown.length, 1);
  assert.equal(sw.shown[0].title, 'Answered by Bob on cawdev');
  assert.equal(sw.shown[0].tag, 'q:1');
  assert.equal(sw.shown[0].silent, true);
});

test('a resolved with nothing showing draws nothing', async () => {
  const sw = worker({ showing: [{ tag: 'q:other' }] });
  await sw.dispatch('push', push({ ...question, kind: 'resolved', title: 'Answered by Bob on cawdev' }));

  assert.equal(sw.shown.length, 0);
});

test('a test push says notifications are working', async () => {
  const sw = worker();
  await sw.dispatch('push', push({ v: 1, kind: 'test', tag: 't:1', title: 'A test from cawdev', url: '/settings/notifications' }));

  assert.equal(sw.shown[0].title, 'Notifications are working');
  assert.equal(sw.shown[0].tag, 't:1');
  assert.deepEqual(plain(sw.shown[0].data), { url: '/settings/notifications' });
});

test('a push it does not understand draws nothing', async () => {
  const sw = worker();
  await sw.dispatch('push', { data: null });
  await sw.dispatch('push', { data: { json: () => { throw new Error('not json'); } } });
  await sw.dispatch('push', push({ v: 2, kind: 'question', tag: 'q:1' }));
  await sw.dispatch('push', push({ v: 1, kind: 'something-new', tag: 'x:1' }));

  assert.equal(sw.shown.length, 0);
});

test('a click reuses a window on this origin: focused and told the URL', async () => {
  const posted = [];
  let focused = 0;
  const other = { url: 'https://elsewhere.example/', focused: true, postMessage() {}, focus() {} };
  const ours = {
    url: 'https://caw.example/projects/cawdev',
    focused: false,
    postMessage: (message) => posted.push(message),
    focus: () => { focused++; return Promise.resolve(ours); },
  };
  const sw = worker({ windows: [other, ours] });
  await sw.dispatch('notificationclick', {
    notification: { close() {}, data: { url: '/inbox?question=1' } },
  });

  assert.deepEqual(plain(posted), [{ type: 'open', url: '/inbox?question=1' }]);
  assert.equal(focused, 1);
  assert.equal(sw.opened.length, 0);
});

test('a click with no window on this origin opens one on the URL', async () => {
  const sw = worker({ windows: [] });
  await sw.dispatch('notificationclick', {
    notification: { close() {}, data: { url: '/inbox?approval=1' } },
  });

  assert.deepEqual(sw.opened, ['https://caw.example/inbox?approval=1']);
});

test('a click on a notification with no URL lands on the inbox', async () => {
  const sw = worker({ windows: [] });
  await sw.dispatch('notificationclick', { notification: { close() {}, data: null } });

  assert.deepEqual(sw.opened, ['https://caw.example/inbox']);
});

// --- R243: the fetch handler ------------------------------------------------

test('unstamped — as it is in the tree — the worker caches nothing and answers nothing', async () => {
  const sw = worker();
  await sw.dispatch('install', {});
  assert.equal(sw.stores.size, 0);
  assert.equal(await sw.request('/inbox', { mode: 'navigate' }), undefined);
  assert.equal(await sw.request('/main-X.js'), undefined);
});

test('stamped, install precaches the shell past the HTTP cache and takes over at once', async () => {
  const sw = worker({ stamped: build });
  await sw.dispatch('install', {});

  assert.equal(sw.skipped(), true);
  assert.deepEqual(sw.added.map((r) => new URL(r.url).pathname), build.shell);
  assert.ok(sw.added.every((r) => r.cache === 'reload'));
  assert.deepEqual([...sw.stores.keys()], ['cawdev-shell-abc123def456']);
});

test('activate drops the caches of every earlier build, keeps its own, and claims', async () => {
  const sw = worker({
    stamped: build,
    caches: { 'cawdev-shell-old1': ['/index.html'], 'cawdev-shell-abc123def456': ['/index.html'], 'something-else': [] },
  });
  await sw.dispatch('activate', {});

  assert.deepEqual([...sw.stores.keys()].sort(), ['cawdev-shell-abc123def456', 'something-else']);
  assert.equal(sw.claimed(), true);
});

test('nothing under /api/ is answered from a cache or put in one', async () => {
  const sw = worker({ stamped: build, caches: { 'cawdev-shell-abc123def456': ['/index.html'] } });

  assert.equal(await sw.request('/api/inbox'), undefined);
  assert.equal(await sw.request('/api/auth/me', { mode: 'navigate' }), undefined);
  assert.equal(await sw.request('/api/push/subscriptions', { method: 'POST' }), undefined);
  assert.deepEqual(sw.fetched, []);
  assert.deepEqual([...sw.stores.get('cawdev-shell-abc123def456').keys()], ['https://caw.example/index.html']);
});

test('a route is the cached index.html, without touching the network', async () => {
  const sw = worker({ stamped: build, caches: { 'cawdev-shell-abc123def456': ['/index.html'] } });

  const inbox = await sw.request('/inbox?question=1', { mode: 'navigate' });
  const deep = await sw.request('/projects/cawdev/runs/42', { mode: 'navigate' });
  assert.equal(inbox.body, 'https://caw.example/index.html');
  assert.equal(deep.body, 'https://caw.example/index.html');
  assert.deepEqual(sw.fetched, []);
});

test('a navigation to a file by name is the file, not index.html', async () => {
  const sw = worker({
    stamped: build,
    caches: { 'cawdev-shell-abc123def456': ['/index.html', '/favicon.svg'] },
  });
  const icon = await sw.request('/favicon.svg', { mode: 'navigate' });
  assert.equal(icon.body, 'https://caw.example/favicon.svg');
});

test('a font is fetched once and cached: the second ask is a hit', async () => {
  const font = new FakeResponse('woff2 bytes');
  const sw = worker({ stamped: build, network: { '/media/inter-latin-ABC.woff2': font } });

  const first = await sw.request('/media/inter-latin-ABC.woff2');
  const second = await sw.request('/media/inter-latin-ABC.woff2');
  assert.equal(first.body, 'woff2 bytes');
  assert.equal(second.body, 'woff2 bytes');
  assert.deepEqual(sw.fetched, ['https://caw.example/media/inter-latin-ABC.woff2']);
});

test('a miss that the network answers badly is passed on and not kept', async () => {
  const sw = worker({ stamped: build });
  const gone = await sw.request('/chunk-OLD.js');
  assert.equal(gone.ok, false);
  assert.equal(sw.stores.get('cawdev-shell-abc123def456').size, 0);
});

test('a cross-origin request, a POST and the worker itself are left to the browser', async () => {
  const sw = worker({ stamped: build });
  assert.equal(await sw.request('https://fonts.example/x.woff2'), undefined);
  assert.equal(await sw.request('/inbox', { method: 'POST' }), undefined);
  assert.equal(await sw.request('/sw.js'), undefined);
  assert.deepEqual(sw.fetched, []);
});
