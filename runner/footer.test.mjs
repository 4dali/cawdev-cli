// node --test tools/runner/footer.test.mjs
//
// R81 — what is pinned, and what it says when the colour is taken away.
//
// R62's rule holds and is why these are functions rather than draw methods: a
// bar built inside a renderer can only be checked by looking at it, and the
// arithmetic in it is exactly the kind that is wrong by ten characters in a way
// nobody notices until a session goes red.
//
// The footer is the one thing R81 makes permanent, so what is pinned here is
// that it CARRIES the five things the entry names — which cawdev, who you are,
// this machine's runner, the per-project counts and the total — at every width,
// and that none of them is carried by a colour alone.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { painter, stripAnsi } from '../lib/ansi.mjs';
import {
  farewell, footerLines, keyList, keysIn, permissionBanner, questionBanner, runLine,
} from './attach.mjs';

const runner = {
  name: 'macbook',
  url: 'http://localhost:8091',
  projects: ['dycrypt', 'cawdev'],
  workspaces: { dycrypt: 1, cawdev: 2 },
  maxSessions: 4,
  pid: 4242,
};

const runs = [
  { id: 'a', label: 'R81 — one word', projectSlug: 'cawdev', state: 'running', writesCode: true },
  { id: 'b', label: 'R80 — something else', projectSlug: 'cawdev', state: 'queued',
    why: 'no free workspace in cawdev (2 here, all busy)' },
];

const drawn = (state, width = 100, depth = 3) =>
  footerLines({ runner, runs, ...state }, width, painter(depth)).map(stripAnsi);

// --- the five fixed answers ---------------------------------------------------

test('the footer carries all five settings at once, and never scrolls away', () => {
  const said = drawn({ email: 'dali@cawdev.test', watching: runs[0] }).join('\n');

  assert.match(said, /http:\/\/localhost:8091/, 'which cawdev');
  assert.match(said, /dali@cawdev\.test/, 'who you are signed in as');
  assert.match(said, /macbook/, "this machine's runner");
  assert.match(said, /dycrypt 0\/1/, "R47's per-project gate");
  assert.match(said, /cawdev 1\/2/, 'and how full it is');
  assert.match(said, /sessions 1\/4/, "the machine's own cap");
});

test('the run being watched is on the footer, because that is what enter prompts', () => {
  const said = drawn({ email: 'dali@cawdev.test', watching: runs[0] }).join('\n');
  assert.match(said, /R81 — one word/);
  assert.match(said, /cawdev · running/);
});

test('with nothing to watch it says what to press rather than showing a gap', () => {
  const said = drawn({ email: 'dali@cawdev.test', watching: null }).join('\n');
  assert.match(said, /nothing being watched/);
  assert.match(said, /L lists/);
});

test('not signed in is a state with a name, not an empty space', () => {
  // "watching only" is not a lesser state — it is the honest one, and R52's
  // whole split is that you can watch without signing in.
  assert.match(drawn({ email: null }).join('\n'), /watching only/);
});

test('a dropped socket says so, in a word as well as a colour', () => {
  assert.match(drawn({ email: 'x@y.z', connected: false }).join('\n'), /detached/);
});

test('every line of the footer is exactly the width it was given', () => {
  // Everything here is coloured, and a coloured string is about ten characters
  // longer than it looks. This is the assertion R62 wrote after "2/2sessions"
  // appeared on screen with no space between them.
  for (const width of [120, 100, 80, 64, 40]) {
    const lines = footerLines(
      { runner, runs, email: 'dali@cawdev.test', watching: runs[0], keys: 'q quit' },
      width, painter(3),
    );
    for (const line of lines) {
      assert.equal(stripAnsi(line).length, width, `at ${width} columns: ${stripAnsi(line)}`);
    }
  }
});

test('with the colour taken away it is the same information', () => {
  const said = drawn({ email: 'dali@cawdev.test', watching: runs[0] }, 100, 0).join('\n');
  assert.match(said, /http:\/\/localhost:8091/);
  assert.match(said, /macbook/);
  assert.match(said, /cawdev 1\/2/);
  assert.match(said, /sessions 1\/4/);
  // The mark cannot be drawn in one colour, so it says its name instead.
  assert.match(said, /cawdev/);
});

test('no escape sequence survives NO_COLOR', () => {
  const lines = footerLines(
    { runner, runs, email: 'dali@cawdev.test', watching: runs[0], keys: 'q quit', status: 'sent' },
    80, painter(0),
  );
  for (const line of lines) {
    assert.equal(stripAnsi(line), line);
  }
});

// --- what is blocking somebody goes above everything else --------------------

