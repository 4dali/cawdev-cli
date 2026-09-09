// node --test tools/runner/permission-keys.test.mjs
//
// R60's three choices in the terminal — R78.
//
// The console had *allow once*, *allow for this session* and *always allow
// here* from the day R60 landed; this client had two of the three, and the one
// missing was the middle one people actually reach for. Whatever the console
// gains for a stopped session, this view gains too, under the same guard — so
// the mapping from a key to a decision is a rule, and rules here are pure and
// tested rather than buried in a switch inside a full-screen renderer.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { permissionBanner, permissionDecision, stripAnsi, visibleWidth } from './attach.mjs';

const request = (over = {}) => ({
  id: 'a1',
  toolName: 'Bash',
  summary: 'mvn --version',
  suggestion: 'Bash(mvn *)',
  askedAt: '2026-09-03T10:04:02Z',
  ...over,
});

// --- what a key means ---------------------------------------------------------

test('y is this call and no more', () => {
  assert.deepEqual(permissionDecision(request(), 'y'), { allow: true, scope: 'ONCE' });
});

test('s is R60: the rest of this run, and no longer', () => {
  assert.deepEqual(permissionDecision(request(), 's'),
    { allow: true, scope: 'SESSION', pattern: 'Bash(mvn *)' });
});

test('s falls back to the whole tool when no narrower rule can be written', () => {
  // The two sizes the console offers as two buttons. A terminal has one key, so
  // it takes the narrow one when there is one — and the broad one is still
  // bounded by the run, which is what makes choosing for the operator fair.
  assert.deepEqual(permissionDecision(request({ suggestion: null }), 's'),
    { allow: true, scope: 'SESSION', pattern: 'Bash' });
});

test('Y is the standing rule, and only when there is one to write', () => {
  assert.deepEqual(permissionDecision(request(), 'Y'),
    { allow: true, scope: 'PROJECT', pattern: 'Bash(mvn *)' });

  // A compound command the matcher refuses to settle from its first word. The
  // caller says so rather than sending a decision with nothing to remember,
  // which the server would quietly turn into an allow-once.
  assert.equal(permissionDecision(request({ suggestion: null }), 'Y'), null);
});

test('nothing else is a decision', () => {
  for (const key of ['n', 'a', 'i', 'q', '']) {
    assert.equal(permissionDecision(request(), key), null, key);
  }
});

// --- and what the banner offers -----------------------------------------------

const banner = (approval, width = 80, machine = {}) =>
  permissionBanner(approval, width, undefined, machine).map(stripAnsi).join('\n');

test('the banner offers all three, plus the refusal', () => {
  const said = banner(request());
  assert.match(said, /mvn --version/, 'the command, read before it is allowed');
  assert.match(said, /y allow once/);
  assert.match(said, /s allow Bash\(mvn \*\) this session/);
  assert.match(said, /Y always allow Bash\(mvn \*\) here/);
  assert.match(said, /n refuse/);
});

test('with no rule to write, Y is not offered and s says what it covers', () => {
  const said = banner(request({ suggestion: null }));
  assert.doesNotMatch(said, /always allow/, 'a key that cannot be honoured is not offered');
  assert.match(said, /s allow every Bash this session/,
    'the broad grant has to say it is broad');
});

test('no line is wider than the pane it is drawn in', () => {
  for (const width of [80, 60, 46, 30]) {
    for (const approval of [request(), request({ suggestion: null })]) {
      for (const line of permissionBanner(approval, width)) {
        assert.ok(visibleWidth(line) <= width,
          `${visibleWidth(line)} > ${width}: ${stripAnsi(line)}`);
      }
    }
  }
});

test('nothing pending is nothing drawn', () => {
  assert.deepEqual(permissionBanner(null, 80), []);
});

// --- R126: the fourth length of yes -------------------------------------------

