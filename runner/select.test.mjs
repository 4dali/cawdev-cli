// node --test tools/runner/select.test.mjs
//
// R83 — the one select widget, and the line you type into.
//
// Both are pure for R62's reason, which R81 then proved twice: a widget built
// inside a draw method can only be checked by looking at it, and three of R81's
// five layout bugs were found by rendering at four widths and READING them. The
// same is true of a caret: an editor whose only test is somebody sitting at a
// terminal is an editor with an off-by-one in it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { painter, stripAnsi, visibleWidth } from '../lib/ansi.mjs';
import {
  History, KeyStream, Line, Pastes, commonPrefix, completionLines, completions, keysIn, pasteMark,
} from './input.mjs';
import { Select, WRITE_MY_OWN, pickFromLine, plainLines } from './select.mjs';

const ESC = '\x1b';

const question = (options = ['Postgres', 'SQLite']) => new Select({
  kind: 'question',
  title: 'Postgres or SQLite?',
  rows: [
    ...options.map((option) => ({ id: option, label: option })),
    { id: WRITE_MY_OWN, label: 'Write my own answer' },
  ],
});

const drawn = (select, width = 80, depth = 3) =>
  select.lines(width, painter(depth)).map(stripAnsi);

// --- moving and choosing ------------------------------------------------------

test('the cursor starts at the top and the arrows move it', () => {
  const select = question();
  assert.equal(select.row.id, 'Postgres');
  select.key(`${ESC}[B`);
  assert.equal(select.row.id, 'SQLite');
  select.key(`${ESC}[A`);
  assert.equal(select.row.id, 'Postgres');
});

test('it wraps, because a list of three should not have a bottom to get stuck on', () => {
  const select = question();
  select.key(`${ESC}[A`);
  assert.equal(select.row.id, WRITE_MY_OWN, 'up from the first is the last');
  select.key(`${ESC}[B`);
  assert.equal(select.row.id, 'Postgres');
});

test('enter chooses whatever the cursor is on', () => {
  const select = question();
  select.key(`${ESC}[B`);
  assert.deepEqual(select.key('\r'), { done: 'chosen', row: select.rows[1] });
});

test('a digit chooses directly, in one key rather than two', () => {
  // The only key on this widget faster than the arrows. Making it move-only
  // would spend the whole reason somebody reached for it.
  const select = question();
  assert.deepEqual(select.key('2'), { done: 'chosen', row: select.rows[1] });
  assert.equal(select.at, 1, 'and the cursor is left where the digit pointed');
});

test('a digit past the end of the list is not a choice', () => {
  assert.equal(question().key('7'), null);
});

test('esc backs out and settles nothing', () => {
  assert.deepEqual(question().key(ESC), { done: 'cancelled', row: null });
});

test('a key the widget has no use for is handed back, not swallowed', () => {
  // This is what lets the single permission keys keep working while the picker
  // is open: the client sees the key because the widget said nothing about it.
  assert.equal(question().key('y'), null);
  assert.equal(question().key('x'), null);
});

// --- what it draws ------------------------------------------------------------

test('the question is above the options and free text is the last row', () => {
  const said = drawn(question());
  assert.match(said[0], /Postgres or SQLite\?/);
  assert.match(said[1], /^❯.*Postgres/, 'the cursor marks the row that enter would take');
  assert.match(said.join('\n'), /1.*Postgres/);
  assert.match(said.join('\n'), /2.*SQLite/);
  assert.match(said[said.length - 2], /Write my own answer/,
    'always last, above the keys');
});

test('the keys are on it, and esc survives a narrow terminal', () => {
  for (const width of [100, 80, 60, 40, 30]) {
    const keys = drawn(question(), width).at(-1);
    assert.ok(keys.length <= width, `at ${width}: ${keys}`);
    assert.match(keys, /esc leave/, `at ${width} columns`);
  }
});