test('a permission request offers three reaches, and each one is a word', () => {
  // R60: the useful answer was the missing one. Somebody unblocking a session
  // at 2am wants neither "ask me again in ninety seconds" nor "decide policy
  // for every agent that ever runs here".
  const said = permissionBanner({
    approval: {
      id: '1', summary: 'mvn -q test', toolName: 'Bash',
      suggestion: 'Bash(mvn *)', askedAt: '2026-09-04T10:11:12Z',
    },
  }, 100, painter(3)).map(stripAnsi).join('\n');

  assert.match(said, /permission/);
  assert.match(said, /mvn -q test/);
  assert.match(said, /y allow once/);
  assert.match(said, /s allow for this session/);
  assert.match(said, /n refuse/);
  assert.match(said, /Y always allow Bash\(mvn \*\)/);
});

test('a request with no suggestion does not offer a rule there is nothing to write', () => {
  const said = permissionBanner({
    approval: { id: '1', summary: 'rm -rf build', toolName: 'Bash', askedAt: '2026-09-04T10:11:12Z' },
  }, 100, painter(3)).map(stripAnsi).join('\n');
  assert.doesNotMatch(said, /always allow/);
});

test("a question that is not yours names the person instead of offering a key", () => {
  // R58. A terminal that let somebody type an answer and then refused it reads
  // as cawdev being broken rather than as the question belonging to a
  // colleague.
  const mine = questionBanner(
    { question: { question: 'Which branch?', options: ['main', 'r81'] }, yours: true },
    100, painter(3),
  ).map(stripAnsi).join('\n');
  assert.match(mine, /a answer/);
  assert.match(mine, /main \/ r81/);

  const theirs = questionBanner(
    { question: { question: 'Which branch?' }, yours: false, waitingOn: 'alice@cawdev.test' },
    100, painter(3),
  ).map(stripAnsi).join('\n');
  assert.doesNotMatch(theirs, /a answer/);
  assert.match(theirs, /waiting on alice@cawdev\.test/);
});

test('at forty columns the name survives and the courtesy is what goes', () => {
  const narrow = questionBanner(
    { question: { question: 'Which branch?' }, yours: false, waitingOn: 'alice@cawdev.test' },
    40, painter(3),
  ).map(stripAnsi).join('\n');
  assert.match(narrow, /alice@cawdev\.test/, '"why is that not moving" is the whole answer');
  assert.doesNotMatch(narrow, /courtesy|hand it to/);
});

test('the banner is above the settings, because it is the only blocking thing', () => {
  const lines = drawn({
    email: 'dali@cawdev.test',
    watching: runs[0],
    banner: permissionBanner({
      approval: { id: '1', summary: 'mvn test', toolName: 'Bash', askedAt: '2026-09-04T10:11:12Z' },
    }, 100, painter(3)),
  });
  const said = lines.join('\n');
  assert.ok(said.indexOf('mvn test') < said.indexOf('sessions 1/4'));
});

// --- the run list -------------------------------------------------------------

test('a queued run carries its reason on the same line as the run', () => {
  // That reason exists nowhere else, and a list that makes you press a key for
  // it has hidden the answer behind the question.
  const line = stripAnsi(runLine(runs[1], { chosen: false, number: '2' }, 100, painter(3)));
  assert.match(line, /R80 — something else/);
  assert.match(line, /cawdev · queued/);
  assert.match(line, /no free workspace in cawdev \(2 here, all busy\)/);
});

test('a running one has no reason to give, and does not invent one', () => {
  const line = stripAnsi(runLine(runs[0], { chosen: true, number: '1' }, 100, painter(3)));
  assert.match(line, /^❯/, 'the one you are on is marked');
  // The line ENDS at the state. A card's own title has an em dash in it, so
  // the absence of a reason is the absence of a clause after `running`.
  assert.match(line, /cawdev · running$/);
});

test('the run list still reads with the colour taken away', () => {
  const line = runLine(runs[1], { chosen: false, number: '2' }, 100, painter(0));
  assert.equal(stripAnsi(line), line);
  assert.match(line, /queued/, 'the state is a word, not a colour');
});

// --- the goodbye ---------------------------------------------------------------

test('quitting names the runner it is leaving behind and how to stop it', () => {
  // The entry is explicit: a background process you did not know you started is
  // the cost of `cawdev` launching one, and it should be paid out loud.
  const said = stripAnsi(farewell(runner, runs, painter(3)).join('\n'));
  assert.match(said, /macbook/);
  assert.match(said, /still driving 1 session\b/, 'a queued run is not a session it is driving');
  assert.match(said, /kill 4242/);
});

