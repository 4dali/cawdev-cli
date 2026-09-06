// node --test tools/runner/openapi.test.mjs
//
// Every `/api/…` the CLI calls is one the platform actually serves.
//
// This exists because of a 404 that no test could have caught. `mintRunnerToken`
// asked for `POST /api/agent-tokens` — the name on the console's *page* rather
// than the one on the endpoint, which is `/api/tokens` and always was. So R93's
// whole promise, a machine that mints its own token, had never worked once
// against a real platform.
//
// **The tests passed the entire time, and that is the interesting part.** The
// fake session in `bootstrap.test.mjs` answered `/api/agent-tokens`, because it
// was written from the same assumption as the code it was testing. A fake built
// from the same guess as the caller agrees with the caller about everything,
// including the parts that are wrong; all it can prove is that the code calls
// itself consistently.
//
// So this checks the one thing a fake never can: the paths against
// `openapi.yaml`, which is the contract the backend is held to from the other
// side by `OpenApiCoverageTest`. Same instinct as that test, one layer out —
// and the same instinct as `configs.test.mjs`, which exists because a file
// nothing imports can sit broken on `main` indefinitely.
//
// Zero dependencies, so the "parser" is a line scan for the two shapes that
// appear in a path list. `openapi.yaml` is hand-edited and this only needs the
// top-level keys under `paths:`.

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS = dirname(HERE);
const SPEC = join(TOOLS, '..', 'openapi.yaml');

/** The paths `openapi.yaml` declares — the two-space keys under `paths:`. */
async function declaredPaths() {
  const text = await readFile(SPEC, 'utf8');
  const paths = new Set();
  let inPaths = false;
  for (const line of text.split('\n')) {
    if (/^paths:\s*$/.test(line)) {
      inPaths = true;
      continue;
    }
    if (inPaths && /^\S/.test(line)) {
      break; // Out of `paths:` and into the next top-level key.
    }
    const match = inPaths && line.match(/^ {2}(\/\S*):\s*$/);
    if (match) {
      paths.add(match[1]);
    }
  }
  return paths;
}

/** Every `request('/api/…')` in the CLI, with the file it is in. */
async function pathsCalled() {
  const files = [];
  for (const dir of [HERE, join(TOOLS, 'lib')]) {
    for (const name of await readdir(dir)) {
      if (name.endsWith('.mjs') && !name.endsWith('.test.mjs')) {
        files.push(join(dir, name));
      }
    }
  }

  const calls = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(/request\(\s*'(\/api\/[^']*)'/g)) {
      calls.push({ file: file.slice(TOOLS.length + 1), path: match[1] });
    }
  }
  return calls;
}

test('openapi.yaml declares the paths this test reads', async () => {
  const declared = await declaredPaths();

  // Not an empty pass. A scan that quietly matched nothing would make every
  // assertion below vacuously true, which is the way this kind of test dies.
  assert.ok(declared.size > 20, `only found ${declared.size} paths in openapi.yaml`);
  assert.ok(declared.has('/api/tokens'), 'the scan missed a path that is certainly there');
});

test('every /api path the CLI calls is one the spec declares', async () => {
  const declared = await declaredPaths();
  const calls = await pathsCalled();

  assert.ok(calls.length > 5, `only found ${calls.length} API calls in the tools`);

  for (const { file, path } of calls) {
    // The query string is the caller's business — `/api/inbox?wait=20` is the
    // long poll, and the spec declares the parameter rather than the string.
    const declaredPath = path.split('?')[0];
    assert.ok(
      declared.has(declaredPath),
      `${file} calls ${declaredPath}, which openapi.yaml does not declare. `
        + 'If the endpoint is real, the spec is missing it; if the spec is right, this is a 404 '
        + 'waiting for somebody to run the command.',
    );
  }
});

test('the mint goes to the endpoint and not to the name on the console page', async () => {
  // Named on its own, because this is the one that was wrong and a general
  // failure message would not say what to look at. `/api/agent-tokens` is what
  // the tokens PAGE is called; the endpoint under it is `/api/tokens`.
  const bootstrap = await readFile(join(HERE, 'bootstrap.mjs'), 'utf8');

  assert.ok(bootstrap.includes("request('/api/tokens'"), 'the mint no longer calls /api/tokens');
  assert.ok(!bootstrap.includes("request('/api/agent-tokens'"), '/api/agent-tokens is a 404');
});
