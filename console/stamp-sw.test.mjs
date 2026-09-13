// node --test tools/console/stamp-sw.test.mjs
//
// R243 — `frontend/stamp-sw.mjs`, the last step of `npm run build`: the build
// id and the precache list written into the built service worker. Here
// because `tools/**/*.test.mjs` is where node tests run, and beside
// `sw.test.mjs`, which runs the stamped worker.
//
// What is easy to get wrong: the digest must not depend on the worker's own
// bytes (it is the file being stamped), must change when ANY other file
// changes (a font, a design-system script), and the stamped worker must still
// be JavaScript with the list as an array.

import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { buildIdOf, shellOf, stamp } from '../../frontend/stamp-sw.mjs';

const files = [
  '/3rdpartylicenses.txt',
  '/cawdev-actions.js',
  '/cawdev-progress.js',
  '/chunk-A.js',
  '/favicon.svg',
  '/icons/icon-192.png',
  '/index.html',
  '/main-X.js',
  '/main-X.js.map',
  '/manifest.webmanifest',
  '/media/inter-latin-N.woff2',
  '/styles-Y.css',
  '/sw.js',
];

test('the shell is everything but the fonts, the worker, the maps and the licences', () => {
  assert.deepEqual(shellOf(files), [
    '/cawdev-actions.js',
    '/cawdev-progress.js',
    '/chunk-A.js',
    '/favicon.svg',
    '/icons/icon-192.png',
    '/index.html',
    '/main-X.js',
    '/manifest.webmanifest',
    '/styles-Y.css',
  ]);
});

test('the build id ignores the worker and changes with any other file', () => {
  const contents = { '/index.html': 'a', '/main-X.js': 'b', '/media/inter-latin-N.woff2': 'c', '/sw.js': 'd' };
  const read = (file) => contents[file] ?? '';
  const some = ['/index.html', '/main-X.js', '/media/inter-latin-N.woff2', '/sw.js'];

  const before = buildIdOf(some, read);
  assert.match(before, /^[0-9a-f]{12}$/);
  assert.equal(buildIdOf(some, (f) => (f === '/sw.js' ? 'changed' : read(f))), before);
  assert.notEqual(buildIdOf(some, (f) => (f === '/media/inter-latin-N.woff2' ? 'changed' : read(f))), before);
  assert.notEqual(buildIdOf(some.filter((f) => f !== '/main-X.js'), read), before);
});

test('stamping leaves JavaScript with the id and the list in place', () => {
  const source = "var BUILD = '__CAWDEV_BUILD__';\nvar SHELL = ['__CAWDEV_SHELL__'];\nvar stamped = BUILD !== '__CAWDEV' + '_BUILD__';\n";
  const out = stamp(source, { build: 'abc123def456', shell: ['/index.html', "/it's-X.js"] });

  const context = vm.createContext({});
  vm.runInContext(out, context);
  assert.equal(context.BUILD, 'abc123def456');
  assert.deepEqual([...context.SHELL], ['/index.html', "/it's-X.js"]);
  assert.equal(context.stamped, true);

  // The tree's copy, unstamped, says so.
  const dev = vm.createContext({});
  vm.runInContext(source, dev);
  assert.equal(dev.stamped, false);
});

test('a worker with no placeholders — already stamped — is refused', () => {
  assert.throws(() => stamp("var BUILD = 'abc';", { build: 'x', shell: [] }), /already stamped/);
});
