// node --test tools/runner/configs.test.mjs
//
// Every runner config checked into this repository parses.
//
// This exists because one did not. `macbook-laptop.json` was committed with
// unresolved merge-conflict markers still in it — `<<<<<<< Updated upstream`
// and the rest — and sat on `main` invalid. Nothing noticed, because the daemon
// reads the file on somebody's disk rather than the one in git, and the machine
// that had a good copy locally went on running perfectly.
//
// That is the shape of the failure worth guarding: a config is the one kind of
// file a repository can hold in a broken state indefinitely without any test
// failing, because nothing imports it. So this imports it.

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));

test('every runner config in the repository is valid JSON', async () => {
  const configs = (await readdir(HERE)).filter((name) => name.endsWith('.json'));

  // Not an empty pass. If the configs move or are renamed away, this test
  // should be deleted deliberately rather than quietly succeeding on nothing.
  assert.ok(configs.length > 0, 'no runner configs found beside runner.mjs');

  for (const name of configs) {
    const text = await readFile(join(HERE, name), 'utf8');

    // Named before parsing, because `JSON.parse` reports a position and not a
    // file, and "Unexpected token < at position 264" in a test run over
    // several configs is a message that sends you looking in the wrong one.
    assert.doesNotThrow(
      () => JSON.parse(text),
      new RegExp('.'),
      `${name} is not valid JSON`,
    );

    const config = JSON.parse(text);
    assert.ok(config.name, `${name} names no runner`);
    assert.ok(config.projects && typeof config.projects === 'object',
      `${name} serves no projects`);
  }
});

test('no config carries merge-conflict markers', async () => {
  // Belt and braces, and it says the real thing in the failure. A conflict
  // marker usually makes a file invalid JSON too, so the test above would
  // catch it — but not always, and "not valid JSON" is a worse message than
  // "you committed a conflict".
  const configs = (await readdir(HERE)).filter((name) => name.endsWith('.json'));

  for (const name of configs) {
    const text = await readFile(join(HERE, name), 'utf8');
    for (const marker of ['<<<<<<<', '=======', '>>>>>>>']) {
      assert.ok(!text.includes(marker), `${name} still has a "${marker}" conflict marker`);
    }
  }
});
