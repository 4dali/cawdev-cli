// node --test tools/runner/served-tools.test.mjs
//
// Every tool the MCP server serves is a tool some run is allowed to call.
//
// This exists because the allow-list has been caught a tool short four times.
// `roadmap_comment` was served since R37, its README documented it, and the
// REVIEW prompt told a session to file findings with it — while no allow-list
// named it, so the call was refused and the findings died in the transcript.
// `issue_list` was the same, leaving an ASK session unable to be asked what was
// broken. `issue_file`, `propose_entry` and R96's four round tools were the
// same again.
//
// The failure is silent by construction, which is why a test has to be the
// thing that notices. A non-coding profile is spawned without
// `--permission-prompt-tool`, so an unlisted tool is not a question somebody
// declines — it is a refusal with nothing on screen. And the server's tool list
// and the daemon's allow-list are edited in different files by different
// changes, so nothing forces the second when somebody writes the first.
//
// Read as text rather than imported: `server.mjs` and `runner.mjs` are daemons
// that read config and open sockets on import, and the claim here is about two
// lists of strings — which is `stage-tools.mjs`'s own argument for living in
// `lib/`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const server = readFileSync(join(here, '..', 'mcp', 'server.mjs'), 'utf8');
const runner = readFileSync(join(here, 'runner.mjs'), 'utf8');

/** The tools the MCP server declares, by the shape its registry is written in. */
function served() {
  return [...server.matchAll(/^ {4}name: '([a-z_]+)',$/gm)].map((match) => match[1]);
}

/** Every `mcp__cawdev__` name the daemon mentions anywhere. */
function named() {
  return new Set([...runner.matchAll(/'mcp__cawdev__([a-z_]+)'/g)].map((match) => match[1]));
}

test('the registry is read at all', () => {
  // If the regex above stops matching, every assertion below passes vacuously
  // and this file becomes decoration. So the count is asserted first.
  assert.ok(served().length > 20,
    `only found ${served().length} served tools — the registry's shape has changed`);
});

test('every served tool is allowed to somebody', () => {
  const allowed = named();
  const missing = served().filter((tool) => !allowed.has(tool));
  assert.deepEqual(missing, [],
    `served by the MCP server and named in no allow-list: ${missing.join(', ')}. `
    + 'A served tool no run may call is a tool that does not exist, and the refusal '
    + 'is silent.');
});

test('the one platform write a PLAN stage may hold is actually served — R150', () => {
  // `READ_ONLY_CAWDEV` is DERIVED from `DEFAULTS.agentArgs`, and
  // `PROFILE_TOOLS.PLAN` appends `CARD_WRITE` to it. So a cardless plan session
  // gets `roadmap_create` only if that string is in the coding defaults in the
  // first place — and if it ever is not, the failure is a session that says out
  // loud it cannot write a card and wastes the run it was started for.
  //
  // Asserted rather than assumed, in the file that exists because this
  // allow-list has been caught a tool short four times.
  assert.ok(served().includes('roadmap_create'),
    'the MCP server no longer serves roadmap_create');
  assert.match(runner, /^ {4}'mcp__cawdev__roadmap_create',$/m,
    'roadmap_create is not in the daemon\'s DEFAULTS.agentArgs, so a cardless '
    + 'PLAN run cannot write the card it was started to write');
});

test('the daemon does not allow a tool that no longer exists', () => {
  // The other direction, and a much smaller problem — a stale name allows
  // nothing. Worth saying anyway: it is how a list starts describing a server
  // that has moved on, and the next person reads it as the contract.
  const exists = new Set(served());
  const stale = [...named()].filter((tool) => !exists.has(tool));
  assert.deepEqual(stale, [],
    `named in the daemon but served by nothing: ${stale.join(', ')}`);
});