test('no row is wider than the terminal it is drawn in, at any width', () => {
  const long = new Select({
    kind: 'question',
    title: 'Which of these should it do, given everything above?',
    rows: [
      { id: 'a', label: 'Rewrite the exporter so the two agree', hint: 'the slow one' },
      { id: 'b', label: 'Leave it and write the difference down' },
      { id: WRITE_MY_OWN, label: 'Write my own answer' },
    ],
  });
  for (const width of [120, 80, 46, 30]) {
    for (const line of long.lines(width, painter(3))) {
      assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${stripAnsi(line)}`);
    }
  }
});

test('with the colour taken away it is the same list', () => {
  const said = drawn(question(), 80, 0);
  assert.equal(said.join('\n'), question().lines(80, painter(0)).join('\n'),
    'nothing survives NO_COLOR but the words');
  assert.match(said.join('\n'), /Postgres/);
  assert.match(said[1], /^❯/, 'the cursor is a glyph, not a colour');
  assert.match(said.join('\n'), /1\)|1 |1\b/, 'and the numbers are still there');
});

test('a long list keeps the cursor on screen rather than scrolling under it', () => {
  const rows = Array.from({ length: 20 }, (_, at) => ({ id: `r${at}`, label: `run ${at}` }));
  const select = new Select({ kind: 'runs', rows, at: 15 });
  const said = select.lines(80, painter(3), 5).map(stripAnsi).join('\n');
  assert.match(said, /run 15/, 'the one you are on is shown');
  assert.match(said, /more/, 'and it says how many were not');
});

test('the hint gives way before the label does', () => {
  // Rendered the other way round this row read `2 Allow Bash(mvn *) for the
  // rest of  dies with the session`, which spends the last columns on the aside
  // and cuts the thing being chosen.
  const select = new Select({
    kind: 'permission',
    rows: [{ id: 's', label: 'Allow Bash(mvn *) for this run', hint: 'dies with the session' }],
  });
  assert.match(select.lines(80, painter(3)).map(stripAnsi)[0], /dies with the session/);
  const narrow = select.lines(40, painter(3)).map(stripAnsi)[0];
  assert.doesNotMatch(narrow, /dies with/);
  assert.match(narrow, /Allow Bash\(mvn \*\) for this run/, 'the decision survives whole');
});

test('a grant shortens a whole phrasing at a time and is never cut mid-promise', () => {
  // R78's rule, in the widget where it matters most: `Allow Bash(mvn *) for th`
  // describes a promise nobody made, and these words are a decision about what
  // a machine may do rather than a status.
  const select = new Select({
    kind: 'permission',
    rows: [{
      id: 's',
      label: 'Allow Bash(mvn *) for the rest of this run',
      short: 'Allow Bash(mvn *) this run',
      hint: 'dies with the session',
    }],
  });
  const narrow = select.lines(40, painter(3)).map(stripAnsi)[0];
  assert.match(narrow, /Allow Bash\(mvn \*\) this run$/);
  assert.ok(narrow.length <= 40);
});

test('an empty list says so instead of drawing nothing', () => {
  const said = drawn(new Select({ kind: 'runs', empty: 'nothing here' })).join('\n');
  assert.match(said, /nothing here/);
});

// --- where there is no cursor to move ----------------------------------------

test('through a pipe it is a numbered list and a line read from stdin', () => {
  const said = plainLines(question()).join('\n');
  assert.match(said, /1\) Postgres/);
  assert.match(said, /2\) SQLite/);
  assert.match(said, /3\) Write my own answer/);
  assert.match(said, /a number, or just type your answer/);
  assert.equal(stripAnsi(said), said, 'nothing to repaint means nothing to paint');
});

test('a number picks, and anything else is the free text', () => {
  const select = question();
  assert.equal(pickFromLine(select, '2').row.id, 'SQLite');
  const wrote = pickFromLine(select, 'neither — use the one already there');
  assert.equal(wrote.row.id, WRITE_MY_OWN);
  assert.equal(wrote.text, 'neither — use the one already there');
});

test('with no free-text row, only a number settles anything', () => {
  const permission = new Select({
    kind: 'permission',
    rows: [{ id: 'y', label: 'Allow once' }, { id: 'refuse', label: 'Refuse' }],
  });
  assert.equal(pickFromLine(permission, 'yes please'), null, 'so it can ask again');
  assert.equal(pickFromLine(permission, '9'), null);
  assert.equal(pickFromLine(permission, '1').row.id, 'y');
});

// --- the line you type into ---------------------------------------------------

test('the caret moves and text goes in where it is', () => {
  const line = new Line('mvn test');
  line.left();
  line.left();
  line.left();
  line.left();
  line.insert('-q ');
  assert.equal(line.text, 'mvn -q test');
  assert.equal(line.at, 7);
});

test('backspace takes the character before the caret and nothing at the start', () => {
  const line = new Line('ab');
  line.backspace();
  assert.equal(line.text, 'a');
  line.home();
  line.backspace();
  assert.equal(line.text, 'a', 'backspacing at column zero is not an error');
});

test('ctrl+w takes the word, ctrl+u takes the line before the caret', () => {
  const line = new Line('fix the exporter');
  line.killWord();
  assert.equal(line.text, 'fix the');
  line.killToStart();
  assert.equal(line.text, '');
});

test('a line longer than the terminal keeps the CARET on screen', () => {
  // A window anchored at character zero means typing past the width types into
  // a line you cannot see, which is the failure a one-line editor has to avoid
  // before it has any other feature.
  const line = new Line('x'.repeat(200));
  const shown = line.window(40);
  assert.ok(shown.at >= 0 && shown.at < 40, `caret at ${shown.at}`);
  // The caret is a column of its own, so the text it sits after is one shorter
  // — the drawn row is the width it was given and not a character more.
  assert.equal(visibleWidth(line.render(40, painter(3))), 40);
  line.home();
  assert.equal(line.window(40).at, 0, 'and it comes back when the caret does');
});