test('M is a rule on the MACHINE, and only when the machine takes them', () => {
  const approval = { toolName: 'Bash', suggestion: 'Bash(mvn *)' };

  assert.deepEqual(permissionDecision(approval, 'M', { acceptsConsoleRules: true }),
    { allow: true, scope: 'RUNNER', pattern: 'Bash(mvn *)' });

  // A machine whose own config does not accept console rules would have the
  // rule written and never applied. Offering the key anyway is how a terminal
  // comes to take an answer the platform then refuses.
  assert.equal(permissionDecision(approval, 'M', { acceptsConsoleRules: false }), null);
  assert.equal(permissionDecision(approval, 'M', {}), null);
});

test('M needs a pattern, exactly as Y does', () => {
  // A compound command the server could write no rule for. A decision with
  // nothing to remember would silently become an allow-once.
  const compound = { toolName: 'Bash', suggestion: null };
  assert.equal(permissionDecision(compound, 'M', { acceptsConsoleRules: true }), null);
});

test('the banner offers M only when the machine takes rules', () => {
  const pending = { approval: { toolName: 'Bash', suggestion: 'Bash(mvn *)' } };

  const offered = banner(pending, 120, { acceptsConsoleRules: true });
  assert.match(offered, /M always, on this machine/);

  const not = banner(pending, 120, {});
  assert.doesNotMatch(not, /\bM\b/);
  // And the other three are untouched by its absence.
  assert.match(not, /y once|y allow once/);
  assert.match(not, /n refuse/);
});

test('on a narrow terminal M goes with Y, never instead of it', () => {
  const pending = { approval: { toolName: 'Bash', suggestion: 'Bash(mvn *)' } };
  const narrow = banner(pending, 30, { acceptsConsoleRules: true });

  // Both are standing rules and M is the WIDER of the two. Dropping Y while
  // keeping M would leave the narrow terminal offering the bigger grant.
  const hasY = /\bY\b/.test(narrow);
  const hasM = /\bM\b/.test(narrow);
  assert.equal(hasM, hasY, `M and Y must come and go together: ${narrow}`);
  assert.match(narrow, /n refuse|refuse/);
});

// --- R135: the command that could never become a wildcard ----------------------

const exact = (over = {}) => request({
  summary: 'cd backend && ./mvnw test',
  suggestion: null,
  exactPattern: 'Bash(cd backend && ./mvnw test)',
  exactWithinCeiling: true,
  ...over,
});

test('Y writes the exact command when this machine would apply it', () => {
  assert.deepEqual(permissionDecision(exact(), 'Y'),
    { allow: true, scope: 'PROJECT', pattern: 'Bash(cd backend && ./mvnw test)' });

  // Outside the ceiling the rule would be dropped here on every call, so the
  // key is not offered — the same "a key that takes an answer the platform
  // then refuses" rule `M` follows.
  assert.equal(permissionDecision(exact({ exactWithinCeiling: false }), 'Y'), null);
});

test('M writes it even outside the ceiling, because that scope raises it', () => {
  assert.deepEqual(
    permissionDecision(exact({ exactWithinCeiling: false }), 'M', { acceptsConsoleRules: true }),
    { allow: true, scope: 'RUNNER', pattern: 'Bash(cd backend && ./mvnw test)' },
  );
});

test('an exact rule is described rather than spelled out in the key row', () => {
  // R78: a grant is never cut short, and this pattern is as long as the command
  // — which is already on the line above, verbatim. So `Y` says what it does
  // and the command speaks for itself.
  const said = banner(exact());
  assert.match(said, /Y always allow this exact command here/);
  assert.doesNotMatch(said, /Y always allow Bash\(cd backend/);
  assert.match(said, /cd backend && \.\/mvnw test/, 'the command itself is still shown');
});

test('a long exact command still fits every pane it is drawn in', () => {
  const long = exact({
    summary: `cd backend && ./mvnw -q -DskipTests package ${'x'.repeat(60)}`,
    exactPattern: `Bash(cd backend && ./mvnw -q -DskipTests package ${'x'.repeat(60)})`,
  });
  for (const width of [80, 60, 46, 30]) {
    for (const line of permissionBanner(long, width, undefined, { acceptsConsoleRules: true })) {
      assert.ok(visibleWidth(line) <= width,
        `${visibleWidth(line)} > ${width}: ${stripAnsi(line)}`);
    }
  }
});
