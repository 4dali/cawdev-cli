// node --test tools/runner/token-store.test.mjs
//
// Where this machine's runner token lives, and the two things that must be true
// of it.
//
// **It is 0600.** It grants a machine the right to run agents in your
// repositories, and a runner is exactly the kind of box with other people on
// it. `session.json` is written this way for the same reason and the test next
// door says so; this one holds the stronger credential of the two.
//
// **It is keyed by URL.** One machine can point at more than one cawdev, and a
// token minted against one instance is not a credential at another — it is a
// 401 at best and somebody else's runner at worst.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { clearToken, loadToken, saveToken, tokenFile } from './token-store.mjs';

/** A home nobody else is using, so the store can be looked at on disk. */
async function inAFreshHome(what) {
  const home = await mkdtemp(join(tmpdir(), 'cawdev-token-'));
  const was = process.env.HOME;
  process.env.HOME = home;
  try {
    return await what(home);
  } finally {
    process.env.HOME = was;
    await rm(home, { recursive: true, force: true });
  }
}

test('a machine that has minted nothing has no token, and that is not an error', async () => {
  await inAFreshHome(async () => {
    assert.equal(await loadToken('https://cawdev.example'), null);
  });
});

test('what was minted comes back, and only for the instance it was minted at', async () => {
  await inAFreshHome(async () => {
    await saveToken('https://cawdev.example', 'cawd_one', { name: 'laptop' });
    await saveToken('http://localhost:8091', 'cawd_two', { name: 'laptop' });

    assert.equal(await loadToken('https://cawdev.example'), 'cawd_one');
    assert.equal(await loadToken('http://localhost:8091'), 'cawd_two');
    assert.equal(await loadToken('https://other.example'), null);
  });
});

test('a trailing slash is the same instance', async () => {
  await inAFreshHome(async () => {
    await saveToken('https://cawdev.example/', 'cawd_one');
    assert.equal(await loadToken('https://cawdev.example'), 'cawd_one');
  });
});

test('the file holding it is readable by nobody else', async () => {
  await inAFreshHome(async () => {
    // Twice, because `mode` on writeFile is ignored for a file that already
    // exists — the second write is where this kind of store goes wrong.
    await saveToken('https://cawdev.example', 'cawd_one');
    await saveToken('https://cawdev.example', 'cawd_two');

    assert.equal((await stat(tokenFile())).mode & 0o777, 0o600);
    assert.equal(await loadToken('https://cawdev.example'), 'cawd_two');
  });
});

test('a half-written store is a machine with no token, not a crash', async () => {
  await inAFreshHome(async (home) => {
    await saveToken('https://cawdev.example', 'cawd_one');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(home, '.cawdev', 'token.json'), '{"https://cawdev.exa');

    // The daemon is started by this, and "you have not minted one yet" is a
    // state cawdev can leave. A parse error thrown from a credential store is
    // one it cannot.
    assert.equal(await loadToken('https://cawdev.example'), null);
  });
});

test('forgetting one instance leaves the others alone', async () => {
  await inAFreshHome(async () => {
    await saveToken('https://cawdev.example', 'cawd_one');
    await saveToken('http://localhost:8091', 'cawd_two');

    await clearToken('https://cawdev.example');

    assert.equal(await loadToken('https://cawdev.example'), null);
    assert.equal(await loadToken('http://localhost:8091'), 'cawd_two');

    // And forgetting one that was never there is not an error either: it is
    // what `cawdev` does on a machine that never minted one.
    await clearToken('https://never.example');
    assert.deepEqual(
      Object.keys(JSON.parse(await readFile(tokenFile(), 'utf8'))),
      ['http://localhost:8091'],
    );
  });
});
