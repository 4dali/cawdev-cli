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

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', '..', 'frontend', 'public', 'sw.js'), 'utf8');

/** A worker global scope: the listeners it registered, and what it drew. */
function worker({ showing = [], windows = [] } = {}) {
  const listeners = {};
  const shown = [];
  const opened = [];
  const self = {
    location: { origin: 'https://caw.example' },
    skipWaiting() {},
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
    claim: () => Promise.resolve(),
    matchAll: () => Promise.resolve(windows),
    openWindow(url) {
      opened.push(url);
      return Promise.resolve();
    },
  };
  const context = vm.createContext({ self, clients, URL, Object, Promise });
  vm.runInContext(source, context);

  /** Dispatches one event and waits for whatever the handler put in `waitUntil`. */
  async function dispatch(name, event) {
    let pending = Promise.resolve();
    listeners[name]({ ...event, waitUntil: (work) => (pending = work) });
    await pending;
  }

  return { dispatch, shown, opened };
}

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