test('a daemon too old to say its pid still gets a sentence that works', () => {
  const said = stripAnsi(farewell({ name: 'macbook' }, [], painter(3)).join('\n'));
  assert.match(said, /macbook/);
  assert.doesNotMatch(said, /kill undefined/);
});

// --- what goes when there is not enough room ---------------------------------

test('the keys row drops whole keys rather than cutting one in half', () => {
  // At sixty columns this row used to end `x c`, and at forty `y/`. That is not
  // a shorter list, it is a list with a typo at the end of it.
  const keys = ['enter prompt', '/ commands', 'L runs', 'y/s/n permission', 'x cancel', 'q quit'];
  const narrow = stripAnsi(keyList(keys, '', 40, painter(3)));

  assert.ok(narrow.length <= 40);
  assert.match(narrow, /…$/, 'and it says that it was cut');
  for (const key of keys) {
    // Every key that IS shown is shown whole.
    const shown = narrow.replace(/ …$/, '').split(' · ');
    assert.ok(shown.every((each) => keys.includes(each)), narrow);
  }
});

test('the status goes before any key does — it is about something already done', () => {
  const keys = ['enter prompt', '/ commands'];
  assert.match(stripAnsi(keyList(keys, 'sent', 100, painter(3))), /sent$/);
  assert.doesNotMatch(stripAnsi(keyList(keys, 'sent', 26, painter(3))), /sent/);
});

test('at forty columns the mark goes and the email stays', () => {
  // The mark is the only decoration in the program, so it is the first thing to
  // go: it was costing eight columns and cutting the email in half, and "who am
  // I acting as" is an answer while a logo is a mood.
  const long = { ...runner, name: 'macbook-laptop' };
  const at = (width) => footerLines(
    { runner: long, runs, email: 'dali@cawdev.test', watching: runs[0] }, width, painter(3),
  ).map(stripAnsi).join('\n');

  assert.match(at(100), /●▸/, 'there is room, so the mark is there');
  assert.doesNotMatch(at(40), /●▸/);
  assert.match(at(40), /macbook-laptop · dali@cawdev\.test/, 'and both answers fit without it');
});

test('a queued run keeps its whole reason, and the title is what shortens', () => {
  const long = {
    id: 'c', projectSlug: 'cawdev', state: 'queued',
    label: 'R80 — a card with a title long enough to use every column it is given',
    why: 'no free workspace in cawdev (2 here, all busy)',
  };
  const line = stripAnsi(runLine(long, { chosen: false, number: '2' }, 100, painter(3)));
  assert.match(line, /no free workspace in cawdev \(2 here, all busy\)$/);
  assert.ok(line.length <= 100);
});

test('the three permission keys survive a forty-column terminal', () => {
  const said = permissionBanner({
    approval: {
      id: '1', summary: 'mvn test', toolName: 'Bash',
      suggestion: 'Bash(mvn *)', askedAt: '2026-09-04T10:11:12Z',
    },
  }, 40, painter(3)).map(stripAnsi);

  const keys = said[2];
  assert.ok(keys.length <= 40, keys);
  assert.match(keys, /y once/);
  assert.match(keys, /s session/);
  // The one that would have gone, and the one somebody reaches for when they do
  // not like what they are looking at.
  assert.match(keys, /n refuse/);
  assert.doesNotMatch(keys, /always allow/, 'the standing rule is what is dropped first');
});

// --- one chunk is not one keypress -------------------------------------------

test('a chunk of stdin is split into the keystrokes it actually contains', () => {
  // The bug a real terminal found: `help\r` arrives as ONE data event, the
  // whole string was compared against '\r', and `/help` sat on the prompt line
  // with nothing happening while the next key landed in it.
  assert.deepEqual(keysIn('help\r'), ['h', 'e', 'l', 'p', '\r']);
  assert.deepEqual(keysIn('q'), ['q']);
  assert.deepEqual(keysIn(''), []);
});

test('an escape sequence is one key, and a bare escape is Escape', () => {
  // `ESC[B` is Down, not three characters. Splitting it would move the cursor
  // and then type `[B` into whatever was open.
  assert.deepEqual(keysIn('\x1b[B'), ['\x1b[B']);
  assert.deepEqual(keysIn('\x1b[5~'), ['\x1b[5~']);
  assert.deepEqual(keysIn('\x1bOA'), ['\x1bOA']);
  assert.deepEqual(keysIn('\x1b'), ['\x1b']);
  assert.deepEqual(keysIn('\x1b[Bx'), ['\x1b[B', 'x']);
});

test('a paste is characters, not one enormous key', () => {
  const pasted = 'fix the thing\nand the other';
  assert.equal(keysIn(pasted).length, pasted.length);
  assert.equal(keysIn(pasted).join(''), pasted);
});