test('the caret is drawn as a block, and on the empty line too', () => {
  const drawnLine = new Line('').render(20, painter(3));
  assert.equal(stripAnsi(drawnLine), ' ', 'a block on nothing is still a block');
  assert.match(stripAnsi(new Line('hi').render(20, painter(3))), /^hi $/);
});

// --- slash commands, filtered as you type -------------------------------------

const COMMANDS = [['/help', 'this list'], ['/login', 'sign in'], ['/logout', 'forget it'],
  ['/log', 'the daemon log'], ['/quit', 'leave']];

test('a bare slash offers everything, and typing narrows it', () => {
  assert.equal(completions('/', COMMANDS).length, COMMANDS.length);
  assert.deepEqual(completions('/log', COMMANDS).map(([name]) => name),
    ['/login', '/logout', '/log']);
  assert.deepEqual(completions('/q', COMMANDS).map(([name]) => name), ['/quit']);
  assert.deepEqual(completions('/zzz', COMMANDS), []);
});

test('a command with an argument has stopped being a name', () => {
  // Completing `/runs foo` to `/runs` would eat the argument.
  assert.deepEqual(completions('/log off', COMMANDS), []);
  assert.deepEqual(completions('not a command', COMMANDS), []);
});

test('tab completes as far as the matches agree', () => {
  assert.equal(commonPrefix(['/login', '/logout', '/log']), '/log');
  assert.equal(commonPrefix(['/quit']), '/quit', 'one match completes it whole');
  assert.equal(commonPrefix([]), '');
});

test('each row of the list carries its description, so the name is not something you know', () => {
  const said = completionLines(completions('/lo', COMMANDS), 0, 80, painter(3)).map(stripAnsi);
  assert.match(said[0], /^❯ \/login\s+sign in/);
  assert.match(said[1], /\/logout\s+forget it/);
  for (const line of completionLines(completions('/', COMMANDS), 0, 30, painter(3))) {
    assert.ok(visibleWidth(line) <= 30, stripAnsi(line));
  }
});

// --- history ------------------------------------------------------------------

test('up walks back through what was sent and down comes home to the draft', () => {
  const history = new History(['first', 'second']);
  assert.equal(history.back('half typed'), 'second');
  assert.equal(history.back(), 'first');
  assert.equal(history.back(), null, 'there is nothing older, so the line is left alone');
  assert.equal(history.forward(), 'second');
  assert.equal(history.forward(), 'half typed', 'what you were writing is not lost');
  assert.equal(history.forward(), null);
});

test('sending the same thing twice is one entry', () => {
  const history = new History();
  history.add('again');
  history.add('again');
  assert.deepEqual(history.entries, ['again']);
});

test('adding puts the cursor back at the end, where the next line is typed', () => {
  const history = new History(['old']);
  history.back('');
  history.add('new');
  assert.equal(history.back(''), 'new');
});

// --- a paste is one thing -----------------------------------------------------

test('a bracketed paste is one key, however many lines are in it', () => {
  const pasted = 'line one\nline two\nline three';
  const keys = keysIn(`${ESC}[200~${pasted}${ESC}[201~`);
  assert.deepEqual(keys, [{ paste: pasted }]);
});

test('a paste split across chunks is still one key', () => {
  // A pasted file arrives in however many reads the pipe felt like, and the end
  // marker can be three chunks later. Everything between is held.
  const stream = new KeyStream();
  assert.deepEqual(stream.push(`${ESC}[200~one\n`), []);
  assert.deepEqual(stream.push('two\n'), []);
  assert.deepEqual(stream.push(`three${ESC}[201~`), [{ paste: 'one\ntwo\nthree' }]);
});

test('keys typed either side of a paste are still keys', () => {
  assert.deepEqual(keysIn(`a${ESC}[200~x${ESC}[201~b`), ['a', { paste: 'x' }, 'b']);
});

test('a multi-line paste becomes one placeholder that says what it is', () => {
  assert.equal(pasteMark('a\nb\nc'), '[pasted, 3 lines]');
  const pastes = new Pastes();
  const mark = pastes.hold('a\nb\nc');
  assert.equal(pastes.expand(`look at ${mark} please`), 'look at a\nb\nc please');
});

test('two different pastes of the same size do not become each other', () => {
  const pastes = new Pastes();
  const first = pastes.hold('a\nb');
  const second = pastes.hold('c\nd');
  assert.notEqual(first, second);
  assert.equal(pastes.expand(`${first} ${second}`), 'a\nb c\nd');
});

test('a placeholder with nothing behind it goes as the text it looks like', () => {
  // Recalled from a previous launch's history: the paste was never stored, only
  // the fact of it, and inventing a body for it would be worse.
  assert.equal(new Pastes().expand('[pasted, 9 lines]'), '[pasted, 9 lines]');
});
