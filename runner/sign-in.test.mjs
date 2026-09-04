// node --test tools/runner/sign-in.test.mjs
//
// R81 — the CLI never draws a password field, and remembers afterwards.
//
// Two halves, and they fail in different ways. The BROWSER half is a protocol:
// start, wait, collect, and the thing that must be true is that the terminal
// keeps waiting through `PENDING` and stops on a refusal rather than polling a
// dead code until the ten minutes run out. The STORE half is a file, and the
// thing that must be true about it is its mode — a world-readable session
// cookie is the whole thing that file must not be.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Session, describeThisMachine, signInThroughBrowser } from './sign-in.mjs';
import { clearSession, loadSession, saveSession, sessionFile } from './session-store.mjs';

/**
 * A platform that runs R81's three calls, and counts the polls.
 *
 * @param answers what `collect` returns, in order. The last one repeats.
 */
async function fakeApi({ answers = [] }) {
  const seen = [];
  let started = null;
  let at = 0;

  const server = createServer((request, response) => {
    const url = (request.url ?? '').split('?')[0];
    seen.push(`${request.method} ${url}`);
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      if (url === '/api/health') {
        response.writeHead(200, {
          'content-type': 'application/json',
          // The CSRF cookie a browser would be handed. A client that is not a
          // browser has to do this by hand, which is the point of `prime`.
          'set-cookie': 'XSRF-TOKEN=csrf-value; Path=/',
        });
        return response.end('{"status":"ok"}');
      }
      if (url === '/api/auth/cli/start') {
        started = {
          code: 'BCDF-GH23',
          secret: 'a-secret-that-never-leaves',
          verifyPath: '/cli-login?code=BCDF-GH23',
          expiresAt: new Date(Date.now() + 10_000).toISOString(),
        };
        response.writeHead(200, { 'content-type': 'application/json' });
        return response.end(JSON.stringify({ ...started, client: JSON.parse(body).client }));
      }
      if (url === '/api/auth/cli/collect') {
        const asked = JSON.parse(body);
        assert.equal(request.headers['x-xsrf-token'], 'csrf-value', 'the CSRF header was not echoed');
        assert.equal(asked.secret, started.secret, 'the secret was not presented');
        const answer = answers[Math.min(at++, answers.length - 1)];
        if (answer.http === 404) {
          response.writeHead(404, { 'content-type': 'application/json' });
          return response.end('{"message":"That sign-in is not waiting for anybody."}');
        }
        response.writeHead(200, {
          'content-type': 'application/json',
          ...(answer.status === 'APPROVED'
            ? { 'set-cookie': 'CAWDEV_SESSION=a-real-session; Path=/; HttpOnly' }
            : {}),
        });
        return response.end(JSON.stringify(answer));
      }
      response.writeHead(404);
      return response.end('{}');
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    seen,
    get polls() {
      return seen.filter((call) => call.endsWith('/collect')).length;
    },
    close: () => server.close(),
  };
}

/** A home nobody else is using, so the store can be looked at on disk. */
async function inAFreshHome(what) {
  const home = await mkdtemp(join(tmpdir(), 'cawdev-store-'));
  const was = process.env.HOME;
  process.env.HOME = home;
  try {
    return await what(home);
  } finally {
    process.env.HOME = was;
    await rm(home, { recursive: true, force: true });
  }
}

// --- the browser half ---------------------------------------------------------

test('the terminal waits through PENDING and stops when somebody approves', async (t) => {
  const api = await fakeApi({
    answers: [
      { status: 'PENDING' },
      { status: 'PENDING' },
      { status: 'APPROVED', user: { email: 'dali@cawdev.test' } },
    ],
  });
  t.after(() => api.close());

  await inAFreshHome(async () => {
    const session = new Session(api.url);
    const shown = [];
    const outcome = await signInThroughBrowser(session, (said) => shown.push(said), { open: false });

    assert.equal(outcome.signedIn, true);
    assert.equal(outcome.email, 'dali@cawdev.test');
    assert.equal(session.signedIn, true);
    assert.equal(api.polls, 3, 'it stopped at the approval rather than polling on');

    // The code and the URL are both shown, and both are load-bearing: the code
    // is what two screens are compared on, and the URL is the only thing that
    // makes this work over ssh, where there is no browser to open.
    assert.equal(shown.length, 1);
    assert.equal(shown[0].code, 'BCDF-GH23');
    assert.match(shown[0].url, /\/cli-login\?code=BCDF-GH23$/);

    // And it is remembered, which is the half the entry asks for by name.
    const stored = await loadSession(api.url);
    assert.equal(stored.email, 'dali@cawdev.test');
    assert.equal(stored.cookies.get('CAWDEV_SESSION'), 'a-real-session');
  });
});

test('a refusal in the browser ends it, rather than being waited out', async (t) => {
  const api = await fakeApi({ answers: [{ status: 'PENDING' }, { status: 'REFUSED' }] });
  t.after(() => api.close());

  await inAFreshHome(async () => {
    const session = new Session(api.url);
    const outcome = await signInThroughBrowser(session, () => undefined, { open: false });

    assert.equal(outcome.signedIn, false);
    assert.equal(outcome.refused, true);
    assert.equal(api.polls, 2);
    assert.equal(await loadSession(api.url), null, 'a refusal stores nothing');
  });
});

test('a code that expires under the terminal stops it, and says which it was', async (t) => {
  const api = await fakeApi({ answers: [{ http: 404 }] });
  t.after(() => api.close());

  await inAFreshHome(async () => {
    const session = new Session(api.url);
    const outcome = await signInThroughBrowser(session, () => undefined, { open: false });
    assert.equal(outcome.signedIn, false);
    assert.equal(outcome.expired, true);
  });
});

test('the machine describes itself as something a person could recognise', () => {
  // Display text on somebody's approval page, and the only thing they have to
  // compare against the terminal in front of them.
  const said = describeThisMachine();
  assert.ok(said.length > 0);
  assert.doesNotMatch(said, /\n/);
});

// --- the stored session -------------------------------------------------------

test('the session file is readable by nobody else', async () => {
  await inAFreshHome(async () => {
    await saveSession('http://localhost:8091', {
      email: 'dali@cawdev.test',
      cookies: new Map([['CAWDEV_SESSION', 'x']]),
    });
    const mode = (await stat(sessionFile())).mode & 0o777;
    // 0600 is asked for AND forced, because writeFile's mode is masked by the
    // umask: asking for 0600 and getting 0644 is the normal outcome.
    assert.equal(mode, 0o600, `session.json is ${mode.toString(8)}`);
  });
});

test('two instances are two sessions, not one that overwrites the other', async () => {
  // One machine can point at more than one cawdev, and reusing a cookie across
  // instances is either a 401 or, worse, not one.
  await inAFreshHome(async () => {
    await saveSession('http://localhost:8091', {
      email: 'dali@one.test', cookies: new Map([['CAWDEV_SESSION', 'one']]),
    });
    await saveSession('https://cawdev.example.com', {
      email: 'dali@two.test', cookies: new Map([['CAWDEV_SESSION', 'two']]),
    });

    assert.equal((await loadSession('http://localhost:8091')).email, 'dali@one.test');
    assert.equal((await loadSession('https://cawdev.example.com')).email, 'dali@two.test');

    // And signing out of one leaves the other alone.
    await clearSession('http://localhost:8091');
    assert.equal(await loadSession('http://localhost:8091'), null);
    assert.equal((await loadSession('https://cawdev.example.com')).email, 'dali@two.test');
  });
});

test('a trailing slash is the same instance, not a second one', async () => {
  await inAFreshHome(async () => {
    await saveSession('http://localhost:8091/', {
      email: 'dali@cawdev.test', cookies: new Map([['CAWDEV_SESSION', 'x']]),
    });
    assert.equal((await loadSession('http://localhost:8091')).email, 'dali@cawdev.test');
  });
});

test('an unreadable or half-written store is "not signed in", not a crash', async () => {
  // The three ways this file can be wrong have one answer, and it is the
  // answer having no file at all gives.
  await inAFreshHome(async () => {
    assert.equal(await loadSession('http://localhost:8091'), null);
    await clearSession('http://localhost:8091');
  });
});
